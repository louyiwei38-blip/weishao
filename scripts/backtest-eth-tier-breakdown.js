/**
 * ETH 推荐方案 A · 12 档动态首注分档回测对比。
 *
 * Usage: node scripts/backtest-eth-tier-breakdown.js --days=365
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
const OUT_FILE = join(OUT_DIR, 'backtest-eth-tier-breakdown.json');

const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = 4;
const MULTIPLIER = 2;
const ENTRY_PRICE = 0.5;
const ACTIVITY_WINDOW = 12;

/** ETH 推荐方案 A */
const ETH_GATE = {
  activityProbeUsdtMin: 60_000_000,
  barVolumeUsdtMinDynamic: 86_000_000,
  barVolumeUsdtMaxDynamic: 110_000_000,
  volumeBurstMinutes: 21,
};

const TIER_OPTS = {
  tier1_9Usd: 1,
  tier10Usd: 6,
  tier11Usd: 8,
  tier12Usd: 24,
};

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function tierHitsRange(tier) {
  const ranges = [];
  for (let h = 0; h <= 12; h += 1) {
    if (activityHitsToTier(h, 12) === tier) ranges.push(h);
  }
  if (!ranges.length) return '—';
  if (ranges.length === 1) return `${ranges[0]}根`;
  return `${ranges[0]}-${ranges.at(-1)}根`;
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

function resolveDynamicThreshold(freq, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(hi - Math.min(1, Math.max(0, freq)) * (hi - lo));
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
    timeline.push({
      t: row.t,
      tradeAllowed: volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs,
    });
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
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');
    raw.push({ t: tradeTs, k1t: k1.t, won });
  }
  return raw;
}

function simulateWithDetails(trades, c5, { tierOpts, gate }) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = tierOpts.tier1_9Usd;
  let skipNext = false;
  let halts = 0;
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  let streakTier = null;
  const details = [];

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      streakTier = null;
      continue;
    }

    if (consecutiveLosses === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { hits, windowBars } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
      streakTier = activityHitsToTier(hits, windowBars);
      currentBet = resolveTierBaseBet(streakTier, tierOpts);
    }

    const stake = currentBet;
    const pnlUsd = t.won
      ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake)
      : -stake;

    cumPnl += pnlUsd;
    peakPnl = Math.max(peakPnl, cumPnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumPnl);
    totalStake += stake;

    details.push({
      ...t,
      stake,
      pnlUsd,
      activityTier: streakTier,
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

  const wins = details.filter((x) => x.won).length;
  return {
    trades: details.length,
    wins,
    winRate: details.length ? wins / details.length : 0,
    halts,
    pnl: cumPnl,
    maxDrawdown,
    roi: totalStake > 0 ? cumPnl / totalStake : 0,
    tradeDetails: details,
  };
}

function summarizeByTier(tradeDetails, tierOpts) {
  const tiers = Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    hitsRange: tierHitsRange(i + 1),
    baseBet: resolveTierBaseBet(i + 1, tierOpts),
    trades: 0,
    wins: 0,
    pnl: 0,
    totalStake: 0,
    halts: 0,
  }));

  for (const t of tradeDetails) {
    if (t.activityTier == null) continue;
    const b = tiers[t.activityTier - 1];
    b.trades += 1;
    if (t.won) b.wins += 1;
    b.pnl += t.pnlUsd;
    b.totalStake += t.stake;
  }

  // 统计各档触发的马丁止损（ streak reset at tier entry）
  let streak = 0;
  let lastTier = null;
  for (const t of tradeDetails) {
    if (t.activityTier != null && t.activityTier !== lastTier) streak = 0;
    if (t.activityTier != null) lastTier = t.activityTier;
    if (!t.won) {
      streak += 1;
      if (streak >= MARTINGALE_MAX && lastTier != null) tiers[lastTier - 1].halts += 1;
    } else streak = 0;
  }

  return tiers.map((b) => ({
    ...b,
    baseBet: Number(b.baseBet.toFixed(2)),
    winRate: b.trades ? b.wins / b.trades : 0,
    roi: b.totalStake > 0 ? b.pnl / b.totalStake : 0,
    pnlPerTrade: b.trades ? b.pnl / b.trades : 0,
    sharePct: 0,
  }));
}

/** 固定首注 edge：每档均用 $3，不含马丁缩放 */
function tierEdgeFixedStake(trades, c5, gate, fixedStake = 3) {
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
    const { hits, windowBars } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
    const tier = activityHitsToTier(hits, windowBars);
    const b = tiers[tier - 1];
    b.trades += 1;
    if (t.won) b.wins += 1;
    b.pnl += t.won ? (calcWinNetProfit(fixedStake, ENTRY_PRICE) ?? fixedStake) : -fixedStake;
  }

  return tiers.map((b) => ({
    ...b,
    winRate: b.trades ? b.wins / b.trades : 0,
    pnlPerTrade: b.trades ? b.pnl / b.trades : 0,
  }));
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;

  const marketCtx = resolveOhlcvMarket('swap', 'ETH/USDT');
  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const rows = c5.filter((b) => b.t >= fromMs && b.t < toMs)
    .map((b) => ({ t: b.t, nowMs: b.t + TF_MS, barUsdt: computeBarUsdtNotional(b) }));

  const timeline = simulateBurstTimeline(c5, rows, ETH_GATE);
  const gatedTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const gateOpenPct = timeline.filter((x) => x.tradeAllowed).length / (timeline.length || 1);

  const run = simulateWithDetails(gatedTrades, c5, { tierOpts: TIER_OPTS, gate: ETH_GATE });
  const byTier = summarizeByTier(run.tradeDetails, TIER_OPTS);
  const totalTrades = byTier.reduce((s, b) => s + b.trades, 0);
  for (const b of byTier) b.sharePct = totalTrades ? b.trades / totalTrades : 0;

  const edgeFixed = tierEdgeFixedStake(gatedTrades, c5, ETH_GATE);

  const merged = byTier.map((b, i) => ({
    ...b,
    edgeFixed3: edgeFixed[i],
  }));

  const output = {
    days,
    gate: ETH_GATE,
    tierOpts: TIER_OPTS,
    gateOpenPct,
    total: {
      trades: run.trades,
      winRate: run.winRate,
      halts: run.halts,
      pnl: run.pnl,
      maxDrawdown: run.maxDrawdown,
      roi: run.roi,
    },
    tiers: merged,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n=== ETH 推荐方案 A · 12档首注分档 · ${days}d ===`);
  console.log('门控: probe=60M min=86M max=110M burst=21min');
  console.log('首注: 1-9=$1 | 10=$6 | 11=$8 | 12=$24');
  console.log(`门控开启: ${pct(gateOpenPct)} | 总交易: ${run.trades} | 总PnL: $${run.pnl.toFixed(0)} | 回撤: $${run.maxDrawdown.toFixed(0)}`);

  console.log('\n--- 12档动态首注分档（含马丁）---');
  console.log('档位 | 命中   | 首注 | 占比  | 交易 | 胜率  | 止损 | 分段PnL | ROI   | 均笔');
  for (const b of merged) {
    console.log(
      `${String(b.tier).padStart(4)} | ${b.hitsRange.padStart(6)} | ` +
      `$${String(b.baseBet).padStart(3)} | ${pct(b.sharePct).padStart(5)} | ` +
      `${String(b.trades).padStart(4)} | ${pct(b.winRate).padStart(5)} | ` +
      `${String(b.halts).padStart(4)} | ` +
      `${b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(0).padStart(7)} | ${pct(b.roi).padStart(5)} | ` +
      `${b.pnlPerTrade >= 0 ? '+' : ''}${b.pnlPerTrade.toFixed(2)}`,
    );
  }

  console.log('\n--- 各档固定$3 edge（无马丁，纯胜率参考）---');
  console.log('档位 | 命中   | 交易 | 胜率  | 固定$3 PnL | 均笔');
  for (const b of merged) {
    const e = b.edgeFixed3;
    console.log(
      `${String(b.tier).padStart(4)} | ${b.hitsRange.padStart(6)} | ` +
      `${String(e.trades).padStart(4)} | ${pct(e.winRate).padStart(5)} | ` +
      `${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(0).padStart(9)} | ${e.pnlPerTrade >= 0 ? '+' : ''}${e.pnlPerTrade.toFixed(2)}`,
    );
  }

  const hot = merged.filter((b) => b.tier >= 10);
  const cold = merged.filter((b) => b.tier <= 9);
  const sum = (arr, k) => arr.reduce((s, b) => s + b[k], 0);
  console.log('\n--- 分桶汇总 ---');
  console.log(`1-9档 ($1): ${sum(cold, 'trades')}笔 PnL ${sum(cold, 'pnl') >= 0 ? '+' : ''}${sum(cold, 'pnl').toFixed(0)}`);
  console.log(`10档 ($6):  ${merged[9].trades}笔 PnL ${merged[9].pnl >= 0 ? '+' : ''}${merged[9].pnl.toFixed(0)}`);
  console.log(`11档 ($8):  ${merged[10].trades}笔 PnL ${merged[10].pnl >= 0 ? '+' : ''}${merged[10].pnl.toFixed(0)}`);
  console.log(`12档 ($24): ${merged[11].trades}笔 PnL ${merged[11].pnl >= 0 ? '+' : ''}${merged[11].pnl.toFixed(0)}`);
  console.log(`10-12档合计: ${sum(hot, 'trades')}笔 PnL ${sum(hot, 'pnl') >= 0 ? '+' : ''}${sum(hot, 'pnl').toFixed(0)}`);

  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
