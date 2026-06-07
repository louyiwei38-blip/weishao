/**
 * Previous-candle follow strategy
 *
 * S1: K[-1]=BULL  → signal UP   (buy YES / 买涨)
 * S2: K[-1]=BEAR  → signal DOWN (buy NO / 买跌)
 *     K[-1]=DOJI   → signal NONE (skip)
 *
 * All functions are pure — no side-effects, safe for offline backtesting.
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
 * Evaluate signal from the most recent closed candle.
 * @param {{ t: number, open: number, close: number }} kMinus2  – kept for logging context
 * @param {{ t: number, open: number, close: number }} kMinus1  – previous closed candle (上一根K线)
 * @returns {{
 *   signal: 'UP' | 'DOWN' | 'NONE',
 *   signalId: 'S1' | 'S2' | null,
 *   prevType: string,
 *   currType: string,
 *   reason: string
 * }}
 */
const TYPE_ZH = { BULL: '阳线', BEAR: '阴线', DOJI: '十字星' };

export function evaluateReversalContinuation(kMinus2, kMinus1) {
  const prevType = classifyCandle(kMinus2);
  const currType = classifyCandle(kMinus1);
  const curr = TYPE_ZH[currType];

  if (currType === 'BULL') {
    return {
      signal: 'UP',
      signalId: 'S1',
      prevType,
      currType,
      reason: `上一根=${curr} → 当前盘口买涨`,
    };
  }

  if (currType === 'BEAR') {
    return {
      signal: 'DOWN',
      signalId: 'S2',
      prevType,
      currType,
      reason: `上一根=${curr} → 当前盘口买跌`,
    };
  }

  return {
    signal: 'NONE',
    signalId: null,
    prevType,
    currType,
    reason: `上一根=${curr} → 十字星跳过`,
  };
}

/**
 * Build a structured signal object ready for logging and downstream use.
 * @param {object} kMinus2
 * @param {object} kMinus1
 * @param {string} symbol
 * @param {string} timeframe
 * @returns {object}
 */
export function buildSignal(kMinus2, kMinus1, symbol, timeframe) {
  const evaluation = evaluateReversalContinuation(kMinus2, kMinus1);
  return {
    symbol,
    timeframe,
    evaluatedAt: new Date().toISOString(),
    kMinus2: {
      t: kMinus2.t,
      o: kMinus2.open,
      h: kMinus2.high,
      l: kMinus2.low,
      c: kMinus2.close,
      type: evaluation.prevType,
    },
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
