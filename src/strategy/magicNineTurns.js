/**
 * TD Sequential "Magic Nine Turns" (神奇九转) setup detection.
 *
 * Buy Setup:  9 consecutive closes < close 4 bars ago → trade UP on the next bar
 * Sell Setup: 9 consecutive closes > close 4 bars ago → trade DOWN on the next bar
 *
 * Evaluation uses the latest *closed* candle as setup bar N. When that bar
 * completes count===9, the current cycle is the "next bar" entry.
 */

export const MIN_SIGNAL_CANDLES = 13; // 9 setup + 4 lookback

/**
 * Consecutive setup count ending at index `idx`.
 * @param {Array<{ close: number }>} candles
 * @param {number} idx
 * @param {'buy'|'sell'} dir
 */
export function countSetupEndingAt(candles, idx, dir) {
  if (!Array.isArray(candles) || idx < 4) return 0;
  let count = 0;
  for (let i = idx; i >= 4; i -= 1) {
    const c = Number(candles[i]?.close);
    const c4 = Number(candles[i - 4]?.close);
    if (!Number.isFinite(c) || !Number.isFinite(c4)) break;
    const ok = dir === 'buy' ? c < c4 : c > c4;
    if (!ok) break;
    count += 1;
  }
  return count;
}

/**
 * @param {Array<{ t?: number, open?: number, high?: number, low?: number, close: number }>} candles
 * @param {number} idx index of latest closed bar (setup completion bar)
 * @returns {{ signal: 'UP'|'DOWN'|'NONE', signalId: string|null, reason: string, buyCount: number, sellCount: number }}
 */
export function evaluateMagicNineAt(candles, idx) {
  const buyCount = countSetupEndingAt(candles, idx, 'buy');
  const sellCount = countSetupEndingAt(candles, idx, 'sell');

  if (buyCount === 9) {
    return {
      signal: 'UP',
      signalId: 'JZ_UP',
      reason: `Buy Setup 九转: 连续9根收盘 < 4根前收盘 → 本周期买涨(反转)`,
      buyCount,
      sellCount,
    };
  }
  if (sellCount === 9) {
    return {
      signal: 'DOWN',
      signalId: 'JZ_DOWN',
      reason: `Sell Setup 九转: 连续9根收盘 > 4根前收盘 → 本周期买跌(反转)`,
      buyCount,
      sellCount,
    };
  }

  return {
    signal: 'NONE',
    signalId: null,
    reason:
      buyCount > 0 || sellCount > 0
        ? `九转未完成 (买Setup=${buyCount}/9 · 卖Setup=${sellCount}/9)`
        : '九转无 Setup 计数',
    buyCount,
    sellCount,
  };
}

export function buildJzSignal(candles, symbol, timeframe, evaluation) {
  const last = candles?.at(-1) ?? null;
  const prev = candles?.length > 1 ? candles[candles.length - 2] : null;
  return {
    symbol,
    timeframe,
    evaluatedAt: new Date().toISOString(),
    kMinus2: prev
      ? { t: prev.t, o: prev.open, h: prev.high, l: prev.low, c: prev.close }
      : null,
    kMinus1: last
      ? { t: last.t, o: last.open, h: last.high, l: last.low, c: last.close }
      : null,
    bands: null,
    prevOutside: null,
    signal: evaluation.signal,
    signalId: evaluation.signalId,
    reason: evaluation.reason,
    buyCount: evaluation.buyCount,
    sellCount: evaluation.sellCount,
  };
}
