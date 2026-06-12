/**
 * Backtest dynamic base bet sized by session-gate activity freq.
 * Base bet recalculated after each win or martingale halt (4-loss stop).
 *
 * Usage:
 *   node scripts/backtest-dynamic-base-bet.js --days=365
 *   node scripts/backtest-dynamic-base-bet.js --days=365 --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import {
  computeActivityFreq,
  resolveBurstThresholdUsdt,
} from '../src/session/sessionGate.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-dynamic-base-bet.json');
const OUT_TIER12 = join(OUT_DIR, 'backtest-dynamic-base-bet-tier12.json');
const OUT_TIER12_HYBRID = join(OUT_DIR, 'backtest-dynamic-base-bet-tier12-hybrid.json');
const OUT_TIER12_RECOMMENDED = join(OUT_DIR, 'backtest-dynamic-base-bet-tier12-recommended.json');

/** 推荐上线：2-6档 $2→$3 · 7-8档 $3 · 9-12档 $4→$12 */
export const RECOMMENDED_HYBRID_OPTS = {
  weakMin: 2,
  weakMax: 3,
  ampMin: 4,
  ampMax: 12,
};
const TF_MS = 5 * 60_000;

const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = Number(parseArg('entry', '0.5'));
const TIER_COUNT = 12;

const BASE_MIN_OPTS = [2, 3, 4];
const BASE_MAX_OPTS = [6, 8, 10, 12];
const DIRECTION_OPTS = ['hot_higher', 'hot_lower'];

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

function resolveDynamicBaseBet(freq, minBet, maxBet, direction) {
  const lo = Math.min(minBet, maxBet);
  const hi = Math.max(minBet, maxBet);
  const f = Math.min(1, Math.max(0, freq));
  if (direction === 'hot_higher') return lo + f * (hi - lo);
  return hi - f * (hi - lo);
}

/** Map probe hits (0..windowBars) → tier 1..12 (cold→hot). */
export function activityHitsToTier(hits, windowBars = TIER_COUNT) {
  const h = Math.min(Math.max(0, hits), windowBars);
  if (windowBars <= 0) return 1;
  return Math.max(1, Math.min(TIER_COUNT, Math.round((h / windowBars) * (TIER_COUNT - 1)) + 1));
}

/** Tier 1 = minBet, tier 12 = maxBet (hot → larger). */
export function resolveTierBaseBet(tier, minBet, maxBet) {
  const lo = Math.min(minBet, maxBet);
  const hi = Math.max(minBet, maxBet);
  const t = (Math.max(1, Math.min(TIER_COUNT, tier)) - 1) / (TIER_COUNT - 1);
  return lo + t * (hi - lo);
}

/**
 * Hybrid: tier 1→$2, tier 2-6 linear $2-$3, tier 7-8 flat $3, tier 9-12 linear ampMin-ampMax.
 */
export function resolveHybridTierBaseBet(tier, {
  weakMin = 2,
  weakMax = 3,
  ampMin = 4,
  ampMax = 12,
} = {}) {
  const t = Math.max(1, Math.min(TIER_COUNT, tier));
  const lo = Math.min(weakMin, weakMax);
  const hi = Math.max(weakMin, weakMax);
  const ampLo = Math.min(ampMin, ampMax);
  const ampHi = Math.max(ampMin, ampMax);

  if (t <= 1) return lo;
  if (t <= 6) return lo + ((t - 2) / (6 - 2)) * (hi - lo);
  if (t <= 8) return hi;
  return ampLo + ((t - 9) / (12 - 9)) * (ampHi - ampLo);
}

function buildHybridTierBetTable({ weakMin = 2, weakMax = 3, ampMin = 4, ampMax = 12 } = {}) {
  return Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    hitsRange: tierHitsRange(i + 1),
    baseBet: Number(resolveHybridTierBaseBet(i + 1, { weakMin, weakMax, ampMin, ampMax }).toFixed(2)),
  }));
}

function getActivityAt(c5, idx) {
  const { hits, windowBars, freq } = computeActivityFreq(c5, idx);
  const tier = activityHitsToTier(hits, windowBars);
  return { hits, windowBars, freq, tier };
}

function simulateBurstTimeline(c5, rows, volumeBurstMinutes) {
  let volumeBurstUntilMs = null;
  const timeline = [];
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));

  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { thresholdUsdt } = resolveBurstThresholdUsdt(c5, idx);
    const barTriggered = row.barUsdt != null && row.barUsdt >= thresholdUsdt;
    if (barTriggered) {
      volumeBurstUntilMs = row.nowMs + volumeBurstMinutes * 60_000;
    }
    const burstActive = volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs;
    timeline.push({
      t: row.t,
      tradeAllowed: burstActive,
      gateMode: burstActive ? 'volume_burst' : 'idle',
      barUsdt: row.barUsdt,
      thresholdUsdt,
    });
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

    raw.push({
      t: tradeTs,
      k1t: k1.t,
      signalId: eval_.signalId,
      signal: eval_.signal,
      won,
      gateMode: allowedByT.get(k1.t).gateMode,
    });
  }
  return raw;
}

/**
 * Martingale with optional dynamic base bet on streak reset (win / halt).
 * After halt, skips the next trade (matches production prepareOrder halted skip).
 */
function simulateMartingaleBetting(trades, c5, {
  fixedBase = null,
  baseMin = 3,
  baseMax = 8,
  direction = 'hot_higher',
  tier12 = false,
  tier12Hybrid = null,
} = {}) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = fixedBase ?? baseMin;
  let skipNext = false;
  let halts = 0;
  let streakTier = null;
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  const out = [];

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      streakTier = null;
      continue;
    }

    let activityTier = streakTier;
    if (consecutiveLosses === 0) {
      if (fixedBase != null) {
        currentBet = fixedBase;
        activityTier = null;
      } else {
        const idx = idxByT.get(t.k1t) ?? 0;
        const activity = getActivityAt(c5, idx);
        activityTier = activity.tier;
        streakTier = activity.tier;
        if (tier12Hybrid) {
          currentBet = resolveHybridTierBaseBet(activity.tier, tier12Hybrid);
        } else if (tier12) {
          currentBet = resolveTierBaseBet(activity.tier, baseMin, baseMax);
        } else {
          currentBet = resolveDynamicBaseBet(activity.freq, baseMin, baseMax, direction);
        }
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

    out.push({
      ...t,
      stake,
      pnlUsd,
      activityTier,
      lossStreakPos: t.won ? 0 : consecutiveLosses + 1,
    });

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

  const wins = out.filter((x) => x.won).length;
  return {
    trades: out.length,
    wins,
    winRate: out.length ? wins / out.length : 0,
    halts,
    pnl: cumPnl,
    maxDrawdown,
    avgStake: out.length ? totalStake / out.length : 0,
    roi: totalStake > 0 ? cumPnl / totalStake : 0,
    skippedAfterHalt: halts,
    tradeDetails: out,
  };
}

function summarizeByTier(tradeDetails, baseMin, baseMax) {
  const tiers = Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    hitsRange: tierHitsRange(i + 1),
    baseBet: resolveTierBaseBet(i + 1, baseMin, baseMax),
    trades: 0,
    wins: 0,
    pnl: 0,
    totalStake: 0,
  }));

  for (const t of tradeDetails) {
    if (t.activityTier == null) continue;
    const bucket = tiers[t.activityTier - 1];
    bucket.trades += 1;
    if (t.won) bucket.wins += 1;
    bucket.pnl += t.pnlUsd;
    bucket.totalStake += t.stake;
  }

  return tiers.map((b) => ({
    ...b,
    baseBet: Number(b.baseBet.toFixed(2)),
    winRate: b.trades ? b.wins / b.trades : 0,
    roi: b.totalStake > 0 ? b.pnl / b.totalStake : 0,
  }));
}

/** Approximate hits that map into each tier (window=12). */
function tierHitsRange(tier) {
  const ranges = [];
  for (let h = 0; h <= 12; h += 1) {
    if (activityHitsToTier(h, 12) === tier) ranges.push(h);
  }
  if (!ranges.length) return '—';
  if (ranges.length === 1) return `${ranges[0]}根`;
  return `${ranges[0]}-${ranges.at(-1)}根`;
}

/** Per-tier edge at fixed $3 stake (no martingale scaling by tier). */
function summarizeTierEdgeAtFixedStake(trades, c5, fixedStake = 3) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const tiers = Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    hitsRange: tierHitsRange(i + 1),
    trades: 0,
    wins: 0,
    pnl: 0,
  }));

  for (const t of trades) {
    const idx = idxByT.get(t.k1t) ?? 0;
    const { tier } = getActivityAt(c5, idx);
    const bucket = tiers[tier - 1];
    bucket.trades += 1;
    if (t.won) bucket.wins += 1;
    bucket.pnl += t.won
      ? (calcWinNetProfit(fixedStake, ENTRY_PRICE) ?? fixedStake)
      : -fixedStake;
  }

  return tiers.map((b) => ({
    ...b,
    winRate: b.trades ? b.wins / b.trades : 0,
    pnlPerTrade: b.trades ? b.pnl / b.trades : 0,
  }));
}

function summarizeByTierHybrid(tradeDetails, hybridOpts) {
  const tiers = Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    hitsRange: tierHitsRange(i + 1),
    baseBet: resolveHybridTierBaseBet(i + 1, hybridOpts),
    trades: 0,
    wins: 0,
    pnl: 0,
    totalStake: 0,
  }));

  for (const t of tradeDetails) {
    if (t.activityTier == null) continue;
    const bucket = tiers[t.activityTier - 1];
    bucket.trades += 1;
    if (t.won) bucket.wins += 1;
    bucket.pnl += t.pnlUsd;
    bucket.totalStake += t.stake;
  }

  return tiers.map((b) => ({
    ...b,
    baseBet: Number(b.baseBet.toFixed(2)),
    winRate: b.trades ? b.wins / b.trades : 0,
    roi: b.totalStake > 0 ? b.pnl / b.totalStake : 0,
  }));
}

async function runTier12HybridBacktest({
  c5,
  rawTrades,
  fromMs,
  toMs,
  days,
  marketCtx,
  gateOpenPct,
  fixedBase,
}) {
  const sg = config.sessionGate;
  const baseline = simulateMartingaleBetting(rawTrades, c5, { fixedBase });
  baseline.label = `固定 $${fixedBase}`;
  delete baseline.tradeDetails;

  const fullTier12 = simulateMartingaleBetting(rawTrades, c5, {
    baseMin: 2,
    baseMax: 12,
    tier12: true,
  });
  const fullRef = { ...fullTier12, label: '$2-$12 全档' };
  delete fullRef.tradeDetails;

  const AMP_MAX_OPTS = [8, 10, 12];
  const AMP_MIN_OPTS = [4, 5, 6];
  const sweep = [];

  for (const ampMax of AMP_MAX_OPTS) {
    for (const ampMin of AMP_MIN_OPTS) {
      if (ampMin >= ampMax) continue;
      const hybridOpts = { weakMin: 2, weakMax: 3, ampMin, ampMax };
      const r = simulateMartingaleBetting(rawTrades, c5, { tier12Hybrid: hybridOpts });
      const { tradeDetails, ...summary } = r;
      sweep.push({
        ...hybridOpts,
        label: `弱2-6:$2-3 | 7-8:$3 | 9-12:$${ampMin}-$${ampMax}`,
        pnlDeltaVsFixed: summary.pnl - baseline.pnl,
        pnlDeltaVsFullTier12: summary.pnl - fullRef.pnl,
        maxDdDeltaVsFixed: summary.maxDrawdown - baseline.maxDrawdown,
        ...summary,
      });
    }
  }
  sweep.sort((a, b) => b.pnl - a.pnl);

  const best = sweep[0];
  const bestHybridOpts = best
    ? { weakMin: 2, weakMax: 3, ampMin: best.ampMin, ampMax: best.ampMax }
    : { weakMin: 2, weakMax: 3, ampMin: 4, ampMax: 12 };
  const bestRun = simulateMartingaleBetting(rawTrades, c5, { tier12Hybrid: bestHybridOpts });
  const tierTable = summarizeByTierHybrid(bestRun.tradeDetails, bestHybridOpts);
  const tierBetTable = buildHybridTierBetTable(bestHybridOpts);

  const report = {
    mode: 'tier12_hybrid',
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
    mapping: {
      tier1: '$2',
      tier2to6: '$2 → $3 线性',
      tier7to8: '$3 持平',
      tier9to12: `$${bestHybridOpts.ampMin} → $${bestHybridOpts.ampMax} 线性`,
    },
    sessionGate: {
      volumeBurstMinutes: sg.volumeBurstMinutes,
      activityWindowBars: sg.activityWindowBars,
      activityProbeUsdtMin: sg.activityProbeUsdtMin,
    },
    gateOpenPct,
    rawSignals: rawTrades.length,
    baseline,
    referenceFullTier12: fullRef,
    tierBetTableRecommended: tierBetTable,
    sweepCount: sweep.length,
    sweep,
    recommended: best ? { ...best, byTier: tierTable } : null,
  };

  writeFileSync(OUT_TIER12_HYBRID, JSON.stringify(report, null, 2));

  console.log(`\n=== 12档混合首注回测 · OKX ${marketCtx.label} · ${days}d ===`);
  console.log('规则: 1档=$2 | 2-6档 $2→$3 | 7-8档=$3 | 9-12档放大');
  console.log(`门控开启: ${(gateOpenPct * 100).toFixed(1)}% | 信号: ${rawTrades.length}笔`);
  console.log(`\n--- 对照 ---`);
  console.log(
    `固定 $${fixedBase}: PnL $${baseline.pnl.toFixed(2)} | 回撤 $${baseline.maxDrawdown.toFixed(2)} | 止损 ${baseline.halts}`,
  );
  console.log(
    `全档 $2-12: PnL $${fullRef.pnl.toFixed(2)} | 回撤 $${fullRef.maxDrawdown.toFixed(2)} | 止损 ${fullRef.halts}`,
  );

  console.log('\n--- 推荐档位首注表 ---');
  console.log('档位 | 命中   | 首注');
  for (const row of tierBetTable) {
    console.log(`${String(row.tier).padStart(4)} | ${row.hitsRange.padStart(6)} | $${row.baseBet.toFixed(2)}`);
  }

  console.log('\n--- 9-12档放大扫参（弱档 $2-3）---');
  console.log('9档起 | 12档止 | 交易 | 胜率  | 止损 | PnL      | 回撤    | Δ固定 | Δ全档');
  for (const r of sweep) {
    console.log(
      `$${r.ampMin}`.padStart(6) + ' | ' +
      `$${r.ampMax}`.padStart(6) + ' | ' +
      `${String(r.trades).padStart(4)} | ` +
      `${(r.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(7)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(6)} | ` +
      `${r.pnlDeltaVsFixed >= 0 ? '+' : ''}${r.pnlDeltaVsFixed.toFixed(0).padStart(5)} | ` +
      `${r.pnlDeltaVsFullTier12 >= 0 ? '+' : ''}${r.pnlDeltaVsFullTier12.toFixed(0)}`,
    );
  }

  if (best) {
    console.log(`\n--- 最优: 9-12档 $${best.ampMin}-$${best.ampMax} 各档表现 ---`);
    console.log('档位 | 命中   | 首注  | 交易  | 胜率  | 分段PnL | ROI%');
    for (const row of tierTable) {
      console.log(
        `${String(row.tier).padStart(4)} | ${row.hitsRange.padStart(6)} | ` +
        `$${row.baseBet.toFixed(2).padStart(4)} | ` +
        `${String(row.trades).padStart(5)} | ` +
        `${(row.winRate * 100).toFixed(1).padStart(4)}% | ` +
        `${row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(0).padStart(7)} | ` +
        `${(row.roi * 100).toFixed(2).padStart(5)}%`,
      );
    }
  }

  console.log(`\n完整结果: ${OUT_TIER12_HYBRID}`);
}

async function runRecommendedHybridBacktest(ctx) {
  const {
    c5, rawTrades, fromMs, toMs, days, marketCtx, gateOpenPct, fixedBase,
  } = ctx;
  const sg = config.sessionGate;
  const hybridOpts = RECOMMENDED_HYBRID_OPTS;

  const baseline = simulateMartingaleBetting(rawTrades, c5, { fixedBase });
  delete baseline.tradeDetails;

  const fullTier12 = simulateMartingaleBetting(rawTrades, c5, {
    baseMin: 2,
    baseMax: 12,
    tier12: true,
  });
  delete fullTier12.tradeDetails;

  const run = simulateMartingaleBetting(rawTrades, c5, { tier12Hybrid: hybridOpts });
  const { tradeDetails, ...result } = run;
  const tierTable = summarizeByTierHybrid(tradeDetails, hybridOpts);
  const tierBetTable = buildHybridTierBetTable(hybridOpts);

  const report = {
    mode: 'tier12_recommended',
    params: {
      tier1: '$2',
      tier2to6: '$2 → $3',
      tier7to8: '$3',
      tier9to12: '$4 → $12',
      ...hybridOpts,
    },
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
    sessionGate: {
      volumeBurstMinutes: sg.volumeBurstMinutes,
      activityWindowBars: sg.activityWindowBars,
      activityProbeUsdtMin: sg.activityProbeUsdtMin,
    },
    martingale: {
      multiplier: MULTIPLIER,
      maxLosses: MARTINGALE_MAX,
      entryPrice: ENTRY_PRICE,
    },
    gateOpenPct,
    rawSignals: rawTrades.length,
    baseline: { ...baseline, label: `固定 $${fixedBase}` },
    referenceFullTier12: { ...fullTier12, label: '$2-$12 全档' },
    tierBetTable,
    result: {
      ...result,
      label: '推荐混合 2-6:$2-3 | 7-8:$3 | 9-12:$4-12',
      pnlDeltaVsFixed: result.pnl - baseline.pnl,
      pnlDeltaVsFullTier12: result.pnl - fullTier12.pnl,
      maxDdDeltaVsFixed: result.maxDrawdown - baseline.maxDrawdown,
      maxDdDeltaVsFullTier12: result.maxDrawdown - fullTier12.maxDrawdown,
    },
    byTier: tierTable,
  };

  writeFileSync(OUT_TIER12_RECOMMENDED, JSON.stringify(report, null, 2));

  const r = report.result;
  console.log(`\n=== 推荐上线参数回测 · OKX ${marketCtx.label} · ${days}d ===`);
  console.log('参数: 1档=$2 | 2-6档 $2→$3 | 7-8档=$3 | 9-12档 $4→$12');
  console.log(`门控: 放量窗 ${sg.volumeBurstMinutes}min | 动态阈值 ${sg.barVolumeUsdtMinDynamic / 1e6}M–${sg.barVolumeUsdtMaxDynamic / 1e6}M`);
  console.log(`门控开启: ${(gateOpenPct * 100).toFixed(1)}% | 信号: ${rawTrades.length}笔 | 成交: ${r.trades}笔`);

  console.log('\n--- 首注档位表 ---');
  console.log('档位 | 命中   | 首注');
  for (const row of tierBetTable) {
    console.log(`${String(row.tier).padStart(4)} | ${row.hitsRange.padStart(6)} | $${row.baseBet.toFixed(2)}`);
  }

  console.log('\n--- 方案对比 ---');
  console.log(
    `固定 $${fixedBase}     | PnL $${baseline.pnl.toFixed(2).padStart(8)} | 回撤 $${baseline.maxDrawdown.toFixed(2).padStart(7)} | ` +
    `ROI ${(baseline.roi * 100).toFixed(2).padStart(6)}% | 止损 ${baseline.halts}`,
  );
  console.log(
    `全档 $2-12    | PnL $${fullTier12.pnl.toFixed(2).padStart(8)} | 回撤 $${fullTier12.maxDrawdown.toFixed(2).padStart(7)} | ` +
    `ROI ${(fullTier12.roi * 100).toFixed(2).padStart(6)}% | 止损 ${fullTier12.halts}`,
  );
  console.log(
    `推荐混合      | PnL $${r.pnl.toFixed(2).padStart(8)} | 回撤 $${r.maxDrawdown.toFixed(2).padStart(7)} | ` +
    `ROI ${(r.roi * 100).toFixed(2).padStart(6)}% | 止损 ${r.halts} | 均注 $${r.avgStake.toFixed(2)}`,
  );
  console.log(
    `Δ vs 固定: PnL ${r.pnlDeltaVsFixed >= 0 ? '+' : ''}${r.pnlDeltaVsFixed.toFixed(2)} | ` +
    `回撤 ${r.maxDdDeltaVsFixed >= 0 ? '+' : ''}${r.maxDdDeltaVsFixed.toFixed(2)}`,
  );
  console.log(
    `Δ vs 全档: PnL ${r.pnlDeltaVsFullTier12 >= 0 ? '+' : ''}${r.pnlDeltaVsFullTier12.toFixed(2)} | ` +
    `回撤 ${r.maxDdDeltaVsFullTier12 >= 0 ? '+' : ''}${r.maxDdDeltaVsFullTier12.toFixed(2)}`,
  );

  console.log('\n--- 各档分段表现 ---');
  console.log('档位 | 命中   | 首注  | 交易  | 胜率  | 分段PnL | ROI%');
  for (const row of tierTable) {
    console.log(
      `${String(row.tier).padStart(4)} | ${row.hitsRange.padStart(6)} | ` +
      `$${row.baseBet.toFixed(2).padStart(4)} | ` +
      `${String(row.trades).padStart(5)} | ` +
      `${(row.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(0).padStart(7)} | ` +
      `${(row.roi * 100).toFixed(2).padStart(5)}%`,
    );
  }

  const weakPnl = tierTable.filter((x) => x.tier <= 8).reduce((s, x) => s + x.pnl, 0);
  const hotPnl = tierTable.filter((x) => x.tier >= 9).reduce((s, x) => s + x.pnl, 0);
  console.log(`\n弱档 1-8 合计 PnL: ${weakPnl >= 0 ? '+' : ''}${weakPnl.toFixed(2)}`);
  console.log(`热档 9-12 合计 PnL: ${hotPnl >= 0 ? '+' : ''}${hotPnl.toFixed(2)}`);
  console.log(`\n完整结果: ${OUT_TIER12_RECOMMENDED}`);
}

async function runTier12Backtest({
  c5,
  rawTrades,
  fromMs,
  toMs,
  days,
  marketCtx,
  gateOpenPct,
  fixedBase,
}) {
  const sg = config.sessionGate;
  const baseline = simulateMartingaleBetting(rawTrades, c5, { fixedBase });
  baseline.label = `固定 $${fixedBase}`;
  delete baseline.tradeDetails;

  const sweep = [];
  for (const baseMin of BASE_MIN_OPTS) {
    for (const baseMax of BASE_MAX_OPTS) {
      if (baseMax <= baseMin) continue;
      const r = simulateMartingaleBetting(rawTrades, c5, {
        baseMin,
        baseMax,
        tier12: true,
      });
      const { tradeDetails, ...summary } = r;
      sweep.push({
        baseMin,
        baseMax,
        label: `$${baseMin}-$${baseMax} 12档热↑`,
        pnlDeltaVsFixed: summary.pnl - baseline.pnl,
        maxDdDeltaVsFixed: summary.maxDrawdown - baseline.maxDrawdown,
        ...summary,
      });
    }
  }
  sweep.sort((a, b) => b.pnl - a.pnl);

  const best = sweep[0];
  const bestRun = simulateMartingaleBetting(rawTrades, c5, {
    baseMin: best.baseMin,
    baseMax: best.baseMax,
    tier12: true,
  });
  const tierTable = summarizeByTier(bestRun.tradeDetails, best.baseMin, best.baseMax);
  const tierEdge = summarizeTierEdgeAtFixedStake(rawTrades, c5, fixedBase);

  const tierBetTable = Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    hitsRange: tierHitsRange(i + 1),
    betAtMinMax: Object.fromEntries(
      [[2, 12], [2, 8], [3, 8]].map(([lo, hi]) => [
        `$${lo}-$${hi}`,
        Number(resolveTierBaseBet(i + 1, lo, hi).toFixed(2)),
      ]),
    ),
  }));

  const report = {
    mode: 'tier12',
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
    mapping: {
      tiers: TIER_COUNT,
      rule: '近12根≥25M命中数 → 1..12档，档越高首注越大',
      tierBetFormula: 'baseBet = min + (tier-1)/11 * (max-min)',
    },
    sessionGate: {
      volumeBurstMinutes: sg.volumeBurstMinutes,
      activityWindowBars: sg.activityWindowBars,
      activityProbeUsdtMin: sg.activityProbeUsdtMin,
    },
    gateOpenPct,
    rawSignals: rawTrades.length,
    baseline,
    tierBetTable,
    tierEdgeAtFixedStake: tierEdge,
    sweepCount: sweep.length,
    sweep,
    recommended: best ? {
      ...best,
      byTier: tierTable,
    } : null,
  };

  writeFileSync(OUT_TIER12, JSON.stringify(report, null, 2));

  console.log(`\n=== 12档动态首注回测 · OKX ${marketCtx.label} · ${days}d ===`);
  console.log('映射: 近12根 ≥25M 命中数 → 1..12档 → 首注 $min..$max（越热越大）');
  console.log(`门控开启: ${(gateOpenPct * 100).toFixed(1)}% | 信号: ${rawTrades.length}笔`);
  console.log(`\n--- 基准（固定 $${fixedBase}）---`);
  console.log(
    `PnL $${baseline.pnl.toFixed(2)} | 回撤 $${baseline.maxDrawdown.toFixed(2)} | ` +
    `WR ${(baseline.winRate * 100).toFixed(1)}% | 止损 ${baseline.halts}`,
  );

  console.log('\n--- 各档命中区间 × 固定$3 边际（无马丁放大）---');
  console.log('档位 | 命中   | 交易  | 胜率  | 单笔PnL | 分段PnL');
  for (const row of tierEdge) {
    console.log(
      `${String(row.tier).padStart(4)} | ` +
      `${row.hitsRange.padStart(6)} | ` +
      `${String(row.trades).padStart(5)} | ` +
      `${(row.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${row.pnlPerTrade >= 0 ? '+' : ''}${row.pnlPerTrade.toFixed(3).padStart(7)} | ` +
      `${row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(0)}`,
    );
  }

  console.log('\n--- 12档首注表（$2-$12 / $2-$8 / $3-$8）---');
  console.log('档位 | 命中   |  $2-12 |  $2-8 |  $3-8');
  for (const row of tierBetTable) {
    console.log(
      `${String(row.tier).padStart(4)} | ${row.hitsRange.padStart(6)} | ` +
      `${String(row.betAtMinMax['$2-$12']).padStart(6)} | ` +
      `${String(row.betAtMinMax['$2-$8']).padStart(5)} | ` +
      `${String(row.betAtMinMax['$3-$8']).padStart(5)}`,
    );
  }

  console.log('\n--- Top 8 方案（12档热↑）---');
  console.log('方案        | 交易 | 胜率  | 止损 | PnL      | 回撤    | ΔPnL');
  for (const r of sweep.slice(0, 8)) {
    console.log(
      `$${r.baseMin}-$${r.baseMax}`.padEnd(11) + ' | ' +
      `${String(r.trades).padStart(4)} | ` +
      `${(r.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(7)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(6)} | ` +
      `${r.pnlDeltaVsFixed >= 0 ? '+' : ''}${r.pnlDeltaVsFixed.toFixed(0)}`,
    );
  }

  if (best) {
    console.log(`\n--- 最优方案 $${best.baseMin}-$${best.baseMax} 各档表现 ---`);
    console.log('档位 | 命中   | 首注  | 交易  | 胜率  | 分段PnL | ROI%');
    for (const row of tierTable) {
      console.log(
        `${String(row.tier).padStart(4)} | ${row.hitsRange.padStart(6)} | ` +
        `$${row.baseBet.toFixed(2).padStart(4)} | ` +
        `${String(row.trades).padStart(5)} | ` +
        `${(row.winRate * 100).toFixed(1).padStart(4)}% | ` +
        `${row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(0).padStart(7)} | ` +
        `${(row.roi * 100).toFixed(2).padStart(5)}%`,
      );
    }
  }

  console.log(`\n完整结果: ${OUT_TIER12}`);
}

function summarizeByActivityBucket(trades, c5) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const buckets = [
    { label: 'cold 0-25%', min: 0, max: 0.25, trades: 0, wins: 0, pnl: 0 },
    { label: 'mid 25-50%', min: 0.25, max: 0.5, trades: 0, wins: 0, pnl: 0 },
    { label: 'warm 50-75%', min: 0.5, max: 0.75, trades: 0, wins: 0, pnl: 0 },
    { label: 'hot 75-100%', min: 0.75, max: 1.01, trades: 0, wins: 0, pnl: 0 },
  ];

  for (const t of trades) {
    const idx = idxByT.get(t.k1t) ?? 0;
    const { freq } = computeActivityFreq(c5, idx);
    const bucket = buckets.find((b) => freq >= b.min && freq < b.max);
    if (!bucket) continue;
    bucket.trades += 1;
    if (t.won) bucket.wins += 1;
    bucket.pnl += t.pnlUsd;
  }

  return buckets.map((b) => ({
    ...b,
    winRate: b.trades ? b.wins / b.trades : 0,
  }));
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = parseArg('to') ? Date.parse(parseArg('to')) : Date.now();
  const fromMs = parseArg('from') ? Date.parse(parseArg('from')) : toMs - days * 24 * 60 * 60_000;
  const marketCtx = resolveOhlcvMarket('swap');

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
    rows.push({
      t: bar.t,
      nowMs: bar.t + TF_MS,
      barUsdt: computeBarUsdtNotional(bar),
    });
  }

  const sg = config.sessionGate;
  const timeline = simulateBurstTimeline(c5, rows, sg.volumeBurstMinutes);
  const gateOpenPct = timeline.filter((x) => x.tradeAllowed).length / (timeline.length || 1);
  const rawTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const fixedBase = config.tradeBudgetUsd;

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  if (hasFlag('recommended') || parseArg('mode') === 'recommended') {
    await runRecommendedHybridBacktest({
      c5,
      rawTrades,
      fromMs,
      toMs,
      days,
      marketCtx,
      gateOpenPct,
      fixedBase,
    });
    return;
  }

  if (hasFlag('tier12-hybrid') || parseArg('mode') === 'tier12-hybrid') {
    await runTier12HybridBacktest({
      c5,
      rawTrades,
      fromMs,
      toMs,
      days,
      marketCtx,
      gateOpenPct,
      fixedBase,
    });
    return;
  }

  if (hasFlag('tier12') || parseArg('mode', 'tier12') === 'tier12') {
    await runTier12Backtest({
      c5,
      rawTrades,
      fromMs,
      toMs,
      days,
      marketCtx,
      gateOpenPct,
      fixedBase,
    });
    return;
  }

  const baseline = simulateMartingaleBetting(rawTrades, c5, { fixedBase });
  baseline.label = `固定 $${fixedBase}`;
  baseline.mode = 'fixed';
  delete baseline.tradeDetails;

  const sweep = [];
  for (const baseMin of BASE_MIN_OPTS) {
    for (const baseMax of BASE_MAX_OPTS) {
      if (baseMax <= baseMin) continue;
      for (const direction of DIRECTION_OPTS) {
        const r = simulateMartingaleBetting(rawTrades, c5, { baseMin, baseMax, direction });
        delete r.tradeDetails;
        sweep.push({
          baseMin,
          baseMax,
          direction,
          directionLabel: direction === 'hot_higher' ? '热→大注' : '热→小注',
          label: `$${baseMin}-$${baseMax} ${direction === 'hot_higher' ? '热↑' : '热↓'}`,
          pnlDeltaVsFixed: r.pnl - baseline.pnl,
          maxDdDeltaVsFixed: r.maxDrawdown - baseline.maxDrawdown,
          ...r,
        });
      }
    }
  }

  sweep.sort((a, b) => b.pnl - a.pnl);

  const topDetail = sweep.slice(0, 5).map((row) => ({
    ...row,
    byActivity: summarizeByActivityBucket(
      simulateMartingaleBettingWithTrades(rawTrades, c5, {
        baseMin: row.baseMin,
        baseMax: row.baseMax,
        direction: row.direction,
      }),
      c5,
    ),
  }));

  const report = {
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
    sessionGate: {
      volumeBurstMinutes: sg.volumeBurstMinutes,
      dynamicThreshold: {
        enabled: sg.dynamicThresholdEnabled,
        minM: sg.barVolumeUsdtMinDynamic / 1e6,
        maxM: sg.barVolumeUsdtMaxDynamic / 1e6,
      },
      activityWindowBars: sg.activityWindowBars,
      activityProbeUsdtMin: sg.activityProbeUsdtMin,
    },
    martingale: {
      multiplier: MULTIPLIER,
      maxLosses: MARTINGALE_MAX,
      entryPrice: ENTRY_PRICE,
    },
    gateOpenPct,
    rawSignals: rawTrades.length,
    baseline,
    sweepCount: sweep.length,
    top5: topDetail,
    sweep,
    recommended: sweep[0] ?? null,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

  console.log(`\n=== 动态首注回测 · OKX ${marketCtx.label} · ${days}d ===`);
  console.log(`门控: 放量窗 ${sg.volumeBurstMinutes}min | 动态阈值 ${sg.barVolumeUsdtMinDynamic / 1e6}M–${sg.barVolumeUsdtMaxDynamic / 1e6}M`);
  console.log(`活跃度: 近${sg.activityWindowBars}根 ≥${(sg.activityProbeUsdtMin / 1e6).toFixed(0)}M 占比 → 映射首注`);
  console.log(`门控开启: ${(gateOpenPct * 100).toFixed(1)}% | 信号: ${rawTrades.length}笔`);
  console.log(`\n--- 基准（固定首注 $${fixedBase}）---`);
  console.log(
    `PnL $${baseline.pnl.toFixed(2)} | ROI ${(baseline.roi * 100).toFixed(2)}% | ` +
    `WR ${(baseline.winRate * 100).toFixed(1)}% | 止损 ${baseline.halts} | ` +
    `最大回撤 $${baseline.maxDrawdown.toFixed(2)} | 均注 $${baseline.avgStake.toFixed(2)}`,
  );

  console.log('\n--- Top 10 动态首注方案 ---');
  console.log('方案              | 方向   | 交易 | 胜率  | 止损 | PnL      | ROI%  | 回撤    | ΔPnL');
  for (const r of sweep.slice(0, 10)) {
    console.log(
      `$${r.baseMin}-$${r.baseMax}`.padEnd(17) + ' | ' +
      `${r.directionLabel.padEnd(6)} | ` +
      `${String(r.trades).padStart(4)} | ` +
      `${(r.winRate * 100).toFixed(1).padStart(4)}% | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(7)} | ` +
      `${(r.roi * 100).toFixed(2).padStart(5)}% | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(6)} | ` +
      `${r.pnlDeltaVsFixed >= 0 ? '+' : ''}${r.pnlDeltaVsFixed.toFixed(0)}`,
    );
  }

  const bestHotHigher = sweep.find((r) => r.direction === 'hot_higher');
  const bestHotLower = sweep.find((r) => r.direction === 'hot_lower');
  console.log('\n--- 方向对比（各方向最优）---');
  if (bestHotHigher) {
    console.log(
      `热→大注: $${bestHotHigher.baseMin}-$${bestHotHigher.baseMax} | ` +
      `PnL $${bestHotHigher.pnl.toFixed(2)} (Δ固定 ${bestHotHigher.pnlDeltaVsFixed >= 0 ? '+' : ''}${bestHotHigher.pnlDeltaVsFixed.toFixed(2)}) | ` +
      `回撤 $${bestHotHigher.maxDrawdown.toFixed(2)} | 止损 ${bestHotHigher.halts}`,
    );
  }
  if (bestHotLower) {
    console.log(
      `热→小注: $${bestHotLower.baseMin}-$${bestHotLower.baseMax} | ` +
      `PnL $${bestHotLower.pnl.toFixed(2)} (Δ固定 ${bestHotLower.pnlDeltaVsFixed >= 0 ? '+' : ''}${bestHotLower.pnlDeltaVsFixed.toFixed(2)}) | ` +
      `回撤 $${bestHotLower.maxDrawdown.toFixed(2)} | 止损 ${bestHotLower.halts}`,
    );
  }

  console.log(`\n完整结果: ${OUT_FILE}`);
}

function simulateMartingaleBettingWithTrades(trades, c5, opts) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = opts.baseMin;
  let skipNext = false;
  const out = [];

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      continue;
    }
    if (consecutiveLosses === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { freq } = computeActivityFreq(c5, idx);
      currentBet = resolveDynamicBaseBet(freq, opts.baseMin, opts.baseMax, opts.direction);
    }
    const stake = currentBet;
    const pnlUsd = t.won
      ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake)
      : -stake;
    out.push({ ...t, stake, pnlUsd });
    if (t.won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MARTINGALE_MAX) {
        consecutiveLosses = 0;
        skipNext = true;
      } else {
        currentBet *= MULTIPLIER;
      }
    }
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
