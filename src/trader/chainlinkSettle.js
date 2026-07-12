/**
 * Settlement for Polymarket Up/Down markets.
 * Default: OKX 永续 K 线 (open vs close, cycle = MARKET_CYCLE_MINUTES).
 * Fallback: Chainlink RTDS oracle.
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { fetchClosedCandleAt } from '../collector/binance.js';
import {
  getChainlinkPriceAt,
  getChainlinkOpenPrice,
  getLatestPrice,
  resolveOutcomeFromPrices,
} from '../collector/chainlink.js';

export function usesChainlinkSettlement() {
  return config.settleSource === 'chainlink';
}

export function usesOkxSettlement() {
  return !usesChainlinkSettlement();
}

export function settleSourceLabel() {
  return usesChainlinkSettlement() ? 'Chainlink' : 'OKX 永续 K 线';
}

/** @type {Map<string, NodeJS.Timeout>} */
const scheduledTimers = new Map();
/** @type {Map<string, Promise<boolean>>} */
const settlingPromises = new Map();

let safetyTimer = null;
let getPendingBet = () => null;
/** @type {(pendingBet: object, ctx?: object) => Promise<boolean>} */
let settleFn = async () => false;

function cycleEndMs(cycleStartTs) {
  return cycleStartTs + config.cycleMinutes * 60 * 1000;
}

function settleWakeMs(cycleStartTs) {
  return cycleEndMs(cycleStartTs) + config.chainlink.settleBufferMs;
}

export function directionWon(betDirection, winningOutcome) {
  return String(betDirection || '').toUpperCase() === String(winningOutcome || '').toUpperCase();
}

export function candleDirection(candle) {
  if (!candle) return null;
  if (candle.close > candle.open) return 'UP';
  if (candle.close < candle.open) return 'DOWN';
  return 'DOJI';
}

export function crossCheckWithCandle(settlement, candle) {
  if (!settlement?.ready || !candle) return null;
  const exchangeDirection = candleDirection(candle);
  const chainlinkOutcome = settlement.winningOutcome;
  const mismatch = exchangeDirection !== 'DOJI' && exchangeDirection !== chainlinkOutcome;
  return { exchangeDirection, chainlinkOutcome, mismatch };
}

async function fetchClosePriceAtEnd(cycleStartTs) {
  const endMs = cycleEndMs(cycleStartTs);
  const deadline = Date.now() + config.chainlink.settleMaxWaitMs;
  let last = null;

  while (Date.now() <= deadline) {
    const snap = getChainlinkPriceAt(config.symbol, endMs);
    if (snap) return snap;
    last = getLatestPrice(config.symbol);
    await sleep(500);
  }

  if (last) {
    logger.warn(
      `[settle] 无周期结束前的 tick，回退至最新价 @ ${formatBeijingTime(last.ts)}`
    );
    return last;
  }

  return null;
}

function findCandleByOpenTime(candles, cycleStartTs) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const exact = candles.find((k) => k.t === cycleStartTs);
  if (exact) return exact;
  // Some exchanges return open times offset by a few ms.
  return candles.find((k) => Math.abs(k.t - cycleStartTs) < 1000) ?? null;
}

async function resolveCandleForCycle(cycleStartTs, candles) {
  const fromBatch = findCandleByOpenTime(candles, cycleStartTs);
  if (fromBatch) return fromBatch;

  const cycleEndedAgo = Date.now() - settleWakeMs(cycleStartTs);
  const isHistorical = cycleEndedAgo > config.chainlink.settleMaxWaitMs;
  const deadline = isHistorical
    ? Date.now()
    : Date.now() + config.chainlink.settleMaxWaitMs;
  let lastErr = null;

  while (Date.now() <= deadline) {
    try {
      return await fetchClosedCandleAt(cycleStartTs);
    } catch (err) {
      lastErr = err;
      if (isHistorical) break;
      await sleep(500);
    }
  }

  if (lastErr) {
    logger.warn('[settle] OKX K 线拉取失败', {
      window: formatBeijingTime(cycleStartTs),
      historical: isHistorical,
      error: lastErr?.message,
    });
  }
  return null;
}

const CHAINLINK_FALLBACK_REASONS = new Set(['no_target_price', 'no_close_price']);

function canFallbackToOkx(chainlinkResult, cycleStartTs) {
  if (!chainlinkResult || chainlinkResult.ready) return false;
  if (!CHAINLINK_FALLBACK_REASONS.has(chainlinkResult.reason)) return false;
  return Date.now() >= settleWakeMs(cycleStartTs);
}

/**
 * Compute OKX perpetual candle settlement (open vs close).
 * @returns {Promise<{ ready: boolean, reason?: string, won?: boolean, winningOutcome?: string, targetPrice?: number, closePrice?: number, closeTickTs?: number, settleDelta?: number, candle?: object }>}
 */
export async function computeOkxSettlement(pendingBet, { candles } = {}) {
  const { cycleStartTs } = pendingBet;

  const wakeMs = settleWakeMs(cycleStartTs);
  if (Date.now() < wakeMs) {
    return { ready: false, reason: 'cycle_not_ended' };
  }

  const candle = await resolveCandleForCycle(cycleStartTs, candles);
  if (!candle) {
    return { ready: false, reason: 'no_candle' };
  }

  const targetPrice = Number(candle.open);
  const closePrice = Number(candle.close);
  const winningOutcome = resolveOutcomeFromPrices(targetPrice, closePrice);
  if (!winningOutcome) {
    return { ready: false, reason: 'invalid_prices' };
  }

  const won = directionWon(pendingBet.signal, winningOutcome);

  return {
    ready: true,
    won,
    winningOutcome,
    targetPrice,
    closePrice,
    closeTickTs: cycleStartTs + config.cycleMinutes * 60 * 1000,
    settleDelta: closePrice - targetPrice,
    candle,
  };
}

/**
 * Route settlement to the configured source.
 * Chainlink mode falls back to OKX candles when RTDS buffer lacks old ticks
 * (e.g. pending bet restored after restart hours later).
 */
export async function computeSettlement(pendingBet, ctx = {}) {
  if (usesOkxSettlement()) {
    return computeOkxSettlement(pendingBet, ctx);
  }

  const chainlinkResult = await computeChainlinkSettlement(pendingBet);
  if (chainlinkResult.ready) {
    return { ...chainlinkResult, sourceUsed: 'chainlink' };
  }

  const { cycleStartTs } = pendingBet;
  if (!canFallbackToOkx(chainlinkResult, cycleStartTs)) {
    return chainlinkResult;
  }

  const okxResult = await computeOkxSettlement(pendingBet, ctx);
  if (!okxResult.ready) {
    return okxResult;
  }

  logger.warn('[settle] Chainlink 数据不可用，已回退 OKX K 线结算', {
    window: formatBeijingTime(cycleStartTs),
    chainlinkReason: chainlinkResult.reason,
  });

  return { ...okxResult, sourceUsed: 'okx_fallback' };
}

/**
 * Compute Chainlink settlement for a pending bet.
 * @returns {Promise<{ ready: boolean, reason?: string, won?: boolean, winningOutcome?: string, targetPrice?: number, closePrice?: number, closeTickTs?: number, targetKind?: string }>}
 */
export async function computeChainlinkSettlement(pendingBet) {
  const { cycleStartTs, targetPrice: storedTarget } = pendingBet;

  const wakeMs = settleWakeMs(cycleStartTs);
  if (Date.now() < wakeMs) {
    return { ready: false, reason: 'cycle_not_ended' };
  }

  let targetPrice = storedTarget;
  let targetKind = null;
  if (!Number.isFinite(Number(targetPrice))) {
    const openSnap = getChainlinkOpenPrice(config.symbol, cycleStartTs);
    targetPrice = openSnap?.price;
    targetKind = openSnap?.kind ?? null;
  }

  if (!Number.isFinite(Number(targetPrice))) {
    return { ready: false, reason: 'no_target_price' };
  }

  const closeSnap = await fetchClosePriceAtEnd(cycleStartTs);
  if (!closeSnap) {
    return { ready: false, reason: 'no_close_price' };
  }

  const winningOutcome = resolveOutcomeFromPrices(targetPrice, closeSnap.price);
  if (!winningOutcome) {
    return { ready: false, reason: 'invalid_prices' };
  }

  const won = directionWon(pendingBet.signal, winningOutcome);

  return {
    ready: true,
    won,
    winningOutcome,
    targetPrice: Number(targetPrice),
    closePrice: closeSnap.price,
    closeTickTs: closeSnap.ts,
    targetKind,
    settleDelta: closeSnap.price - Number(targetPrice),
  };
}

/**
 * Wire settlement callbacks from index.js.
 * @param {{ getPendingBet: () => object|null, settleFn: (pending: object, ctx?: object) => Promise<boolean> }} handlers
 */
export function initChainlinkSettler(handlers) {
  getPendingBet = handlers.getPendingBet;
  settleFn = handlers.settleFn;
}

async function settleOnce(pendingBet, ctx = {}) {
  const key = String(pendingBet.cycleStartTs);
  const current = getPendingBet();
  if (!current || current.cycleStartTs !== pendingBet.cycleStartTs) {
    return false;
  }

  const inflight = settlingPromises.get(key);
  if (inflight) return inflight;

  const promise = settleFn(pendingBet, ctx).finally(() => {
    settlingPromises.delete(key);
    scheduledTimers.delete(key);
  });
  settlingPromises.set(key, promise);
  return promise;
}

export function scheduleChainlinkSettlement(pendingBet) {
  if (!pendingBet?.cycleStartTs) return;

  const key = String(pendingBet.cycleStartTs);
  const existing = scheduledTimers.get(key);
  if (existing) clearTimeout(existing);

  const wakeMs = settleWakeMs(pendingBet.cycleStartTs);
  const delay = Math.max(0, wakeMs - Date.now());

  logger.debug('[settle] 已调度结算', {
    source: config.settleSource,
    window: formatBeijingTime(pendingBet.cycleStartTs),
    wakeAt: formatBeijingTime(wakeMs),
    delayMs: delay,
  });

  const timer = setTimeout(() => {
    settleOnce(pendingBet).catch((err) => {
      logger.warn('[settle] 定时结算失败', { error: err?.message });
    });
  }, delay);

  scheduledTimers.set(key, timer);
}

export async function settleAllDuePending(ctx = {}) {
  const pending = getPendingBet();
  if (!pending) return false;

  if (Date.now() < settleWakeMs(pending.cycleStartTs)) return false;
  return settleOnce(pending, ctx);
}

export function startChainlinkSettler() {
  if (safetyTimer) return;

  logger.info('[settle] 结算器已启动', {
    source: config.settleSource,
    bufferMs: config.chainlink.settleBufferMs,
    safetyIntervalMs: config.chainlink.safetyIntervalMs,
  });

  settleAllDuePending().catch((err) => {
    logger.warn('[settle] 启动补结算失败', { error: err?.message });
  });

  safetyTimer = setInterval(() => {
    settleAllDuePending().catch((err) => {
      logger.warn('[settle] 兜底轮询失败', { error: err?.message });
    });
  }, config.chainlink.safetyIntervalMs);
}

export function stopChainlinkSettler() {
  for (const timer of scheduledTimers.values()) clearTimeout(timer);
  scheduledTimers.clear();
  settlingPromises.clear();

  if (safetyTimer) {
    clearInterval(safetyTimer);
    safetyTimer = null;
    logger.info('[settle] 结算器已停止');
  }
}

export async function trySettlePending(pendingBet, ctx = {}) {
  return settleOnce(pendingBet, ctx);
}
