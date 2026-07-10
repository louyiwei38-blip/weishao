/**
 * Polymarket RTDS Chainlink price collector.
 * Used for settlement (target + close price); signals still use CCXT OHLCV.
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { resolveWebSocket, bindSocket, sendSocket } from '../utils/websocket.js';

const RTDS_URL = 'wss://ws-live-data.polymarket.com';

export const SYMBOL_CHAINLINK = {
  'BTC/USDT': 'btc/usd',
  'ETH/USDT': 'eth/usd',
  'SOL/USDT': 'sol/usd',
  'BNB/USDT': 'bnb/usd',
  'XRP/USDT': 'xrp/usd',
};

/** @type {Map<string, Array<{ timestamp: number, value: number }>>} */
const tickBuffers = new Map();

let ws = null;
let reconnectTimer = null;
let started = false;
let subscribedSymbols = [];

function symbolToCl(symbol) {
  return SYMBOL_CHAINLINK[symbol] || null;
}

function maxBufferTicks() {
  const minutes = config.chainlink.bufferMinutes;
  return minutes * 60 + 120;
}

function ingestPoints(clSymbol, points) {
  if (!clSymbol || !Array.isArray(points) || !points.length) return false;

  let buf = tickBuffers.get(clSymbol);
  if (!buf) {
    buf = [];
    tickBuffers.set(clSymbol, buf);
  }

  const byTs = new Map(buf.map((p) => [p.timestamp, p.value]));
  let added = 0;

  for (const pt of points) {
    const ts = Number(pt.timestamp);
    const value = Number(pt.value);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
    if (!byTs.has(ts)) added += 1;
    byTs.set(ts, value);
  }

  const merged = [...byTs.entries()]
    .map(([timestamp, value]) => ({ timestamp, value }))
    .sort((a, b) => a.timestamp - b.timestamp);

  tickBuffers.set(clSymbol, merged.slice(-maxBufferTicks()));
  return added > 0;
}

function subscribePayload() {
  const subs = [];
  for (const symbol of subscribedSymbols) {
    const cl = symbolToCl(symbol);
    if (!cl) continue;
    subs.push({
      topic: 'crypto_prices_chainlink',
      type: '*',
      filters: JSON.stringify({ symbol: cl }),
    });
  }
  return { action: 'subscribe', subscriptions: subs };
}

function connectRtds() {
  const resolved = resolveWebSocket();
  if (!resolved) {
    logger.error(
      '[chainlink] WebSocket 不可用（需 Node >= 18 并 npm install ws）'
    );
    return;
  }

  const { WebSocket, flavor } = resolved;

  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }

  ws = new WebSocket(RTDS_URL);
  const OPEN = WebSocket.OPEN ?? 1;

  bindSocket(ws, flavor, {
    onOpen: () => {
      logger.info(
        `[chainlink] RTDS 已连接 (${flavor})，已订阅: ${subscribedSymbols.join(', ')}`
      );
      sendSocket(ws, flavor, JSON.stringify(subscribePayload()));
    },
    onMessage: (ev) => {
      try {
        const raw = String(ev.data || '').trim();
        if (!raw) return;
        if (raw === 'ping') {
          if (ws.readyState === OPEN) sendSocket(ws, flavor, 'pong');
          return;
        }

        const msg = JSON.parse(raw);
        const payload = msg.payload;
        if (!payload) return;

        let points = null;
        const clSymbol = payload.symbol;

        if (Array.isArray(payload.data) && payload.data.length) {
          points = payload.data;
        } else if (
          clSymbol &&
          payload.timestamp != null &&
          payload.value != null
        ) {
          points = [{ timestamp: payload.timestamp, value: payload.value }];
        }

        if (!clSymbol || !points?.length) return;

        if (ingestPoints(clSymbol, points)) {
          const buf = tickBuffers.get(clSymbol) || [];
          logger.debug(`[chainlink] ${clSymbol}: 缓冲区 ${buf.length} 个 tick`);
        }
      } catch {
        /* ignore malformed frames */
      }
    },
    onClose: () => {
      ws = null;
      if (!started) return;
      logger.warn('[chainlink] RTDS 断开，5 秒后重连...');
      reconnectTimer = setTimeout(connectRtds, 5000);
    },
    onError: () => {
      /* close handler reconnects */
    },
  });
}

/**
 * Start RTDS buffer (call once at bot startup).
 * @param {string[]} symbols
 */
export async function startRtdsBuffer(symbols = [config.symbol]) {
  subscribedSymbols = [...new Set(symbols)];
  started = true;

  for (const symbol of subscribedSymbols) {
    const cl = symbolToCl(symbol);
    if (!cl) {
      logger.warn(`[chainlink] ${symbol}: 无 Chainlink 映射，跳过订阅`);
      continue;
    }
    if (!tickBuffers.has(cl)) tickBuffers.set(cl, []);
  }

  connectRtds();

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const ready = subscribedSymbols.every((sym) => {
      const cl = symbolToCl(sym);
      return cl && (tickBuffers.get(cl)?.length || 0) >= 10;
    });
    if (ready) break;
    await sleep(300);
  }

  const summary = subscribedSymbols
    .map((sym) => {
      const cl = symbolToCl(sym);
      return `${sym}=${tickBuffers.get(cl)?.length || 0}ticks`;
    })
    .join(', ');
  logger.info(`[chainlink] RTDS 缓冲区就绪 (${summary})`);
}

export function stopRtdsBuffer() {
  started = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}

export function getLatestPrice(symbol) {
  const cl = symbolToCl(symbol);
  if (!cl) return null;
  const buf = tickBuffers.get(cl);
  if (!buf?.length) return null;
  const latest = buf[buf.length - 1];
  return { price: latest.value, ts: latest.timestamp, symbol: cl };
}

/** Last Chainlink tick with timestamp <= tsMs (settlement close price). */
export function getChainlinkPriceAt(symbol, tsMs) {
  const cl = symbolToCl(symbol);
  if (!cl || !Number.isFinite(tsMs)) return null;
  const buf = tickBuffers.get(cl);
  if (!buf?.length) return null;

  let best = null;
  for (const pt of buf) {
    if (pt.timestamp <= tsMs) best = pt;
    else break;
  }

  if (!best) return null;
  return { price: best.value, ts: best.timestamp, symbol: cl };
}

/**
 * Cycle open (target) price: first tick in [cycleStart, cycleStart+openWindow],
 * else last tick <= cycleStart.
 */
export function getChainlinkOpenPrice(symbol, cycleStartMs) {
  const cl = symbolToCl(symbol);
  if (!cl || !Number.isFinite(cycleStartMs)) return null;
  const buf = tickBuffers.get(cl);
  if (!buf?.length) return null;

  const windowEnd = cycleStartMs + config.chainlink.openWindowMs;
  for (const pt of buf) {
    if (pt.timestamp >= cycleStartMs && pt.timestamp <= windowEnd) {
      return { price: pt.value, ts: pt.timestamp, symbol: cl, kind: 'at-or-after-open' };
    }
  }

  const atOrBefore = getChainlinkPriceAt(symbol, cycleStartMs);
  if (atOrBefore) {
    return { ...atOrBefore, kind: 'at-or-before-open' };
  }
  return null;
}

/** Polymarket Up/Down: close >= target → UP, else DOWN */
export function resolveOutcomeFromPrices(targetPrice, closePrice) {
  const target = Number(targetPrice);
  const close = Number(closePrice);
  if (!Number.isFinite(target) || !Number.isFinite(close)) return null;
  return close >= target ? 'UP' : 'DOWN';
}

export function getBufferStats(symbol) {
  const cl = symbolToCl(symbol);
  const buf = cl ? tickBuffers.get(cl) : null;
  return {
    clSymbol: cl,
    ticks: buf?.length || 0,
    oldest: buf?.[0]?.timestamp || null,
    newest: buf?.at(-1)?.timestamp || null,
  };
}
