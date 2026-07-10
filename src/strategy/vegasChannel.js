/**
 * Vegas channel (EMA144 / EMA169) cross-entry strategy for 1h Polymarket up/down.
 *
 *   Channel: lower = min(EMA144, EMA169), upper = max(EMA144, EMA169)
 *   Body above: min(open, close) > upper
 *   Body below: max(open, close) < lower
 *   From above: prev body above + curr low <= upper  → UP
 *   From below: prev body below + curr high >= lower → DOWN
 */

import logger from '../utils/logger.js';

export const EMA_FAST = 144;
export const EMA_SLOW = 169;

/**
 * Standard EMA series (null until period bars available).
 * @param {number[]} closes
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function computeEma(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  out[period - 1] = ema;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/**
 * @param {{ open: number, high: number, low: number, close: number, t?: number }[]} candles
 * @returns {({ ema144: number, ema169: number, upper: number, lower: number }|null)[]}
 */
export function vegasBands(candles) {
  const closes = candles.map((c) => c.close);
  const ema144 = computeEma(closes, EMA_FAST);
  const ema169 = computeEma(closes, EMA_SLOW);

  return candles.map((_, i) => {
    const a = ema144[i];
    const b = ema169[i];
    if (a == null || b == null) return null;
    return {
      ema144: a,
      ema169: b,
      upper: Math.max(a, b),
      lower: Math.min(a, b),
    };
  });
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
      reason: 'EMA 通道尚未就绪',
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
 * Evaluate cross-entry on the two most recent closed candles.
 */
export function evaluateVegasEntry(candles) {
  if (!candles || candles.length < EMA_SLOW + 1) {
    return {
      signal: 'NONE',
      signalId: null,
      reason: `K 线不足（需 ≥ ${EMA_SLOW + 1}，当前 ${candles?.length ?? 0}）`,
      bands: null,
      prevOutside: null,
      kMinus2: null,
      kMinus1: null,
    };
  }
  return evaluateVegasEntryAt(candles, vegasBands(candles), candles.length - 1);
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
 * Whether the latest closed candle body is fully outside the channel.
 */
export function latestBodyOutside(candles) {
  if (!candles || candles.length < EMA_SLOW) {
    return { outside: false, side: null, bands: null, candle: null };
  }
  const bands = vegasBands(candles);
  return bodyOutsideAt(candles, bands, candles.length - 1);
}

/**
 * Build a structured signal object for logging / Telegram.
 * @param {object[]} candles
 * @param {string} symbol
 * @param {string} timeframe
 * @param {object} [evaluation] — optional precomputed evaluateVegasEntry result
 */
export function buildSignal(candles, symbol, timeframe, evaluation = null) {
  const ev = evaluation ?? evaluateVegasEntry(candles);
  const kMinus2 = ev.kMinus2;
  const kMinus1 = ev.kMinus1;
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
    bands: ev.bands,
    prevOutside: ev.prevOutside,
    signal: ev.signal,
    signalId: ev.signalId,
    reason: ev.reason,
  };
}
