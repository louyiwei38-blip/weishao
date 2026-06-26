/**
 * ETH 多方法参数调优：随机搜索 / 遗传算法 / 模拟退火 / 拉丁超立方 / 多起点分治 / 局部网格
 *
 * Usage: node scripts/backtest-eth-multi-optimize.js --days=365
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  fmtM, pct, loadEthContext, formatState, formatEnv, roundM,
} from './lib/ethBacktestSim.js';
import {
  coordinateDescent, randomSearch, geneticAlgorithm, simulatedAnnealing,
  latinHypercubeRefine, multiStartCoordinateDescent, localGridRefine,
  pickBest, dedupeResults,
} from './lib/ethOptimizers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-eth-multi-optimize.json');

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function logResult(label, r) {
  if (!r?.metrics) {
    console.log(`  ${label}: 无有效结果`);
    return;
  }
  const s = r.params;
  console.log(
    `  ${label}: PnL $${r.metrics.pnl.toFixed(0)} | dd $${r.metrics.maxDrawdown.toFixed(0)} ` +
    `| gate ${pct(r.metrics.gateOpenPct)} | WR ${pct(r.metrics.winRate)} | score ${r.metrics.score.toFixed(0)}`,
  );
  console.log(`    ${formatState(s)}`);
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const { ctx, evaluate } = await loadEthContext(days, hasFlag('fetch'));
  const { barDist, candidates: cand } = ctx;

  console.log(`\n=== ETH 多方法调优 · ${days}d · burst=21min ===`);
  console.log(`成交额: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)}`);

  const seeds = [
    { probeM: 60, minM: 85.8, maxM: 129.3, tier1_9: 1, tier10: 10, tier11: 12, tier12: 24 },
    { probeM: 60, minM: 86, maxM: 110, tier1_9: 1, tier10: 6, tier11: 8, tier12: 24 },
    { probeM: roundM(barDist.p90 * 0.7), minM: roundM(barDist.p90), maxM: roundM(barDist.p95 * 0.85), tier1_9: 1, tier10: 6, tier11: 8, tier12: 24 },
    { probeM: roundM(barDist.p75), minM: roundM(barDist.p90), maxM: roundM(barDist.p95), tier1_9: 1, tier10: 8, tier11: 12, tier12: 24 },
    { probeM: roundM(barDist.p90), minM: roundM(barDist.p75), maxM: roundM(barDist.p90), tier1_9: 2, tier10: 10, tier11: 12, tier12: 20 },
  ];

  const methods = [];

  console.log('\n[1/7] 坐标下降（分治，seed=方案A）');
  const r1 = coordinateDescent(seeds[1], cand, evaluate, 3);
  logResult('坐标下降', r1);
  methods.push({ method: 'coordinate_descent', ...r1 });

  console.log('\n[2/7] 随机搜索 (600 组)');
  const r2 = randomSearch(cand, barDist, evaluate, 600);
  const r2b = coordinateDescent(r2.params, cand, evaluate, 2);
  logResult('随机搜索→refine', r2b);
  methods.push({ method: 'random_search', ...r2b });

  console.log('\n[3/7] 遗传算法 (48×28代)');
  const r3 = geneticAlgorithm(cand, barDist, evaluate);
  logResult('遗传算法', r3);
  methods.push({ method: 'genetic_algorithm', ...r3 });

  console.log('\n[4/7] 模拟退火 (500步，起点=分治最优)');
  const r4 = simulatedAnnealing(seeds[0], cand, barDist, evaluate);
  logResult('模拟退火', r4);
  methods.push({ method: 'simulated_annealing', ...r4 });

  console.log('\n[5/7] 拉丁超立方 (180样本 + top8 refine)');
  const r5 = latinHypercubeRefine(cand, barDist, evaluate);
  logResult('拉丁超立方', r5);
  methods.push({ method: 'latin_hypercube', ...r5 });

  console.log('\n[6/7] 多起点坐标下降 (5 seeds)');
  const r6 = multiStartCoordinateDescent(seeds, cand, evaluate, 3);
  logResult('多起点分治', r6);
  methods.push({ method: 'multi_start_cd', ...r6 });

  console.log('\n[7/7] 集成：各方法 top 结果 → 局部精细网格');
  const topPool = dedupeResults(methods.filter((m) => m.metrics));
  const gridResults = topPool.map((m) => localGridRefine(m.params, cand, evaluate));
  const r7 = pickBest(gridResults);
  logResult('局部网格', r7);
  methods.push({ method: 'local_grid', ...r7 });

  const ranked = dedupeResults(methods)
    .sort((a, b) => b.metrics.score - a.metrics.score || b.metrics.pnl - a.metrics.pnl);

  const globalBest = ranked[0];
  const schemeA = evaluate(seeds[1]);
  const divideConquer = evaluate(seeds[0]);

  const output = {
    days,
    barDist,
    candidates: cand,
    methods: methods.map(({ method, params, metrics }) => ({ method, params, metrics })),
    ranked: ranked.map(({ method, params, metrics }) => ({ method, params, metrics })),
    globalBest: globalBest ? { method: globalBest.method, params: globalBest.params, metrics: globalBest.metrics } : null,
    baselines: {
      schemeA: { params: seeds[1], metrics: schemeA },
      divideConquer: { params: seeds[0], metrics: divideConquer },
    },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log('\n=== 各方法排名 (by score) ===');
  for (const [i, r] of ranked.entries()) {
    console.log(
      `${i + 1}. [${r.method}] PnL $${r.metrics.pnl.toFixed(0)} dd $${r.metrics.maxDrawdown.toFixed(0)} ` +
      `gate ${pct(r.metrics.gateOpenPct)} | ${formatState(r.params)}`,
    );
  }

  if (globalBest) {
    console.log('\n=== 全局最优 ===');
    console.log(formatEnv(globalBest.params));
    const m = globalBest.metrics;
    console.log(
      `→ ${m.trades}笔 WR ${pct(m.winRate)} PnL $${m.pnl.toFixed(0)} ROI ${pct(m.roi)} ` +
      `回撤 $${m.maxDrawdown.toFixed(0)} 门控 ${pct(m.gateOpenPct)} (via ${globalBest.method})`,
    );
  }

  if (schemeA) {
    console.log(`\n方案A对照: PnL $${schemeA.pnl.toFixed(0)} gate ${pct(schemeA.gateOpenPct)}`);
  }
  if (divideConquer) {
    console.log(`分治对照: PnL $${divideConquer.pnl.toFixed(0)} gate ${pct(divideConquer.gateOpenPct)}`);
  }
  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
