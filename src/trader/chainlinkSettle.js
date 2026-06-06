/**
 * Chainlink-based settlement for Polymarket Up/Down markets.
 * Settlement rule: close >= target → UP, else DOWN (official oracle).
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { formatBeijingTime } from '../utils/datetime.js';
import {
  getChainlinkPriceAt,
  getChainlinkOpenPrice,
  getLatestPrice,
  resolveOutcomeFromPrices,
} from '../collector/chainlink.js';

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

  logger.debug('[settle] 已调度 Chainlink 结算', {
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

  logger.info('[settle] Chainlink 结算器已启动', {
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
    logger.info('[settle] Chainlink 结算器已停止');
  }
}

export async function trySettlePending(pendingBet, ctx = {}) {
  return settleOnce(pendingBet, ctx);
}
