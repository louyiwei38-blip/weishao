import { classifyCandle, evaluateReversalContinuation } from '../../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../../src/trader/fillSync.js';
import { activityHitsToTier, resolveTierBaseBet } from '../../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../../src/collector/binance.js';
import { ensureOkxCandles } from './okxOhlcv.js';

export const TF_MS = 5 * 60_000;
export const MARTINGALE_MAX = 4;
export const MULTIPLIER = 2;
export const ENTRY_PRICE = 0.5;
export const ACTIVITY_WINDOW = 12;
export const BURST_MIN = 21;

export function roundM(v) {
  return Math.round(v / 100_000) / 10;
}

export function fmtM(n) {
  return `${(n / 1e6).toFixed(1)}M`;
}

export function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

export function buildCandidates(barDist) {
  const { p50, p75, p90, p95 } = barDist;
  const uniq = (arr) => [...new Set(arr.map((v) => roundM(v)))].sort((a, b) => a - b);
  return {
    probeM: uniq([p50 * 0.7, p50, p75 * 0.85, p75, p90 * 0.7, p90, p95 * 0.85, p95 * 0.7]),
    minM: uniq([p50 * 0.8, p50, p75 * 0.75, p75, p90 * 0.75, p90, p95 * 0.65]),
    maxM: uniq([p90 * 0.9, p90, p95 * 0.75, p95 * 0.85, p95]).filter((m) => m <= p95 / 1e6 * 1.02),
    tier1_9: [1, 2, 3],
    tier10: [4, 5, 6, 8, 10, 12],
    tier11: [6, 8, 10, 12, 16],
    tier12: [12, 16, 20, 24, 32],
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

function runMartingale(c5, trades, gate, tierOpts) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let ls = 0;
  let skip = false;
  let halts = 0;
  let bet = tierOpts.tier1_9Usd;
  let pnl = 0;
  let peak = 0;
  let dd = 0;
  let stake = 0;
  let winCount = 0;

  for (const t of trades) {
    if (skip) { skip = false; ls = 0; continue; }
    if (ls === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { hits, windowBars } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
      bet = resolveTierBaseBet(activityHitsToTier(hits, windowBars), tierOpts);
    }
    const s = bet;
    const p = t.won ? (calcWinNetProfit(s, ENTRY_PRICE) ?? s) : -s;
    pnl += p;
    stake += s;
    peak = Math.max(peak, pnl);
    dd = Math.max(dd, peak - pnl);
    if (t.won) { winCount += 1; ls = 0; }
    else {
      ls += 1;
      if (ls >= MARTINGALE_MAX) { halts += 1; ls = 0; skip = true; }
      else bet *= MULTIPLIER;
    }
  }

  return { halts, pnl, maxDrawdown: dd, roi: stake > 0 ? pnl / stake : 0, winCount, trades: trades.length };
}

export function isValidState(s, barDist) {
  if (s.minM >= s.maxM) return false;
  if (s.maxM > barDist.p95 / 1e6 * 1.02) return false;
  if (s.tier11 < s.tier10 || s.tier12 < s.tier11) return false;
  return true;
}

export function scoreMetrics(m, barDist, maxM) {
  return m.pnl - m.maxDrawdown * 0.35 - m.halts * 8 - (maxM > barDist.p95 / 1e6 ? 50 : 0);
}

export function createEvaluator(ctx) {
  const { c5, rows, barDist, fromMs, toMs } = ctx;
  const gateCache = new Map();

  function gateBundle(probeM, minM, maxM) {
    const key = `${probeM}|${minM}|${maxM}`;
    if (gateCache.has(key)) return gateCache.get(key);
    const gate = {
      activityProbeUsdtMin: probeM * 1e6,
      barVolumeUsdtMinDynamic: minM * 1e6,
      barVolumeUsdtMaxDynamic: maxM * 1e6,
      volumeBurstMinutes: BURST_MIN,
    };
    const tl = simulateBurstTimeline(c5, rows, gate);
    const open = tl.filter((x) => x.ok).length / (tl.length || 1);
    const trades = buildTrades(c5, tl, fromMs, toMs);
    const bundle = { gate, open, trades };
    gateCache.set(key, bundle);
    return bundle;
  }

  return function evaluate(s) {
    if (!isValidState(s, barDist)) return null;
    const { gate, open, trades } = gateBundle(s.probeM, s.minM, s.maxM);
    if (open < 0.06 || open > 0.4) return null;
    const tierOpts = {
      tier1_9Usd: s.tier1_9,
      tier10Usd: s.tier10,
      tier11Usd: s.tier11,
      tier12Usd: s.tier12,
    };
    const m = runMartingale(c5, trades, gate, tierOpts);
    const score = scoreMetrics(m, barDist, s.maxM);
    return {
      gateOpenPct: open,
      trades: m.trades,
      winRate: m.trades ? m.winCount / m.trades : 0,
      halts: m.halts,
      pnl: m.pnl,
      maxDrawdown: m.maxDrawdown,
      roi: m.roi,
      score,
    };
  };
}

export function stateKey(s) {
  return `${s.probeM}|${s.minM}|${s.maxM}|${s.tier1_9}|${s.tier10}|${s.tier11}|${s.tier12}`;
}

export function cloneState(s) {
  return { ...s };
}

export function formatState(s) {
  return `probe=${s.probeM}M min=${s.minM}M max=${s.maxM}M tiers=${s.tier1_9}/${s.tier10}/${s.tier11}/${s.tier12}`;
}

export function formatEnv(s) {
  return [
    `ACTIVITY_PROBE_USDT_MIN=${s.probeM * 1e6}`,
    `BAR_VOLUME_USDT_MIN_DYNAMIC=${s.minM * 1e6}`,
    `BAR_VOLUME_USDT_MAX_DYNAMIC=${s.maxM * 1e6}`,
    `VOLUME_BURST_MINUTES=${BURST_MIN}`,
    `# BASE_BET: 1-9=$${s.tier1_9} | 10=$${s.tier10} | 11=$${s.tier11} | 12=$${s.tier12}`,
  ].join('\n');
}

export async function loadEthContext(days, forceFetch = false) {
  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;
  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch,
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
  const candidates = buildCandidates(barDist);
  const ctx = { c5, rows, barDist, fromMs, toMs, candidates };
  const evaluate = createEvaluator(ctx);
  return { ctx, evaluate };
}
