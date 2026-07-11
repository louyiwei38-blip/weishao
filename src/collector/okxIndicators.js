/**
 * OKX technical indicators API — Vegas channel EMA144/169.
 * Endpoint: POST /api/v5/aigc/mcp/indicators (public, no auth).
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { resolveOhlcvMarket } from './binance.js';
import { EMA_FAST, EMA_SLOW, bandFromEma } from '../strategy/vegasChannel.js';

const OKX_INDICATORS_URL = 'https://www.okx.com/api/v5/aigc/mcp/indicators';
const MAX_LIMIT = 100;

/** Project timeframe → OKX indicator bar */
const BAR_MAP = {
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
};

/**
 * CCXT-style symbol → OKX instId.
 * e.g. BNB/USDT:USDT → BNB-USDT-SWAP, BNB/USDT → BNB-USDT
 */
export function toOkxInstId(symbolOverride = null, marketType = config.ohlcvMarketType) {
  const market = resolveOhlcvMarket(marketType, symbolOverride);
  const [base, rest] = market.symbol.split('/');
  const quote = (rest || 'USDT').split(':')[0];
  if (market.marketType === 'swap') return `${base}-${quote}-SWAP`;
  return `${base}-${quote}`;
}

export function toOkxBar(timeframe = config.timeframe) {
  const key = String(timeframe || '').trim().toLowerCase();
  const bar = BAR_MAP[key];
  if (!bar) {
    throw new Error(
      `OKX 指标不支持 timeframe=${timeframe}（支持: ${Object.keys(BAR_MAP).join(', ')}）`,
    );
  }
  return bar;
}

/**
 * Raw EMA points from OKX (newest last).
 * @returns {Promise<{ ts: number, ema144: number, ema169: number }[]>}
 */
export async function fetchOkxEmaPoints({
  instId = toOkxInstId(),
  bar = toOkxBar(),
  periods = [EMA_FAST, EMA_SLOW],
  limit = 20,
  backtestTime = null,
} = {}) {
  const capped = Math.min(Math.max(1, Number(limit) || 20), MAX_LIMIT);
  const body = {
    instId,
    timeframes: [bar],
    indicators: {
      EMA: {
        paramList: periods,
        returnList: true,
        limit: capped,
      },
    },
  };
  if (backtestTime != null && Number.isFinite(Number(backtestTime))) {
    body.backtestTime = Number(backtestTime);
  }

  const payload = await withRetry(
    async () => {
      const res = await fetch(OKX_INDICATORS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OKX indicators HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json();
      if (String(json.code) !== '0') {
        throw new Error(`OKX indicators code=${json.code} msg=${json.msg || json.error_message || ''}`);
      }
      return json;
    },
    { label: `okxEma(${instId},${bar})`, maxAttempts: 3, baseDelayMs: 400 },
  );

  const root = payload?.data?.[0]?.data?.[0];
  const series = root?.timeframes?.[bar]?.indicators?.EMA;
  if (!Array.isArray(series)) {
    throw new Error(`OKX EMA 响应缺少序列 (${instId} ${bar})`);
  }

  const fastKey = String(EMA_FAST);
  const slowKey = String(EMA_SLOW);
  const out = [];
  for (const row of series) {
    const ts = Number(row.ts);
    const v = row.values || {};
    const a = Number(v[fastKey]);
    const b = Number(v[slowKey]);
    if (!Number.isFinite(ts) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push({ ts, ema144: a, ema169: b });
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/**
 * Align OKX EMA points onto candle open times → vegas band array (null where missing).
 */
export function alignEmaToCandles(candles, emaPoints) {
  const byTs = new Map();
  for (const p of emaPoints) {
    byTs.set(p.ts, bandFromEma(p.ema144, p.ema169));
  }
  return candles.map((c) => byTs.get(c.t) ?? null);
}

/**
 * Live / recent: pull latest OKX EMA and align to candles (only recent bars filled).
 * Enough for signal logic which only needs the last 2 closed bars.
 */
export async function fetchOkxVegasBands(candles, opts = {}) {
  if (!candles?.length) return [];

  const instId = opts.instId ?? toOkxInstId(opts.symbol ?? null);
  const bar = opts.bar ?? toOkxBar(opts.timeframe ?? config.timeframe);
  const limit = Math.min(opts.limit ?? 30, MAX_LIMIT);

  const points = await fetchOkxEmaPoints({
    instId,
    bar,
    periods: [EMA_FAST, EMA_SLOW],
    limit,
    backtestTime: opts.backtestTime ?? null,
  });

  const bands = alignEmaToCandles(candles, points);
  const last = bands.at(-1);
  const prev = bands.at(-2);
  logger.debug('[okx-ema] 维加斯通道已对齐', {
    instId,
    bar,
    points: points.length,
    lastBand: last,
    prevReady: prev != null,
    lastCandleT: candles.at(-1)?.t,
  });

  if (!last || !prev) {
    logger.warn('[okx-ema] 最近 K 线未能对齐 OKX EMA', {
      instId,
      bar,
      lastCandleT: candles.at(-1)?.t,
      prevCandleT: candles.at(-2)?.t,
      emaFirst: points[0]?.ts,
      emaLast: points.at(-1)?.ts,
    });
  }

  return bands;
}

/**
 * Full-history bands for backtests: page OKX EMA (max 100/req) via backtestTime.
 * @param {object[]} candles — ascending by t
 * @param {{ instId?: string, bar?: string, onProgress?: (n: number) => void }} [opts]
 */
export async function fetchOkxVegasBandsHistory(candles, opts = {}) {
  if (!candles?.length) return [];

  const instId = opts.instId ?? toOkxInstId(opts.symbol ?? null);
  const bar = opts.bar ?? toOkxBar(opts.timeframe ?? config.timeframe);
  const byTs = new Map();

  let cursor = (candles.at(-1)?.t ?? Date.now()) + 1;
  const oldestNeed = candles[0].t;
  let pages = 0;
  let emptyStreak = 0;

  while (true) {
    const points = await fetchOkxEmaPoints({
      instId,
      bar,
      periods: [EMA_FAST, EMA_SLOW],
      limit: MAX_LIMIT,
      backtestTime: cursor,
    });

    if (!points.length) {
      emptyStreak += 1;
      if (emptyStreak >= 3) break;
      cursor -= MAX_LIMIT * guessBarMs(bar);
      continue;
    }
    emptyStreak = 0;

    for (const p of points) {
      if (!byTs.has(p.ts)) byTs.set(p.ts, bandFromEma(p.ema144, p.ema169));
    }

    pages += 1;
    opts.onProgress?.(byTs.size);

    const pageOldest = points[0].ts;
    if (pageOldest <= oldestNeed) break;
    if (pageOldest >= cursor) break;
    cursor = pageOldest - 1;

    // gentle rate limit
    await new Promise((r) => setTimeout(r, 80));
    if (pages > 50_000) {
      throw new Error('OKX EMA 历史分页过多，已中止');
    }
  }

  logger.info('[okx-ema] 历史通道拉取完成', {
    instId,
    bar,
    pages,
    emaPoints: byTs.size,
    candles: candles.length,
  });

  return candles.map((c) => byTs.get(c.t) ?? null);
}

function guessBarMs(bar) {
  const m = String(bar).match(/^(\d+)(m|H|D)/i);
  if (!m) return 60 * 60_000;
  const n = Number(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'M') return n * 60_000;
  if (u === 'H') return n * 60 * 60_000;
  if (u === 'D') return n * 24 * 60 * 60_000;
  return 60 * 60_000;
}
