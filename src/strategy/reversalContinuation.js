/**
 * Single-candle follow strategy (K[-1] only)
 *
 *   S1: K[-1]=BULL (close > open)  → signal UP    (buy YES)
 *   S2: K[-1]=BEAR (close < open)  → signal DOWN  (buy NO)
 *   DOJI: open = close             → signal NONE   (skip)
 */

/**
 * Classify a candle as BULL / BEAR / DOJI.
 * @param {{ open: number, close: number }} candle
 * @returns {'BULL' | 'BEAR' | 'DOJI'}
 */
export function classifyCandle(candle) {
  if (candle.close > candle.open) return 'BULL';
  if (candle.close < candle.open) return 'BEAR';
  return 'DOJI';
}

/**
 * Evaluate signal from the previous closed candle K[-1].
 * @param {{ t: number, open: number, close: number }} kMinus2 - legacy arg, ignored
 * @param {{ t: number, open: number, close: number }} [kMinus1]
 * @param {'high' | 'low'} [volRegime='high'] - legacy arg, ignored
 * @returns {{
 *   signal: 'UP' | 'DOWN' | 'NONE',
 *   signalId: 'S1' | 'S2' | null,
 *   volRegime: 'high' | 'low',
 *   prevType: string,
 *   currType: string,
 *   reason: string
 * }}
 */
const TYPE_ZH = { BULL: '阳线', BEAR: '阴线', DOJI: '十字星' };

export function evaluateReversalContinuation(kMinus2, kMinus1, volRegime = 'high') {
  const candle = kMinus1 !== undefined ? kMinus1 : kMinus2;
  const currType = classifyCandle(candle);
  const curr = TYPE_ZH[currType];

  if (currType === 'BULL') {
    return {
      signal: 'UP',
      signalId: 'S1',
      volRegime,
      prevType: currType,
      currType,
      reason: `上一根=${curr} → S1 UP (买涨)`,
    };
  }

  if (currType === 'BEAR') {
    return {
      signal: 'DOWN',
      signalId: 'S2',
      volRegime,
      prevType: currType,
      currType,
      reason: `上一根=${curr} → S2 DOWN (买跌)`,
    };
  }

  return {
    signal: 'NONE',
    signalId: null,
    volRegime,
    prevType: currType,
    currType,
    reason: `上一根=${curr} → 十字线，无信号`,
  };
}

/**
 * Build a structured signal object ready for logging and downstream use.
 * @param {object} kMinus1
 * @param {string} symbol
 * @param {string} timeframe
 * @param {'high' | 'low'} [volRegime='high']
 * @returns {object}
 */
export function buildSignal(kMinus1, symbol, timeframe, volRegime = 'high') {
  const evaluation = evaluateReversalContinuation(kMinus1, undefined, volRegime);
  return {
    symbol,
    timeframe,
    evaluatedAt: new Date().toISOString(),
    kMinus1: {
      t: kMinus1.t,
      o: kMinus1.open,
      h: kMinus1.high,
      l: kMinus1.low,
      c: kMinus1.close,
      type: evaluation.currType,
    },
    ...evaluation,
  };
}
