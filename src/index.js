/**
 * Polymarket Reversal Continuation Bot — entry point
 * PRD v2.2 | BTC/USDT 5m | Martingale 4-loss stop
 */

import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from './config.js';
import logger from './utils/logger.js';
import { sleep } from './utils/retry.js';
import { fetchClosedCandles, isCandleFresh } from './collector/binance.js';
import { buildSignal } from './strategy/reversalContinuation.js';
import { findNextCycleMarket, isPriceAcceptable, pollUntilResolved } from './market/polymarket.js';
import { getBalance, placeOrder, recordLoss, isDailyLossExceeded } from './trader/executor.js';
import * as martingale from './martingale/manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR   = join(__dirname, '..', 'logs');
const SIGNAL_LOG = join(LOGS_DIR, 'signals.jsonl');

const CYCLE_MS = config.cycleMinutes * 60 * 1000;

// ─────────────────────────────────────────
// Startup
// ─────────────────────────────────────────

function ensureLogs() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function writeSignalLog(entry) {
  try {
    appendFileSync(SIGNAL_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    logger.error('[main] failed to write signal log', { error: err?.message });
  }
}

// ─────────────────────────────────────────
// Core per-cycle logic
// ─────────────────────────────────────────

async function runCycle(cycleStartTs) {
  logger.info('━━━ cycle start', {
    cycle: new Date(cycleStartTs).toISOString(),
    dryRun: config.dryRun,
  });

  // ── FR-5.2: Wait SIGNAL_DELAY_MS after boundary for exchange to write OHLCV ──
  // (Already waited in the scheduler; small safety noop here.)

  // ── FR-1: Fetch OHLCV ──
  let candles;
  try {
    candles = await fetchClosedCandles(config.candleLimit);
  } catch (err) {
    logger.error('[main] OHLCV fetch failed', { error: err?.message });
    return;
  }

  if (candles.length < 2) {
    logger.warn('[main] not enough candles', { got: candles.length });
    return;
  }

  const kMinus2 = candles.at(-2);
  const kMinus1 = candles.at(-1);

  // FR-1.4: freshness check
  if (!isCandleFresh(kMinus1, CYCLE_MS)) {
    logger.warn('[main] stale candle — skipping cycle');
    return;
  }

  // ── FR-2: Signal evaluation ──
  const signalObj = buildSignal(kMinus2, kMinus1, config.symbol, config.timeframe);
  writeSignalLog(signalObj);

  logger.info('[main] signal', {
    signal: signalObj.signal,
    signalId: signalObj.signalId,
    reason: signalObj.reason,
  });

  if (signalObj.signal === 'NONE') {
    logger.info('[main] no signal — skipping trade');
    return;
  }

  // ── Daily loss guard ──
  if (isDailyLossExceeded()) {
    logger.warn('[main] daily loss limit reached — stopping for today');
    return;
  }

  // ── FR-3: Market discovery ──
  const market = await findNextCycleMarket(cycleStartTs);
  if (!market) {
    logger.warn('[main] no Polymarket BTC 5M market found — skipping trade');
    return;
  }

  // ── Price sanity check ──
  if (!isPriceAcceptable(market.yesPrice)) {
    logger.warn('[main] YES price out of acceptable range — skipping', {
      yesPrice: market.yesPrice,
    });
    return;
  }

  // ── FR-4.5 / FR-4.6: Martingale bet sizing ──
  const balance = await getBalance();

  if (balance < config.minBalanceUsd) {
    logger.warn('[main] pUSD balance below minimum', {
      balance,
      min: config.minBalanceUsd,
    });
    return;
  }

  const mgState  = martingale.getState();
  const { actualBet, skipReason } = martingale.prepareOrder(balance);

  if (skipReason) {
    logger.info('[main] order skipped by martingale', { skipReason });
    return;
  }

  // ── FR-4: Place order ──
  const orderResult = await placeOrder({
    signal: signalObj.signal,
    signalId: signalObj.signalId,
    yesTokenId: market.yesTokenId,
    noTokenId:  market.noTokenId,
    conditionId: market.conditionId,
    cycleStartTs,
    actualBet,
    baseBet: config.tradeBudgetUsd,
    consecutiveLosses: mgState.consecutiveLosses,
    yesPrice: market.yesPrice,
  });

  if (orderResult.skipped) {
    logger.info('[main] order was skipped', { reason: orderResult.skipReason });
    return;
  }

  logger.info('[main] order submitted', { orderId: orderResult.orderId, actualBet });

  // ── FR-5.8: Async settlement polling ──
  // Fire-and-forget — does NOT block the next cycle
  pollUntilResolved(
    market.conditionId,
    signalObj.signal,
    (won) => {
      martingale.onSettled(won);
      if (!won) recordLoss(actualBet);
    },
    { pollIntervalMs: 20_000, timeoutMs: (config.cycleMinutes + 2) * 60_000 }
  ).catch((err) =>
    logger.error('[main] pollUntilResolved threw', { error: err?.message })
  );
}

// ─────────────────────────────────────────
// Scheduler: align to UTC 5m boundaries
// ─────────────────────────────────────────

function nextCycleBoundary() {
  const now = Date.now();
  return Math.ceil(now / CYCLE_MS) * CYCLE_MS;
}

async function scheduler() {
  logger.info('▶ Bot starting', {
    symbol: config.symbol,
    timeframe: config.timeframe,
    dryRun: config.dryRun,
    cycleMinutes: config.cycleMinutes,
    signalDelayMs: config.signalDelayMs,
  });

  martingale.init();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const boundary = nextCycleBoundary();
    const waitMs   = boundary - Date.now();

    logger.debug('[scheduler] waiting for next boundary', {
      boundary: new Date(boundary).toISOString(),
      waitMs,
    });

    await sleep(waitMs);                          // sleep to boundary
    await sleep(config.signalDelayMs);            // wait for exchange OHLCV to flush

    await runCycle(boundary).catch((err) =>
      logger.error('[main] runCycle threw', { error: err?.message, stack: err?.stack })
    );
  }
}

// ─────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────

function setupGracefulShutdown() {
  const shutdown = (sig) => {
    logger.info(`[main] received ${sig} — shutting down gracefully`);
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ─────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────

ensureLogs();
setupGracefulShutdown();
scheduler().catch((err) => {
  logger.error('[main] fatal', { error: err?.message, stack: err?.stack });
  process.exit(1);
});
