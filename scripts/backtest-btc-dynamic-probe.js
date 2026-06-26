/**
 * BTC 365d：固定探测线 28.5M vs 动态探测线 22M–28.5M（门控常开 + MIN_ACTIVITY_TIER）
 *
 * Usage:
 *   node scripts/backtest-btc-dynamic-probe.js --days=365
 *   node scripts/backtest-btc-dynamic-probe.js --days=365 --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import {
  buildAlwaysOnTrades,
  simulateMartingale,
  barUsdtDistribution,
  fmtM,
  pct,
} from './lib/btcAlwaysOnSim.js';
import { activityHitsToTier, formatTierParamLabel } from '../src/martingale/dynamicBaseBet.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { computeActivityFreq, resolveProbeLineUsdt } from '../src/session/sessionGate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-btc-dynamic-probe.json');

const FIXED_PROBE = 28_500_000;
const DYNAMIC_PROBE_OPTS = {
  dynamicProbeEnabled: true,
  activityProbeUsdtMinDynamic: 22_000_000,
  activityProbeUsdtMaxDynamic: 28_500_000,
  activityWindowBars: 12,
};
const FIXED_PROBE_OPTS = {
  dynamicProbeEnabled: false,
  activityProbeUsdtMin: FIXED_PROBE,
};

const TIER_OPTS = {
  tier1_9Usd: config.dynamicBaseBet.tier1_9Usd,
  tier10Usd: config.dynamicBaseBet.tier10Usd,
  tier11Usd: config.dynamicBaseBet.tier11Usd,
  tier12Usd: config.dynamicBaseBet.tier12Usd,
};
const MIN_ACTIVITY_TIER = config.dynamicBaseBet.minActivityTier;

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

function printMetrics(label, m, extra = {}) {
  console.log(
    `${label.padEnd(22)} | 成交 ${String(m.trades).padStart(5)} | 胜率 ${pct(m.winRate).padStart(6)} | `
    + `PnL $${m.pnl.toFixed(0).padStart(6)} | ROI ${pct(m.roi).padStart(7)} | `
    + `回撤 $${m.maxDrawdown.toFixed(0).padStart(5)} | 停机 ${m.halts} | 冷档跳过 ${m.skippedCold}`,
  );
  if (extra.avgProbeUsdt != null) {
    console.log(`${''.padEnd(22)} | 均探测线 ${fmtM(extra.avgProbeUsdt)} | 10-12档占比 ${pct(m.hotTierPct)}`);
  }
  if (m.tierCounts) {
    const hot = m.tierCounts.slice(9).reduce((a, b) => a + b, 0);
    const t10 = m.tierCounts[9];
    const t11 = m.tierCounts[10];
    const t12 = m.tierCounts[11];
    console.log(`${''.padEnd(22)} | 档位新开: 10=${t10} 11=${t11} 12=${t12} (热档合计 ${hot})`);
  }
}

function analyzeProbeDistribution(c5, fromMs, toMs) {
  const probes = [];
  for (let i = 0; i < c5.length; i += 1) {
    const bar = c5[i];
    if (bar.t < fromMs || bar.t >= toMs) continue;
    const { probeLineUsdt } = resolveProbeLineUsdt(c5, i, DYNAMIC_PROBE_OPTS);
    probes.push(probeLineUsdt);
  }
  probes.sort((a, b) => a - b);
  if (!probes.length) return null;
  const at = (p) => probes[Math.floor(p * (probes.length - 1))];
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9), min: probes[0], max: probes.at(-1) };
}

function analyzeTierShift(c5, trades, fromMs, toMs) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let fixedHot = 0;
  let dynamicHot = 0;
  let fixedSkipped = 0;
  let dynamicSkipped = 0;
  let upgraded = 0;
  let downgraded = 0;
  let total = 0;

  for (const t of trades) {
    if (t.t < fromMs || t.t >= toMs) continue;
    const idx = idxByT.get(t.k1t) ?? 0;
    const fixed = computeActivityFreq(c5, idx, FIXED_PROBE_OPTS);
    const dyn = computeActivityFreq(c5, idx, DYNAMIC_PROBE_OPTS);
    const fixedTier = activityHitsToTier(fixed.hits, fixed.windowBars);
    const dynTier = activityHitsToTier(dyn.hits, dyn.windowBars);
    total += 1;
    if (fixedTier < MIN_ACTIVITY_TIER) fixedSkipped += 1;
    if (dynTier < MIN_ACTIVITY_TIER) dynamicSkipped += 1;
    if (fixedTier >= MIN_ACTIVITY_TIER) fixedHot += 1;
    if (dynTier >= MIN_ACTIVITY_TIER) dynamicHot += 1;
    if (dynTier > fixedTier) upgraded += 1;
    if (dynTier < fixedTier) downgraded += 1;
  }

  return {
    total,
    fixedHot,
    dynamicHot,
    fixedSkipped,
    dynamicSkipped,
    upgraded,
    downgraded,
    netHotGain: dynamicHot - fixedHot,
  };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const forceFetch = hasFlag('fetch');
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;

  console.log(`\n=== BTC 动态探测线 A/B · ${days}d · OKX 永续 5m ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
  console.log(`固定: probe=${fmtM(FIXED_PROBE)} | 动态: ${fmtM(DYNAMIC_PROBE_OPTS.activityProbeUsdtMinDynamic)}–${fmtM(DYNAMIC_PROBE_OPTS.activityProbeUsdtMaxDynamic)} (近12根过探测线占比→探测线)`);
  console.log(`首注: ${formatTierParamLabel(TIER_OPTS)} | MIN_ACTIVITY_TIER=${MIN_ACTIVITY_TIER}`);

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

  const fixedMetrics = simulateMartingale(trades, c5, {
    tierOpts: TIER_OPTS,
    probeUsdt: FIXED_PROBE,
    minActivityTier: MIN_ACTIVITY_TIER,
  });

  const dynamicMetrics = simulateMartingale(trades, c5, {
    tierOpts: TIER_OPTS,
    probeOverrides: DYNAMIC_PROBE_OPTS,
    minActivityTier: MIN_ACTIVITY_TIER,
  });

  const probeDist = analyzeProbeDistribution(c5, fromMs, toMs);
  const tierShift = analyzeTierShift(c5, trades, fromMs, toMs);

  console.log(`\n5m 成交额分布: p50=${fmtM(barDist?.p50)} p90=${fmtM(barDist?.p90)} p95=${fmtM(barDist?.p95)}`);
  console.log(`原始信号: ${trades.length} 条\n`);

  console.log('--- 回测结果 ---');
  printMetrics('固定 28.5M', fixedMetrics);
  printMetrics('动态 22–28.5M', dynamicMetrics, { avgProbeUsdt: dynamicMetrics.avgProbeUsdt });

  if (probeDist) {
    console.log(`\n动态探测线分布: min=${fmtM(probeDist.min)} p10=${fmtM(probeDist.p10)} p50=${fmtM(probeDist.p50)} p90=${fmtM(probeDist.p90)} max=${fmtM(probeDist.max)}`);
  }

  if (tierShift) {
    console.log('\n--- 档位对比（每根信号 K 线，非实际成交）---');
    console.log(`可开新单(≥${MIN_ACTIVITY_TIER}档): 固定 ${tierShift.fixedHot} → 动态 ${tierShift.dynamicHot} (${tierShift.netHotGain >= 0 ? '+' : ''}${tierShift.netHotGain})`);
    console.log(`冷档跳过: 固定 ${tierShift.fixedSkipped} → 动态 ${tierShift.dynamicSkipped}`);
    console.log(`档位变化: 升档 ${tierShift.upgraded} · 降档 ${tierShift.downgraded}`);
  }

  const deltaPnl = dynamicMetrics.pnl - fixedMetrics.pnl;
  const deltaRoi = dynamicMetrics.roi - fixedMetrics.roi;
  console.log('\n═══ 结论 ═══');
  console.log(`PnL 差: ${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)} | ROI 差: ${deltaRoi >= 0 ? '+' : ''}${pct(deltaRoi)}`);
  if (dynamicMetrics.pnl > fixedMetrics.pnl && dynamicMetrics.roi >= fixedMetrics.roi * 0.95) {
    console.log('动态探测线在 PnL/ROI 上优于或接近固定线，可考虑启用 DYNAMIC_PROBE_ENABLED=true');
  } else if (dynamicMetrics.pnl > fixedMetrics.pnl) {
    console.log('动态探测线 PnL 更高但 ROI 偏低，需权衡成交增量 vs 回撤');
  } else {
    console.log('固定 28.5M 仍更优，建议保持 DYNAMIC_PROBE_ENABLED=false');
  }

  const output = {
    days,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    params: {
      fixedProbe: FIXED_PROBE,
      dynamicProbe: DYNAMIC_PROBE_OPTS,
      tierOpts: TIER_OPTS,
      minActivityTier: MIN_ACTIVITY_TIER,
    },
    barDist,
    probeDist,
    tierShift,
    rawSignals: trades.length,
    fixed: fixedMetrics,
    dynamic: dynamicMetrics,
    delta: { pnl: deltaPnl, roi: deltaRoi },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
