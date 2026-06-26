/**
 * BTC 365d：活跃度探测窗 12 根 vs 15 根 A/B 对比
 *
 * 基线（12 根）：近 12 根 5m K 线中，成交额 ≥ 探测线的根数 → 线性映射 1–12 档
 * 方案（15 根）：近 15 根统计命中数；≥12 根命中 → 12 档；0–11 根仍按 12 根刻度映射 1–11 档
 *
 * Usage:
 *   node scripts/backtest-btc-activity-window-compare.js --days=365
 *   node scripts/backtest-btc-activity-window-compare.js --days=365 --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import {
  buildAlwaysOnTrades,
  barUsdtDistribution,
  fmtM,
  pct,
} from './lib/btcAlwaysOnSim.js';
import {
  activityHitsToTier,
  resolveTierBaseBet,
  formatTierParamLabel,
  TIER_COUNT,
} from '../src/martingale/dynamicBaseBet.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-btc-activity-window-compare.json');

const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = 0.5;

const PROBE_USDT = config.sessionGate.activityProbeUsdtMin;
const TIER_OPTS = {
  tier1_9Usd: config.dynamicBaseBet.tier1_9Usd,
  tier10Usd: config.dynamicBaseBet.tier10Usd,
  tier11Usd: config.dynamicBaseBet.tier11Usd,
  tier12Usd: config.dynamicBaseBet.tier12Usd,
};
const MIN_ACTIVITY_TIER = config.dynamicBaseBet.minActivityTier;

const WINDOW_BASELINE = 12;
const WINDOW_NEW = 15;
const TIER_SCALE = 12;

/** 15 根窗：≥tier12MinHits 命中 → 12 档；0–11 命中仍按 12 根刻度映射 */
export function activityHitsToTier15Window(hits, tier12MinHits = TIER_SCALE) {
  const h = Math.max(0, hits);
  if (h >= tier12MinHits) return TIER_COUNT;
  const mapH = Math.min(h, Math.min(TIER_SCALE - 1, tier12MinHits - 1));
  return activityHitsToTier(mapH, TIER_SCALE);
}

function countProbeHits(c5, idx, probeUsdt, windowBars) {
  const w = Math.min(windowBars, idx + 1);
  const startIdx = idx - w + 1;
  let hits = 0;
  for (let i = startIdx; i <= idx; i += 1) {
    const usdt = computeBarUsdtNotional(c5[i]);
    if (usdt != null && usdt >= probeUsdt) hits += 1;
  }
  return { hits, windowBars: w };
}

function hitsToTier(hits, windowBars, mode) {
  if (mode === 'baseline') {
    return activityHitsToTier(hits, windowBars);
  }
  return activityHitsToTier15Window(hits);
}

function simulateMartingaleWindow(trades, c5, { windowBars, mode, minActivityTier }) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));

  let consecutiveLosses = 0;
  let currentBet = TIER_OPTS.tier1_9Usd;
  let skipNext = false;
  let halts = 0;
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  let tradesCount = 0;
  let wins = 0;
  let hotTierTrades = 0;
  let skippedCold = 0;
  const tierCounts = Array.from({ length: 12 }, () => 0);
  const hitsHist = Array.from({ length: windowBars + 1 }, () => 0);

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      continue;
    }

    if (consecutiveLosses === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { hits, windowBars: w } = countProbeHits(c5, idx, PROBE_USDT, windowBars);
      hitsHist[Math.min(hits, hitsHist.length - 1)] += 1;
      const tier = hitsToTier(hits, w, mode);
      if (tier < minActivityTier) {
        skippedCold += 1;
        continue;
      }
      currentBet = resolveTierBaseBet(tier, TIER_OPTS);
      tierCounts[tier - 1] += 1;
      if (tier >= 10) hotTierTrades += 1;
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
    hotTierPct: tradesCount ? hotTierTrades / tradesCount : 0,
    skippedCold,
    tierCounts,
    hitsHist,
  };
}

function analyzeTierShift(c5, trades, fromMs, toMs) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let upgraded = 0;
  let downgraded = 0;
  let same = 0;
  let baselineHot = 0;
  let newHot = 0;
  let baselineSkipped = 0;
  let newSkipped = 0;
  const shiftByTier = Array.from({ length: 12 }, () => ({ up: 0, down: 0, same: 0 }));

  for (const t of trades) {
    if (t.t < fromMs || t.t >= toMs) continue;
    const idx = idxByT.get(t.k1t) ?? 0;
    const base = countProbeHits(c5, idx, PROBE_USDT, WINDOW_BASELINE);
    const neu = countProbeHits(c5, idx, PROBE_USDT, WINDOW_NEW);
    const baseTier = hitsToTier(base.hits, base.windowBars, 'baseline');
    const newTier = hitsToTier(neu.hits, neu.windowBars, 'new');
    if (baseTier < MIN_ACTIVITY_TIER) baselineSkipped += 1;
    if (newTier < MIN_ACTIVITY_TIER) newSkipped += 1;
    if (baseTier >= MIN_ACTIVITY_TIER) baselineHot += 1;
    if (newTier >= MIN_ACTIVITY_TIER) newHot += 1;
    if (newTier > baseTier) upgraded += 1;
    else if (newTier < baseTier) downgraded += 1;
    else same += 1;
    const b = shiftByTier[baseTier - 1];
    if (newTier > baseTier) b.up += 1;
    else if (newTier < baseTier) b.down += 1;
    else b.same += 1;
  }

  return {
    upgraded,
    downgraded,
    same,
    baselineHot,
    newHot,
    baselineSkipped,
    newSkipped,
    shiftByTier,
  };
}

function tierHitsRangeLabel(tier, mode) {
  const maxH = mode === 'baseline' ? WINDOW_BASELINE : WINDOW_NEW;
  const ranges = [];
  for (let h = 0; h <= maxH; h += 1) {
    const t = mode === 'baseline'
      ? activityHitsToTier(h, WINDOW_BASELINE)
      : activityHitsToTier15Window(h);
    if (t === tier) ranges.push(h);
  }
  if (!ranges.length) return '—';
  if (ranges.length === 1) return `${ranges[0]}根`;
  return `${ranges[0]}-${ranges.at(-1)}根`;
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

function printMetrics(label, m) {
  console.log(
    `${label.padEnd(20)} | 成交 ${String(m.trades).padStart(5)} | 胜率 ${pct(m.winRate).padStart(6)} | `
    + `PnL $${m.pnl.toFixed(0).padStart(6)} | ROI ${pct(m.roi).padStart(7)} | `
    + `回撤 $${m.maxDrawdown.toFixed(0).padStart(5)} | 停机 ${m.halts} | 冷档跳过 ${m.skippedCold}`,
  );
  const t10 = m.tierCounts[9];
  const t11 = m.tierCounts[10];
  const t12 = m.tierCounts[11];
  console.log(
    `${''.padEnd(20)} | 新开档: 10=${t10} 11=${t11} 12=${t12} | 热档占比 ${pct(m.hotTierPct)} | 均注 $${m.avgStake.toFixed(2)}`,
  );
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const forceFetch = hasFlag('fetch');
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;

  console.log(`\n=== BTC 活跃度探测窗 A/B · ${days}d · OKX 永续 5m ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
  console.log(`探测线: ${fmtM(PROBE_USDT)} | 首注: ${formatTierParamLabel(TIER_OPTS)} | MIN_ACTIVITY_TIER=${MIN_ACTIVITY_TIER}`);
  console.log('\n--- 逻辑 ---');
  console.log(`基线: 近 ${WINDOW_BASELINE} 根，命中数 h → tier = round(h/${WINDOW_BASELINE}×11)+1`);
  console.log(`方案: 近 ${WINDOW_NEW} 根统计命中；h≥${TIER_SCALE} → 12档；h=0–11 → 仍按 ${TIER_SCALE} 根刻度映射 1–11档`);

  console.log('\n--- 档位命中区间 ---');
  console.log('档 | 基线(12根窗) | 方案(15根窗)');
  for (let tier = 1; tier <= 12; tier += 1) {
    console.log(
      `${String(tier).padStart(2)} | ${tierHitsRangeLabel(tier, 'baseline').padStart(10)} | ${tierHitsRangeLabel(tier, 'new').padStart(10)}`,
    );
  }

  const marketCtx = resolveOhlcvMarket('swap', 'BTC/USDT');
  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch,
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const trades = buildAlwaysOnTrades(c5, fromMs, toMs);
  const barDist = barUsdtDistribution(
    c5.filter((b) => b.t >= fromMs && b.t < toMs).map((b) => ({ barUsdt: computeBarUsdtNotional(b) })),
  );

  const baseline = simulateMartingaleWindow(trades, c5, {
    windowBars: WINDOW_BASELINE,
    mode: 'baseline',
    minActivityTier: MIN_ACTIVITY_TIER,
  });

  const proposed = simulateMartingaleWindow(trades, c5, {
    windowBars: WINDOW_NEW,
    mode: 'new',
    minActivityTier: MIN_ACTIVITY_TIER,
  });

  const tierShift = analyzeTierShift(c5, trades, fromMs, toMs);

  console.log(`\n5m 成交额: p50=${fmtM(barDist?.p50)} p90=${fmtM(barDist?.p90)} p95=${fmtM(barDist?.p95)}`);
  console.log(`原始信号: ${trades.length} 条\n`);

  console.log('--- 回测结果 ---');
  printMetrics(`基线 ${WINDOW_BASELINE}根`, baseline);
  printMetrics(`方案 ${WINDOW_NEW}根`, proposed);

  console.log('\n--- 信号级档位变化（每根 K 线，非实际成交）---');
  console.log(`可开新单(≥${MIN_ACTIVITY_TIER}档): ${tierShift.baselineHot} → ${tierShift.newHot} (${tierShift.newHot - tierShift.baselineHot >= 0 ? '+' : ''}${tierShift.newHot - tierShift.baselineHot})`);
  console.log(`冷档跳过: ${tierShift.baselineSkipped} → ${tierShift.newSkipped}`);
  console.log(`升档 ${tierShift.upgraded} · 降档 ${tierShift.downgraded} · 不变 ${tierShift.same}`);

  const deltaPnl = proposed.pnl - baseline.pnl;
  const deltaRoi = proposed.roi - baseline.roi;
  const deltaTrades = proposed.trades - baseline.trades;
  console.log('\n═══ 结论 ═══');
  console.log(`成交差: ${deltaTrades >= 0 ? '+' : ''}${deltaTrades} | PnL 差: ${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)} | ROI 差: ${deltaRoi >= 0 ? '+' : ''}${pct(deltaRoi)}`);
  if (proposed.pnl > baseline.pnl && proposed.roi >= baseline.roi * 0.95) {
    console.log('15 根窗在 PnL/ROI 上优于或接近 12 根窗，可考虑 ACTIVITY_WINDOW_BARS=15 + 新档映射');
  } else if (proposed.pnl > baseline.pnl) {
    console.log('15 根窗 PnL 更高但 ROI 偏低，需权衡成交增量 vs 回撤');
  } else {
    console.log('12 根窗仍更优，建议保持现状');
  }

  const output = {
    days,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    params: { probeUsdt: PROBE_USDT, tierOpts: TIER_OPTS, minActivityTier: MIN_ACTIVITY_TIER },
    logic: {
      baseline: { windowBars: WINDOW_BASELINE, tierMapping: 'activityHitsToTier(h, 12)' },
      proposed: {
        windowBars: WINDOW_NEW,
        tierMapping: 'h>=12→12档; else activityHitsToTier(h, 12)',
      },
    },
    tierHitsRanges: Array.from({ length: 12 }, (_, i) => ({
      tier: i + 1,
      baseline: tierHitsRangeLabel(i + 1, 'baseline'),
      proposed: tierHitsRangeLabel(i + 1, 'new'),
    })),
    barDist,
    tierShift,
    rawSignals: trades.length,
    baseline,
    proposed,
    delta: { pnl: deltaPnl, roi: deltaRoi, trades: deltaTrades },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
