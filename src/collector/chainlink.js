/**
 * Polymarket RTDS Chainlink price collector.
 * - Spot ticks: open / price-to-beat (target)
 * - TWAP 30s/60s: official close reference since 2026-08-07 UTC
 * Signals still use CCXT OHLCV.
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
  'DOGE/USDT': 'doge/usd',
};

/** @type {Map<string, Array<{ timestamp: number, value: number }>>} */
const tickBuffers = new Map();
/** @type {Map<string, Array<{ timestamp: number, value: number }>>} key = `${cl}:30` | `${cl}:60` */
const twapBuffers = new Map();

let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let started = false;
let subscribedSymbols = [];
/** Wall-clock ms of last successful RTDS ingest (any symbol). */
let lastIngestWallMs = 0;
let rtdsConnected = false;

function symbolToCl(symbol) {
  return SYMBOL_CHAINLINK[symbol] || null;
}

function maxBufferTicks() {
  const minutes = config.chainlink.bufferMinutes;
  return minutes * 60 + 120;
}

function maxTwapPoints() {
  // ~1 point/sec → keep ~bufferMinutes of TWAP updates
  return config.chainlink.bufferMinutes * 60 + 120;
}

/**
 * Polymarket Up/Down close TWAP window by market length.
 * 5m → 30s; 15m / 1h / 4h → 60s (official docs; 1h uses 60s).
 */
export function twapWindowForCycleMinutes(cycleMinutes = config.cycleMinutes) {
  const m = Number(cycleMinutes);
  if (Number.isFinite(m) && m > 0 && m <= 5) return 30;
  return 60;
}

function ingestInto(map, key, points, maxLen) {
  if (!key || !Array.isArray(points) || !points.length) return false;

  let buf = map.get(key);
  if (!buf) {
    buf = [];
    map.set(key, buf);
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

  map.set(key, merged.slice(-maxLen));
  if (added > 0 || merged.length) {
    lastIngestWallMs = Date.now();
  }
  return added > 0;
}

function ingestPoints(clSymbol, points) {
  return ingestInto(tickBuffers, clSymbol, points, maxBufferTicks());
}

function ingestTwap(clSymbol, windowSeconds, points) {
  const w = Number(windowSeconds) === 30 ? 30 : 60;
  return ingestInto(twapBuffers, `${clSymbol}:${w}`, points, maxTwapPoints());
}

function subscribePayload() {
  const subs = [];
  for (const symbol of subscribedSymbols) {
    const cl = symbolToCl(symbol);
    if (!cl) continue;
    const filter = JSON.stringify({ symbol: cl });
    subs.push({
      topic: 'crypto_prices_chainlink',
      type: '*',
      filters: filter,
    });
    // Official close since 2026-08-07 — Chainlink TWAP via RTDS
    subs.push({
      topic: 'crypto_prices_twap_thirty',
      type: 'update',
      filters: filter,
    });
    subs.push({
      topic: 'crypto_prices_twap_sixty',
      type: 'update',
      filters: filter,
    });
  }
  return { action: 'subscribe', subscriptions: subs };
}

function clearPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function startPing(flavor, OPEN) {
  clearPing();
  // Polymarket RTDS: send text PING every 5s
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== OPEN) return;
    try {
      sendSocket(ws, flavor, 'PING');
    } catch {
      /* ignore */
    }
  }, 5000);
}

function parsePayloadValue(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  const n = Number(String(raw).trim());
  return n;
}

function connectRtds() {
  const resolved = resolveWebSocket();
  if (!resolved) {
    logger.error(
      '[chainlink] WebSocket 不可用（需 Node >= 18 并 npm install ws）',
    );
    return;
  }

  const { WebSocket, flavor } = resolved;

  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  clearPing();

  ws = new WebSocket(RTDS_URL);
  const OPEN = WebSocket.OPEN ?? 1;

  bindSocket(ws, flavor, {
    onOpen: () => {
      rtdsConnected = true;
      logger.info(
        `[chainlink] RTDS 已连接 (${flavor})，已订阅 ticks+TWAP: ${subscribedSymbols.join(', ')}`,
      );
      sendSocket(ws, flavor, JSON.stringify(subscribePayload()));
      startPing(flavor, OPEN);
    },
    onMessage: (ev) => {
      try {
        const raw = String(ev.data || '').trim();
        if (!raw) return;
        const lower = raw.toLowerCase();
        if (lower === 'ping') {
          if (ws.readyState === OPEN) sendSocket(ws, flavor, 'pong');
          return;
        }
        if (lower === 'pong') return;

        const msg = JSON.parse(raw);
        const payload = msg.payload;
        if (!payload) return;

        const topic = String(msg.topic || '');
        const clSymbol = payload.symbol;
        if (!clSymbol) return;

        let points = null;
        if (Array.isArray(payload.data) && payload.data.length) {
          points = payload.data.map((pt) => ({
            timestamp: pt.timestamp,
            value: parsePayloadValue(pt.value),
          }));
        } else if (payload.timestamp != null && payload.value != null) {
          points = [
            {
              timestamp: payload.timestamp,
              value: parsePayloadValue(payload.value),
            },
          ];
        }
        if (!points?.length) return;

        const isTwapThirty =
          topic.includes('twap_thirty') ||
          Number(payload.window_s) === 30 ||
          Number(payload.windowSeconds) === 30;
        const isTwapSixty =
          topic.includes('twap_sixty') ||
          Number(payload.window_s) === 60 ||
          Number(payload.windowSeconds) === 60;

        if (isTwapThirty || isTwapSixty) {
          const w = isTwapThirty ? 30 : 60;
          if (ingestTwap(clSymbol, w, points)) {
            logger.debug(`[chainlink] TWAP${w}s ${clSymbol}: +update`);
          }
          return;
        }

        if (ingestPoints(clSymbol, points)) {
          const buf = tickBuffers.get(clSymbol) || [];
          logger.debug(`[chainlink] ${clSymbol}: 缓冲区 ${buf.length} 个 tick`);
        }
      } catch {
        /* ignore malformed frames */
      }
    },
    onClose: () => {
      rtdsConnected = false;
      clearPing();
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
    if (!twapBuffers.has(`${cl}:30`)) twapBuffers.set(`${cl}:30`, []);
    if (!twapBuffers.has(`${cl}:60`)) twapBuffers.set(`${cl}:60`, []);
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
      const t30 = twapBuffers.get(`${cl}:30`)?.length || 0;
      const t60 = twapBuffers.get(`${cl}:60`)?.length || 0;
      return `${sym}=${tickBuffers.get(cl)?.length || 0}ticks/twap30=${t30}/twap60=${t60}`;
    })
    .join(', ');
  logger.info(`[chainlink] RTDS 缓冲区就绪 (${summary})`);
}

export function stopRtdsBuffer() {
  started = false;
  rtdsConnected = false;
  clearPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

/**
 * Whether RTDS has a usable recent tick for trading / settlement target capture.
 * @param {string} [symbol]
 * @param {{ maxStaleMs?: number }} [opts]
 */
export function isChainlinkFeedHealthy(symbol = config.symbol, opts = {}) {
  const maxStaleMs = Number.isFinite(opts.maxStaleMs)
    ? opts.maxStaleMs
    : config.chainlink.requireFreshMs;
  const latest = getLatestPrice(symbol);
  if (!latest) {
    return {
      ok: false,
      reason: 'no_ticks',
      connected: rtdsConnected,
      tickAgeMs: null,
      lastIngestWallMs: lastIngestWallMs || null,
    };
  }

  const tickAgeMs = Math.max(0, Date.now() - Number(latest.ts));
  const ingestAgeMs = lastIngestWallMs
    ? Math.max(0, Date.now() - lastIngestWallMs)
    : null;
  const freshByTick = tickAgeMs <= maxStaleMs;
  const freshByIngest = ingestAgeMs != null && ingestAgeMs <= maxStaleMs;
  if (!freshByTick && !freshByIngest) {
    return {
      ok: false,
      reason: 'stale',
      connected: rtdsConnected,
      tickAgeMs,
      lastIngestWallMs: lastIngestWallMs || null,
      price: latest.price,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    connected: rtdsConnected,
    tickAgeMs,
    lastIngestWallMs: lastIngestWallMs || null,
    price: latest.price,
  };
}

/**
 * Snapshot cycle open (target) price for pending-bet persistence.
 * Prefers official open-window tick; falls back to last tick ≤ cycleStart.
 */
export function captureCycleTargetPrice(symbol, cycleStartMs) {
  const open = getChainlinkOpenPrice(symbol, cycleStartMs);
  if (open && Number.isFinite(open.price)) {
    return {
      targetPrice: open.price,
      targetKind: open.kind,
      targetTs: open.ts,
    };
  }
  const atOpen = getChainlinkPriceAt(symbol, cycleStartMs);
  if (atOpen && Number.isFinite(atOpen.price)) {
    return {
      targetPrice: atOpen.price,
      targetKind: 'at-or-before-open',
      targetTs: atOpen.ts,
    };
  }
  return null;
}

export function getLatestPrice(symbol) {
  const cl = symbolToCl(symbol);
  if (!cl) return null;
  const buf = tickBuffers.get(cl);
  if (!buf?.length) return null;
  const latest = buf[buf.length - 1];
  return { price: latest.value, ts: latest.timestamp, symbol: cl };
}

/** Last Chainlink spot tick with timestamp <= tsMs. */
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
  return { price: best.value, ts: best.timestamp, symbol: cl, kind: 'snapshot' };
}

/**
 * Last Chainlink TWAP update with observation timestamp <= tsMs.
 * @param {string} symbol
 * @param {30|60} windowSeconds
 * @param {number} tsMs
 */
export function getChainlinkTwapAt(symbol, windowSeconds, tsMs) {
  const cl = symbolToCl(symbol);
  const w = Number(windowSeconds) === 30 ? 30 : 60;
  if (!cl || !Number.isFinite(tsMs)) return null;
  const buf = twapBuffers.get(`${cl}:${w}`);
  if (!buf?.length) return null;

  let best = null;
  for (const pt of buf) {
    if (pt.timestamp <= tsMs) best = pt;
    else break;
  }
  if (!best) return null;
  return {
    price: best.value,
    ts: best.timestamp,
    symbol: cl,
    kind: `twap_${w}s`,
    windowSeconds: w,
  };
}

/**
 * Official close reference for Up/Down: TWAP preferred, snapshot fallback.
 * @returns {{ price: number, ts: number, symbol: string, kind: string, windowSeconds?: number }|null}
 */
export function getSettlementClosePrice(
  symbol,
  cycleEndMs,
  cycleMinutes = config.cycleMinutes,
) {
  const windowS = twapWindowForCycleMinutes(cycleMinutes);
  const twap = getChainlinkTwapAt(symbol, windowS, cycleEndMs);
  if (twap && Number.isFinite(twap.price)) return twap;
  // Allow a slightly late TWAP print (observation ts may lag a few hundred ms)
  const graceMs = Number(config.chainlink.twapGraceMs) || 3000;
  const twapLate = getChainlinkTwapAt(symbol, windowS, cycleEndMs + graceMs);
  if (twapLate && Number.isFinite(twapLate.price)) {
    return { ...twapLate, kind: `${twapLate.kind}_late` };
  }
  const snap = getChainlinkPriceAt(symbol, cycleEndMs);
  if (snap) return { ...snap, kind: 'snapshot_fallback' };
  return null;
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
  const t30 = cl ? twapBuffers.get(`${cl}:30`) : null;
  const t60 = cl ? twapBuffers.get(`${cl}:60`) : null;
  return {
    clSymbol: cl,
    ticks: buf?.length || 0,
    twap30: t30?.length || 0,
    twap60: t60?.length || 0,
    oldest: buf?.[0]?.timestamp || null,
    newest: buf?.at(-1)?.timestamp || null,
  };
}
