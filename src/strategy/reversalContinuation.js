/**
 * Volatility-gated continuation strategy
 *
 * Only trades when volatility is high (rv_5m >= threshold OR rv_15m >= threshold).
 * Low volatility cycles are skipped upstream in index.js.
 *
 * High vol — continuation:
 *   S1: K[-2]=BULL, K[-1]=BEAR  → signal DOWN  (buy NO)
 *   S2: K[-2]=BEAR, K[-1]=BULL  → signal UP    (buy YES)
 *
 * Same direction / DOJI → signal NONE (skip)
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
 * Evaluate continuation signal from candle pattern.
 * @param {{ t: number, open: number, close: number }} kMinus2
 * @param {{ t: number, open: number, close: number }} kMinus1
 * @returns {{
 *   signal: 'UP' | 'DOWN' | 'NONE',
 *   signalId: 'S1' | 'S2' | null,
 *   volRegime: 'high',
 *   prevType: string,
 *   currType: string,
 *   reason: string
 * }}
 */
const TYPE_ZH = { BULL: '阳线', BEAR: '阴线', DOJI: '十字星' };

export function evaluateReversalContinuation(kMinus2, kMinus1) {
  const prevType = classifyCandle(kMinus2);
  const currType = classifyCandle(kMinus1);
  const prev = TYPE_ZH[prevType];
  const curr = TYPE_ZH[currType];

  if (prevType === 'BULL' && currType === 'BEAR') {
    return {
      signal: 'DOWN',
      signalId: 'S1',
      volRegime: 'high',
      prevType,
      currType,
      reason: `上上根=${prev}, 上一根=${curr} → 高波动延续 → S1 DOWN (买跌)`,
    };
  }

  if (prevType === 'BEAR' && currType === 'BULL') {
    return {
      signal: 'UP',
      signalId: 'S2',
      volRegime: 'high',
      prevType,
      currType,
      reason: `上上根=${prev}, 上一根=${curr} → 高波动延续 → S2 UP (买涨)`,
    };
  }

  return {
    signal: 'NONE',
    signalId: null,
    volRegime: 'high',
    prevType,
    currType,
    reason: `上上根=${prev}, 上一根=${curr} → 同向/十字线，无信号`,
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
