/**
 * 门控常开 + 仅动态首注：OKX BTC 永续 5m，扫活跃度探测线与四档首注。
 *
 * Usage:
 *   node scripts/backtest-btc-always-on-dynamic.js --days=365
 *   node scripts/backtest-btc-always-on-dynamic.js --days=365 --fetch
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
  formatTierParamLabel,
} from '../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-btc-always-on-dynamic.json');

const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = 0.5;
const ACTIVITY_WINDOW = config.sessionGate.activityWindowBars;

const TIER1_9_OPTS = [1, 2, 3];
const TIER10_OPTS = [4, 5, 6, 8];
const TIER11_OPTS = [6, 8, 10, 12];
const TIER12_OPTS = [12, 16, 20, 24];

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
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n / 1e6).toFixed(1)}M`;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function uniqM(vals) {
  return [...new Set(vals.map((v) => Math.round(v / 100_000) / 10))].sort((a, b) => a - b);
}

function buildProbeGrid(barDist) {
  if (!barDist) {
    return [15, 18, 20, 22, 25, 28, 30, 35, 40];
  }
  const { p50, p75, p90, p95 } = barDist;
  return uniqM([
    p50 * 0.5, p50 * 0.7, p50 * 0.85, p50,
    p75 * 0.7, p75 * 0.85, p75,
    p90 * 0.6, p90 * 0.75, p90 * 0.85, p90,
    p95 * 0.7, p95 * 0.85, p95,
    25,
  ]).filter((m) => m >= 5);
}

function barUsdtDistribution(rows) {
  const vals = rows.map((r) => r.barUsdt).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return null;
  const at = (p) => vals[Math.floor(p * (vals.length - 1))];
  return { p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), p99: at(0.99) };
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

function buildAlwaysOnTrades(c5, fromMs, toMs) {
  const raw = [];
  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;

    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({ t: tradeTs, k1t: k1.t, signal: eval_.signal, won });
  }
  return raw;
}

function simulateMartingale(trades, c5, { fixedBase = null, tierOpts = null, probeUsdt = null } = {}) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const probe = probeUsdt ?? config.sessionGate.activityProbeUsdtMin;

  let consecutiveLosses = 0;
  let currentBet = fixedBase ?? tierOpts?.tier1_9Usd ?? config.tradeBudgetUsd;
  let skipNext = false;
  let halts = 0;
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
      continue;
    }

    if (consecutiveLosses === 0) {
      if (fixedBase != null) {
        currentBet = fixedBase;
      } else if (tierOpts) {
        const idx = idxByT.get(t.k1t) ?? 0;
        const { hits, windowBars } = computeActivityFreqLocal(c5, idx, probe);
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

    if (t.won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MARTINGALE_MAX) {
        halts += 1;
        consecutiveLosses = 0;
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
    avgStake: tradesCount ? totalStake / tradesCount : 0,
  };
}

function summarizeTierDistribution(trades, c5, probeUsdt) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const buckets = Array.from({ length: 12 }, (_, i) => ({
    tier: i + 1,
    trades: 0,
    wins: 0,
    pnl: 0,
  }));

  for (const t of trades) {
    const idx = idxByT.get(t.k1t) ?? 0;
    const { hits, windowBars } = computeActivityFreqLocal(c5, idx, probeUsdt);
    const tier = activityHitsToTier(hits, windowBars);
    const b = buckets[tier - 1];
    b.trades += 1;
    if (t.won) b.wins += 1;
    const stake = 3;
    b.pnl += t.won ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake) : -stake;
  }

  return buckets.map((b) => ({
    ...b,
    winRate: b.trades ? b.wins / b.trades : 0,
  }));
}

function scoreResult(r) {
  return r.pnl - r.maxDrawdown * 0.15 - r.halts * 8;
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = parseArg('to') ? Date.parse(parseArg('to')) : Date.now();
  const fromMs = parseArg('from') ? Date.parse(parseArg('from')) : toMs - days * 24 * 60 * 60_000;
  const symbol = parseArg('symbol', 'BTC/USDT');
  const marketCtx = resolveOhlcvMarket('swap', symbol);

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const rows = [];
  for (const bar of c5) {
    if (bar.t < fromMs || bar.t >= toMs) continue;
    rows.push({ t: bar.t, barUsdt: computeBarUsdtNotional(bar) });
  }

  const barDist = barUsdtDistribution(rows);
  const trades = buildAlwaysOnTrades(c5, fromMs, toMs);
  const fixedBase = config.tradeBudgetUsd;
  const defaultTierOpts = {
    tier1_9Usd: config.dynamicBaseBet.tier1_9Usd,
    tier10Usd: config.dynamicBaseBet.tier10Usd,
    tier11Usd: config.dynamicBaseBet.tier11Usd,
    tier12Usd: config.dynamicBaseBet.tier12Usd,
  };

  const baseline = simulateMartingale(trades, c5, { fixedBase });
  const productionDynamic = simulateMartingale(trades, c5, {
    tierOpts: defaultTierOpts,
    probeUsdt: config.sessionGate.activityProbeUsdtMin,
  });

  console.log(`\n=== BTC 门控常开 · 动态首注阈值扫参 · ${days}d · ${marketCtx.label} ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
  console.log(`数据: OKX ${marketCtx.symbol} 永续 5m | 信号 ${trades.length} 笔`);
  if (barDist) {
    console.log(`5m 成交额: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)} p99=${fmtM(barDist.p99)}`);
  }
  console.log(`马丁: ×${MULTIPLIER} 连亏${MARTINGALE_MAX}停 | 入场价 ${ENTRY_PRICE}`);
  console.log(`\n--- 基准（常开固定 $${fixedBase}）---`);
  console.log(
    `${baseline.trades}笔 WR ${pct(baseline.winRate)} PnL $${baseline.pnl.toFixed(2)} ` +
    `ROI ${pct(baseline.roi)} 回撤 $${baseline.maxDrawdown.toFixed(2)} 止损${baseline.halts}`,
  );
  console.log(`\n--- 当前生产参数（probe=${fmtM(config.sessionGate.activityProbeUsdtMin)} ${formatTierParamLabel(defaultTierOpts)}）---`);
  console.log(
    `${productionDynamic.trades}笔 WR ${pct(productionDynamic.winRate)} PnL $${productionDynamic.pnl.toFixed(2)} ` +
    `ROI ${pct(productionDynamic.roi)} 回撤 $${productionDynamic.maxDrawdown.toFixed(2)} 止损${productionDynamic.halts} ` +
    `(Δ固定 ${productionDynamic.pnl - baseline.pnl >= 0 ? '+' : ''}${(productionDynamic.pnl - baseline.pnl).toFixed(2)})`,
  );

  const probeGrid = buildProbeGrid(barDist);
  console.log(`\n[1/2] 探测线扫参（固定四档 ${formatTierParamLabel(defaultTierOpts)}）`);
  console.log(`网格 probeM: [${probeGrid.join(', ')}]`);

  const probeSweep = [];
  for (const probeM of probeGrid) {
    const probeUsdt = probeM * 1e6;
    const r = simulateMartingale(trades, c5, { tierOpts: defaultTierOpts, probeUsdt });
    const tierDist = summarizeTierDistribution(trades, c5, probeUsdt);
    const hotTrades = tierDist.filter((x) => x.tier >= 10).reduce((s, x) => s + x.trades, 0);
    probeSweep.push({
      probeM,
      probeUsdt,
      hotTierPct: hotTrades / (trades.length || 1),
      pnlDeltaVsFixed: r.pnl - baseline.pnl,
      pnlDeltaVsProduction: r.pnl - productionDynamic.pnl,
      score: scoreResult(r),
      ...r,
    });
  }
  probeSweep.sort((a, b) => b.score - a.score || b.pnl - a.pnl);

  console.log('\n--- Top 12 探测线（常开 + 动态首注）---');
  console.log('probe | 热档占比 | 交易 | 胜率  | 止损 | 均注  | PnL      | ROI   | 回撤   | Δ固定  | score');
  for (const r of probeSweep.slice(0, 12)) {
    console.log(
      `${String(r.probeM).padStart(4)}M | ` +
      `${(r.hotTierPct * 100).toFixed(1).padStart(6)}% | ` +
      `${String(r.trades).padStart(4)} | ` +
      `${(r.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.avgStake.toFixed(2).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(7)} | ` +
      `${pct(r.roi).padStart(5)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(5)} | ` +
      `${r.pnlDeltaVsFixed >= 0 ? '+' : ''}${r.pnlDeltaVsFixed.toFixed(0).padStart(5)} | ` +
      `${r.score.toFixed(0)}`,
    );
  }

  const topProbes = probeSweep.slice(0, 5);
  console.log('\n[2/2] 四档首注扫参（Top 5 探测线 × 档位网格）');

  const tierSweep = [];
  for (const probe of topProbes) {
    for (const tier1_9 of TIER1_9_OPTS) {
      for (const tier10 of TIER10_OPTS) {
        for (const tier11 of TIER11_OPTS) {
          if (tier11 < tier10) continue;
          for (const tier12 of TIER12_OPTS) {
            if (tier12 < tier11) continue;
            const tierOpts = { tier1_9Usd: tier1_9, tier10Usd: tier10, tier11Usd: tier11, tier12Usd: tier12 };
            const r = simulateMartingale(trades, c5, { tierOpts, probeUsdt: probe.probeUsdt });
            tierSweep.push({
              probeM: probe.probeM,
              tierOpts,
              label: `probe${probe.probeM}M | ${formatTierParamLabel(tierOpts)}`,
              pnlDeltaVsFixed: r.pnl - baseline.pnl,
              score: scoreResult(r),
              ...r,
            });
          }
        }
      }
    }
  }
  tierSweep.sort((a, b) => b.score - a.score || b.pnl - a.pnl);

  console.log('\n--- Top 10 综合（探测线 + 四档首注）---');
  console.log('方案                                              | 交易 | 胜率 | 止损 | PnL    | 回撤   | 均注  | Δ固定 | score');
  for (const r of tierSweep.slice(0, 10)) {
    console.log(
      `${r.label.slice(0, 48).padEnd(48)} | ` +
      `${String(r.trades).padStart(4)} | ` +
      `${pct(r.winRate).padStart(4)} | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(5)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(5)} | ` +
      `$${r.avgStake.toFixed(2).padStart(4)} | ` +
      `${r.pnlDeltaVsFixed >= 0 ? '+' : ''}${r.pnlDeltaVsFixed.toFixed(0).padStart(5)} | ` +
      `${r.score.toFixed(0)}`,
    );
  }

  const bestProbe = probeSweep[0];
  const bestCombo = tierSweep[0];

  const output = {
    mode: 'always_on_dynamic',
    days,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
    barUsdtDistribution: barDist,
    rawSignals: trades.length,
    baseline,
    productionDynamic: {
      probeUsdt: config.sessionGate.activityProbeUsdtMin,
      tierOpts: defaultTierOpts,
      ...productionDynamic,
    },
    probeSweep,
    tierSweepTop30: tierSweep.slice(0, 30),
    recommended: {
      bestProbe,
      bestCombo,
    },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log('\n=== 推荐 ===');
  if (bestProbe) {
    console.log(`【最优探测线】ACTIVITY_PROBE_USDT_MIN=${bestProbe.probeUsdt}`);
    console.log(
      `→ PnL $${bestProbe.pnl.toFixed(2)} ROI ${pct(bestProbe.roi)} 回撤 $${bestProbe.maxDrawdown.toFixed(2)} ` +
      `热档占比 ${pct(bestProbe.hotTierPct)} (Δ固定 ${bestProbe.pnlDeltaVsFixed >= 0 ? '+' : ''}${bestProbe.pnlDeltaVsFixed.toFixed(2)})`,
    );
  }
  if (bestCombo) {
    const t = bestCombo.tierOpts;
    console.log('\n【最优综合】');
    console.log(`ACTIVITY_PROBE_USDT_MIN=${bestCombo.probeM * 1e6}`);
    console.log(`BASE_BET_TIER1_9_USD=${t.tier1_9Usd}`);
    console.log(`BASE_BET_TIER10_USD=${t.tier10Usd}`);
    console.log(`BASE_BET_TIER11_USD=${t.tier11Usd}`);
    console.log(`BASE_BET_TIER12_USD=${t.tier12Usd}`);
    console.log(
      `→ PnL $${bestCombo.pnl.toFixed(2)} ROI ${pct(bestCombo.roi)} 回撤 $${bestCombo.maxDrawdown.toFixed(2)} 止损${bestCombo.halts}`,
    );
  }
  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
