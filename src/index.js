/**
 * Polymarket Reversal Continuation Bot — entry point
 * PRD v2.2 | BTC/USDT 5m | Martingale 4-loss stop
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from './config.js';
import logger from './utils/logger.js';
import { sleep } from './utils/retry.js';
import { appendJsonl } from './utils/jsonl.js';
import { writeHeartbeat } from './utils/heartbeat.js';
import { fetchClosedCandles, isCandleFresh } from './collector/binance.js';
import {
  startRtdsBuffer,
  stopRtdsBuffer,
  getChainlinkOpenPrice,
} from './collector/chainlink.js';
import {
  initChainlinkSettler,
  startChainlinkSettler,
  stopChainlinkSettler,
  scheduleChainlinkSettlement,
  trySettlePending,
  computeChainlinkSettlement,
  crossCheckWithCandle,
} from './trader/chainlinkSettle.js';
import { buildSignal } from './strategy/reversalContinuation.js';
import { findCurrentCycleMarket, isPriceAcceptable } from './market/polymarket.js';
import {
  getBalance,
  getClobClient,
  placeOrder,
  recordLoss,
  isDailyLossExceeded,
  initDailyLoss,
  getDailyLossUsd,
  clearOrderDedup,
} from './trader/executor.js';
import { fetchFillFromOrder, formatFillNote, formatPriceOddsLines } from './trader/fillSync.js';
import {
  initRestingFillWatcher,
  scheduleRestingFillWatch,
  stopAllRestingFillWatchers,
} from './trader/restingFillWatcher.js';
import * as martingale from './martingale/manager.js';
import { notifyTelegram } from './utils/telegram.js';
import { formatBeijingTime } from './utils/datetime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR    = join(__dirname, '..', 'logs');
const SIGNAL_LOG  = join(LOGS_DIR, 'signals.jsonl');
const SETTLE_LOG  = join(LOGS_DIR, 'settlements.jsonl');
const PENDING_FILE = join(LOGS_DIR, 'pending-bet.json');

const CYCLE_MS = config.cycleMinutes * 60 * 1000;

// Pending bet awaiting Chainlink settlement. Shape:
//   { cycleStartTs, signal, actualBet, targetPrice?, orderId? }
let pendingBet = null;

let shutdownRequested = false;
let cycleInProgress = null;

// ─────────────────────────────────────────
// Startup
// ─────────────────────────────────────────

function ensureLogs() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function writeSignalLog(entry) {
  try {
    appendJsonl(SIGNAL_LOG, entry, config.jsonlMaxBytes);
  } catch (err) {
    logger.error('[main] 写入信号日志失败', { error: err?.message });
  }
}

// ─────────────────────────────────────────
// Pending-bet persistence (for crash/restart safety)
// ─────────────────────────────────────────

function loadPending() {
  try {
    if (existsSync(PENDING_FILE)) {
      pendingBet = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
      logger.info('[settle] 已恢复待结算注单', { pendingBet });
    }
  } catch {
    pendingBet = null;
  }
}

function savePending() {
  try {
    if (pendingBet) {
      writeFileSync(PENDING_FILE, JSON.stringify(pendingBet), 'utf8');
    } else if (existsSync(PENDING_FILE)) {
      rmSync(PENDING_FILE);
    }
  } catch (err) {
    logger.warn('[settle] 持久化待结算注单失败', { error: err?.message });
  }
}

// ─────────────────────────────────────────
// Core per-cycle logic
// ─────────────────────────────────────────

async function runCycle(cycleStartTs) {
  const cycleStartedAt = Date.now();
  let cycleStatus = 'ok';
  let cycleError = null;
  let lastSignal = null;

  logger.info('━━━ 周期开始', {
    cycle: formatBeijingTime(cycleStartTs),
    dryRun: config.dryRun,
  });

  clearOrderDedup();

  try {
    // ── FR-1: Fetch OHLCV ──
    let candles;
    try {
      candles = await fetchClosedCandles(config.candleLimit);
    } catch (err) {
      cycleStatus = 'ohlcv_failed';
      cycleError = err?.message;
      logger.error('[main] K 线拉取失败', { error: err?.message });
      return;
    }

    if (candles.length < 2) {
      cycleStatus = 'insufficient_candles';
      logger.warn('[main] K 线数量不足', { got: candles.length });
      return;
    }

    // ── Settle the PREVIOUS cycle's bet (Chainlink; OHLCV used for cross-check) ──
    if (pendingBet) {
      await trySettlePending(pendingBet, { candles });
    }

    const kMinus2 = candles.at(-2);
    const kMinus1 = candles.at(-1);

    if (!isCandleFresh(kMinus1, CYCLE_MS)) {
      cycleStatus = 'stale_candle';
      logger.warn('[main] K 线过期 — 跳过本周期');
      return;
    }

    // ── FR-2: Signal evaluation ──
    const signalObj = buildSignal(kMinus2, kMinus1, config.symbol, config.timeframe);
    lastSignal = signalObj.signal;
    writeSignalLog(signalObj);

    logger.info('[main] 信号', {
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      reason: signalObj.reason,
    });

    if (signalObj.signal === 'NONE') {
      cycleStatus = 'no_signal';
      logger.info('[main] 无信号 — 跳过下单');
      return;
    }

    if (isDailyLossExceeded()) {
      cycleStatus = 'daily_loss_limit';
      logger.warn('[main] 已达当日亏损上限 — 今日停止交易');
      return;
    }

    const tradeDeadline = Date.now() + config.cycleTimeoutMs;

    // ── FR-3: Market discovery ──
    const market = await findCurrentCycleMarket(cycleStartTs, tradeDeadline);
    if (!market) {
      cycleStatus = 'market_not_found';
      logger.warn('[main] 未找到 Polymarket BTC 5 分钟市场 — 跳过下单');
      return;
    }

    if (!isPriceAcceptable(market.yesPrice)) {
      cycleStatus = 'price_out_of_range';
      logger.warn('[main] YES 价格超出可接受范围 — 跳过', {
        yesPrice: market.yesPrice,
      });
      return;
    }

    // ── FR-4.5 / FR-4.6: Martingale bet sizing ──
    const balance = await getBalance();

    if (balance < config.minBalanceUsd) {
      cycleStatus = 'low_balance';
      logger.warn('[main] pUSD 余额低于下限', {
        balance,
        min: config.minBalanceUsd,
      });
      return;
    }

    const mgState  = martingale.getState();
    const { actualBet, skipReason } = martingale.prepareOrder(balance);

    if (skipReason) {
      cycleStatus = `martingale_${skipReason}`;
      logger.info('[main] 马丁格尔策略跳过下单', { skipReason });
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
      deadlineMs: tradeDeadline,
    });

    if (orderResult.skipped) {
      cycleStatus = `order_${orderResult.skipReason ?? 'skipped'}`;
      logger.info('[main] 订单已跳过', { reason: orderResult.skipReason });
      return;
    }

    const spent = orderResult.usdcSpent || 0;
    const cycleEndMs = cycleStartTs + CYCLE_MS;

    if (spent > 0) {
      registerPendingBet({
        cycleStartTs,
        signal: signalObj.signal,
        actualBet: spent,
        orderId: orderResult.orderId,
        limitPrice: orderResult.limitPrice,
      });

      const side = signalObj.signal === 'UP' ? '📈 买涨 UP' : '📉 买跌 DOWN';
      const fillNote = formatFillNote(orderResult.fill);
      const priceOdds = formatPriceOddsLines({
        fill: orderResult.fill,
        limitPrice: orderResult.limitPrice,
        signal: signalObj.signal,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        amountUsdc: spent,
      });
      await notifyTelegram(
        `🤖 <b>开单成交</b>\n` +
        `方向: <b>${side}</b> (${signalObj.signalId})\n` +
        priceOdds +
        `金额: <b>${fillNote || `$${spent.toFixed(2)}`}</b>  (连败 ${mgState.consecutiveLosses})\n` +
        `类型: ${orderResult.orderType ?? config.orderType}\n` +
        `余额: <b>$${balance.toFixed(2)}</b>\n` +
        `盘口: ${market.slug}\n` +
        `时间: ${formatBeijingTime(cycleStartTs)}`
      );
    } else if (orderResult.resting) {
      logger.info('[main] 限价单挂单中 — 监视成交', {
        orderId: orderResult.orderId,
        limitPrice: orderResult.limitPrice,
      });
      scheduleRestingFillWatch({
        orderId: orderResult.orderId,
        cycleStartTs,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        cycleEndMs,
        limitPrice: orderResult.limitPrice,
      });

      const side = signalObj.signal === 'UP' ? '📈 买涨 UP' : '📉 买跌 DOWN';
      const priceOdds = formatPriceOddsLines({
        limitPrice: orderResult.limitPrice,
        signal: signalObj.signal,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        amountUsdc: actualBet,
      });
      await notifyTelegram(
        `⏳ <b>限价挂单</b>\n` +
        `方向: <b>${side}</b> (${signalObj.signalId})\n` +
        priceOdds +
        `预算: $${actualBet}  (连败 ${mgState.consecutiveLosses})\n` +
        `盘口: ${market.slug}\n` +
        `周期内自动监视成交`
      );
    } else {
      cycleStatus = 'order_no_fill';
      logger.warn('[main] 订单已接受但未成交且非挂单状态');
    }
  } catch (err) {
    cycleStatus = 'error';
    cycleError = err?.message;
    throw err;
  } finally {
    const mg = martingale.getState();
    writeHeartbeat({
      status: cycleStatus,
      cycle: new Date(cycleStartTs).toISOString(),
      durationMs: Date.now() - cycleStartedAt,
      dryRun: config.dryRun,
      signal: lastSignal,
      pendingBet: pendingBet
        ? { cycleStartTs: pendingBet.cycleStartTs, signal: pendingBet.signal }
        : null,
      martingale: {
        consecutiveLosses: mg.consecutiveLosses,
        currentBet: mg.currentBet,
        isHalted: mg.isHalted,
      },
      dailyLossUsd: getDailyLossUsd(),
      error: cycleError,
      shutdownRequested,
    });
  }
}

// ─────────────────────────────────────────
// Pending bet + Chainlink settlement
// ─────────────────────────────────────────

function registerPendingBet({ cycleStartTs, signal, actualBet, orderId, limitPrice }) {
  const openSnap = getChainlinkOpenPrice(config.symbol, cycleStartTs);
  pendingBet = {
    cycleStartTs,
    signal,
    actualBet,
    targetPrice: openSnap?.price,
    orderId,
    limitPrice,
  };
  savePending();
  scheduleChainlinkSettlement(pendingBet);
  logger.info('[main] 待结算注单已登记', {
    cycleStartTs: formatBeijingTime(cycleStartTs),
    signal,
    actualBet,
    orderId,
    targetPrice: pendingBet.targetPrice,
  });
}

async function confirmOrderFilled(pending) {
  if (config.dryRun) return true;
  if (!pending?.orderId) return true;

  try {
    const client = await getClobClient();
    const fill = await fetchFillFromOrder(client, pending.orderId);
    if (fill.usdcSpent > 0) return true;

    logger.warn('[settle] 结算时订单未成交 — 作废待结算注单', {
      orderId: pending.orderId,
      status: fill.status,
    });
    pendingBet = null;
    savePending();
    return false;
  } catch (err) {
    logger.warn('[settle] 成交确认失败', { error: err?.message });
    return false;
  }
}

function writeSettlementLog(entry) {
  try {
    appendJsonl(SETTLE_LOG, entry, config.jsonlMaxBytes);
  } catch (err) {
    logger.error('[settle] 写入结算日志失败', { error: err?.message });
  }
}

/**
 * Apply Chainlink settlement for a pending bet.
 * Returns true when settled; false when not ready or pending changed.
 */
async function applyChainlinkSettlement(pending, { candles } = {}) {
  if (!pending || pending !== pendingBet) return false;

  const result = await computeChainlinkSettlement(pending);
  if (!result.ready) {
    logger.debug('[settle] 结算尚未就绪', {
      window: formatBeijingTime(pending.cycleStartTs),
      reason: result.reason,
    });
    return false;
  }

  if (!(await confirmOrderFilled(pending))) {
    return false;
  }

  const candle = candles?.find((k) => k.t === pending.cycleStartTs);
  const cross = crossCheckWithCandle(result, candle);
  if (cross?.mismatch) {
    logger.warn('[settle] Chainlink 与交易所 K 线方向不一致', {
      window: formatBeijingTime(pending.cycleStartTs),
      exchangeDirection: cross.exchangeDirection,
      chainlinkOutcome: cross.chainlinkOutcome,
      targetPrice: result.targetPrice,
      closePrice: result.closePrice,
      candleOpen: candle?.open,
      candleClose: candle?.close,
    });
  }

  const { signal, actualBet, cycleStartTs } = pending;
  const { won, winningOutcome, targetPrice, closePrice, settleDelta } = result;
  const side = signal === 'UP' ? '📈 UP' : '📉 DOWN';
  const windowLabel = formatBeijingTime(cycleStartTs);

  logger.info('[settle] Chainlink 结算结果', {
    window: windowLabel,
    targetPrice,
    closePrice,
    winningOutcome,
    signal,
    won,
    settleDelta,
    crossCheck: cross,
  });

  martingale.onSettled(won);
  if (!won) recordLoss(actualBet);

  pendingBet = null;
  savePending();

  writeSettlementLog({
    ts: new Date().toISOString(),
    cycleStartTs,
    signal,
    actualBet,
    won,
    winningOutcome,
    targetPrice,
    closePrice,
    settleDelta,
    settleSource: 'chainlink',
    exchangeDirection: cross?.exchangeDirection ?? null,
    crossMismatch: cross?.mismatch ?? false,
    dryRun: config.dryRun,
  });

  const mg = martingale.getState();
  let balanceStr = '—';
  try {
    const balance = await getBalance();
    balanceStr = `$${balance.toFixed(2)}`;
  } catch {
    // notification should still go out
  }

  const resultEmoji = won ? '✅' : '❌';
  const resultText = won ? '赢' : '输';
  const mismatchNote = cross?.mismatch
    ? `\n⚠️ 交易所 K 线: ${cross.exchangeDirection} ≠ Chainlink ${cross.chainlinkOutcome}`
    : '';

  await notifyTelegram(
    `${resultEmoji} <b>结算${resultText}</b> (Chainlink)\n` +
    `窗口: ${windowLabel}\n` +
    `下注: ${side} $${actualBet}\n` +
    `目标价: $${targetPrice.toFixed(2)} → 收盘价: $${closePrice.toFixed(2)}\n` +
    `结果: <b>${winningOutcome}</b> (Δ ${settleDelta >= 0 ? '+' : ''}${settleDelta.toFixed(2)})` +
    mismatchNote + '\n' +
    `下一注: <b>$${mg.currentBet}</b>  (连败 ${mg.consecutiveLosses})\n` +
    `今日亏损: $${getDailyLossUsd().toFixed(2)} / $${config.maxDailyLossUsd}\n` +
    `余额: <b>${balanceStr}</b>`
  );

  return true;
}

// ─────────────────────────────────────────
// Scheduler: align to UTC 5m boundaries
// ─────────────────────────────────────────

function nextCycleBoundary() {
  const now = Date.now();
  return Math.ceil(now / CYCLE_MS) * CYCLE_MS;
}

/** Sleep in small steps so shutdown can interrupt long waits. */
async function sleepUntilShutdown(ms) {
  const step = 500;
  let remaining = ms;
  while (remaining > 0 && !shutdownRequested) {
    await sleep(Math.min(step, remaining));
    remaining -= step;
  }
}

async function scheduler() {
  logger.info('▶ 机器人启动', {
    symbol: config.symbol,
    timeframe: config.timeframe,
    dryRun: config.dryRun,
    cycleMinutes: config.cycleMinutes,
    signalDelayMs: config.signalDelayMs,
    cycleTimeoutMs: config.cycleTimeoutMs,
    settlement: 'chainlink-rtds',
  });

  martingale.init();
  initDailyLoss();
  loadPending();

  initChainlinkSettler({
    getPendingBet: () => pendingBet,
    settleFn: applyChainlinkSettlement,
  });

  initRestingFillWatcher(async (ctx) => {
    if (pendingBet) {
      logger.debug('[fillWatch] 已有待结算注单，跳过重复登记');
      return;
    }
    registerPendingBet({
      cycleStartTs: ctx.cycleStartTs,
      signal: ctx.signal,
      actualBet: ctx.actualBet,
      orderId: ctx.orderId,
      limitPrice: ctx.limitPrice,
    });

    const side = ctx.signal === 'UP' ? '📈 买涨 UP' : '📉 买跌 DOWN';
    const fillNote = formatFillNote(ctx.fill);
    const priceOdds = formatPriceOddsLines({
      fill: ctx.fill,
      limitPrice: ctx.limitPrice,
      signal: ctx.signal,
      amountUsdc: ctx.actualBet,
    });
    await notifyTelegram(
      `🤖 <b>限价单成交</b>\n` +
      `方向: <b>${side}</b> (${ctx.signalId ?? '—'})\n` +
      priceOdds +
      `金额: <b>${fillNote || `$${ctx.actualBet.toFixed(2)}`}</b>\n` +
      `窗口: ${formatBeijingTime(ctx.cycleStartTs)}`
    );
  });

  await startRtdsBuffer([config.symbol]);
  startChainlinkSettler();

  try {
    logger.info('[main] CLOB 预热中...');
    await getClobClient();
  } catch (err) {
    logger.error('[main] CLOB 预热失败 — 退出', { error: err?.message });
    stopChainlinkSettler();
    stopRtdsBuffer();
    process.exit(1);
  }

  if (pendingBet) {
    scheduleChainlinkSettlement(pendingBet);
    logger.info('[settle] 重启后重新调度待结算注单', {
      pendingBet: {
        cycleStartTs: pendingBet.cycleStartTs,
        signal: pendingBet.signal,
        targetPrice: pendingBet.targetPrice,
      },
    });
  }

  writeHeartbeat({
    status: 'started',
    dryRun: config.dryRun,
    pendingBet: pendingBet
      ? { cycleStartTs: pendingBet.cycleStartTs, signal: pendingBet.signal }
      : null,
  });

  // eslint-disable-next-line no-constant-condition
  while (!shutdownRequested) {
    const boundary = nextCycleBoundary();
    const waitMs   = boundary - Date.now();

    logger.debug('[scheduler] 等待下一周期边界', {
      boundary: formatBeijingTime(boundary),
      waitMs,
    });

    await sleepUntilShutdown(waitMs);
    if (shutdownRequested) break;

    await sleepUntilShutdown(config.signalDelayMs);
    if (shutdownRequested) break;

    cycleInProgress = runCycle(boundary)
      .catch((err) => {
        logger.error('[main] 周期执行异常', { error: err?.message, stack: err?.stack });
      })
      .finally(() => {
        cycleInProgress = null;
      });

    await cycleInProgress;
  }

  logger.info('[main] 调度器已停止');
}

// ─────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────

function setupGracefulShutdown() {
  const shutdown = async (sig) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    logger.info(`[main] 收到 ${sig} — 完成当前周期后退出`);

    writeHeartbeat({ status: 'shutting_down', signal: sig });

    if (cycleInProgress) {
      try {
        await cycleInProgress;
      } catch {
        // already logged in runCycle
      }
    }

    stopChainlinkSettler();
    stopAllRestingFillWatchers();
    stopRtdsBuffer();

    await sleep(300);
    process.exit(0);
  };

  process.on('SIGINT',  () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
}

// ─────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────

ensureLogs();
setupGracefulShutdown();
scheduler().catch((err) => {
  logger.error('[main] 致命错误', { error: err?.message, stack: err?.stack });
  process.exit(1);
});
