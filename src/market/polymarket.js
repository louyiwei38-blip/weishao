import config from '../config.js';
import logger from '../utils/logger.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { withRetry } from '../utils/retry.js';

const GAMMA_API = config.poly.gammaApi;

/** Simple in-memory cache per cycle boundary */
let cache = { cycleTs: 0, market: null };

/** e.g. BTC/USDT + 1h → btc-updown-1h-1780758600 */
export function buildMarketSlug(windowStartSec, symbol = config.symbol, timeframe = config.timeframe) {
  const [base] = symbol.split('/');
  if (!base) throw new Error(`Invalid TRADING_SYMBOL: ${symbol}`);
  return `${base.toLowerCase()}-updown-${timeframe}-${windowStartSec}`;
}

/**
 * Fetch the configured symbol's Up/Down market for the CURRENT window.
 * Polymarket slug format: {base}-updown-{timeframe}-{windowStartUnixSec}
 *
 * The signal is derived from closed candles and predicts the direction of the
 * window that just opened, so we trade THAT window — the one starting exactly
 * at cycleStartTs.
 *
 * @param {number} cycleStartTs – UTC ms of the cycle boundary that just opened
 * @param {number} [deadlineMs] – abort retries after this timestamp
 */
export async function findCurrentCycleMarket(cycleStartTs, deadlineMs) {
  if (cache.cycleTs === cycleStartTs && cache.market) {
    logger.debug('[market] 使用缓存市场', { slug: cache.market.slug });
    return cache.market;
  }

  // Trade the window that just opened (the one the signal predicts)
  const windowStartMs = cycleStartTs;
  const windowStartSec = Math.floor(windowStartMs / 1000);
  const slug = buildMarketSlug(windowStartSec);

  logger.info('[market] 按 slug 拉取事件', {
    slug,
    symbol: config.symbol,
    windowStart: formatBeijingTime(windowStartMs),
  });

  let parsed;
  try {
    // Retry when Gamma is slow, times out, or the new cycle event is not indexed yet
    // (empty slug response is common in the first seconds after a window opens).
    parsed = await withRetry(
      async () => fetchAndValidateEvent(slug),
      {
        label: 'gamma-event',
        maxAttempts: config.gammaFetchAttempts,
        baseDelayMs: config.gammaFetchRetryDelayMs,
        deadlineMs,
      }
    );
  } catch (err) {
    logger.error('[market] 拉取事件失败', { slug, error: err?.message });
    return null;
  }

  const { event, m, upTokenId, downTokenId, upPrice, downPrice } = parsed;

  const result = {
    conditionId: m.conditionId,
    marketId: m.id,
    question: m.question ?? event.title,
    slug,
    endDate: m.endDate ?? event.endDate,
    yesTokenId: upTokenId,   // UP signal → buy Up token
    noTokenId: downTokenId,  // DOWN signal → buy Down token
    yesPrice: upPrice,
    noPrice: downPrice ?? (upPrice != null ? +(1 - upPrice).toFixed(4) : null),
  };

  logger.info('[market] 匹配到市场', {
    slug: result.slug,
    conditionId: result.conditionId,
    upPrice: result.yesPrice,
    endDate: result.endDate,
  });

  cache = { cycleTs: cycleStartTs, market: result };
  return result;
}

/**
 * Preliminary price cap from Gamma outcomePrices (authoritative check uses CLOB best ask in executor).
 * No range skip — always proceeds.
 * @param {{ yesPrice: number|null, noPrice: number|null }} market
 * @param {'UP' | 'DOWN'} signal
 * @returns {{
 *   proceed: true,
 *   priceCapped: boolean,
 *   yesPrice: number|null,
 *   noPrice: number|null,
 *   originalYesPrice?: number|null,
 *   originalNoPrice?: number|null,
 *   maxLimitPrice?: number
 * }}
 */
export function resolveOrderPricePolicy(market, signal) {
  const originalYesPrice = market.yesPrice;
  const originalNoPrice = market.noPrice ?? (
    originalYesPrice != null ? +(1 - originalYesPrice).toFixed(4) : null
  );
  const cap = config.orderPriceCap;

  const base = {
    proceed: true,
    priceCapped: false,
    yesPrice: originalYesPrice,
    noPrice: originalNoPrice,
    ...(cap > 0 ? { maxLimitPrice: cap } : {}),
  };

  if (!(cap > 0)) return base;

  if (signal === 'UP' && originalYesPrice != null && originalYesPrice > cap) {
    return {
      ...base,
      priceCapped: true,
      yesPrice: cap,
      noPrice: +(1 - cap).toFixed(4),
      originalYesPrice,
      originalNoPrice,
      maxLimitPrice: cap,
    };
  }

  if (signal === 'DOWN' && originalNoPrice != null && originalNoPrice > cap) {
    return {
      ...base,
      priceCapped: true,
      yesPrice: originalYesPrice,
      noPrice: cap,
      originalYesPrice,
      originalNoPrice,
      maxLimitPrice: cap,
    };
  }

  return base;
}

// ─────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────

async function fetchEventBySlug(slug) {
  const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(config.gammaFetchTimeoutMs),
  });

  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  const event = list[0] ?? null;
  logger.debug('[market] Gamma 请求', { slug, ms: Date.now() - t0, found: Boolean(event) });
  return event;
}

/** Fetch slug and validate trade readiness; throws to trigger withRetry. */
async function fetchAndValidateEvent(slug) {
  const event = await fetchEventBySlug(slug);
  if (!event) {
    throw new Error('event not found for slug (may not be indexed yet)');
  }
  if (event.closed || !event.active) {
    throw new Error(`event not tradeable: active=${event.active} closed=${event.closed}`);
  }

  const m = event.markets?.[0];
  if (!m) throw new Error('event has no markets array');

  const { upTokenId, downTokenId, upPrice } = parseUpDownTokens(m);
  if (!upTokenId || !downTokenId) {
    throw new Error(`could not parse Up/Down token IDs: ${m.outcomes}`);
  }

  return { event, m, upTokenId, downTokenId, upPrice };
}

function parseUpDownTokens(market) {
  let tokenIds = market.clobTokenIds ?? market.tokens?.map((t) => t.tokenId);
  if (typeof tokenIds === 'string') {
    try {
      tokenIds = JSON.parse(tokenIds);
    } catch {
      tokenIds = null;
    }
  }

  let outcomes = market.outcomes;
  if (typeof outcomes === 'string') {
    try {
      outcomes = JSON.parse(outcomes);
    } catch {
      outcomes = [];
    }
  }

  let prices = market.outcomePrices;
  if (typeof prices === 'string') {
    try {
      prices = JSON.parse(prices);
    } catch {
      prices = [];
    }
  }

  let upTokenId = null;
  let downTokenId = null;
  let upPrice = null;
  let downPrice = null;

  if (Array.isArray(tokenIds) && Array.isArray(outcomes)) {
    outcomes.forEach((outcome, i) => {
      const label = String(outcome).toUpperCase();
      if (label === 'UP' || label === 'YES') {
        upTokenId = tokenIds[i];
        upPrice = prices?.[i] != null ? Number(prices[i]) : null;
      }
      if (label === 'DOWN' || label === 'NO') {
        downTokenId = tokenIds[i];
        downPrice = prices?.[i] != null ? Number(prices[i]) : null;
      }
    });
  }

  return { upTokenId, downTokenId, upPrice, downPrice };
}

// Settlement uses Chainlink RTDS in src/trader/chainlinkSettle.js;
// exchange OHLCV is kept for signal generation and cross-check only.
