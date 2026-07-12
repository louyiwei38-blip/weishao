import config from '../config.js';
import logger from '../utils/logger.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { withRetry } from '../utils/retry.js';

const GAMMA_API = config.poly.gammaApi;
const ET_TZ = 'America/New_York';

/** Polymarket 1h slugs use full asset names, not ticker abbreviations. */
const HOURLY_SLUG_ASSET_NAMES = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'bnb',
  XRP: 'xrp',
  DOGE: 'dogecoin',
};

/** Simple in-memory cache per cycle boundary */
let cache = { cycleTs: 0, market: null };

function hourlySlugAssetName(symbol) {
  const [base] = symbol.split('/');
  if (!base) throw new Error(`Invalid TRADING_SYMBOL: ${symbol}`);
  return HOURLY_SLUG_ASSET_NAMES[base.toUpperCase()] ?? base.toLowerCase();
}

/** Build ET hour label for 1h slug, e.g. "9am", "10pm". */
function formatHourlySlugParts(windowStartMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(new Date(windowStartMs));

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    month: get('month').toLowerCase(),
    day: get('day'),
    year: get('year'),
    hourLabel: `${get('hour').toLowerCase()}${get('dayPeriod').toLowerCase()}`,
  };
}

function buildHourlyMarketSlug(windowStartMs, symbol, includeYear = false) {
  const name = hourlySlugAssetName(symbol);
  const { month, day, year, hourLabel } = formatHourlySlugParts(windowStartMs);
  if (includeYear) {
    return `${name}-up-or-down-${month}-${day}-${year}-${hourLabel}-et`;
  }
  return `${name}-up-or-down-${month}-${day}-${hourLabel}-et`;
}

/**
 * Return slug candidates for the current window (tried in order).
 * 5m/15m/4h: {base}-updown-{tf}-{unix}
 * 1h: {name}-up-or-down-{month}-{day}[-{year}]-{hour}{am|pm}-et (ET boundaries)
 */
export function buildMarketSlugCandidates(
  windowStartMs,
  symbol = config.symbol,
  timeframe = config.timeframe,
) {
  const [base] = symbol.split('/');
  if (!base) throw new Error(`Invalid TRADING_SYMBOL: ${symbol}`);

  if (timeframe === '1h') {
    return [
      buildHourlyMarketSlug(windowStartMs, symbol, false),
      buildHourlyMarketSlug(windowStartMs, symbol, true),
    ];
  }

  const windowStartSec = Math.floor(windowStartMs / 1000);
  return [`${base.toLowerCase()}-updown-${timeframe}-${windowStartSec}`];
}

/** @deprecated Prefer buildMarketSlugCandidates — 1h returns the primary ET slug only. */
export function buildMarketSlug(windowStartSec, symbol = config.symbol, timeframe = config.timeframe) {
  return buildMarketSlugCandidates(windowStartSec * 1000, symbol, timeframe)[0];
}

/**
 * Fetch the configured symbol's Up/Down market for the CURRENT window.
 *
 * Slug formats:
 * - 5m / 15m / 4h: {base}-updown-{timeframe}-{windowStartUnixSec}
 * - 1h: {name}-up-or-down-{month}-{day}[-{year}]-{hour}{am|pm}-et (US Eastern)
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

  const windowStartMs = cycleStartTs;
  const slugCandidates = buildMarketSlugCandidates(windowStartMs);

  logger.info('[market] 按 slug 拉取事件', {
    slug: slugCandidates[0],
    slugCandidates,
    symbol: config.symbol,
    timeframe: config.timeframe,
    windowStart: formatBeijingTime(windowStartMs),
  });

  let parsed;
  try {
    parsed = await withRetry(
      async () => fetchAndValidateEventCandidates(slugCandidates),
      {
        label: 'gamma-event',
        maxAttempts: config.gammaFetchAttempts,
        baseDelayMs: config.gammaFetchRetryDelayMs,
        deadlineMs,
      }
    );
  } catch (err) {
    logger.error('[market] 拉取事件失败', { slugCandidates, error: err?.message });
    return null;
  }

  const { event, m, upTokenId, downTokenId, upPrice, downPrice, slug } = parsed;

  const result = {
    conditionId: m.conditionId,
    marketId: m.id,
    question: m.question ?? event.title,
    slug,
    endDate: m.endDate ?? event.endDate,
    yesTokenId: upTokenId,
    noTokenId: downTokenId,
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

/** Try slug candidates in order; throws the last error to trigger withRetry. */
async function fetchAndValidateEventCandidates(slugCandidates) {
  let lastErr;
  for (const slug of slugCandidates) {
    try {
      const parsed = await fetchAndValidateEvent(slug);
      return { ...parsed, slug };
    } catch (err) {
      lastErr = err;
      logger.debug('[market] slug 未命中，尝试下一个', { slug, error: err?.message });
    }
  }
  throw lastErr ?? new Error('no slug candidates');
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
