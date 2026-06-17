import {
  cloneState,
  isValidState,
  stateKey,
} from './btcAlwaysOnSim.js';

function better(a, b, field = 'score') {
  if (!b) return true;
  if (!a) return false;
  if (a[field] !== b[field]) return a[field] > b[field];
  if (a.pnl !== b.pnl) return a.pnl > b.pnl;
  return a.maxDrawdown < b.maxDrawdown;
}

function pickFrom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
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

function randomState(cand, rng) {
  for (let i = 0; i < 60; i += 1) {
    const s = {
      probeM: pickFrom(cand.probeM, rng),
      tier1_9: pickFrom(cand.tier1_9, rng),
      tier10: pickFrom(cand.tier10, rng),
      tier11: pickFrom(cand.tier11, rng),
      tier12: pickFrom(cand.tier12, rng),
    };
    if (s.tier11 < s.tier10) s.tier11 = s.tier10;
    if (s.tier12 < s.tier11) s.tier12 = s.tier11;
    if (isValidState(s)) return s;
  }
  return null;
}

function neighborState(s, cand, rng) {
  const dims = [
    ['probeM', cand.probeM],
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
  if (!choices.length) choices.push(pool[Math.floor(rng() * pool.length)]);
  const n = cloneState(s);
  n[dim] = choices[Math.floor(rng() * choices.length)];
  if (n.tier11 < n.tier10) n.tier11 = n.tier10;
  if (n.tier12 < n.tier11) n.tier12 = n.tier11;
  return n;
}

function optimizeDim(name, values, current, evaluate, scoreField) {
  let best = { value: current[name], metrics: evaluate(current) };
  for (const v of values) {
    if (v === current[name]) continue;
    const trial = { ...current, [name]: v };
    const m = evaluate(trial);
    if (!m) continue;
    if (better(m, best.metrics, scoreField)) best = { value: v, metrics: m };
  }
  if (best.metrics) current[name] = best.value;
  return best.metrics;
}

export function coordinateDescent(start, cand, evaluate, { rounds = 2, scoreField = 'score' } = {}) {
  const state = cloneState(start);
  const dims = [
    ['probeM', cand.probeM],
    ['tier1_9', cand.tier1_9],
    ['tier10', cand.tier10],
    ['tier11', cand.tier11],
    ['tier12', cand.tier12],
  ];
  for (let r = 0; r < rounds; r += 1) {
    for (const [dim, pool] of dims) {
      const vals = dim === 'tier11' ? cand.tier11.filter((v) => v >= state.tier10)
        : dim === 'tier12' ? cand.tier12.filter((v) => v >= state.tier11) : pool;
      optimizeDim(dim, vals, state, evaluate, scoreField);
    }
  }
  return { params: state, metrics: evaluate(state) };
}

export function exhaustiveGrid(cand, evaluate, scoreField = 'score') {
  let best = null;
  for (const probeM of cand.probeM) {
    for (const tier1_9 of cand.tier1_9) {
      for (const tier10 of cand.tier10) {
        for (const tier11 of cand.tier11) {
          if (tier11 < tier10) continue;
          for (const tier12 of cand.tier12) {
            if (tier12 < tier11) continue;
            const s = { probeM, tier1_9, tier10, tier11, tier12 };
            const m = evaluate(s);
            if (!m) continue;
            if (!best || better(m, best.metrics, scoreField)) {
              best = { params: s, metrics: m };
            }
          }
        }
      }
    }
  }
  return best;
}

export function randomSearch(cand, evaluate, { n = 500, seed = 42, scoreField = 'score' } = {}) {
  const rng = mulberry32(seed);
  let best = null;
  for (let i = 0; i < n; i += 1) {
    const s = randomState(cand, rng);
    if (!s) continue;
    const m = evaluate(s);
    if (!m) continue;
    if (!best || better(m, best.metrics, scoreField)) best = { params: s, metrics: m };
  }
  return best;
}

export function geneticAlgorithm(cand, evaluate, {
  popSize = 40, generations = 24, seed = 7, scoreField = 'score',
} = {}) {
  const rng = mulberry32(seed);
  let pop = [];
  while (pop.length < popSize) {
    const s = randomState(cand, rng);
    if (!s) continue;
    const m = evaluate(s);
    if (m) pop.push({ params: s, metrics: m });
  }
  let best = pop.reduce((b, c) => (!b || better(c.metrics, b.metrics, scoreField) ? c : b), null);

  for (let g = 0; g < generations; g += 1) {
    pop.sort((a, b) => b.metrics[scoreField] - a.metrics[scoreField]);
    const next = pop.slice(0, 6);
    while (next.length < popSize) {
      const p1 = pop[Math.floor(rng() * Math.min(10, pop.length))];
      const p2 = pop[Math.floor(rng() * Math.min(10, pop.length))];
      const child = crossover(p1.params, p2.params);
      if (rng() < 0.35) mutate(child, cand, rng);
      if (child.tier11 < child.tier10) child.tier11 = child.tier10;
      if (child.tier12 < child.tier11) child.tier12 = child.tier11;
      if (!isValidState(child)) continue;
      const m = evaluate(child);
      if (m) next.push({ params: child, metrics: m });
    }
    pop = next;
    const genBest = pop.reduce((b, c) => (!b || better(c.metrics, b.metrics, scoreField) ? c : b), null);
    if (genBest && better(genBest.metrics, best?.metrics, scoreField)) best = genBest;
  }
  return coordinateDescent(best.params, cand, evaluate, { rounds: 1, scoreField });
}

function crossover(a, b) {
  const pick = (k) => (Math.random() < 0.5 ? a[k] : b[k]);
  return {
    probeM: pick('probeM'),
    tier1_9: pick('tier1_9'),
    tier10: pick('tier10'),
    tier11: pick('tier11'),
    tier12: pick('tier12'),
  };
}

function mutate(s, cand, rng) {
  const dims = ['probeM', 'tier1_9', 'tier10', 'tier11', 'tier12'];
  const dim = dims[Math.floor(rng() * dims.length)];
  s[dim] = pickFrom(cand[dim], rng);
}

export function simulatedAnnealing(start, cand, evaluate, {
  steps = 400, t0 = 150, seed = 99, scoreField = 'score',
} = {}) {
  const rng = mulberry32(seed);
  let cur = cloneState(start);
  let curM = evaluate(cur);
  let best = { params: cloneState(cur), metrics: curM };

  for (let i = 0; i < steps; i += 1) {
    const t = t0 * (1 - i / steps);
    const n = neighborState(cur, cand, rng);
    if (!isValidState(n)) continue;
    const nm = evaluate(n);
    if (!nm) continue;
    const delta = nm[scoreField] - curM[scoreField];
    if (delta > 0 || rng() < Math.exp(delta / Math.max(t, 1e-6))) {
      cur = n;
      curM = nm;
      if (better(nm, best.metrics, scoreField)) best = { params: cloneState(cur), metrics: nm };
    }
  }
  return coordinateDescent(best.params, cand, evaluate, { rounds: 1, scoreField });
}

export function latinHypercubeRefine(cand, evaluate, {
  samples = 120, refineTop = 6, seed = 13, scoreField = 'score',
} = {}) {
  const rng = mulberry32(seed);
  const dims = ['probeM', 'tier1_9', 'tier10', 'tier11', 'tier12'];
  const buckets = Object.fromEntries(dims.map((d) => [d, shuffle([...cand[d]], rng)]));

  const results = [];
  for (let i = 0; i < samples; i += 1) {
    const s = {};
    for (const d of dims) s[d] = buckets[d][i % buckets[d].length];
    if (s.tier11 < s.tier10) s.tier11 = s.tier10;
    if (s.tier12 < s.tier11) s.tier12 = s.tier11;
    if (!isValidState(s)) continue;
    const m = evaluate(s);
    if (m) results.push({ params: s, metrics: m });
  }

  results.sort((a, b) => b.metrics[scoreField] - a.metrics[scoreField]);
  let best = results[0] ?? null;
  for (const hit of results.slice(0, refineTop)) {
    const refined = coordinateDescent(hit.params, cand, evaluate, { rounds: 2, scoreField });
    if (refined.metrics && better(refined.metrics, best?.metrics, scoreField)) best = refined;
  }
  return best;
}

export function multiStartCoordinateDescent(seeds, cand, evaluate, { rounds = 2, scoreField = 'score' } = {}) {
  let best = null;
  for (const seed of seeds) {
    const r = coordinateDescent(seed, cand, evaluate, { rounds, scoreField });
    if (r.metrics && better(r.metrics, best?.metrics, scoreField)) best = r;
  }
  return best;
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
