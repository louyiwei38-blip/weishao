import ccxt from 'ccxt';
import config from '../config.js';
import logger from '../utils/logger.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { withRetry } from '../utils/retry.js';

/** Exchanges to try, in order (binance often blocked in CN) */
const EXCHANGE_CHAIN = buildExchangeChain();

function buildExchangeChain() {
  const primary = (config.ohlcvExchange || 'okx').toLowerCase();
  const fallbacks = ['okx', 'bybit', 'binance'];
  const ordered = [primary, ...fallbacks.filter((e) => e !== primary)];
  return [...new Set(ordered)];
}

const exchangeCache = {};

function swapSymbolFrom(symbol) {
  if (symbol.includes(':')) return symbol;
  const [base, quote] = symbol.split('/');
  return `${base}/${quote}:${quote}`;
}

/** CCXT symbol + OKX options for spot or USDT-margined swap. */
export function resolveOhlcvMarket(marketType = config.ohlcvMarketType, symbolOverride = null) {
  const market = (marketType || 'swap').toLowerCase();
  if (market === 'spot') {
    const symbol = symbolOverride || config.ohlcvSymbol || config.symbol;
    return { marketType: 'spot', symbol, okxOptions: {}, label: 'spot' };
  }
  const raw = symbolOverride || config.ohlcvSymbol || config.symbol;
  const symbol = swapSymbolFrom(raw);
  return {
    marketType: 'swap',
    symbol,
    okxOptions: { defaultType: 'swap' },
    label: 'USDT永续',
  };
}

/** Resolved OHLCV source for strategy signals, session gate, and rv candles. */
export function describeOhlcvSource(timeframe = config.timeframe) {
  const market = resolveOhlcvMarket();
  return {
    exchange: config.ohlcvExchange,
    marketType: market.marketType,
    symbol: market.symbol,
    label: market.label,
    timeframe,
  };
}

function getExchangeOptions(exchangeId) {
  if (exchangeId === 'okx' || exchangeId === 'bybit') {
    return resolveOhlcvMarket().okxOptions;
  }
  if (config.ohlcvMarketType === 'swap') {
    return { defaultType: 'swap' };
  }
  return {};
}

function getOhlcvSymbol(_exchangeId) {
  return resolveOhlcvMarket().symbol;
}

function getExchange(id) {
  if (!exchangeCache[id]) {
    const Ctor = ccxt[id];
    if (!Ctor) throw new Error(`Unknown exchange: ${id}`);
    exchangeCache[id] = new Ctor({
      apiKey: config.binance.apiKey || undefined,
      secret: config.binance.secret || undefined,
      enableRateLimit: true,
      timeout: 20_000,
      options: getExchangeOptions(id),
    });
  }
  return exchangeCache[id];
}

/**
 * Internal OHLCV fetch; returns closed candles only.
 * Uses resolveOhlcvMarket() — swap mode → OKX BTC/USDT:USDT 永续 when OHLCV_EXCHANGE=okx.
 */
async function fetchOhlcvCandles(timeframe, limit) {
  const market = resolveOhlcvMarket();
  let lastErr;

  for (const exchangeId of EXCHANGE_CHAIN) {
    try {
      const ex = getExchange(exchangeId);
      const fetchSymbol = getOhlcvSymbol(exchangeId);
      const raw = await withRetry(
        () => ex.fetchOHLCV(fetchSymbol, timeframe, undefined, limit + 1),
        { label: `fetchOHLCV(${exchangeId},${fetchSymbol},${timeframe})`, maxAttempts: 2, baseDelayMs: 1000 }
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
        marketType: market.marketType,
        symbol: fetchSymbol,
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
 * Fetch the most recent closed OHLCV candles for strategy signals (5m).
 */
export async function fetchClosedCandles(limit = config.candleLimit) {
  const candles = await fetchOhlcvCandles(config.timeframe, limit);
  if (candles.length < 2) {
    throw new Error(`too few strategy candles: ${candles.length}`);
  }
  return candles;
}

/**
 * Fetch finer-grained candles for realized-volatility metrics (default 1m, same market).
 */
export async function fetchVolatilityCandles(
  limit = config.volatilityCandleLimit,
  timeframe = config.volatilityBarTimeframe,
) {
  return fetchOhlcvCandles(timeframe, limit);
}

/**
 * Fetch closed 5m candles for session gate volume evaluation (same source as signals).
 */
export async function fetchSessionCandles(limit = config.sessionGate.candleLimit) {
  const candles = await fetchOhlcvCandles(config.timeframe, limit);
  if (candles.length < 2) {
    throw new Error(`too few session candles: ${candles.length}`);
  }
  return candles;
}

/**
 * Fetch a single closed OHLCV candle whose open time equals openTimeMs.
 * Used for OKX-based settlement when the candle is not in the in-memory batch.
 */
export async function fetchClosedCandleAt(openTimeMs) {
  const cycleMs = config.cycleMinutes * 60 * 1000;
  let lastErr;

  for (const exchangeId of EXCHANGE_CHAIN) {
    try {
      const ex = getExchange(exchangeId);
      const fetchSymbol = getOhlcvSymbol(exchangeId);
      const raw = await withRetry(
        () => ex.fetchOHLCV(fetchSymbol, config.timeframe, openTimeMs, 3),
        {
          label: `fetchOHLCV(${exchangeId},${fetchSymbol},at=${openTimeMs})`,
          maxAttempts: 2,
          baseDelayMs: 1000,
        },
      );

      if (!raw?.length) {
        throw new Error(`empty OHLCV @ ${openTimeMs}`);
      }

      const lastOpen = raw[raw.length - 1][0];
      const closed = lastOpen >= openTimeMs + cycleMs ? raw : raw.slice(0, -1);
      const row = closed.find(([t]) => t === openTimeMs);
      if (!row) {
        throw new Error(`candle not found @ ${openTimeMs}`);
      }

      const [t, open, high, low, close, volume] = row;
      return { t, open, high, low, close, volume };
    } catch (err) {
      lastErr = err;
      logger.warn(`[collector] ${exchangeId} 单根 K 线拉取失败`, {
        openTimeMs,
        error: err?.message,
      });
    }
  }

  throw lastErr ?? new Error(`fetchClosedCandleAt failed @ ${openTimeMs}`);
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
