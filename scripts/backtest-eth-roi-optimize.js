/**
 * ETH ROI 专项寻优：以 roi = pnl/stake 为目标
 * Usage: node scripts/backtest-eth-roi-optimize.js --days=365
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pct, loadEthContext, formatState, formatEnv } from './lib/ethBacktestSim.js';
import {
  randomSearch, coordinateDescent, multiStartCoordinateDescent, dedupeResults,
} from './lib/ethOptimizers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'logs', 'backtest-eth-roi-optimize.json');

function betterRoi(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (a.roi !== b.roi) return a.roi > b.roi;
  if (a.pnl !== b.pnl) return a.pnl > b.pnl;
  return a.maxDrawdown < b.maxDrawdown;
}

function makeRoiEvaluate(baseEvaluate) {
  return (s) => {
    const m = baseEvaluate(s);
    if (!m || m.pnl <= 0) return null;
    return m;
  };
}

function optimizeDimRoi(name, values, current, evaluate) {
  let best = { value: current[name], metrics: evaluate(current) };
  for (const v of values) {
    if (v === current[name]) continue;
    const trial = { ...current, [name]: v };
    const m = evaluate(trial);
    if (!m) continue;
    if (betterRoi(m, best.metrics)) best = { value: v, metrics: m };
  }
  if (best.metrics) current[name] = best.value;
  return best.metrics;
}

function coordinateDescentRoi(start, cand, evaluate, rounds = 3) {
  const state = { ...start };
  const dims = [
    ['probeM', cand.probeM],
    ['minM', cand.minM],
    ['maxM', cand.maxM],
    ['tier1_9', cand.tier1_9],
    ['tier10', cand.tier10],
    ['tier11', cand.tier11],
    ['tier12', cand.tier12],
  ];
  for (let r = 0; r < rounds; r += 1) {
    for (const [dim, pool] of dims) {
      const vals = dim === 'tier11' ? cand.tier11.filter((v) => v >= state.tier10)
        : dim === 'tier12' ? cand.tier12.filter((v) => v >= state.tier11) : pool;
      optimizeDimRoi(dim, vals, state, evaluate);
    }
  }
  return { params: state, metrics: evaluate(state) };
}

function randomSearchRoi(cand, barDist, evaluate, n = 400) {
  let seed = 42;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let best = null;
  for (let i = 0; i < n; i += 1) {
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const s = {
      probeM: pick(cand.probeM),
      minM: pick(cand.minM),
      maxM: pick(cand.maxM),
      tier1_9: pick(cand.tier1_9),
      tier10: pick(cand.tier10),
      tier11: pick(cand.tier11),
      tier12: pick(cand.tier12),
    };
    if (s.minM >= s.maxM || s.tier11 < s.tier10 || s.tier12 < s.tier11) continue;
    const m = evaluate(s);
    if (!m) continue;
    const cur = { params: s, metrics: m };
    if (!best || betterRoi(m, best.metrics)) best = cur;
  }
  return best;
}

async function main() {
  const { ctx, evaluate: baseEval } = await loadEthContext(365);
  const evaluate = makeRoiEvaluate(baseEval);
  const { candidates: cand, barDist } = ctx;

  const seeds = [
    { probeM: 109.9, minM: 64.3, maxM: 129.3, tier1_9: 1, tier10: 12, tier11: 16, tier12: 32 },
    { probeM: 60, minM: 85.8, maxM: 129.3, tier1_9: 1, tier10: 6, tier11: 8, tier12: 12 },
    { probeM: 60, minM: 85.8, maxM: 110, tier1_9: 1, tier10: 4, tier11: 6, tier12: 12 },
    { probeM: 85.8, minM: 64.3, maxM: 97, tier1_9: 1, tier10: 5, tier11: 6, tier12: 12 },
    { probeM: 60, minM: 85.8, maxM: 129.3, tier1_9: 1, tier10: 10, tier11: 12, tier12: 24 },
  ];

  console.log('\n=== ETH ROI 专项寻优 · 365d ===');

  const r1 = coordinateDescentRoi(seeds[1], cand, evaluate, 3);
  const r2 = randomSearchRoi(cand, barDist, evaluate, 500);
  const r2b = r2 ? coordinateDescentRoi(r2.params, cand, evaluate, 2) : null;
  const r3 = multiStartCoordinateDescent(seeds, cand, evaluate, 3);
  // patch multiStart to use ROI - it uses score by default. Re-run with ROI cd:
  const r3roi = seeds.map((s) => coordinateDescentRoi(s, cand, evaluate, 2))
    .filter((r) => r.metrics)
    .sort((a, b) => b.metrics.roi - a.metrics.roi)[0];

  const all = dedupeResults([r1, r2b, r3roi].filter(Boolean));
  all.sort((a, b) => b.metrics.roi - a.metrics.roi);

  const pnlBest = evaluate({ probeM: 60, minM: 85.8, maxM: 129.3, tier1_9: 1, tier10: 12, tier11: 16, tier12: 32 });

  console.log('\n--- ROI Top ---');
  for (const r of all.slice(0, 8)) {
    const m = r.metrics;
    console.log(
      `ROI ${pct(m.roi)} | PnL $${m.pnl.toFixed(0)} | dd $${m.maxDrawdown.toFixed(0)} ` +
      `| gate ${pct(m.gateOpenPct)} | WR ${pct(m.winRate)} | ${formatState(r.params)}`,
    );
  }

  const best = all[0];
  if (pnlBest) {
    console.log(`\nPnL最优对照: ROI ${pct(pnlBest.roi)} PnL $${pnlBest.pnl.toFixed(0)} tiers=1/12/16/32`);
  }

  if (best) {
    console.log('\n=== ROI 最高 ===');
    console.log(formatEnv(best.params));
    const m = best.metrics;
    console.log(`→ ROI ${pct(m.roi)} PnL $${m.pnl.toFixed(0)} 回撤 $${m.maxDrawdown.toFixed(0)} 门控 ${pct(m.gateOpenPct)}`);
  }

  const outDir = join(__dirname, '..', 'logs');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(OUT, JSON.stringify({ ranked: all, pnlBest: { params: { probeM: 60, minM: 85.8, maxM: 129.3, tier1_9: 1, tier10: 12, tier11: 16, tier12: 32 }, metrics: pnlBest } }, null, 2));
  console.log(`\n${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
