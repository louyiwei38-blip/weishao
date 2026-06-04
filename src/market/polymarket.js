import config from '../config.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const GAMMA_API = config.poly.gammaApi;
const CYCLE_MS = config.cycleMinutes * 60 * 1000;

/** Simple in-memory cache per cycle boundary */
let cache = { cycleTs: 0, market: null };

/**
 * Fetch the BTC 5-minute Up/Down market for the NEXT window.
 * Polymarket slug format: btc-updown-5m-{windowStartUnixSec}
 *
 * @param {number} cycleStartTs – UTC ms of the 5m boundary that just closed
 */
export async function findNextCycleMarket(cycleStartTs) {
  if (cache.cycleTs === cycleStartTs && cache.market) {
    logger.debug('[market] using cached market', { slug: cache.market.slug });
    return cache.market;
  }

  // Next window starts one cycle after the boundary we triggered on
  const windowStartMs = cycleStartTs + CYCLE_MS;
  const windowStartSec = Math.floor(windowStartMs / 1000);
  const slug = `btc-updown-5m-${windowStartSec}`;

  logger.info('[market] fetching event by slug', {
    slug,
    windowStart: new Date(windowStartMs).toISOString(),
  });

  let event;
  try {
    event = await withRetry(
      () => fetchEventBySlug(slug),
      { label: 'gamma-event', maxAttempts: 3, baseDelayMs: 1000 }
    );
  } catch (err) {
    logger.error('[market] failed to fetch event', { slug, error: err?.message });
    return null;
  }

  if (!event) {
    logger.warn('[market] no BTC 5M event for slug', { slug });
    return null;
  }

  if (event.closed || !event.active) {
    logger.warn('[market] event not tradeable', {
      slug,
      active: event.active,
      closed: event.closed,
    });
    return null;
  }

  const m = event.markets?.[0];
  if (!m) {
    logger.warn('[market] event has no markets array', { slug });
    return null;
  }

  const { upTokenId, downTokenId, upPrice } = parseUpDownTokens(m);
  if (!upTokenId || !downTokenId) {
    logger.warn('[market] could not parse Up/Down token IDs', { slug, outcomes: m.outcomes });
    return null;
  }

  const result = {
    conditionId: m.conditionId,
    marketId: m.id,
    question: m.question ?? event.title,
    slug,
    endDate: m.endDate ?? event.endDate,
    yesTokenId: upTokenId,   // UP signal → buy Up token
    noTokenId: downTokenId,  // DOWN signal → buy Down token
    yesPrice: upPrice,
    noPrice: upPrice != null ? +(1 - upPrice).toFixed(4) : null,
  };

  logger.info('[market] matched market', {
    slug: result.slug,
    conditionId: result.conditionId,
    upPrice: result.yesPrice,
    endDate: result.endDate,
  });

  cache = { cycleTs: cycleStartTs, market: result };
  return result;
}

/**
 * Validate that the Up token price is within the acceptable range.
 */
export function isPriceAcceptable(yesPrice) {
  if (!config.skipIfYesPriceOutOfRange) return true;
  if (yesPrice === null) return true;
  return yesPrice >= config.yesPriceMin && yesPrice <= config.yesPriceMax;
}

// ─────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────

async function fetchEventBySlug(slug) {
  const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  return list[0] ?? null;
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

  if (Array.isArray(tokenIds) && Array.isArray(outcomes)) {
    outcomes.forEach((outcome, i) => {
      const label = String(outcome).toUpperCase();
      if (label === 'UP' || label === 'YES') {
        upTokenId = tokenIds[i];
        upPrice = prices?.[i] != null ? Number(prices[i]) : null;
      }
      if (label === 'DOWN' || label === 'NO') {
        downTokenId = tokenIds[i];
      }
    });
  }

  return { upTokenId, downTokenId, upPrice };
}

/**
 * Poll until market resolves; calls onSettled(won).
 */
export async function pollUntilResolved(conditionId, signal, onSettledCb, {
  pollIntervalMs = 30_000,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    try {
      const url = `${GAMMA_API}/markets?condition_id=${conditionId}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;

      const data = await res.json();
      const m = Array.isArray(data) ? data[0] : data;
      if (!m?.closed && !m?.resolved) continue;

      let outcomes = m.outcomes;
      let prices = m.outcomePrices;
      if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
      if (typeof prices === 'string') prices = JSON.parse(prices);

      const winnerIdx = prices
        ?.map((p, i) => ({ p: Number(p), outcome: outcomes?.[i] }))
        ?.sort((a, b) => b.p - a.p)?.[0];

      const winning = String(winnerIdx?.outcome ?? '').toUpperCase();
      const betSide = signal === 'UP' ? 'UP' : 'DOWN';
      const won = winning === betSide || winning === (betSide === 'UP' ? 'YES' : 'NO');

      logger.info('[market] resolved', { conditionId, winning, signal, won });
      onSettledCb(won);
      return;
    } catch (err) {
      logger.debug('[market] poll error', { conditionId, error: err?.message });
    }
  }

  logger.warn('[market] resolution polling timed out', { conditionId });
}
