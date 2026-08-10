/**
 * Polymarket Gamma/CLOB helpers for historical entry prices (crypto Up/Down windows).
 * Uses curl.exe + optional HTTP(S)_PROXY / --proxy= so China hosts can reach Polymarket.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { buildMarketSlugCandidates } from '../../src/market/polymarket.js';

const execFileAsync = promisify(execFile);

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/** @type {string|null} */
let proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || null;

export function setPmProxy(url) {
  proxyUrl = url || null;
}

export function resolveDefaultProxy() {
  if (proxyUrl) return proxyUrl;
  return process.env.PM_PROXY || 'http://127.0.0.1:7897';
}

async function curlJson(url, { timeoutSec = 30 } = {}) {
  const proxy = resolveDefaultProxy();
  const args = ['-sS', '--connect-timeout', '15', '-m', String(timeoutSec)];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  const { stdout } = await execFileAsync('curl.exe', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (!stdout) return null;
  return JSON.parse(stdout);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function parseJsonField(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

export function parseUpDownTokens(market) {
  const tokenIds = parseJsonField(market.clobTokenIds) ?? market.tokens?.map((t) => t.tokenId);
  const outcomes = parseJsonField(market.outcomes) ?? [];
  const prices = parseJsonField(market.outcomePrices) ?? [];

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

export async function fetchEventBySlug(slug) {
  const data = await curlJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list[0] ?? null;
}

/**
 * Resolve Up/Down token ids for a cycle window (allows closed historical markets).
 */
export async function resolveWindowMarket(cycleStartMs, { base, timeframe, symbol }) {
  const sym = symbol || `${String(base).toUpperCase()}/USDT`;
  const slugs = buildMarketSlugCandidates(cycleStartMs, sym, timeframe);
  for (const slug of slugs) {
    const event = await fetchEventBySlug(slug);
    if (!event?.markets?.[0]) continue;
    const m = event.markets[0];
    const tokens = parseUpDownTokens(m);
    if (!tokens.upTokenId || !tokens.downTokenId) continue;
    return {
      slug,
      conditionId: m.conditionId,
      closed: Boolean(event.closed),
      ...tokens,
    };
  }
  return null;
}

/**
 * @returns {Promise<{ t: number, p: number }[]>}
 */
export async function fetchPricesHistory(tokenId, startTsSec, endTsSec, fidelity = 1) {
  const url =
    `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}` +
    `&startTs=${startTsSec}&endTs=${endTsSec}&fidelity=${fidelity}`;
  const data = await curlJson(url);
  const hist = data?.history;
  return Array.isArray(hist) ? hist.map((h) => ({ t: Number(h.t), p: Number(h.p) })) : [];
}

/**
 * Entry simulation matching live FOK+cap mode:
 * - first ask <= cap → market fill at that price
 * - first ask > cap → limit@cap; fill if any later tick <= cap else unfilled force-win
 */
export function simulateCapEntry(history, {
  cap = 0.55,
  entryDelaySec = 3,
  windowStartSec,
} = {}) {
  if (!history?.length) {
    return { ok: false, reason: 'no_history' };
  }
  const sorted = [...history].sort((a, b) => a.t - b.t);
  const afterOpen = sorted.filter((h) => h.t >= windowStartSec + entryDelaySec - 1);
  const series = afterOpen.length ? afterOpen : sorted;
  const first = series[0];
  if (!(first.p > 0 && first.p < 1)) {
    return { ok: false, reason: 'bad_price', first };
  }

  if (first.p <= cap) {
    return {
      ok: true,
      filled: true,
      forceWin: false,
      entryPrice: first.p,
      mode: 'market',
      askAtEntry: first.p,
      ticks: series.length,
    };
  }

  const touch = series.find((h) => h.p <= cap);
  if (touch) {
    return {
      ok: true,
      filled: true,
      forceWin: false,
      entryPrice: cap,
      mode: 'limit_fill',
      askAtEntry: first.p,
      fillTs: touch.t,
      ticks: series.length,
    };
  }

  return {
    ok: true,
    filled: false,
    forceWin: true,
    entryPrice: cap,
    mode: 'unfilled_force_win',
    askAtEntry: first.p,
    ticks: series.length,
  };
}

/**
 * Disk-cached resolver: market meta + side entry simulation for one intent.
 */
export async function resolveIntentEntryPrice(intent, {
  cacheDir,
  cap = 0.55,
  entryDelaySec = 3,
  forceRefresh = false,
} = {}) {
  ensureDir(cacheDir);
  const key = `${intent.stream}-${intent.signalBarT}-${intent.signal}`;
  const cacheFile = join(cacheDir, `${key}.json`);
  if (!forceRefresh && existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }

  // Trade the settle window (same as live cycleStartTs for that bar).
  const tradeWindowMs = intent.settleBarT ?? intent.signalBarT;
  const tradeWindowSec = Math.floor(tradeWindowMs / 1000);
  const tfSec =
    intent.timeframe === '5m' ? 300 : intent.timeframe === '15m' ? 900 : 3600;

  let market;
  try {
    market = await resolveWindowMarket(tradeWindowMs, {
      base: intent.base,
      timeframe: intent.timeframe,
      symbol: intent.symbol,
    });
  } catch (err) {
    const out = { ok: false, reason: `gamma:${err?.message || err}`, key };
    writeFileSync(cacheFile, JSON.stringify(out));
    return out;
  }

  if (!market) {
    const out = { ok: false, reason: 'market_not_found', key, tradeWindowSec };
    writeFileSync(cacheFile, JSON.stringify(out));
    return out;
  }

  const tokenId = intent.signal === 'UP' ? market.upTokenId : market.downTokenId;
  let history = [];
  try {
    history = await fetchPricesHistory(tokenId, tradeWindowSec, tradeWindowSec + tfSec, 1);
  } catch (err) {
    const out = {
      ok: false,
      reason: `history:${err?.message || err}`,
      key,
      slug: market.slug,
      tokenId,
    };
    writeFileSync(cacheFile, JSON.stringify(out));
    return out;
  }

  const sim = simulateCapEntry(history, {
    cap,
    entryDelaySec,
    windowStartSec: tradeWindowSec,
  });

  const out = {
    ...sim,
    key,
    slug: market.slug,
    tokenId,
    tradeWindowSec,
    historyN: history.length,
    historySample: history.slice(0, 6),
  };
  writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}
