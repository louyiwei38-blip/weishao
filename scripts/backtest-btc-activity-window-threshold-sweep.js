/**
 * BTC 365d：扩展探测窗 × 12 档阈值扫参
 *
 * 基线: 12 根窗 + 标准映射
 * 方案: N 根窗，h≥阈值 → 12档；未达阈值仍按 12 根刻度映射 1–11 档
 *
 * Usage:
 *   node scripts/backtest-btc-activity-window-threshold-sweep.js --days=365
 *   node scripts/backtest-btc-activity-window-threshold-sweep.js --days=365 --windows=13,14
 *   node scripts/backtest-btc-activity-window-threshold-sweep.js --days=365 --fetch
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
const OUT_FILE = join(OUT_DIR, 'backtest-btc-activity-window-threshold-sweep.json');

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
const TIER_SCALE = 12;
const DEFAULT_WINDOWS = [13, 14];

function activityHitsToTierExtendedWindow(hits, tier12MinHits) {
  const h = Math.max(0, hits);
  if (h >= tier12MinHits) return TIER_COUNT;
  // 未达 12 档阈值时，映射输入封顶 11，避免 h=12 在阈值 13+ 时仍落 12 档
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

function hitsToTier(hits, { windowBars, tier12MinHits = null }) {
  if (tier12MinHits == null) {
    return activityHitsToTier(hits, windowBars);
  }
  return activityHitsToTierExtendedWindow(hits, tier12MinHits);
}

function buildScenarios(windows) {
  const scenarios = [{ windowBars: WINDOW_BASELINE, tier12MinHits: null }];
  for (const w of windows) {
    for (let t = TIER_SCALE; t <= w; t += 1) {
      scenarios.push({ windowBars: w, tier12MinHits: t });
    }
  }
  return scenarios;
}

function simulate(trades, c5, { windowBars, tier12MinHits = null, minActivityTier }) {
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

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      continue;
    }

    if (consecutiveLosses === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { hits, windowBars: w } = countProbeHits(c5, idx, PROBE_USDT, windowBars);
      const tier = hitsToTier(hits, { windowBars: w, tier12MinHits });
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
  };
}

function labelFor(windowBars, tier12MinHits) {
  if (tier12MinHits == null) return `基线 ${windowBars}根`;
  return `${windowBars}根≥${tier12MinHits}→12档`;
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

function scoreBalanced(m) {
  return m.pnl - m.maxDrawdown * 0.15 - m.halts * 8;
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const forceFetch = hasFlag('fetch');
  const windowsArg = parseArg('windows', DEFAULT_WINDOWS.join(','));
  const windows = windowsArg.split(',').map(Number).filter((n) => n > WINDOW_BASELINE);
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;

  console.log(`\n=== BTC 扩展探测窗 12档阈值扫参 · ${days}d · OKX 永续 5m ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
  console.log(`探测线: ${fmtM(PROBE_USDT)} | ${formatTierParamLabel(TIER_OPTS)} | MIN_ACTIVITY_TIER=${MIN_ACTIVITY_TIER}`);
  console.log(`扫参: 基线12根 + 窗 [${windows.join(', ')}] 各阈值 12..窗长\n`);

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

  const scenarios = buildScenarios(windows);

  const results = scenarios.map((s) => {
    const m = simulate(trades, c5, { ...s, minActivityTier: MIN_ACTIVITY_TIER });
    return { ...s, label: labelFor(s.windowBars, s.tier12MinHits), metrics: m };
  });

  const baseline = results[0].metrics;

  console.log('方案                  | 成交  | 胜率   | PnL     | ROI    | 回撤   | 停机 | 12档新开 | 均注   | ΔPnL   | ΔROI');
  console.log('-'.repeat(110));
  for (const r of results) {
    const m = r.metrics;
    const t12 = m.tierCounts[11];
    const dPnl = m.pnl - baseline.pnl;
    const dRoi = m.roi - baseline.roi;
    console.log(
      `${r.label.padEnd(20)} | ${String(m.trades).padStart(5)} | ${pct(m.winRate).padStart(6)} | `
      + `$${m.pnl.toFixed(0).padStart(6)} | ${pct(m.roi).padStart(6)} | `
      + `$${m.maxDrawdown.toFixed(0).padStart(5)} | ${String(m.halts).padStart(4)} | `
      + `${String(t12).padStart(7)} | $${m.avgStake.toFixed(1).padStart(5)} | `
      + `${(dPnl >= 0 ? '+' : '')}${dPnl.toFixed(0).padStart(5)} | ${(dRoi >= 0 ? '+' : '')}${pct(dRoi)}`,
    );
  }

  const ranked = [...results.slice(1)].sort((a, b) => scoreBalanced(b.metrics) - scoreBalanced(a.metrics));
  const bestBalanced = ranked[0];
  const bestRoi = [...results.slice(1)].sort((a, b) => b.metrics.roi - a.metrics.roi)[0];
  const bestPnl = [...results.slice(1)].sort((a, b) => b.metrics.pnl - a.metrics.pnl)[0];

  console.log('\n═══ 推荐 ═══');
  console.log(`综合( PnL-回撤-停机 ): ${bestBalanced.label} — PnL $${bestBalanced.metrics.pnl.toFixed(0)} ROI ${pct(bestBalanced.metrics.roi)} 回撤 $${bestBalanced.metrics.maxDrawdown.toFixed(0)}`);
  console.log(`最高 ROI: ${bestRoi.label} — ${pct(bestRoi.metrics.roi)}`);
  console.log(`最高 PnL: ${bestPnl.label} — $${bestPnl.metrics.pnl.toFixed(0)}`);

  const output = {
    days,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    params: { probeUsdt: PROBE_USDT, tierOpts: TIER_OPTS, minActivityTier: MIN_ACTIVITY_TIER, windows },
    barDist,
    rawSignals: trades.length,
    results: results.map((r) => ({
      label: r.label,
      windowBars: r.windowBars,
      tier12MinHits: r.tier12MinHits,
      metrics: r.metrics,
      deltaVsBaseline: {
        pnl: r.metrics.pnl - baseline.pnl,
        roi: r.metrics.roi - baseline.roi,
        trades: r.metrics.trades - baseline.trades,
        maxDrawdown: r.metrics.maxDrawdown - baseline.maxDrawdown,
      },
      scoreBalanced: scoreBalanced(r.metrics),
    })),
    recommendations: {
      balanced: bestBalanced.label,
      bestRoi: bestRoi.label,
      bestPnl: bestPnl.label,
    },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
