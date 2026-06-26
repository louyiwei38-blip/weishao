/**
 * ETH 分治法寻优：逐维优化门控 → 首注 → 局部 refinement。
 *
 * Usage: node scripts/backtest-eth-divide-conquer.js --days=365
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import { activityHitsToTier, resolveTierBaseBet } from '../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-eth-divide-conquer.json');

const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = 4;
const MULTIPLIER = 2;
const ENTRY_PRICE = 0.5;
const ACTIVITY_WINDOW = 12;
const BURST_MIN = 21;

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fmtM(n) {
  return `${(n / 1e6).toFixed(1)}M`;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function roundM(v) {
  return Math.round(v / 100_000) / 10;
}

function buildCandidates(barDist) {
  const { p50, p75, p90, p95 } = barDist;
  const uniq = (arr) => [...new Set(arr.map((v) => roundM(v)))].sort((a, b) => a - b);
  return {
    probeM: uniq([p50 * 0.7, p50, p75 * 0.85, p75, p90 * 0.7, p90, p95 * 0.85]),
    minM: uniq([p50 * 0.8, p50, p75 * 0.75, p75, p90 * 0.75, p90]),
    maxM: uniq([p90, p95 * 0.85, p95]).filter((m) => m <= p95 / 1e6 * 1.02),
    tier1_9: [1, 2, 3],
    tier10: [4, 5, 6, 8, 10],
    tier11: [6, 8, 10, 12],
    tier12: [12, 16, 20, 24],
  };
}

function computeActivityFreqLocal(c5, idx, probeUsdt) {
  const w = Math.min(ACTIVITY_WINDOW, idx + 1);
  let hits = 0;
  for (let i = idx - w + 1; i <= idx; i += 1) {
    const u = computeBarUsdtNotional(c5[i]);
    if (u != null && u >= probeUsdt) hits += 1;
  }
  return { hits, windowBars: w, freq: w > 0 ? hits / w : 0 };
}

function resolveThresh(freq, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(hi - Math.min(1, Math.max(0, freq)) * (hi - lo));
}

function simulateBurstTimeline(c5, rows, gate) {
  let until = null;
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const burstMs = gate.volumeBurstMinutes * 60_000;
  const tl = [];
  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { freq } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
    const th = resolveThresh(freq, gate.barVolumeUsdtMinDynamic, gate.barVolumeUsdtMaxDynamic);
    if (row.barUsdt >= th) until = row.nowMs + burstMs;
    tl.push({ t: row.t, ok: until != null && row.nowMs < until });
  }
  return tl;
}

function buildTrades(c5, tl, fromMs, toMs) {
  const ok = new Set(tl.filter((x) => x.ok).map((x) => x.t));
  const out = [];
  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    if (!ok.has(k1.t)) continue;
    const ts = k1.t + TF_MS;
    if (ts < fromMs || ts >= toMs) continue;
    const ev = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (ev.signal === 'NONE') continue;
    const nx = c5[i + 1];
    const won = (ev.signal === 'UP' && classifyCandle(nx) === 'BULL')
      || (ev.signal === 'DOWN' && classifyCandle(nx) === 'BEAR');
    out.push({ k1t: k1.t, won });
  }
  return out;
}

function evalConfig(c5, rows, gate, tierOpts, barDist) {
  if (gate.barVolumeUsdtMaxDynamic > barDist.p95 * 1.02) return null;
  if (gate.barVolumeUsdtMinDynamic >= gate.barVolumeUsdtMaxDynamic) return null;
  const tl = simulateBurstTimeline(c5, rows, gate);
  const open = tl.filter((x) => x.ok).length / (tl.length || 1);
  if (open < 0.06 || open > 0.4) return null;
  const trades = buildTrades(c5, tl, gate._fromMs, gate._toMs);
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let ls = 0;
  let skip = false;
  let halts = 0;
  let bet = tierOpts.tier1_9Usd;
  let streakTier = null;
  let pnl = 0;
  let peak = 0;
  let dd = 0;
  let stake = 0;

  for (const t of trades) {
    if (skip) { skip = false; ls = 0; streakTier = null; continue; }
    if (ls === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { hits, windowBars } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
      streakTier = activityHitsToTier(hits, windowBars);
      bet = resolveTierBaseBet(streakTier, tierOpts);
    }
    const s = bet;
    const p = t.won ? (calcWinNetProfit(s, ENTRY_PRICE) ?? s) : -s;
    pnl += p;
    stake += s;
    peak = Math.max(peak, pnl);
    dd = Math.max(dd, peak - pnl);
    if (t.won) ls = 0;
    else {
      ls += 1;
      if (ls >= MARTINGALE_MAX) { halts += 1; ls = 0; skip = true; streakTier = null; }
      else bet *= MULTIPLIER;
    }
  }

  let winCount = 0;
  {
    let ls2 = 0; let skip2 = false; let b2 = tierOpts.tier1_9Usd;
    for (const t of trades) {
      if (skip2) { skip2 = false; ls2 = 0; continue; }
      if (ls2 === 0) {
        const idx = idxByT.get(t.k1t) ?? 0;
        const { hits, windowBars } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
        b2 = resolveTierBaseBet(activityHitsToTier(hits, windowBars), tierOpts);
      }
      if (t.won) { winCount += 1; ls2 = 0; } else {
        ls2 += 1;
        if (ls2 >= MARTINGALE_MAX) { ls2 = 0; skip2 = true; } else b2 *= 2;
      }
    }
  }

  const coldThresh = gate.barVolumeUsdtMaxDynamic;
  const score = pnl - dd * 0.35 - halts * 8 - (coldThresh > barDist.p95 ? 50 : 0);

  return {
    gateOpenPct: open,
    trades: trades.length,
    winRate: trades.length ? winCount / trades.length : 0,
    halts,
    pnl,
    maxDrawdown: dd,
    roi: stake > 0 ? pnl / stake : 0,
    score,
  };
}

function gateFrom(probeM, minM, maxM, fromMs, toMs) {
  return {
    activityProbeUsdtMin: probeM * 1e6,
    barVolumeUsdtMinDynamic: minM * 1e6,
    barVolumeUsdtMaxDynamic: maxM * 1e6,
    volumeBurstMinutes: BURST_MIN,
    _fromMs: fromMs,
    _toMs: toMs,
  };
}

function tierFrom(t19, t10, t11, t12) {
  return { tier1_9Usd: t19, tier10Usd: t10, tier11Usd: t11, tier12Usd: t12 };
}

/** 分治：固定其余维，单维取最优 */
function optimizeDim(name, values, current, evaluate) {
  let best = { value: current[name], result: evaluate(current) };
  for (const v of values) {
    if (v === current[name]) continue;
    const trial = { ...current, [name]: v };
    const r = evaluate(trial);
    if (!r) continue;
    if (!best.result || r.score > best.result.score || (r.score === best.result.score && r.pnl > best.result.pnl)) {
      best = { value: v, result: r };
    }
  }
  if (best.result && best.value !== current[name]) {
    current[name] = best.value;
  }
  return { name, best: best.result, chosen: current[name] };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: 'swap',
    symbol: resolveOhlcvMarket('swap', 'ETH/USDT').symbol,
  });

  const rows = c5.filter((b) => b.t >= fromMs && b.t < toMs)
    .map((b) => ({ t: b.t, nowMs: b.t + TF_MS, barUsdt: computeBarUsdtNotional(b) }));
  const vals = rows.map((r) => r.barUsdt).sort((a, b) => a - b);
  const barDist = {
    p50: vals[Math.floor(vals.length * 0.5)],
    p75: vals[Math.floor(vals.length * 0.75)],
    p90: vals[Math.floor(vals.length * 0.9)],
    p95: vals[Math.floor(vals.length * 0.95)],
    p99: vals[Math.floor(vals.length * 0.99)],
  };

  const cand = buildCandidates(barDist);
  const history = [];

  // 初始点：BTC 参数映射到 ETH 量级的中位
  let state = {
    probeM: roundM(barDist.p90 * 0.7),
    minM: roundM(barDist.p90),
    maxM: roundM(barDist.p95 * 0.85),
    tier1_9: 1,
    tier10: 6,
    tier11: 8,
    tier12: 24,
  };

  const evaluate = (s) => {
    const gate = gateFrom(s.probeM, s.minM, s.maxM, fromMs, toMs);
    const tiers = tierFrom(s.tier1_9, s.tier10, s.tier11, s.tier12);
    if (s.tier11 < s.tier10 || s.tier12 < s.tier11) return null;
    return evalConfig(c5, rows, gate, tiers, barDist);
  };

  console.log(`\n=== ETH 分治法寻优 · ${days}d · burst=${BURST_MIN}min ===`);
  console.log(`成交额: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)}`);

  // ── Phase 1: 门控三维逐维优化（默认首注 1/6/8/24）──
  console.log('\n[Phase 1] 门控逐维优化（首注固定 1/6/8/24）');
  const gateDims = [
    ['probeM', cand.probeM],
    ['minM', cand.minM],
    ['maxM', cand.maxM],
  ];
  for (let round = 0; round < 2; round += 1) {
    for (const [dim, values] of gateDims) {
      const step = optimizeDim(dim, values, state, evaluate);
      history.push({ phase: 1, round, ...step });
      if (step.best) {
        console.log(
          `  ${dim} → ${step.chosen}M | PnL $${step.best.pnl.toFixed(0)} ` +
          `gate ${pct(step.best.gateOpenPct)} WR ${pct(step.best.winRate)} score ${step.best.score.toFixed(0)}`,
        );
      }
    }
  }

  // ── Phase 2: 首注四维逐维优化 ──
  console.log('\n[Phase 2] 首注逐维优化（门控固定 Phase1 结果）');
  const tierDims = [
    ['tier1_9', cand.tier1_9],
    ['tier10', cand.tier10],
    ['tier11', cand.tier11.filter((v) => v >= state.tier10)],
    ['tier12', cand.tier12.filter((v) => v >= state.tier11)],
  ];
  for (let round = 0; round < 2; round += 1) {
    for (const [dim, values] of tierDims) {
      const vals2 = dim === 'tier11' ? cand.tier11.filter((v) => v >= state.tier10)
        : dim === 'tier12' ? cand.tier12.filter((v) => v >= state.tier11) : values;
      const step = optimizeDim(dim, vals2, state, evaluate);
      history.push({ phase: 2, round, ...step });
      if (step.best) {
        console.log(
          `  ${dim} → $${step.chosen} | PnL $${step.best.pnl.toFixed(0)} ` +
          `ROI ${pct(step.best.roi)} dd $${step.best.maxDrawdown.toFixed(0)}`,
        );
      }
    }
  }

  // ── Phase 3: 局部 refinement（各维 ± 邻近候选）──
  console.log('\n[Phase 3] 局部 refinement');
  const neighbors = (arr, val) => {
    const idx = arr.indexOf(val);
    const out = [val];
    if (idx > 0) out.push(arr[idx - 1]);
    if (idx >= 0 && idx < arr.length - 1) out.push(arr[idx + 1]);
    return [...new Set(out)];
  };

  for (let round = 0; round < 2; round += 1) {
    for (const [dim, pool] of [
      ['probeM', cand.probeM],
      ['minM', cand.minM],
      ['maxM', cand.maxM],
      ['tier1_9', cand.tier1_9],
      ['tier10', cand.tier10],
      ['tier11', cand.tier11],
      ['tier12', cand.tier12],
    ]) {
      const local = neighbors(pool, state[dim]);
      const step = optimizeDim(dim, local, state, evaluate);
      history.push({ phase: 3, round, ...step });
    }
  }

  const final = evaluate(state);
  const baseline = evaluate({
    probeM: 25, minM: 20, maxM: 37,
    tier1_9: 1, tier10: 6, tier11: 8, tier12: 24,
  });

  const output = {
    days,
    barDist,
    candidates: cand,
    history,
    final: {
      params: state,
      gate: {
        activityProbeUsdtMin: state.probeM * 1e6,
        barVolumeUsdtMinDynamic: state.minM * 1e6,
        barVolumeUsdtMaxDynamic: state.maxM * 1e6,
        volumeBurstMinutes: BURST_MIN,
      },
      tierOpts: tierFrom(state.tier1_9, state.tier10, state.tier11, state.tier12),
      metrics: final,
    },
    btcDefaultsOnEth: baseline,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log('\n=== 分治最优 ===');
  console.log(`ACTIVITY_PROBE_USDT_MIN=${state.probeM * 1e6}`);
  console.log(`BAR_VOLUME_USDT_MIN_DYNAMIC=${state.minM * 1e6}`);
  console.log(`BAR_VOLUME_USDT_MAX_DYNAMIC=${state.maxM * 1e6}`);
  console.log(`VOLUME_BURST_MINUTES=${BURST_MIN}`);
  console.log(`BASE_BET: 1-9=$${state.tier1_9} | 10=$${state.tier10} | 11=$${state.tier11} | 12=$${state.tier12}`);
  if (final) {
    console.log(
      `→ ${final.trades}笔 WR ${pct(final.winRate)} PnL $${final.pnl.toFixed(0)} ` +
      `ROI ${pct(final.roi)} 回撤 $${final.maxDrawdown.toFixed(0)} 门控 ${pct(final.gateOpenPct)}`,
    );
  }
  if (baseline) {
    console.log(`\nBTC默认参数对照: PnL $${baseline.pnl.toFixed(0)} gate ${pct(baseline.gateOpenPct)}`);
  }
  console.log(`\n完整过程: ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
