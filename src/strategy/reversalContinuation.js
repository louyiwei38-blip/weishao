/**
 * Volatility-regime reversal / continuation strategy
 *
 * Production: always low-vol reversal (S1→UP, S2→DOWN).
 *
 * High vol — continuation:
 *   S1: K[-2]=BULL, K[-1]=BEAR  → signal DOWN  (buy NO)
 *   S2: K[-2]=BEAR, K[-1]=BULL  → signal UP    (buy YES)
 *
 * Low vol — reversal (backtest-only; not used in production):
 *   S1 → UP, S2 → DOWN
 *
 * Same direction / DOJI → signal NONE (skip)
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
 * Evaluate signal from candle pattern and volatility regime.
 * @param {{ t: number, open: number, close: number }} kMinus2
 * @param {{ t: number, open: number, close: number }} kMinus1
 * @param {'high' | 'low'} [volRegime='high']
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
  const prevType = classifyCandle(kMinus2);
  const currType = classifyCandle(kMinus1);
  const prev = TYPE_ZH[prevType];
  const curr = TYPE_ZH[currType];
  const mode = volRegime === 'low' ? '低波动反转' : '高波动延续';

  if (prevType === 'BULL' && currType === 'BEAR') {
    const signal = volRegime === 'low' ? 'UP' : 'DOWN';
    const action = signal === 'UP' ? '买涨' : '买跌';
    return {
      signal,
      signalId: 'S1',
      volRegime,
      prevType,
      currType,
      reason: `上上根=${prev}, 上一根=${curr} → ${mode} → S1 ${signal} (${action})`,
    };
  }

  if (prevType === 'BEAR' && currType === 'BULL') {
    const signal = volRegime === 'low' ? 'DOWN' : 'UP';
    const action = signal === 'UP' ? '买涨' : '买跌';
    return {
      signal,
      signalId: 'S2',
      volRegime,
      prevType,
      currType,
      reason: `上上根=${prev}, 上一根=${curr} → ${mode} → S2 ${signal} (${action})`,
    };
  }

  return {
    signal: 'NONE',
    signalId: null,
    volRegime,
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
 * @param {'high' | 'low'} [volRegime='high']
 * @returns {object}
 */
export function buildSignal(kMinus2, kMinus1, symbol, timeframe, volRegime = 'high') {
  const evaluation = evaluateReversalContinuation(kMinus2, kMinus1, volRegime);
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
