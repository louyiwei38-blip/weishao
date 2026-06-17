import config from '../../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../../src/trader/fillSync.js';
import { activityHitsToTier, resolveTierBaseBet, formatTierParamLabel } from '../../src/martingale/dynamicBaseBet.js';

export const TF_MS = 5 * 60_000;
export const MARTINGALE_MAX = config.martingaleMaxLosses;
export const MULTIPLIER = config.martingaleMultiplier;
export const ENTRY_PRICE = 0.5;
export const ACTIVITY_WINDOW = config.sessionGate.activityWindowBars;

export function roundM(v) {
  return Math.round(v / 100_000) / 10;
}

export function fmtM(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n / 1e6).toFixed(1)}M`;
}

export function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

export function barUsdtDistribution(rows) {
  const vals = rows.map((r) => r.barUsdt).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return null;
  const at = (p) => vals[Math.floor(p * (vals.length - 1))];
  return { p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), p99: at(0.99) };
}

export function buildCandidates(barDist) {
  if (!barDist) {
    return {
      probeM: [10, 15, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50],
      tier1_9: [1, 2, 3],
      tier10: [4, 5, 6, 8, 10],
      tier11: [6, 8, 10, 12, 16],
      tier12: [12, 16, 20, 24, 32],
    };
  }
  const { p50, p75, p90, p95 } = barDist;
  const uniq = (arr) => [...new Set(arr.map((v) => roundM(v)))].sort((a, b) => a - b);
  return {
    probeM: uniq([
      p50 * 0.4, p50 * 0.55, p50 * 0.7, p50 * 0.85, p50,
      p75 * 0.6, p75 * 0.75, p75 * 0.9, p75,
      p90 * 0.55, p90 * 0.7, p90 * 0.85, p90,
      p95 * 0.65, p95 * 0.8, p95, 25,
    ]).filter((m) => m >= 3),
    tier1_9: [1, 2, 3],
    tier10: [4, 5, 6, 8, 10],
    tier11: [6, 8, 10, 12, 16],
    tier12: [12, 16, 20, 24, 32],
  };
}

/** Fine probe grid for ROI curve (step ~0.5M–1M). */
export function buildFineProbeGrid(barDist, stepM = 1) {
  const lo = roundM(barDist.p50 * 0.4);
  const hi = roundM(barDist.p95 * 1.05);
  const out = [];
  for (let m = lo; m <= hi + 0.01; m += stepM) {
    out.push(roundM(m * 1e6));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function computeActivityFreqLocal(c5, idx, probeUsdt) {
  const windowBars = Math.min(ACTIVITY_WINDOW, idx + 1);
  const startIdx = idx - windowBars + 1;
  let hits = 0;
  for (let i = startIdx; i <= idx; i += 1) {
    const usdt = computeBarUsdtNotional(c5[i]);
    if (usdt != null && usdt >= probeUsdt) hits += 1;
  }
  return { hits, windowBars, freq: windowBars > 0 ? hits / windowBars : 0 };
}

export function buildAlwaysOnTrades(c5, fromMs, toMs) {
  const raw = [];
  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;
    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');
    raw.push({ t: tradeTs, k1t: k1.t, won });
  }
  return raw;
}

export function stateToTierOpts(s) {
  return {
    tier1_9Usd: s.tier1_9,
    tier10Usd: s.tier10,
    tier11Usd: s.tier11,
    tier12Usd: s.tier12,
  };
}

export function formatState(s) {
  return `probe=${s.probeM}M | ${formatTierParamLabel(stateToTierOpts(s))}`;
}

export function stateKey(s) {
  return `${s.probeM}|${s.tier1_9}|${s.tier10}|${s.tier11}|${s.tier12}`;
}

export function cloneState(s) {
  return { probeM: s.probeM, tier1_9: s.tier1_9, tier10: s.tier10, tier11: s.tier11, tier12: s.tier12 };
}

export function isValidState(s) {
  return s.tier11 >= s.tier10 && s.tier12 >= s.tier11 && s.probeM > 0;
}

export function simulateMartingale(trades, c5, { fixedBase = null, tierOpts = null, probeUsdt = null } = {}) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const probe = probeUsdt ?? config.sessionGate.activityProbeUsdtMin;

  let consecutiveLosses = 0;
  let currentBet = fixedBase ?? tierOpts?.tier1_9Usd ?? config.tradeBudgetUsd;
  let skipNext = false;
  let halts = 0;
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  let tradesCount = 0;
  let wins = 0;
  let hotTierTrades = 0;

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      continue;
    }

    let tier = null;
    if (consecutiveLosses === 0) {
      if (fixedBase != null) {
        currentBet = fixedBase;
      } else if (tierOpts) {
        const idx = idxByT.get(t.k1t) ?? 0;
        const { hits, windowBars } = computeActivityFreqLocal(c5, idx, probe);
        tier = activityHitsToTier(hits, windowBars);
        currentBet = resolveTierBaseBet(tier, tierOpts);
        if (tier >= 10) hotTierTrades += 1;
      }
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
  };
}

export function evaluateState(s, trades, c5, objective = 'balanced') {
  if (!isValidState(s)) return null;
  const m = simulateMartingale(trades, c5, {
    tierOpts: stateToTierOpts(s),
    probeUsdt: s.probeM * 1e6,
  });
  return {
    ...m,
    score: scoreMetrics(m, objective),
    objective,
  };
}

/** @param {'pnl'|'roi'|'balanced'|'sharpe'} objective */
export function scoreMetrics(m, objective = 'balanced') {
  if (!m || m.trades < 100) return -Infinity;
  switch (objective) {
    case 'roi':
      return m.roi * 10000 + m.pnl * 0.01;
    case 'pnl':
      return m.pnl - m.maxDrawdown * 0.08;
    case 'sharpe':
      return m.roi * 8000 + m.pnl * 0.05 - m.maxDrawdown * 0.12;
    default:
      return m.pnl - m.maxDrawdown * 0.15 - m.halts * 8;
  }
}

export function envLines(s) {
  return [
    `ACTIVITY_PROBE_USDT_MIN=${s.probeM * 1e6}`,
    `BASE_BET_TIER1_9_USD=${s.tier1_9}`,
    `BASE_BET_TIER10_USD=${s.tier10}`,
    `BASE_BET_TIER11_USD=${s.tier11}`,
    `BASE_BET_TIER12_USD=${s.tier12}`,
  ];
}
