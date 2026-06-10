import { classifyCandle, evaluateReversalContinuation } from '../../src/strategy/reversalContinuation.js';
import { computeSignalVolatility } from '../../src/utils/volatility.js';

export const MARTINGALE_MAX = 4;
export const RV_THRESH = 0;

export function atr(candles, idx, period = 14) {
  if (idx < period) return null;
  const trs = [];
  for (let i = idx - period + 1; i <= idx; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

export function er20(candles, idx) {
  if (idx < 20) return null;
  let path = 0;
  for (let i = idx - 19; i <= idx; i += 1) {
    path += Math.abs(candles[i].close - candles[i - 1].close);
  }
  if (path === 0) return 0;
  return Math.abs(candles[idx].close - candles[idx - 20].close) / path;
}

export function rollingPivot(candles, idx, lookback = 48) {
  const start = Math.max(0, idx - lookback + 1);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= idx; i += 1) {
    hi = Math.max(hi, candles[i].high);
    lo = Math.min(lo, candles[i].low);
  }
  return { pivotHigh: hi, pivotLow: lo, pivotMid: (hi + lo) / 2 };
}

export function pivotCrossCount(candles, idx, pivot, lookback = 12) {
  const start = idx - lookback + 1;
  if (start < 1) return null;
  let count = 0;
  for (let i = start; i <= idx; i += 1) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    if ((prev - pivot) * (curr - pivot) < 0) count += 1;
  }
  return count;
}

export function bodyRatio(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

export function wickDominance(candle, direction) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBot = Math.min(candle.open, candle.close);
  const upper = candle.high - bodyTop;
  const lower = bodyBot - candle.low;
  if (direction === 'UP') return lower / range;
  if (direction === 'DOWN') return upper / range;
  return Math.max(upper, lower) / range;
}

export function prevSameDirStreak(candles, idx) {
  const type = classifyCandle(candles[idx]);
  if (type === 'DOJI') return 0;
  let streak = 1;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (classifyCandle(candles[i]) !== type) break;
    streak += 1;
  }
  return streak;
}

function avgPastVolume(candles5m, idx, lookback) {
  const start = idx - lookback;
  if (start < 0) return null;
  let sum = 0;
  for (let j = start; j < idx; j += 1) {
    const v = Number(candles5m[j]?.volume);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / lookback;
}

function nearestPivot(close, pivots) {
  const dists = [
    { val: pivots.pivotHigh, d: Math.abs(close - pivots.pivotHigh) },
    { val: pivots.pivotMid, d: Math.abs(close - pivots.pivotMid) },
    { val: pivots.pivotLow, d: Math.abs(close - pivots.pivotLow) },
  ];
  dists.sort((a, b) => a.d - b.d);
  return dists[0].val;
}

export function build1mIndex(candles1m) {
  const times = candles1m.map((c) => c.t);
  return {
    candles: candles1m,
    times,
    slice(endTs, count = 20) {
      let end = times.length;
      for (let i = times.length - 1; i >= 0; i -= 1) {
        if (times[i] <= endTs) { end = i + 1; break; }
      }
      return candles1m.slice(Math.max(0, end - count), end);
    },
  };
}

export function computeTradeFactors(candles5m, idx1m, i, rvHistory) {
  const k2 = candles5m[i - 1];
  const k1 = candles5m[i];
  const pivots = rollingPivot(candles5m, i);
  const pivot = nearestPivot(k1.close, pivots);
  const atr14 = atr(candles5m, i, 14);
  const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
  const vol = computeSignalVolatility(slice1m, '1m');
  const rv5Now = vol.rv_5m;
  const rv5T3 = rvHistory[i - 3] ?? null;
  const eval_ = evaluateReversalContinuation(k2, k1, 'high');
  const signalDir = eval_.signal === 'NONE' ? null : eval_.signal;

  const breakoutRaw = signalDir === 'UP' ? k1.close - pivot
    : signalDir === 'DOWN' ? pivot - k1.close : 0;

  let bodyMean6 = null;
  if (i >= 5) {
    let sum = 0;
    for (let j = i - 5; j <= i; j += 1) sum += bodyRatio(candles5m[j]);
    bodyMean6 = sum / 6;
  }

  let rangeComp = null;
  if (i >= 11 && atr14) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - 11; j <= i; j += 1) {
      hi = Math.max(hi, candles5m[j].high);
      lo = Math.min(lo, candles5m[j].low);
    }
    rangeComp = (hi - lo) / atr14;
  }

  const k1Vol = Number(k1.volume);
  const avgVol5 = avgPastVolume(candles5m, i, 5);
  const avgVol20 = avgPastVolume(candles5m, i, 20);
  const vol3Ago = Number(candles5m[i - 3]?.volume);

  return {
    t: k1.t + 5 * 60_000,
    k1t: k1.t,
    signalId: eval_.signalId,
    signal: eval_.signal,
    rv_1m: vol.rv_1m,
    rv_5m: rv5Now,
    rv_15m: vol.rv_15m,
    rv_ratio: rv5Now != null && vol.rv_15m ? rv5Now / vol.rv_15m : null,
    rv_accel: rv5Now != null && rv5T3 ? rv5Now / rv5T3 : null,
    atr_5m_14: atr14,
    atr_pct: atr14 != null ? atr14 / k1.close : null,
    ER_20: er20(candles5m, i),
    pivot_cross_count_12: pivotCrossCount(candles5m, i, pivot, 12),
    range_compression: rangeComp,
    body_ratio_mean_6: bodyMean6,
    signal_body_pct: bodyRatio(k1),
    signal_wick_dominance: signalDir ? wickDominance(k1, signalDir) : null,
    prev_same_dir_streak: prevSameDirStreak(candles5m, i - 1),
    breakout_dist: atr14 ? breakoutRaw / atr14 : null,
    vol_ratio_5: Number.isFinite(k1Vol) && avgVol5 ? k1Vol / avgVol5 : null,
    vol_ratio_20: Number.isFinite(k1Vol) && avgVol20 ? k1Vol / avgVol20 : null,
    vol_accel: Number.isFinite(k1Vol) && Number.isFinite(vol3Ago) && vol3Ago > 0
      ? k1Vol / vol3Ago : null,
  };
}

export function simulateMartingale(trades) {
  let streak = 0;
  const out = [];
  for (const t of trades) {
    let halted = false;
    let lossStreakPos = 0;
    if (t.won) {
      streak = 0;
    } else {
      streak += 1;
      lossStreakPos = streak;
      if (streak >= MARTINGALE_MAX) {
        halted = true;
        streak = 0;
      }
    }
    out.push({
      ...t,
      lossStreakPos,
      martingaleHalted: halted,
      inHaltStreak: !t.won && lossStreakPos > 0,
    });
  }
  return out;
}

export function applyFilterStats(trades, fn, minCoverage = 0) {
  const kept = trades.filter(fn);
  const coverage = kept.length / (trades.length || 1);
  if (coverage < minCoverage) return null;

  let streak = 0;
  let halts = 0;
  let wins = 0;
  let pnl = 0;
  let haltStreakTrades = 0;

  for (const t of kept) {
    pnl += t.pnlUsd;
    if (t.won) {
      wins += 1;
      streak = 0;
    } else {
      streak += 1;
      if (streak >= 1) haltStreakTrades += 1;
      if (streak >= MARTINGALE_MAX) {
        halts += 1;
        streak = 0;
      }
    }
  }

  const baseline = summarizeTrades(trades);
  return {
    kept: kept.length,
    skipped: trades.length - kept.length,
    coverage,
    winRate: kept.length ? wins / kept.length : 0,
    halts,
    pnl,
    roi: pnl / (kept.length * 0.5 || 1),
    haltStreakTrades,
    haltReduction: baseline.halts ? 1 - halts / baseline.halts : 0,
    pnlDelta: pnl - baseline.pnl,
    winRateDelta: (kept.length ? wins / kept.length : 0) - baseline.winRate,
  };
}

export function summarizeTrades(trades) {
  let streak = 0;
  let halts = 0;
  let wins = 0;
  let pnl = 0;
  for (const t of trades) {
    pnl += t.pnlUsd;
    if (t.won) { wins += 1; streak = 0; }
    else {
      streak += 1;
      if (streak >= MARTINGALE_MAX) { halts += 1; streak = 0; }
    }
  }
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    halts,
    pnl,
    roi: pnl / (trades.length * 0.5 || 1),
  };
}
