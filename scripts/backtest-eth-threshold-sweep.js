/**
 * ETH 综合阈值扫参：活跃度探测线 + 动态门控阈值 + 放量时长 + 动态首注四档。
 *
 * Usage:
 *   node scripts/backtest-eth-threshold-sweep.js --days=365 --fetch
 *   node scripts/backtest-eth-threshold-sweep.js --days=180 --symbol=ETH/USDT
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import {
  activityHitsToTier,
  resolveTierBaseBet,
  TIER_COUNT,
} from '../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-eth-threshold-sweep.json');

const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = 0.5;
const ACTIVITY_WINDOW = 12;

const DEFAULT_BURST_MIN = [10, 15, 21, 30, 40];
const TIER1_9 = [1, 2, 3];
const TIER10 = [4, 5, 6, 8];
const TIER11 = [6, 8, 10, 12];
const TIER12 = [12, 16, 20, 24];

/** Derive sweep grids from symbol 5m volume distribution (ETH << BTC). */
function buildThresholdGrids(barDist) {
  if (!barDist) {
    return {
      probeM: [8, 10, 15, 20, 25],
      threshMinM: [8, 10, 15, 20],
      threshMaxM: [25, 30, 37, 45, 55],
    };
  }

  const uniqM = (vals) => [...new Set(vals.map((v) => Math.round(v / 100_000) / 10))].sort((a, b) => a - b);
  const { p50, p75, p90, p95, p99 } = barDist;

  const probeM = uniqM([
    p50 * 0.5, p50 * 0.75, p50, p75 * 0.8, p75, p90 * 0.7, p90 * 0.85, p90, p95 * 0.8, p95,
  ]).filter((m) => m >= 0.2);

  const threshMinM = uniqM([
    p50 * 0.6, p50, p75 * 0.7, p75, p90 * 0.6, p90 * 0.8, p90, p95 * 0.7, p95,
  ]).filter((m) => m >= 0.3);

  const threshMaxM = uniqM([
    p90, p95 * 0.9, p95, p99 * 0.7, p99 * 0.85, p99,
  ]).filter((m) => m >= 1 && m <= p99 * 1.02);

  return { probeM, threshMinM, threshMaxM };
}

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function fmtM(n) {
  if (n == null) return '—';
  return `${(n / 1e6).toFixed(1)}M`;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function scoreResult(r) {
  return r.pnl - r.maxDrawdown * 0.35 - r.halts * 8;
}

function computeActivityFreqLocal(c5, idx, probeUsdt) {
  const windowBars = Math.min(ACTIVITY_WINDOW, idx + 1);
  const startIdx = idx - windowBars + 1;
  let hits = 0;
  for (let i = startIdx; i <= idx; i += 1) {
    const usdt = computeBarUsdtNotional(c5[i]);
    if (usdt != null && usdt >= probeUsdt) hits += 1;
  }
  return { hits, windowBars, freq: windowBars > 0 ? hits / windowBars : 0 };
}

function resolveDynamicThreshold(freq, threshMin, threshMax) {
  const lo = Math.min(threshMin, threshMax);
  const hi = Math.max(threshMin, threshMax);
  const clamped = Math.min(1, Math.max(0, freq));
  return Math.round(hi - clamped * (hi - lo));
}

function simulateBurstTimeline(c5, rows, gate) {
  let volumeBurstUntilMs = null;
  const timeline = [];
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const burstMs = gate.volumeBurstMinutes * 60_000;

  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { freq } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
    const thresholdUsdt = resolveDynamicThreshold(
      freq,
      gate.barVolumeUsdtMinDynamic,
      gate.barVolumeUsdtMaxDynamic,
    );
    const barTriggered = row.barUsdt != null && row.barUsdt >= thresholdUsdt;
    if (barTriggered) volumeBurstUntilMs = row.nowMs + burstMs;
    const burstActive = volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs;
    timeline.push({ t: row.t, tradeAllowed: burstActive });
  }
  return timeline;
}

function buildGatedTrades(c5, timeline, fromMs, toMs) {
  const allowedByT = new Map(timeline.filter((x) => x.tradeAllowed).map((x) => [x.t, x]));
  const raw = [];

  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;
    if (!allowedByT.has(k1.t)) continue;

    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({ t: tradeTs, k1t: k1.t, won });
  }
  return raw;
}

function simulateMartingale(trades, c5, { fixedBase = null, tierOpts = null, gate = null } = {}) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = fixedBase ?? tierOpts?.tier1_9Usd ?? 1;
  let skipNext = false;
  let halts = 0;
  let streakTier = null;
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  let tradesCount = 0;
  let wins = 0;

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      streakTier = null;
      continue;
    }

    if (consecutiveLosses === 0) {
      if (fixedBase != null) {
        currentBet = fixedBase;
      } else if (tierOpts) {
        const idx = idxByT.get(t.k1t) ?? 0;
        const { hits, windowBars } = computeActivityFreqLocal(
          c5,
          idx,
          gate?.activityProbeUsdtMin ?? config.sessionGate.activityProbeUsdtMin,
        );
        const tier = activityHitsToTier(hits, windowBars);
        streakTier = tier;
        currentBet = resolveTierBaseBet(tier, tierOpts);
      }
    }

    const stake = currentBet;
    const pnlUsd = t.won
      ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake)
      : -stake;

    cumPnl += pnlUsd;
    peakPnl = Math.max(peakPnl, cumPnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumPnl);
    totalStake += stake;
    tradesCount += 1;
    if (t.won) wins += 1;

    if (t.won) {
      consecutiveLosses = 0;
      streakTier = null;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MARTINGALE_MAX) {
        halts += 1;
        consecutiveLosses = 0;
        streakTier = null;
        skipNext = true;
      } else {
        currentBet *= MULTIPLIER;
      }
    }
  }

  return {
    trades: tradesCount,
    wins,
    winRate: tradesCount ? wins / tradesCount : 0,
    halts,
    pnl: cumPnl,
    maxDrawdown,
    roi: totalStake > 0 ? cumPnl / totalStake : 0,
  };
}

function barUsdtDistribution(rows) {
  const vals = rows.map((r) => r.barUsdt).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return null;
  const pct = (p) => vals[Math.floor(p * (vals.length - 1))];
  return { p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99) };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const symbol = parseArg('symbol', 'ETH/USDT');
  const burstMinArg = parseArg('burst-min', null);
  const burstMinOpts = burstMinArg != null
    ? [Number(burstMinArg)].filter((n) => Number.isFinite(n) && n > 0)
    : DEFAULT_BURST_MIN;
  const outFile = burstMinArg != null
    ? join(OUT_DIR, `backtest-eth-threshold-sweep-${burstMinArg}m.json`)
    : OUT_FILE;
  const marketCtx = resolveOhlcvMarket('swap', symbol);

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const rows = [];
  for (let i = 0; i < c5.length; i += 1) {
    const bar = c5[i];
    if (bar.t < fromMs || bar.t >= toMs) continue;
    rows.push({ t: bar.t, nowMs: bar.t + TF_MS, barUsdt: computeBarUsdtNotional(bar) });
  }

  const barDist = barUsdtDistribution(rows);
  const alwaysOn = simulateMartingale(
    buildGatedTrades(c5, rows.map((r) => ({ t: r.t, tradeAllowed: true })), fromMs, toMs),
    c5,
    { fixedBase: config.tradeBudgetUsd },
  );

  console.log(`\n=== ETH 综合阈值扫参 · ${days}d · ${marketCtx.symbol} (${marketCtx.label}) ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
  if (barDist) {
    console.log(`5m 成交额: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)} p99=${fmtM(barDist.p99)}`);
    if (barDist.p50 < 5_000_000) {
      console.warn(
        '⚠ 成交额 p50 < 5M，疑似拉到了现货 ETH/USDT 而非永续 ETH/USDT:USDT；' +
        '请确认 resolveOhlcvMarket 已输出带 :USDT 后缀的 symbol',
      );
    }
  }
  console.log(`常开基准: ${alwaysOn.trades}笔 WR ${pct(alwaysOn.winRate)} PnL $${alwaysOn.pnl.toFixed(2)} 止损${alwaysOn.halts}`);

  const { probeM: PROBE_M, threshMinM: THRESH_MIN_M, threshMaxM: THRESH_MAX_M } = buildThresholdGrids(barDist);
  console.log(`扫参网格: probe=[${PROBE_M.join(',')}]M min=[${THRESH_MIN_M.join(',')}]M max=[${THRESH_MAX_M.join(',')}]M burst=[${burstMinOpts.join(',')}]min`);

  // ── Phase 1: gate sweep (fixed $3 baseline for ranking) ──
  console.log('\n[1/2] 门控阈值扫参...');
  const gateSweep = [];
  for (const probeM of PROBE_M) {
    for (const minM of THRESH_MIN_M) {
      for (const maxM of THRESH_MAX_M) {
        if (maxM <= minM) continue;
        if (maxM * 1e6 > barDist.p99 * 1.02) continue;
        for (const burstMin of burstMinOpts) {
          const gate = {
            activityProbeUsdtMin: probeM * 1e6,
            barVolumeUsdtMinDynamic: minM * 1e6,
            barVolumeUsdtMaxDynamic: maxM * 1e6,
            volumeBurstMinutes: burstMin,
          };
          const timeline = simulateBurstTimeline(c5, rows, gate);
          const gateOpenPct = timeline.filter((x) => x.tradeAllowed).length / (timeline.length || 1);
          if (gateOpenPct < 0.05 || gateOpenPct > 0.85) continue;
          const trades = buildGatedTrades(c5, timeline, fromMs, toMs);
          const r = simulateMartingale(trades, c5, { fixedBase: config.tradeBudgetUsd });
          gateSweep.push({
            ...gate,
            probeM,
            threshMinM: minM,
            threshMaxM: maxM,
            gateOpenPct,
            rawSignals: trades.length,
            pnlDeltaVsAlways: r.pnl - alwaysOn.pnl,
            score: scoreResult(r),
            ...r,
          });
        }
      }
    }
  }
  gateSweep.sort((a, b) => b.score - a.score || b.pnl - a.pnl);

  console.log('\n--- Top 10 门控方案（固定首注 $3）---');
  console.log('探测 | 动态min | 动态max | 时长 | 门控% | 交易 | 胜率 | 止损 | PnL    | 回撤   | score');
  for (const r of gateSweep.slice(0, 10)) {
    console.log(
      `${String(r.probeM).padStart(4)}M | ` +
      `${String(r.threshMinM).padStart(5)}M | ` +
      `${String(r.threshMaxM).padStart(5)}M | ` +
      `${String(r.volumeBurstMinutes).padStart(4)}m | ` +
      `${(r.gateOpenPct * 100).toFixed(1).padStart(5)}% | ` +
      `${String(r.trades).padStart(4)} | ` +
      `${(r.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(5)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(5)} | ` +
      `${r.score.toFixed(0)}`,
    );
  }

  const topGates = gateSweep.slice(0, 12);

  // ── Phase 2: tier sweep on top gates ──
  console.log('\n[2/2] 动态首注扫参（Top 12 门控 × 四档首注）...');
  const comboSweep = [];
  for (const gate of topGates) {
    const timeline = simulateBurstTimeline(c5, rows, gate);
    const trades = buildGatedTrades(c5, timeline, fromMs, toMs);
    for (const t19 of TIER1_9) {
      for (const t10 of TIER10) {
        for (const t11 of TIER11) {
          if (t11 < t10) continue;
          for (const t12 of TIER12) {
            if (t12 < t11) continue;
            const tierOpts = {
              tier1_9Usd: t19,
              tier10Usd: t10,
              tier11Usd: t11,
              tier12Usd: t12,
            };
            const r = simulateMartingale(trades, c5, { tierOpts, gate });
            comboSweep.push({
              gate: {
                activityProbeUsdtMin: gate.activityProbeUsdtMin,
                barVolumeUsdtMinDynamic: gate.barVolumeUsdtMinDynamic,
                barVolumeUsdtMaxDynamic: gate.barVolumeUsdtMaxDynamic,
                volumeBurstMinutes: gate.volumeBurstMinutes,
                probeM: gate.probeM,
                threshMinM: gate.threshMinM,
                threshMaxM: gate.threshMaxM,
                gateOpenPct: gate.gateOpenPct,
              },
              tierOpts,
              label: `probe${gate.probeM}M min${gate.threshMinM}M max${gate.threshMaxM}M ${gate.volumeBurstMinutes}m | 1-9=$${t19}/10=$${t10}/11=$${t11}/12=$${t12}`,
              pnlDeltaVsAlways: r.pnl - alwaysOn.pnl,
              score: scoreResult(r),
              ...r,
            });
          }
        }
      }
    }
  }
  comboSweep.sort((a, b) => b.score - a.score || b.pnl - a.pnl);
  const best = comboSweep[0];
  const bestGateOnly = gateSweep[0];
  const bestBalanced = comboSweep.find((r) => r.halts <= bestGateOnly.halts + 2 && r.maxDrawdown <= bestGateOnly.maxDrawdown * 1.2)
    ?? best;

  const output = {
    symbol: marketCtx.symbol,
    days,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    barUsdtDistribution: barDist,
    alwaysOn,
    currentProduction: {
      sessionGate: {
        activityProbeUsdtMin: config.sessionGate.activityProbeUsdtMin,
        barVolumeUsdtMinDynamic: config.sessionGate.barVolumeUsdtMinDynamic,
        barVolumeUsdtMaxDynamic: config.sessionGate.barVolumeUsdtMaxDynamic,
        volumeBurstMinutes: config.sessionGate.volumeBurstMinutes,
      },
      dynamicBaseBet: config.dynamicBaseBet,
    },
    gateSweepTop20: gateSweep.slice(0, 20),
    comboSweepTop30: comboSweep.slice(0, 30),
    recommended: {
      bestOverall: best,
      bestGateOnly: bestGateOnly,
      bestBalanced,
    },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('\n=== 推荐配置 ===');
  if (best) {
    const g = best.gate;
    const t = best.tierOpts;
    console.log('\n【综合最优】');
    console.log(`ACTIVITY_PROBE_USDT_MIN=${g.activityProbeUsdtMin}`);
    console.log(`BAR_VOLUME_USDT_MIN_DYNAMIC=${g.barVolumeUsdtMinDynamic}`);
    console.log(`BAR_VOLUME_USDT_MAX_DYNAMIC=${g.barVolumeUsdtMaxDynamic}`);
    console.log(`VOLUME_BURST_MINUTES=${g.volumeBurstMinutes}`);
    console.log(`BASE_BET_TIER1_9_USD=${t.tier1_9Usd}`);
    console.log(`BASE_BET_TIER10_USD=${t.tier10Usd}`);
    console.log(`BASE_BET_TIER11_USD=${t.tier11Usd}`);
    console.log(`BASE_BET_TIER12_USD=${t.tier12Usd}`);
    console.log(
      `→ ${best.trades}笔 WR ${pct(best.winRate)} PnL $${best.pnl.toFixed(2)} ` +
      `ROI ${pct(best.roi)} 回撤 $${best.maxDrawdown.toFixed(2)} 止损${best.halts} ` +
      `(Δ常开 ${best.pnlDeltaVsAlways >= 0 ? '+' : ''}${best.pnlDeltaVsAlways.toFixed(2)})`,
    );
  }

  console.log('\n--- Top 8 综合方案 ---');
  console.log('方案摘要                                      | 交易 | 胜率 | 止损 | PnL    | 回撤   | score');
  for (const r of comboSweep.slice(0, 8)) {
    console.log(
      `${r.label.slice(0, 44).padEnd(44)} | ` +
      `${String(r.trades).padStart(4)} | ` +
      `${(r.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(5)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(5)} | ` +
      `${r.score.toFixed(0)}`,
    );
  }

  console.log(`\n完整结果: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
