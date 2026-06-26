/**
 * ETH 门控常开 · 多方法探测线寻优（MIN_ACTIVITY_TIER=10 仅热档开新单）
 *
 * Usage:
 *   node scripts/backtest-eth-always-on-optimize.js --days=365
 *   node scripts/backtest-eth-always-on-optimize.js --days=365 --symbol=SOL/USDT --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { formatTierParamLabel } from '../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import {
  barUsdtDistribution,
  buildAlwaysOnTrades,
  buildCandidates,
  buildFineProbeGrid,
  evaluateState,
  formatState,
  envLines,
  fmtM,
  pct,
  roundM,
  simulateMartingale,
  stateKey,
  stateToTierOpts,
} from './lib/btcAlwaysOnSim.js';
import {
  dedupeResults,
  geneticAlgorithm,
  latinHypercubeRefine,
  multiStartCoordinateDescent,
  randomSearch,
  simulatedAnnealing,
} from './lib/btcAlwaysOnOptimizers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');

/** 生产对齐：仅 10–12 档开新单 */
const MIN_ACTIVITY_TIER = 10;

/** 默认四档（与 BTC ROI 最优一致，便于对比） */
const DEFAULT_TIERS = { tier1_9: 1, tier10: 6, tier11: 6, tier12: 32 };

function assetSlug(symbol) {
  return symbol.split('/')[0].toLowerCase();
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

function printResult(label, r) {
  if (!r?.metrics) {
    console.log(`${label}: 无有效结果`);
    return;
  }
  const m = r.metrics;
  const s = r.params;
  console.log(
    `${label.padEnd(22)} | probe=${String(s.probeM).padStart(6)}M | ` +
    `1-9=$${s.tier1_9} 10=$${s.tier10} 11=$${s.tier11} 12=$${s.tier12} | ` +
    `成交 ${String(m.trades).padStart(5)} 跳过冷 ${String(m.skippedCold ?? 0).padStart(5)} | ` +
    `PnL $${m.pnl.toFixed(0).padStart(6)} ROI ${pct(m.roi).padStart(7)} ` +
    `回撤 $${m.maxDrawdown.toFixed(0).padStart(5)}`,
  );
}

function btcProbeState() {
  return { probeM: roundM(28_500_000), ...DEFAULT_TIERS };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const tradingSymbol = parseArg('symbol', 'ETH/USDT');
  const asset = assetSlug(tradingSymbol);
  const outFile = join(OUT_DIR, `backtest-${asset}-always-on-optimize.json`);
  const toMs = parseArg('to') ? Date.parse(parseArg('to')) : Date.now();
  const fromMs = parseArg('from') ? Date.parse(parseArg('from')) : toMs - days * 24 * 60 * 60_000;
  const marketCtx = resolveOhlcvMarket('swap', tradingSymbol);

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
  const cand = buildCandidates(barDist);
  const btcRef = btcProbeState();

  const evalPnl = (s) => evaluateState(s, trades, c5, 'pnl', MIN_ACTIVITY_TIER);
  const evalRoi = (s) => evaluateState(s, trades, c5, 'roi', MIN_ACTIVITY_TIER);
  const evalBalanced = (s) => evaluateState(s, trades, c5, 'balanced', MIN_ACTIVITY_TIER);

  const baseline = simulateMartingale(trades, c5, {
    fixedBase: config.tradeBudgetUsd,
    minActivityTier: MIN_ACTIVITY_TIER,
  });
  const btcRefMetrics = evalBalanced(btcRef);

  console.log(`\n=== ${asset.toUpperCase()} 门控常开 · 探测线多方法寻优 · ${days}d · ${marketCtx.label} ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)} | 原始信号 ${trades.length} | minTier=${MIN_ACTIVITY_TIER}`);
  if (barDist) {
    console.log(`5m 成交额: p50=${fmtM(barDist.p50)} p75=${fmtM(barDist.p75)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)}`);
  }
  console.log(`\n基准 固定 $${config.tradeBudgetUsd}: 成交 ${baseline.trades} PnL $${baseline.pnl.toFixed(0)} ROI ${pct(baseline.roi)}`);
  console.log(`BTC探测线 28.5M + 1/6/6/32: 成交 ${btcRefMetrics?.trades ?? 0} PnL $${btcRefMetrics?.pnl?.toFixed(0) ?? '—'} ROI ${btcRefMetrics ? pct(btcRefMetrics.roi) : '—'}`);

  // ── ROI 曲线：固定四档 1/6/6/32，细扫 probe ──
  console.log('\n═══ ROI 峰值分析（固定四档 1/6/6/32，细扫 probe）═══');
  const defaultTiers = stateToTierOpts({ ...DEFAULT_TIERS });
  const fineProbe = buildFineProbeGrid(barDist, 2);
  const roiCurve = fineProbe.map((probeM) => {
    const m = simulateMartingale(trades, c5, {
      tierOpts: defaultTiers,
      probeUsdt: probeM * 1e6,
      minActivityTier: MIN_ACTIVITY_TIER,
    });
    return { probeM, ...m };
  }).filter((x) => x.trades >= 50);

  roiCurve.sort((a, b) => b.roi - a.roi);
  const roiPeak = roiCurve[0];
  const pnlPeak = [...roiCurve].sort((a, b) => b.pnl - a.pnl)[0];
  const roiPeakPositive = roiCurve.filter((x) => x.pnl > 0).sort((a, b) => b.roi - a.roi)[0];

  console.log(`细扫 ${fineProbe.length} 个 probe 点 (步长 2M, ${roundM(barDist.p50 * 0.4)}M–${roundM(barDist.p95 * 1.05)}M)`);
  if (roiPeak) {
    console.log(`【ROI 最高】probe=${roiPeak.probeM}M → ROI ${pct(roiPeak.roi)} PnL $${roiPeak.pnl.toFixed(0)} 成交 ${roiPeak.trades} 均注 $${roiPeak.avgStake.toFixed(2)}`);
  }
  if (roiPeakPositive && roiPeakPositive.probeM !== roiPeak?.probeM) {
    console.log(`【ROI 最高且 PnL>0】probe=${roiPeakPositive.probeM}M → ROI ${pct(roiPeakPositive.roi)} PnL $${roiPeakPositive.pnl.toFixed(0)}`);
  }
  if (pnlPeak) {
    console.log(`【PnL 最高】probe=${pnlPeak.probeM}M → PnL $${pnlPeak.pnl.toFixed(0)} ROI ${pct(pnlPeak.roi)} 成交 ${pnlPeak.trades}`);
  }
  if (btcRefMetrics) {
    console.log(`【BTC方案 28.5M】PnL $${btcRefMetrics.pnl.toFixed(0)} ROI ${pct(btcRefMetrics.roi)} 成交 ${btcRefMetrics.trades}`);
  }

  console.log('\nprobe(M) | 成交  | 跳过冷 | ROI%   | PnL    | 均注  | 回撤');
  const curveShow = [...fineProbe]
    .map((probeM) => roiCurve.find((x) => x.probeM === probeM))
    .filter(Boolean)
    .sort((a, b) => a.probeM - b.probeM);
  for (const r of curveShow.filter((x, i) => i % 4 === 0
    || x.probeM === btcRef.probeM
    || x.probeM === roiPeak?.probeM
    || x.probeM === pnlPeak?.probeM)) {
    const mark = r.probeM === roiPeak?.probeM ? ' ◀ ROI峰'
      : r.probeM === pnlPeak?.probeM ? ' ◀ PnL峰'
        : r.probeM === btcRef.probeM ? ' ◀ BTC28.5M' : '';
    console.log(
      `${String(r.probeM).padStart(7)} | ${String(r.trades).padStart(5)} | ${String(r.skippedCold).padStart(6)} | ` +
      `${pct(r.roi).padStart(6)} | $${r.pnl.toFixed(0).padStart(5)} | $${r.avgStake.toFixed(2).padStart(4)} | ` +
      `$${r.maxDrawdown.toFixed(0)}${mark}`,
    );
  }

  // ── 多方法寻优 ──
  console.log('\n═══ 多方法寻优（6 种 · minTier=10）═══');
  const seeds = [
    { probeM: roiPeak?.probeM ?? roundM(barDist.p75), ...DEFAULT_TIERS },
    { probeM: pnlPeak?.probeM ?? roundM(barDist.p90 * 0.7), ...DEFAULT_TIERS },
    btcRef,
    { probeM: roundM(barDist.p50), tier1_9: 1, tier10: 6, tier11: 8, tier12: 24 },
    { probeM: roundM(barDist.p90), tier1_9: 1, tier10: 8, tier11: 12, tier12: 24 },
    { probeM: roundM(barDist.p75), tier1_9: 1, tier10: 6, tier11: 8, tier12: 32 },
  ].filter((s) => s.probeM > 0);

  const methods = [];

  console.log('\n[1] 坐标下降 (PnL)...');
  methods.push({ method: 'coordinate_pnl', objective: 'pnl', ...multiStartCoordinateDescent(seeds, cand, evalPnl, { rounds: 3, scoreField: 'score' }) });

  console.log('[2] 坐标下降 (ROI)...');
  methods.push({ method: 'coordinate_roi', objective: 'roi', ...multiStartCoordinateDescent(seeds, cand, evalRoi, { rounds: 3, scoreField: 'score' }) });

  console.log('[3] 随机搜索 ×600 (balanced)...');
  methods.push({ method: 'random_balanced', objective: 'balanced', ...randomSearch(cand, evalBalanced, { n: 600, seed: 42, scoreField: 'score' }) });

  console.log('[4] 遗传算法 (PnL)...');
  methods.push({ method: 'genetic_pnl', objective: 'pnl', ...geneticAlgorithm(cand, evalPnl, { popSize: 36, generations: 22, seed: 7, scoreField: 'score' }) });

  console.log('[5] 拉丁超立方 (ROI)...');
  methods.push({ method: 'lhs_roi', objective: 'roi', ...latinHypercubeRefine(cand, evalRoi, { samples: 140, refineTop: 8, seed: 13, scoreField: 'score' }) });

  console.log('[6] 模拟退火 (balanced)...');
  methods.push({ method: 'anneal_balanced', objective: 'balanced', ...simulatedAnnealing(seeds[0], cand, evalBalanced, { steps: 450, seed: 99, scoreField: 'score' }) });

  const unique = dedupeResults(methods);
  const byPnl = [...unique].sort((a, b) => b.metrics.pnl - a.metrics.pnl);
  const byRoi = [...unique].sort((a, b) => b.metrics.roi - a.metrics.roi);
  const byBalanced = [...unique].sort((a, b) => b.metrics.score - a.metrics.score);

  console.log('\n--- 各方法 Top（按 PnL）---');
  for (const r of byPnl.slice(0, 8)) printResult(r.method, r);

  console.log('\n--- ROI Top 5 ---');
  for (const r of byRoi.slice(0, 5)) printResult(r.method, r);

  const bestPnl = byPnl[0];
  const bestRoi = byRoi[0];
  const bestBal = byBalanced[0];

  console.log('\n═══ 结论 ═══');
  console.log(`1. ${asset.toUpperCase()} 5m 成交额 p50≈${fmtM(barDist.p50)} p95≈${fmtM(barDist.p95)}，探测线需按流动性单独标定`);
  if (roiPeak) console.log(`2. 固定四档下 ROI 峰值 probe≈${roiPeak.probeM}M（ROI ${pct(roiPeak.roi)}，PnL $${roiPeak.pnl.toFixed(0)}）`);
  if (pnlPeak) console.log(`3. PnL 峰值 probe≈${pnlPeak.probeM}M（PnL $${pnlPeak.pnl.toFixed(0)}，ROI ${pct(pnlPeak.roi)}）`);
  console.log(`4. 直接套用 BTC 28.5M：PnL $${btcRefMetrics?.pnl?.toFixed(0) ?? '—'} ROI ${btcRefMetrics ? pct(btcRefMetrics.roi) : '—'}`);

  if (bestRoi?.params) {
    console.log('\n【多方法 ROI 最优】');
    for (const line of envLines(bestRoi.params)) console.log(line);
    console.log(`MIN_ACTIVITY_TIER=${MIN_ACTIVITY_TIER}`);
    printResult('best_roi', bestRoi);
  }
  if (bestPnl?.params && stateKey(bestPnl.params) !== stateKey(bestRoi?.params)) {
    console.log('\n【多方法 PnL 最优】');
    for (const line of envLines(bestPnl.params)) console.log(line);
    console.log(`MIN_ACTIVITY_TIER=${MIN_ACTIVITY_TIER}`);
    printResult('best_pnl', bestPnl);
  }

  const output = {
    symbol: marketCtx.symbol,
    days,
    minActivityTier: MIN_ACTIVITY_TIER,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    barDist,
    rawSignals: trades.length,
    baseline,
    btcReference: { params: btcRef, metrics: btcRefMetrics },
    roiCurveAnalysis: { fineProbeCount: fineProbe.length, roiPeak, pnlPeak, roiPeakPositive, curve: curveShow },
    methods: unique,
    ranked: { byPnl: byPnl.slice(0, 10), byRoi: byRoi.slice(0, 10), byBalanced: byBalanced.slice(0, 10) },
    recommendations: {
      bestPnl: bestPnl ? { method: bestPnl.method, params: bestPnl.params, metrics: bestPnl.metrics } : null,
      bestRoi: bestRoi ? { method: bestRoi.method, params: bestRoi.params, metrics: bestRoi.metrics } : null,
      bestBalanced: bestBal ? { method: bestBal.method, params: bestBal.params, metrics: bestBal.metrics } : null,
    },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\n完整结果: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
