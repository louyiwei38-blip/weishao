/**
 * Real-time volume metrics for offline backtests (no per-trade filter in production).
 */

/** 288 × 5m = 24h rolling window */
export const ROLLING_24H_BARS = 288;
/** 1h short window for period ratio */
export const PERIOD_SHORT_BARS = 12;
/** 8h long window for period ratio */
export const PERIOD_LONG_BARS = 96;

function roundUsdt(n) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(0));
}

function roundRatio(n) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

/**
 * Rolling 24h USDT notional: Σ(base_volume × close) over last 288 closed 5m bars.
 * Computable at every 5m close — no UTC day-boundary lag.
 * @param {Array<{ volume: number, close: number }>} candles5m
 * @param {number} idx index of the signal bar (K[-1])
 */
export function computeRolling24hUsdt(candles5m, idx) {
  if (!Array.isArray(candles5m) || idx < ROLLING_24H_BARS - 1) return null;
  let sum = 0;
  for (let j = idx - ROLLING_24H_BARS + 1; j <= idx; j += 1) {
    const v = Number(candles5m[j]?.volume);
    const close = Number(candles5m[j]?.close);
    if (!Number.isFinite(v) || !Number.isFinite(close)) return null;
    sum += v * close;
  }
  return roundUsdt(sum);
}

/**
 * Period volume ratio: avg(base_volume, shortBars) / avg(base_volume, longBars).
 * Updates every 5m; proxies intraday volume regime without waiting for EOD totals.
 */
export function computePeriodVolRatio(
  candles5m,
  idx,
  shortBars = PERIOD_SHORT_BARS,
  longBars = PERIOD_LONG_BARS,
) {
  if (!Array.isArray(candles5m) || idx < longBars - 1) return null;

  let shortSum = 0;
  let longSum = 0;
  for (let j = idx - shortBars + 1; j <= idx; j += 1) {
    const v = Number(candles5m[j]?.volume);
    if (!Number.isFinite(v)) return null;
    shortSum += v;
  }
  for (let j = idx - longBars + 1; j <= idx; j += 1) {
    const v = Number(candles5m[j]?.volume);
    if (!Number.isFinite(v)) return null;
    longSum += v;
  }
  const shortAvg = shortSum / shortBars;
  const longAvg = longSum / longBars;
  if (longAvg <= 0) return null;
  return roundRatio(shortAvg / longAvg);
}

/**
 * Snapshot volume metrics at the last candle index.
 * @param {Array<{ volume: number, close: number }>} candles5m closed 5m bars, oldest first
 */
export function buildVolumeSnapshot(candles5m) {
  if (!Array.isArray(candles5m) || candles5m.length === 0) {
    return { rolling24hUsdt: null, periodVolRatio: null, barIndex: null };
  }
  const idx = candles5m.length - 1;
  return {
    barIndex: idx,
    rolling24hUsdt: computeRolling24hUsdt(candles5m, idx),
    periodVolRatio: computePeriodVolRatio(candles5m, idx),
  };
}
