/**
 * OKX OHLCV fetch + cache (spot or USDT-margined perpetual swap).
 */
import ccxt from 'ccxt';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../../src/config.js';
import { resolveOhlcvMarket } from '../../src/collector/binance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', '..', 'logs');
const TF_MS = 5 * 60_000;

export function cachePathForMarket(marketType = config.ohlcvMarketType, symbol = null) {
  const ctx = resolveOhlcvMarket(marketType, symbol);
  const slug = ctx.symbol.replace(/[/:]/g, '-').toLowerCase();
  return marketType === 'swap'
    ? join(OUT_DIR, `ohlcv-5m-okx-swap-${slug}-cache.json`)
    : join(OUT_DIR, `ohlcv-5m-${slug}-cache.json`);
}

export async function fetchAllCandles(exchange, symbol, timeframe, since, until) {
  const all = [];
  let cursor = since;
  while (cursor < until) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, cursor, 300);
    if (!batch.length) break;
    for (const row of batch) {
      const [t, o, h, l, c, v] = row;
      if (t >= until) break;
      all.push({ t, open: o, high: h, low: l, close: c, volume: v });
    }
    const lastT = batch.at(-1)[0];
    if (lastT <= cursor) break;
    cursor = lastT + TF_MS;
    await new Promise((r) => setTimeout(r, 80));
  }
  const dedup = new Map(all.map((c) => [c.t, c]));
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

export async function ensureOkxCandles({
  fromMs,
  toMs,
  forceFetch = false,
  warmupMs = 5 * 24 * 60 * 60_000,
  marketType = config.ohlcvMarketType,
  symbol = null,
} = {}) {
  const ctx = resolveOhlcvMarket(marketType, symbol);
  const needSince = fromMs - warmupMs;
  const cacheFile = cachePathForMarket(ctx.marketType, symbol ?? ctx.symbol);
  let c5 = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : [];
  const cacheStart = c5[0]?.t ?? Infinity;
  const cacheEnd = c5.at(-1)?.t ?? 0;
  const tolerateMs = 2 * 60 * 60_000;
  const covers = c5.length && cacheStart <= needSince && cacheEnd >= toMs - tolerateMs;

  const fmtTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

  if (covers && !forceFetch) {
    console.log(`Using ${ctx.label} cache: ${fmtTs(cacheStart)} → ${fmtTs(cacheEnd)} (${c5.length} bars)`);
    return { c5, ...ctx };
  }

  console.log(`Fetching OKX ${ctx.label} ${ctx.symbol} 5m ${fmtTs(needSince)} → ${fmtTs(toMs)} ...`);
  const ex = new ccxt.okx({ enableRateLimit: true, timeout: 60_000, options: ctx.okxOptions });
  c5 = await fetchAllCandles(ex, ctx.symbol, '5m', needSince, toMs);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(c5));
  console.log(`Fetched ${c5.length} bars (${ctx.label})`);
  return { c5, ...ctx };
}
