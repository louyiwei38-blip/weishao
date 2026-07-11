/**
 * Vegas channel (EMA144 / EMA169) cross-entry strategy.
 *
 * Channel bands come from OKX indicators API (see collector/okxIndicators.js):
 *   upper = max(EMA144, EMA169), lower = min(EMA144, EMA169)
 *   Body above: min(open, close) > upper
 *   Body below: max(open, close) < lower
 *   From above: prev body above + curr low <= upper  → UP
 *   From below: prev body below + curr high >= lower → DOWN
 */

import logger from '../utils/logger.js';

export const EMA_FAST = 144;
export const EMA_SLOW = 169;

/** Minimum closed candles needed once OKX EMA is available (prev + curr). */
export const MIN_SIGNAL_CANDLES = 2;

/**
 * @param {number} ema144
 * @param {number} ema169
 */
export function bandFromEma(ema144, ema169) {
  return {
    ema144,
    ema169,
    upper: Math.max(ema144, ema169),
    lower: Math.min(ema144, ema169),
  };
}

/**
 * @param {{ open: number, close: number }} candle
 * @param {number} upper
 * @param {number} lower
 * @returns {'above' | 'below' | null}
 */
export function bodyOutside(candle, upper, lower) {
  const bodyLow = Math.min(candle.open, candle.close);
  const bodyHigh = Math.max(candle.open, candle.close);
  if (bodyLow > upper) return 'above';
  if (bodyHigh < lower) return 'below';
  return null;
}

/**
 * @param {{ high: number, low: number }} curr
 * @param {number} upper
 * @param {number} lower
 * @param {'above' | 'below'} side
 */
export function wickEntersFrom(curr, upper, lower, side) {
  if (side === 'above') return curr.low <= upper;
  if (side === 'below') return curr.high >= lower;
  return false;
}

/**
 * Evaluate cross-entry at candle index iCurr (K[-1]), using precomputed bands.
 * @param {object[]} candles
 * @param {({ upper: number, lower: number }|null)[]} bands
 * @param {number} iCurr
 */
export function evaluateVegasEntryAt(candles, bands, iCurr) {
  const iPrev = iCurr - 1;
  if (iPrev < 0 || iCurr >= candles.length) {
    return {
      signal: 'NONE',
      signalId: null,
      reason: 'K 线索引无效',
      bands: null,
      prevOutside: null,
      kMinus2: null,
      kMinus1: null,
    };
  }

  const bandPrev = bands[iPrev];
  const bandCurr = bands[iCurr];
  const kMinus2 = candles[iPrev];
  const kMinus1 = candles[iCurr];

  if (!bandPrev || !bandCurr) {
    return {
      signal: 'NONE',
      signalId: null,
      reason: 'OKX EMA 通道尚未对齐到最近 K 线',
      bands: bandCurr,
      prevOutside: null,
      kMinus2,
      kMinus1,
    };
  }

  const prevOut = bodyOutside(kMinus2, bandPrev.upper, bandPrev.lower);
  const fromAbove =
    prevOut === 'above' && wickEntersFrom(kMinus1, bandCurr.upper, bandCurr.lower, 'above');
  const fromBelow =
    prevOut === 'below' && wickEntersFrom(kMinus1, bandCurr.upper, bandCurr.lower, 'below');

  if (fromAbove && fromBelow) {
    logger.warn('[vegas] 异常：同时满足上穿与下穿，跳过', {
      prevOut,
      low: kMinus1.low,
      high: kMinus1.high,
      upper: bandCurr.upper,
      lower: bandCurr.lower,
    });
    return {
      signal: 'NONE',
      signalId: null,
      reason: '异常：同时满足上穿与下穿，跳过',
      bands: bandCurr,
      prevOutside: prevOut,
      kMinus2,
      kMinus1,
    };
  }

  if (fromAbove) {
    return {
      signal: 'UP',
      signalId: 'VG_UP',
      reason:
        `上一根实体在通道上方 (upper=${bandPrev.upper.toFixed(2)})，` +
        `本根影线入通道 (low=${kMinus1.low.toFixed(2)} ≤ ${bandCurr.upper.toFixed(2)}) → UP`,
      bands: bandCurr,
      prevOutside: 'above',
      kMinus2,
      kMinus1,
    };
  }

  if (fromBelow) {
    return {
      signal: 'DOWN',
      signalId: 'VG_DOWN',
      reason:
        `上一根实体在通道下方 (lower=${bandPrev.lower.toFixed(2)})，` +
        `本根影线入通道 (high=${kMinus1.high.toFixed(2)} ≥ ${bandCurr.lower.toFixed(2)}) → DOWN`,
      bands: bandCurr,
      prevOutside: 'below',
      kMinus2,
      kMinus1,
    };
  }

  const sideZh = prevOut === 'above' ? '上方' : prevOut === 'below' ? '下方' : '通道内/贴边';
  return {
    signal: 'NONE',
    signalId: null,
    reason: `无穿越入场（上一根实体在${sideZh}，本根影线未入通道）`,
    bands: bandCurr,
    prevOutside: prevOut,
    kMinus2,
    kMinus1,
  };
}

/**
 * Body-outside check at index i with precomputed bands.
 */
export function bodyOutsideAt(candles, bands, i) {
  const band = bands[i];
  const candle = candles[i];
  if (!band || !candle) return { outside: false, side: null, bands: null, candle: candle ?? null };
  const side = bodyOutside(candle, band.upper, band.lower);
  return { outside: side != null, side, bands: band, candle };
}

/**
 * Build a structured signal object for logging / Telegram.
 * @param {object[]} candles
 * @param {string} symbol
 * @param {string} timeframe
 * @param {object} [evaluation] — precomputed evaluateVegasEntryAt result (required)
 */
export function buildSignal(candles, symbol, timeframe, evaluation) {
  if (!evaluation) {
    throw new Error('buildSignal requires a precomputed evaluation (OKX EMA bands)');
  }
  const kMinus2 = evaluation.kMinus2;
  const kMinus1 = evaluation.kMinus1;
  return {
    symbol,
    timeframe,
    evaluatedAt: new Date().toISOString(),
    kMinus2: kMinus2
      ? {
          t: kMinus2.t,
          o: kMinus2.open,
          h: kMinus2.high,
          l: kMinus2.low,
          c: kMinus2.close,
        }
      : null,
    kMinus1: kMinus1
      ? {
          t: kMinus1.t,
          o: kMinus1.open,
          h: kMinus1.high,
          l: kMinus1.low,
          c: kMinus1.close,
        }
      : null,
    bands: evaluation.bands,
    prevOutside: evaluation.prevOutside,
    signal: evaluation.signal,
    signalId: evaluation.signalId,
    reason: evaluation.reason,
  };
}
