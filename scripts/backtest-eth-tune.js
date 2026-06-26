/**
 * ETH 专用合理调参：基于永续成交额分位数，max≤p99，放量窗默认 21min。
 *
 * Usage:
 *   node scripts/backtest-eth-tune.js --days=365
 *   node scripts/backtest-eth-tune.js --days=365 --burst-min=21 --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import { activityHitsToTier, resolveTierBaseBet } from '../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = 0.5;
const ACTIVITY_WINDOW = 12;

const BTC_PARAMS = {
  activityProbeUsdtMin: 25_000_000,
  barVolumeUsdtMinDynamic: 20_000_000,
  barVolumeUsdtMaxDynamic: 37_000_000,
  volumeBurstMinutes: 21,
};

const TIER_PRESETS = {
  conservative: { tier1_9Usd: 1, tier10Usd: 3, tier11Usd: 4, tier12Usd: 8, label: '1/3/4/8' },
  default: { tier1_9Usd: 1, tier10Usd: 6, tier11Usd: 8, tier12Usd: 24, label: '1/6/8/24' },
  fixed3: { tier1_9Usd: 3, tier10Usd: 3, tier11Usd: 3, tier12Usd: 3, label: '3/3/3/3' },
};

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fmtM(n) {
  if (n == null) return '—';
  return `${(n / 1e6).toFixed(1)}M`;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function roundM(v) {
  return Math.round(v / 100_000) / 10;
}

/** 合理网格：probe/min 在 p50~p90，max 在 p90~p99（不超过 p99） */
function buildReasonableGrids(barDist) {
  const { p50, p75, p90, p95, p99 } = barDist;
  const uniq = (arr) => [...new Set(arr.map(roundM))].sort((a, b) => a - b);

  const probeM = uniq([p50 * 0.7, p50, p75 * 0.85, p75, p90 * 0.7, p90, p95 * 0.85]);
  const threshMinM = uniq([p50 * 0.8, p50, p75 * 0.75, p75, p90 * 0.75, p90]);
  const threshMaxM = uniq([p90, p95 * 0.85, p95, p99 * 0.75])
    .filter((m) => m >= p90 / 1e6 * 0.8 && m <= p95 / 1e6 * 1.02);

  return { probeM, threshMinM, threshMaxM };
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
  return Math.round(hi - Math.min(1, Math.max(0, freq)) * (hi - lo));
}

function analyzeGate(c5, rows, gate, barDist) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let triggerBars = 0;
  let coldThreshSum = 0;
  let coldCount = 0;
  const thresholds = [];

  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { freq } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
    const th = resolveDynamicThreshold(freq, gate.barVolumeUsdtMinDynamic, gate.barVolumeUsdtMaxDynamic);
    thresholds.push(th);
    if (row.barUsdt >= th) triggerBars += 1;
    if (freq < 0.17) {
      coldCount += 1;
      coldThreshSum += th;
    }
  }
  thresholds.sort((a, b) => a - b);
  const timeline = simulateBurstTimeline(c5, rows, gate);
  const gateOpenPct = timeline.filter((x) => x.tradeAllowed).length / (timeline.length || 1);
  const coldThreshAvg = coldCount ? coldThreshSum / coldCount : gate.barVolumeUsdtMaxDynamic;
  const coldReachablePct = coldCount
    ? rows.filter((row, i) => {
      const idx = idxByT.get(row.t) ?? 0;
      const { freq } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
      if (freq >= 0.17) return false;
      const th = resolveDynamicThreshold(freq, gate.barVolumeUsdtMinDynamic, gate.barVolumeUsdtMaxDynamic);
      return row.barUsdt >= th;
    }).length / coldCount
    : 0;

  return {
    gateOpenPct,
    triggerBarPct: rows.length ? triggerBars / rows.length : 0,
    coldThreshAvg,
    coldReachablePct,
    coldAboveP99: coldThreshAvg > barDist.p99,
    threshP50: thresholds[Math.floor(thresholds.length * 0.5)] ?? 0,
  };
}

function simulateBurstTimeline(c5, rows, gate) {
  let volumeBurstUntilMs = null;
  const timeline = [];
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const burstMs = gate.volumeBurstMinutes * 60_000;
  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { freq } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
    const th = resolveDynamicThreshold(freq, gate.barVolumeUsdtMinDynamic, gate.barVolumeUsdtMaxDynamic);
    if (row.barUsdt != null && row.barUsdt >= th) volumeBurstUntilMs = row.nowMs + burstMs;
    timeline.push({ t: row.t, tradeAllowed: volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs });
  }
  return timeline;
}

function buildGatedTrades(c5, timeline, fromMs, toMs) {
  const allowed = new Set(timeline.filter((x) => x.tradeAllowed).map((x) => x.t));
  const raw = [];
  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs || !allowed.has(k1.t)) continue;
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;
    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL') || (eval_.signal === 'DOWN' && outcome === 'BEAR');
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
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  let tradesCount = 0;
  let wins = 0;

  for (const t of trades) {
    if (skipNext) { skipNext = false; consecutiveLosses = 0; continue; }
    if (consecutiveLosses === 0) {
      if (fixedBase != null) currentBet = fixedBase;
      else if (tierOpts) {
        const idx = idxByT.get(t.k1t) ?? 0;
        const { hits, windowBars } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
        currentBet = resolveTierBaseBet(activityHitsToTier(hits, windowBars), tierOpts);
      }
    }
    const stake = currentBet;
    const pnlUsd = t.won ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake) : -stake;
    cumPnl += pnlUsd;
    peakPnl = Math.max(peakPnl, cumPnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumPnl);
    totalStake += stake;
    tradesCount += 1;
    if (t.won) wins += 1;
    if (t.won) consecutiveLosses = 0;
    else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MARTINGALE_MAX) { halts += 1; consecutiveLosses = 0; skipNext = true; }
      else currentBet *= MULTIPLIER;
    }
  }
  return {
    trades: tradesCount, wins, winRate: tradesCount ? wins / tradesCount : 0,
    halts, pnl: cumPnl, maxDrawdown, roi: totalStake > 0 ? cumPnl / totalStake : 0,
  };
}

function scoreReasonable(r, meta, barDist) {
  let s = r.pnl - r.maxDrawdown * 0.35 - r.halts * 8;
  if (meta.coldAboveP99) s -= 500;
  if (meta.gateOpenPct > 0.35) s -= (meta.gateOpenPct - 0.35) * 1500;
  if (meta.gateOpenPct < 0.08) s -= 150;
  // 冷态阈值越接近 p95 越好（可达性）
  if (meta.coldThreshAvg > barDist.p95 * 1.05) s -= 100;
  return s;
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const burstMin = Number(parseArg('burst-min', '21'));
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const outFile = join(OUT_DIR, `backtest-eth-tune-${burstMin}m.json`);

  const marketCtx = resolveOhlcvMarket('swap', 'ETH/USDT');
  const { c5 } = await ensureOkxCandles({
    fromMs, toMs, forceFetch: hasFlag('fetch'),
    marketType: marketCtx.marketType, symbol: marketCtx.symbol,
  });

  const rows = c5.filter((b) => b.t >= fromMs && b.t < toMs)
    .map((b) => ({ t: b.t, nowMs: b.t + TF_MS, barUsdt: computeBarUsdtNotional(b) }));

  const vals = rows.map((r) => r.barUsdt).filter(Number.isFinite).sort((a, b) => a - b);
  const barDist = {
    p50: vals[Math.floor(vals.length * 0.5)],
    p75: vals[Math.floor(vals.length * 0.75)],
    p90: vals[Math.floor(vals.length * 0.9)],
    p95: vals[Math.floor(vals.length * 0.95)],
    p99: vals[Math.floor(vals.length * 0.99)],
  };

  const alwaysOnTrades = buildGatedTrades(c5, rows.map((r) => ({ t: r.t, tradeAllowed: true })), fromMs, toMs);
  const alwaysOn = simulateMartingale(alwaysOnTrades, c5, { fixedBase: 3 });

  const { probeM, threshMinM, threshMaxM } = buildReasonableGrids(barDist);

  console.log(`\n=== ETH 合理调参 · ${days}d · 放量窗 ${burstMin}min ===`);
  console.log(`成交额: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)} p99=${fmtM(barDist.p99)}`);
  console.log(`常开: ${alwaysOn.trades}笔 WR ${pct(alwaysOn.winRate)} PnL $${alwaysOn.pnl.toFixed(0)}`);
  console.log(`网格: probe=[${probeM.join(',')}]M min=[${threshMinM.join(',')}]M max=[${threshMaxM.join(',')}]M`);

  const gateSweep = [];
  for (const pM of probeM) {
    for (const minM of threshMinM) {
      for (const maxM of threshMaxM) {
        if (maxM <= minM) continue;
        const gate = {
          activityProbeUsdtMin: pM * 1e6,
          barVolumeUsdtMinDynamic: minM * 1e6,
          barVolumeUsdtMaxDynamic: maxM * 1e6,
          volumeBurstMinutes: burstMin,
        };
        const meta = analyzeGate(c5, rows, gate, barDist);
        if (meta.coldAboveP99) continue;
        if (meta.gateOpenPct < 0.08 || meta.gateOpenPct > 0.35) continue;
        const trades = buildGatedTrades(c5, simulateBurstTimeline(c5, rows, gate), fromMs, toMs);
        const fixed = simulateMartingale(trades, c5, { fixedBase: 3 });
        gateSweep.push({
          probeM: pM, threshMinM: minM, threshMaxM: maxM, ...gate, ...meta,
          ...fixed, pnlDeltaVsAlways: fixed.pnl - alwaysOn.pnl,
          score: scoreReasonable(fixed, meta, barDist),
        });
      }
    }
  }
  gateSweep.sort((a, b) => b.score - a.score || b.pnl - a.pnl);

  const comboSweep = [];
  for (const gate of gateSweep.slice(0, 15)) {
    const g = {
      activityProbeUsdtMin: gate.activityProbeUsdtMin,
      barVolumeUsdtMinDynamic: gate.barVolumeUsdtMinDynamic,
      barVolumeUsdtMaxDynamic: gate.barVolumeUsdtMaxDynamic,
      volumeBurstMinutes: gate.volumeBurstMinutes,
    };
    const trades = buildGatedTrades(c5, simulateBurstTimeline(c5, rows, g), fromMs, toMs);
    for (const preset of Object.values(TIER_PRESETS)) {
      const { label, ...tierOpts } = preset;
      const r = simulateMartingale(trades, c5, { tierOpts, gate: g });
      comboSweep.push({
        gate: { probeM: gate.probeM, threshMinM: gate.threshMinM, threshMaxM: gate.threshMaxM, ...g, gateOpenPct: gate.gateOpenPct },
        tierLabel: label, tierOpts, ...r,
        pnlDeltaVsAlways: r.pnl - alwaysOn.pnl,
        score: scoreReasonable(r, gate, barDist),
      });
    }
  }
  comboSweep.sort((a, b) => b.score - a.score || b.pnl - a.pnl);

  // BTC 参数 baseline on ETH
  const btcGate = { ...BTC_PARAMS };
  const btcMeta = analyzeGate(c5, rows, btcGate, barDist);
  const btcTrades = buildGatedTrades(c5, simulateBurstTimeline(c5, rows, btcGate), fromMs, toMs);
  const btcFixed = simulateMartingale(btcTrades, c5, { fixedBase: 3 });
  const btcDynamic = simulateMartingale(btcTrades, c5, { tierOpts: TIER_PRESETS.default, gate: btcGate });

  const best = comboSweep[0];
  const bestFixed = gateSweep[0];
  const bestPnl = [...comboSweep].sort((a, b) => b.pnl - a.pnl)[0];

  const output = {
    days, burstMin, barDist, alwaysOn,
    btcParamsOnEth: { meta: btcMeta, fixed: btcFixed, dynamic: btcDynamic },
    gateSweepTop15: gateSweep.slice(0, 15),
    comboSweepTop15: comboSweep.slice(0, 15),
    recommended: { bestFixed, bestCombo: best, bestPnl },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('\n--- Top 8 门控（固定 $3，合理约束）---');
  console.log('probe | min  | max  | 门控% | 冷态均阈 | 交易 | 胜率 | PnL   | 回撤');
  for (const r of gateSweep.slice(0, 8)) {
    console.log(
      `${String(r.probeM).padStart(4)}M | ${String(r.threshMinM).padStart(4)}M | ${String(r.threshMaxM).padStart(4)}M | ` +
      `${(r.gateOpenPct * 100).toFixed(1).padStart(5)}% | ${fmtM(r.coldThreshAvg).padStart(7)} | ` +
      `${String(r.trades).padStart(4)} | ${(r.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `$${r.pnl.toFixed(0).padStart(5)} | $${r.maxDrawdown.toFixed(0)}`,
    );
  }

  console.log('\n--- Top 8 综合（门控 + 首注）---');
  console.log('probe | min  | max  | 首注    | 门控% | PnL   | 回撤  | Δ常开');
  for (const r of comboSweep.slice(0, 8)) {
    const g = r.gate;
    console.log(
      `${String(g.probeM).padStart(4)}M | ${String(g.threshMinM).padStart(4)}M | ${String(g.threshMaxM).padStart(4)}M | ` +
      `${r.tierLabel.padStart(7)} | ${(g.gateOpenPct * 100).toFixed(1).padStart(5)}% | ` +
      `$${r.pnl.toFixed(0).padStart(5)} | $${r.maxDrawdown.toFixed(0).padStart(5)} | ${r.pnlDeltaVsAlways >= 0 ? '+' : ''}${r.pnlDeltaVsAlways.toFixed(0)}`,
    );
  }

  console.log('\n--- BTC 默认参数套 ETH（对照）---');
  console.log(`门控开启 ${pct(btcMeta.gateOpenPct)} | 固定$3 PnL $${btcFixed.pnl.toFixed(0)} | 动态首注 PnL $${btcDynamic.pnl.toFixed(0)}`);

  if (bestFixed) {
    console.log('\n【ETH 推荐 · 门控】');
    console.log(`ACTIVITY_PROBE_USDT_MIN=${bestFixed.activityProbeUsdtMin}`);
    console.log(`BAR_VOLUME_USDT_MIN_DYNAMIC=${bestFixed.barVolumeUsdtMinDynamic}`);
    console.log(`BAR_VOLUME_USDT_MAX_DYNAMIC=${bestFixed.barVolumeUsdtMaxDynamic}`);
    console.log(`VOLUME_BURST_MINUTES=${burstMin}`);
  }
  if (best) {
    console.log('\n【ETH 推荐 · 门控 + 首注】');
    console.log(`首注 ${best.tierLabel} | PnL $${best.pnl.toFixed(0)} | 门控 ${pct(best.gate.gateOpenPct)}`);
  }

  console.log(`\n完整结果: ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
