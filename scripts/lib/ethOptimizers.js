import { cloneState, isValidState, stateKey } from './ethBacktestSim.js';

function better(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (a.score !== b.score) return a.score > b.score;
  if (a.pnl !== b.pnl) return a.pnl > b.pnl;
  return a.maxDrawdown < b.maxDrawdown;
}

export function pickBest(results) {
  return results.reduce((best, cur) => (better(cur.metrics, best?.metrics) ? cur : best), null);
}

function pickFrom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function randomState(cand, barDist, rng) {
  for (let i = 0; i < 80; i += 1) {
    const s = {
      probeM: pickFrom(cand.probeM, rng),
      minM: pickFrom(cand.minM, rng),
      maxM: pickFrom(cand.maxM, rng),
      tier1_9: pickFrom(cand.tier1_9, rng),
      tier10: pickFrom(cand.tier10, rng),
      tier11: pickFrom(cand.tier11, rng),
      tier12: pickFrom(cand.tier12, rng),
    };
    if (s.tier11 < s.tier10) s.tier11 = s.tier10;
    if (s.tier12 < s.tier11) s.tier12 = s.tier11;
    if (isValidState(s, barDist)) return s;
  }
  return null;
}

function neighborState(s, cand, rng) {
  const dims = [
    ['probeM', cand.probeM],
    ['minM', cand.minM],
    ['maxM', cand.maxM],
    ['tier1_9', cand.tier1_9],
    ['tier10', cand.tier10],
    ['tier11', cand.tier11],
    ['tier12', cand.tier12],
  ];
  const [dim, pool] = dims[Math.floor(rng() * dims.length)];
  const idx = pool.indexOf(s[dim]);
  const choices = [];
  if (idx > 0) choices.push(pool[idx - 1]);
  if (idx >= 0 && idx < pool.length - 1) choices.push(pool[idx + 1]);
  if (choices.length === 0) choices.push(pool[Math.floor(rng() * pool.length)]);
  const n = cloneState(s);
  n[dim] = choices[Math.floor(rng() * choices.length)];
  if (n.tier11 < n.tier10) n.tier11 = n.tier10;
  if (n.tier12 < n.tier11) n.tier12 = n.tier11;
  return n;
}

function optimizeDim(name, values, current, evaluate) {
  let best = { value: current[name], metrics: evaluate(current) };
  for (const v of values) {
    if (v === current[name]) continue;
    const trial = { ...current, [name]: v };
    const m = evaluate(trial);
    if (!m) continue;
    if (better(m, best.metrics)) best = { value: v, metrics: m };
  }
  if (best.metrics) current[name] = best.value;
  return best.metrics;
}

/** 1. 坐标下降 / 分治法 */
export function coordinateDescent(start, cand, evaluate, rounds = 2) {
  const state = cloneState(start);
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
      optimizeDim(dim, vals, state, evaluate);
    }
  }
  return { params: state, metrics: evaluate(state) };
}

/** 2. 随机搜索 */
export function randomSearch(cand, barDist, evaluate, n = 600, seed = 42) {
  const rng = mulberry32(seed);
  let best = null;
  for (let i = 0; i < n; i += 1) {
    const s = randomState(cand, barDist, rng);
    if (!s) continue;
    const m = evaluate(s);
    if (!m) continue;
    const cur = { params: s, metrics: m };
    if (!best || better(m, best.metrics)) best = cur;
  }
  return best;
}

/** 3. 遗传算法 */
export function geneticAlgorithm(cand, barDist, evaluate, {
  popSize = 48, generations = 28, seed = 7,
} = {}) {
  const rng = mulberry32(seed);
  let pop = [];
  while (pop.length < popSize) {
    const s = randomState(cand, barDist, rng);
    if (!s) continue;
    const m = evaluate(s);
    if (m) pop.push({ params: s, metrics: m });
  }
  let best = pickBest(pop);

  for (let g = 0; g < generations; g += 1) {
    pop.sort((a, b) => b.metrics.score - a.metrics.score);
    const next = pop.slice(0, 8);
    while (next.length < popSize) {
      const p1 = pop[Math.floor(rng() * Math.min(12, pop.length))];
      const p2 = pop[Math.floor(rng() * Math.min(12, pop.length))];
      const child = crossover(p1.params, p2.params, cand);
      if (rng() < 0.35) mutate(child, cand, rng);
      if (child.tier11 < child.tier10) child.tier11 = child.tier10;
      if (child.tier12 < child.tier11) child.tier12 = child.tier11;
      if (!isValidState(child, barDist)) continue;
      const m = evaluate(child);
      if (m) next.push({ params: child, metrics: m });
    }
    pop = next;
    const genBest = pickBest(pop);
    if (genBest && better(genBest.metrics, best?.metrics)) best = genBest;
  }
  return coordinateDescent(best.params, cand, evaluate, 1);
}

function crossover(a, b, cand) {
  const pick = (k) => (Math.random() < 0.5 ? a[k] : b[k]);
  return {
    probeM: pick('probeM'),
    minM: pick('minM'),
    maxM: pick('maxM'),
    tier1_9: pick('tier1_9'),
    tier10: pick('tier10'),
    tier11: pick('tier11'),
    tier12: pick('tier12'),
  };
}

function mutate(s, cand, rng) {
  const dims = ['probeM', 'minM', 'maxM', 'tier1_9', 'tier10', 'tier11', 'tier12'];
  const dim = dims[Math.floor(rng() * dims.length)];
  s[dim] = pickFrom(cand[dim], rng);
}

/** 4. 模拟退火 */
export function simulatedAnnealing(start, cand, barDist, evaluate, {
  steps = 500, t0 = 180, seed = 99,
} = {}) {
  const rng = mulberry32(seed);
  let cur = cloneState(start);
  let curM = evaluate(cur);
  let best = { params: cloneState(cur), metrics: curM };

  for (let i = 0; i < steps; i += 1) {
    const t = t0 * (1 - i / steps);
    const n = neighborState(cur, cand, rng);
    if (!isValidState(n, barDist)) continue;
    const nm = evaluate(n);
    if (!nm) continue;
    const delta = nm.score - curM.score;
    if (delta > 0 || rng() < Math.exp(delta / Math.max(t, 1e-6))) {
      cur = n;
      curM = nm;
      if (better(nm, best.metrics)) best = { params: cloneState(cur), metrics: nm };
    }
  }
  return coordinateDescent(best.params, cand, evaluate, 1);
}

/** 5. 拉丁超立方采样 + 局部坐标下降 */
export function latinHypercubeRefine(cand, barDist, evaluate, {
  samples = 180, refineTop = 8, seed = 13,
} = {}) {
  const rng = mulberry32(seed);
  const dims = ['probeM', 'minM', 'maxM', 'tier1_9', 'tier10', 'tier11', 'tier12'];
  const buckets = Object.fromEntries(dims.map((d) => [d, shuffle([...cand[d]], rng)]));

  const results = [];
  for (let i = 0; i < samples; i += 1) {
    const s = {};
    for (const d of dims) {
      const pool = buckets[d];
      s[d] = pool[i % pool.length];
    }
    if (s.tier11 < s.tier10) s.tier11 = s.tier10;
    if (s.tier12 < s.tier11) s.tier12 = s.tier11;
    if (!isValidState(s, barDist)) continue;
    const m = evaluate(s);
    if (m) results.push({ params: s, metrics: m });
  }

  results.sort((a, b) => b.metrics.score - a.metrics.score);
  let best = results[0] ?? null;
  for (const hit of results.slice(0, refineTop)) {
    const refined = coordinateDescent(hit.params, cand, evaluate, 2);
    if (refined.metrics && better(refined.metrics, best?.metrics)) best = refined;
  }
  return best;
}

/** 6. 多起点坐标下降 */
export function multiStartCoordinateDescent(seeds, cand, evaluate, rounds = 2) {
  let best = null;
  for (const seed of seeds) {
    const r = coordinateDescent(seed, cand, evaluate, rounds);
    if (r.metrics && better(r.metrics, best?.metrics)) best = r;
  }
  return best;
}

/** 7. 精细网格：门控小邻域 × 首注组合 */
export function localGridRefine(center, cand, evaluate) {
  const near = (pool, val) => {
    const idx = pool.indexOf(val);
    const out = [val];
    if (idx > 0) out.push(pool[idx - 1]);
    if (idx >= 0 && idx < pool.length - 1) out.push(pool[idx + 1]);
    return [...new Set(out)];
  };

  let best = { params: cloneState(center), metrics: evaluate(center) };
  const probePool = near(cand.probeM, center.probeM);
  const minPool = near(cand.minM, center.minM);
  const maxPool = near(cand.maxM, center.maxM);

  for (const probeM of probePool) {
    for (const minM of minPool) {
      for (const maxM of maxPool) {
        for (const tier1_9 of cand.tier1_9) {
          for (const tier10 of cand.tier10) {
            for (const tier11 of cand.tier11.filter((v) => v >= tier10)) {
              for (const tier12 of cand.tier12.filter((v) => v >= tier11)) {
                const s = { probeM, minM, maxM, tier1_9, tier10, tier11, tier12 };
                const m = evaluate(s);
                if (m && better(m, best.metrics)) best = { params: s, metrics: m };
              }
            }
          }
        }
      }
    }
  }
  return best;
}

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function dedupeResults(list) {
  const seen = new Set();
  return list.filter((x) => {
    if (!x?.metrics) return false;
    const k = stateKey(x.params);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
