import ccxt from 'ccxt';
import config from '../config.js';
import logger from '../utils/logger.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { withRetry } from '../utils/retry.js';

/** Exchanges to try, in order (binance often blocked in CN) */
const EXCHANGE_CHAIN = buildExchangeChain();

function buildExchangeChain() {
  const primary = (config.ohlcvExchange || 'binance').toLowerCase();
  const fallbacks = ['okx', 'bybit', 'binance'];
  const ordered = [primary, ...fallbacks.filter((e) => e !== primary)];
  return [...new Set(ordered)];
}

const exchangeCache = {};

function getExchange(id) {
  if (!exchangeCache[id]) {
    const Ctor = ccxt[id];
    if (!Ctor) throw new Error(`Unknown exchange: ${id}`);
    exchangeCache[id] = new Ctor({
      apiKey: config.binance.apiKey || undefined,
      secret: config.binance.secret || undefined,
      enableRateLimit: true,
      timeout: 20_000,
    });
  }
  return exchangeCache[id];
}

/**
 * Internal OHLCV fetch; returns closed candles only.
 */
async function fetchOhlcvCandles(symbol, timeframe, limit) {
  let lastErr;

  for (const exchangeId of EXCHANGE_CHAIN) {
    try {
      const ex = getExchange(exchangeId);
      const raw = await withRetry(
        () => ex.fetchOHLCV(symbol, timeframe, undefined, limit + 1),
        { label: `fetchOHLCV(${exchangeId},${timeframe})`, maxAttempts: 2, baseDelayMs: 1000 }
      );

      if (!raw || raw.length < 2) {
        throw new Error(`too few candles: ${raw?.length}`);
      }

      const closed = raw.slice(0, -1);
      const candles = closed.map(([t, open, high, low, close, volume]) => ({
        t, open, high, low, close, volume,
      }));

      if (exchangeId !== EXCHANGE_CHAIN[0]) {
        logger.warn('[collector] 使用备用交易所', {
          exchange: exchangeId,
          primary: EXCHANGE_CHAIN[0],
          timeframe,
        });
      }

      logger.debug('[collector] K 线已拉取', {
        exchange: exchangeId,
        timeframe,
        count: candles.length,
        last: candles.at(-1),
      });

      return candles;
    } catch (err) {
      lastErr = err;
      logger.warn(`[collector] ${exchangeId} 拉取失败`, {
        timeframe,
        error: err?.message,
      });
    }
  }

  throw lastErr ?? new Error(`all OHLCV exchanges failed (${timeframe})`);
}

/**
 * Fetch the most recent closed OHLCV candles for the strategy timeframe.
 */
export async function fetchClosedCandles(limit = config.candleLimit) {
  const candles = await fetchOhlcvCandles(config.symbol, config.timeframe, limit);
  if (candles.length < 2) {
    throw new Error(`too few strategy candles: ${candles.length}`);
  }
  return candles;
}

/**
 * Fetch finer-grained candles for realized-volatility risk checks.
 */
export async function fetchVolatilityCandles(
  limit = config.volatilityCandleLimit,
  timeframe = config.volatilityBarTimeframe,
) {
  return fetchOhlcvCandles(config.symbol, timeframe, limit);
}

/**
 * Validate candle timestamp aligns with expected 5m boundary.
 */
export function isCandleFresh(candle, cycleMs) {
  const nowMs = Date.now();
  const expectedOpenMs =
    Math.floor((nowMs - config.signalDelayMs) / cycleMs) * cycleMs - cycleMs;
  const diff = Math.abs(candle.t - expectedOpenMs);
  if (diff > cycleMs) {
    logger.warn('[collector] K 线时间戳不匹配', {
      candleT: formatBeijingTime(candle.t),
      expectedT: formatBeijingTime(expectedOpenMs),
      diffMs: diff,
    });
    return false;
  }
  return true;
}
