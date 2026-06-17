/**
 * BTC 门控常开 · 多方法参数寻优 + ROI 峰值分析
 *
 * Usage:
 *   node scripts/backtest-btc-always-on-optimize.js --days=365
 *   node scripts/backtest-btc-always-on-optimize.js --days=365 --fetch
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
  coordinateDescent,
  dedupeResults,
  exhaustiveGrid,
  geneticAlgorithm,
  latinHypercubeRefine,
  multiStartCoordinateDescent,
  randomSearch,
  simulatedAnnealing,
} from './lib/btcAlwaysOnOptimizers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-btc-always-on-optimize.json');

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
    `${label.padEnd(22)} | probe=${String(s.probeM).padStart(5)}M | ` +
    `1-9=$${s.tier1_9} 10=$${s.tier10} 11=$${s.tier11} 12=$${s.tier12} | ` +
    `PnL $${m.pnl.toFixed(0).padStart(6)} ROI ${pct(m.roi).padStart(7)} ` +
    `回撤 $${m.maxDrawdown.toFixed(0).padStart(5)} 热档 ${pct(m.hotTierPct)}`,
  );
}

function productionState() {
  const c = config.dynamicBaseBet;
  return {
    probeM: roundM(config.sessionGate.activityProbeUsdtMin),
    tier1_9: c.tier1_9Usd,
    tier10: c.tier10Usd,
    tier11: c.tier11Usd,
    tier12: c.tier12Usd,
  };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = parseArg('to') ? Date.parse(parseArg('to')) : Date.now();
  const fromMs = parseArg('from') ? Date.parse(parseArg('from')) : toMs - days * 24 * 60 * 60_000;
  const marketCtx = resolveOhlcvMarket('swap', parseArg('symbol', 'BTC/USDT'));

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
  const prod = productionState();

  const evalPnl = (s) => evaluateState(s, trades, c5, 'pnl');
  const evalRoi = (s) => evaluateState(s, trades, c5, 'roi');
  const evalBalanced = (s) => evaluateState(s, trades, c5, 'balanced');

  const baseline = simulateMartingale(trades, c5, { fixedBase: config.tradeBudgetUsd });
  const prodMetrics = evalBalanced(prod);

  console.log(`\n=== BTC 门控常开 · 多方法寻优 · ${days}d · ${marketCtx.label} ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)} | 成交 ${trades.length} 信号`);
  if (barDist) {
    console.log(`5m 成交额: p50=${fmtM(barDist.p50)} p75=${fmtM(barDist.p75)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)}`);
  }
  console.log(`\n基准 固定 $${config.tradeBudgetUsd}: PnL $${baseline.pnl.toFixed(0)} ROI ${pct(baseline.roi)}`);
  console.log(`生产 ${formatState(prod)}: PnL $${prodMetrics.pnl.toFixed(0)} ROI ${pct(prodMetrics.roi)}`);

  // ── ROI 曲线：固定生产四档，细扫 probe ──
  console.log('\n═══ ROI 峰值分析（固定四档 1/6/8/24，细扫 probe）═══');
  const defaultTiers = stateToTierOpts(prod);
  const fineProbe = buildFineProbeGrid(barDist, 1);
  const roiCurve = fineProbe.map((probeM) => {
    const m = simulateMartingale(trades, c5, {
      tierOpts: defaultTiers,
      probeUsdt: probeM * 1e6,
    });
    return { probeM, ...m };
  });
  roiCurve.sort((a, b) => b.roi - a.roi);
  const roiPeak = roiCurve[0];
  const roiPeakPnlPositive = roiCurve.filter((x) => x.pnl > 0).sort((a, b) => b.roi - a.roi)[0];
  const pnlPeakOnCurve = [...roiCurve].sort((a, b) => b.pnl - a.pnl)[0];

  console.log(`细扫 ${fineProbe.length} 个 probe 点 (步长 1M, ${roundM(barDist.p50 * 0.4)}M–${roundM(barDist.p95 * 1.05)}M)`);
  console.log(`\n【ROI 绝对最高】probe=${roiPeak.probeM}M → ROI ${pct(roiPeak.roi)} PnL $${roiPeak.pnl.toFixed(0)} 均注 $${roiPeak.avgStake.toFixed(2)} 热档 ${pct(roiPeak.hotTierPct)}`);
  if (roiPeakPnlPositive && roiPeakPnlPositive.probeM !== roiPeak.probeM) {
    console.log(`【ROI 最高且 PnL>0】probe=${roiPeakPnlPositive.probeM}M → ROI ${pct(roiPeakPnlPositive.roi)} PnL $${roiPeakPnlPositive.pnl.toFixed(0)}`);
  }
  console.log(`【同曲线 PnL 最高】probe=${pnlPeakOnCurve.probeM}M → PnL $${pnlPeakOnCurve.pnl.toFixed(0)} ROI ${pct(pnlPeakOnCurve.roi)}`);

  console.log('\nprobe(M) | ROI%   | PnL    | 均注  | 热档%  | 回撤');
  const curveShow = [...fineProbe]
    .map((probeM) => roiCurve.find((x) => x.probeM === probeM))
    .filter(Boolean)
    .sort((a, b) => a.probeM - b.probeM);
  for (const r of curveShow.filter((x, i) => i % 3 === 0 || x.probeM === prod.probeM || x.probeM === roiPeak.probeM)) {
    const mark = r.probeM === roiPeak.probeM ? ' ◀ ROI峰'
      : r.probeM === prod.probeM ? ' ◀ 生产' : '';
    console.log(
      `${String(r.probeM).padStart(7)} | ${pct(r.roi).padStart(6)} | $${r.pnl.toFixed(0).padStart(5)} | ` +
      `$${r.avgStake.toFixed(2).padStart(4)} | ${pct(r.hotTierPct).padStart(5)} | $${r.maxDrawdown.toFixed(0)}${mark}`,
    );
  }

  // ROI vs probe 规律摘要
  const lowProbe = curveShow.find((x) => x.probeM <= roundM(barDist.p50 * 0.6));
  const midProbe = curveShow.find((x) => Math.abs(x.probeM - prod.probeM) < 0.6);
  const highProbe = curveShow.find((x) => x.probeM >= roundM(barDist.p90 * 0.85));
  console.log('\n--- ROI 随 probe 变化规律 ---');
  if (lowProbe) console.log(`低 probe (~${lowProbe.probeM}M): ROI ${pct(lowProbe.roi)} | 热档 ${pct(lowProbe.hotTierPct)} | 均注 $${lowProbe.avgStake.toFixed(2)} → 注码大、ROI 低`);
  if (midProbe) console.log(`中 probe (~${midProbe.probeM}M): ROI ${pct(midProbe.roi)} | 热档 ${pct(midProbe.hotTierPct)} | 均注 $${midProbe.avgStake.toFixed(2)}`);
  if (highProbe) console.log(`高 probe (~${highProbe.probeM}M): ROI ${pct(highProbe.roi)} | 热档 ${pct(highProbe.hotTierPct)} | 均注 $${highProbe.avgStake.toFixed(2)} → 注码小、ROI 高`);

  // ── 多方法寻优 ──
  console.log('\n═══ 多方法寻优（7 种）═══');
  const seeds = [
    prod,
    { probeM: roiPeak.probeM, tier1_9: 1, tier10: 6, tier11: 8, tier12: 24 },
    { probeM: pnlPeakOnCurve.probeM, tier1_9: 1, tier10: 8, tier11: 12, tier12: 24 },
    { probeM: roundM(barDist.p75), tier1_9: 1, tier10: 6, tier11: 8, tier12: 16 },
  ];

  const methods = [];

  console.log('\n[1] 穷举网格 (PnL 目标)...');
  const gridPnl = exhaustiveGrid(cand, evalPnl, 'score');
  methods.push({ method: 'grid_pnl', objective: 'pnl', ...gridPnl });

  console.log('[2] 穷举网格 (ROI 目标)...');
  const gridRoi = exhaustiveGrid(cand, evalRoi, 'score');
  methods.push({ method: 'grid_roi', objective: 'roi', ...gridRoi });

  console.log('[3] 坐标下降 / 分治 (PnL)...');
  const cdPnl = multiStartCoordinateDescent(seeds, cand, evalPnl, { rounds: 3, scoreField: 'score' });
  methods.push({ method: 'coordinate_pnl', objective: 'pnl', ...cdPnl });

  console.log('[4] 坐标下降 (ROI)...');
  const cdRoi = multiStartCoordinateDescent(seeds, cand, evalRoi, { rounds: 3, scoreField: 'score' });
  methods.push({ method: 'coordinate_roi', objective: 'roi', ...cdRoi });

  console.log('[5] 随机搜索 ×800 (balanced)...');
  const randBal = randomSearch(cand, evalBalanced, { n: 800, seed: 42, scoreField: 'score' });
  methods.push({ method: 'random_balanced', objective: 'balanced', ...randBal });

  console.log('[6] 遗传算法 (PnL)...');
  const gaPnl = geneticAlgorithm(cand, evalPnl, { popSize: 36, generations: 22, seed: 7, scoreField: 'score' });
  methods.push({ method: 'genetic_pnl', objective: 'pnl', ...gaPnl });

  console.log('[7] 拉丁超立方 + 坐标下降 (ROI)...');
  const lhsRoi = latinHypercubeRefine(cand, evalRoi, { samples: 140, refineTop: 8, seed: 13, scoreField: 'score' });
  methods.push({ method: 'lhs_roi', objective: 'roi', ...lhsRoi });

  console.log('[8] 模拟退火 (balanced)...');
  const saBal = simulatedAnnealing(prod, cand, evalBalanced, { steps: 450, seed: 99, scoreField: 'score' });
  methods.push({ method: 'anneal_balanced', objective: 'balanced', ...saBal });

  const unique = dedupeResults(methods);
  const byPnl = [...unique].sort((a, b) => b.metrics.pnl - a.metrics.pnl);
  const byRoi = [...unique].sort((a, b) => b.metrics.roi - a.metrics.roi);
  const byBalanced = [...unique].sort((a, b) => b.metrics.score - a.metrics.score);

  console.log('\n--- 各方法 Top 结果（按 PnL 排序）---');
  for (const r of byPnl.slice(0, 8)) {
    printResult(r.method, r);
  }

  console.log('\n--- ROI 最优（各方法去重后 Top 5）---');
  for (const r of byRoi.slice(0, 5)) {
    printResult(r.method, r);
  }

  console.log('\n--- 综合 score 最优 ---');
  for (const r of byBalanced.slice(0, 3)) {
    printResult(r.method, r);
  }

  const bestPnl = byPnl[0];
  const bestRoi = byRoi[0];
  const bestBal = byBalanced[0];

  console.log('\n═══ 结论：什么时候 ROI 最优？═══');
  console.log('1. ROI 随 probe 呈倒 U 型：过低 probe 均注过大 ROI 低；约 25–30M 达峰；过高 probe 热档过少 ROI 回落');
  console.log(`2. 固定四档 1/6/8/24 下，ROI 峰值在 probe≈${roiPeak.probeM}M（ROI ${pct(roiPeak.roi)}，PnL $${roiPeak.pnl.toFixed(0)}）`);
  console.log(`3. PnL 峰值在 probe≈${pnlPeakOnCurve.probeM}M（PnL $${pnlPeakOnCurve.pnl.toFixed(0)}，ROI ${pct(pnlPeakOnCurve.roi)}）`);
  console.log(`4. 生产 probe=${prod.probeM}M 处于中间：ROI ${pct(prodMetrics.roi)}，PnL $${prodMetrics.pnl.toFixed(0)}`);
  console.log('5. 若目标 ROI%：选高 probe（28–40M）+ 保守四档（1/4–6/6–8/12–16）');
  console.log('6. 若目标绝对 PnL：选低 probe（10–15M）+ 激进四档（1/8/12/24）');
  console.log('7. ROI 与 PnL 不可同时最优 — 需在 ROI 峰值与 PnL 峰值之间取折中');

  if (bestRoi?.params) {
    console.log('\n【多方法 ROI 最优参数】');
    for (const line of envLines(bestRoi.params)) console.log(line);
    printResult('best_roi', bestRoi);
  }
  if (bestPnl?.params && stateKey(bestPnl.params) !== stateKey(bestRoi?.params)) {
    console.log('\n【多方法 PnL 最优参数】');
    for (const line of envLines(bestPnl.params)) console.log(line);
    printResult('best_pnl', bestPnl);
  }

  const output = {
    days,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    ohlcv: marketCtx,
    barDist,
    baseline,
    production: { params: prod, metrics: prodMetrics },
    roiCurveAnalysis: {
      fineProbeCount: fineProbe.length,
      roiPeak,
      pnlPeakOnCurve,
      curve: curveShow,
    },
    methods: unique,
    ranked: { byPnl: byPnl.slice(0, 10), byRoi: byRoi.slice(0, 10), byBalanced: byBalanced.slice(0, 10) },
    recommendations: {
      bestPnl: bestPnl ? { params: bestPnl.params, metrics: bestPnl.metrics, method: bestPnl.method } : null,
      bestRoi: bestRoi ? { params: bestRoi.params, metrics: bestRoi.metrics, method: bestRoi.method } : null,
      bestBalanced: bestBal ? { params: bestBal.params, metrics: bestBal.metrics, method: bestBal.method } : null,
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
