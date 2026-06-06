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
 * Fetch the most recent closed 5m OHLCV candles for BTC/USDT.
 */
export async function fetchClosedCandles(limit = config.candleLimit) {
  const symbol = config.symbol;
  const timeframe = config.timeframe;
  let lastErr;

  for (const exchangeId of EXCHANGE_CHAIN) {
    try {
      const ex = getExchange(exchangeId);
      const raw = await withRetry(
        () => ex.fetchOHLCV(symbol, timeframe, undefined, limit + 1),
        { label: `fetchOHLCV(${exchangeId})`, maxAttempts: 2, baseDelayMs: 1000 }
      );

      if (!raw || raw.length < 3) {
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
        });
      }

      logger.debug('[collector] K 线已拉取', {
        exchange: exchangeId,
        count: candles.length,
        last: candles.at(-1),
      });

      return candles;
    } catch (err) {
      lastErr = err;
      logger.warn(`[collector] ${exchangeId} 拉取失败`, { error: err?.message });
    }
  }

  throw lastErr ?? new Error('all OHLCV exchanges failed');
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
