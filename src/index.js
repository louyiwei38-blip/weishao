/**
 * Polymarket Vegas Channel Bot — entry point
 * OKX OHLCV | EMA144/169 Vegas cross-entry | Same-dir Martingale ×1 / 5-loss stop
 * Multi-instance: BOT_INSTANCE + CANDLE_TIMEFRAME (PM2: 15m + 5m)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from './config.js';
import logger from './utils/logger.js';
import { sleep } from './utils/retry.js';
import { appendJsonl } from './utils/jsonl.js';
import { writeHeartbeat } from './utils/heartbeat.js';
import {
  fetchClosedCandles,
  isCandleFresh,
  areSignalCandlesAligned,
  describeOhlcvSource,
} from './collector/binance.js';
import {
  startRtdsBuffer,
  stopRtdsBuffer,
} from './collector/chainlink.js';
import {
  initChainlinkSettler,
  startChainlinkSettler,
  stopChainlinkSettler,
  scheduleChainlinkSettlement,
  trySettlePending,
  computeSettlement,
  crossCheckWithCandle,
  candleDirection,
  usesChainlinkSettlement,
  settleSourceLabel,
} from './trader/chainlinkSettle.js';
import * as vegasState from './strategy/vegasState.js';
import { MIN_SIGNAL_CANDLES } from './strategy/vegasChannel.js';
import { findCurrentCycleMarket, resolveOrderPricePolicy } from './market/polymarket.js';
import {
  getBalanceBreakdown,
  getClobClient,
  placeOrder,
  peekExpectedEntryPrice,
  recordLoss,
  isDailyLossExceeded,
  initDailyLoss,
  getDailyLossUsd,
  clearOrderDedup,
  warnOrderPolicyMismatch,
} from './trader/executor.js';
import { fetchFillFromOrder, formatFillNote, formatPriceOddsLines, formatSettlementTradeLines } from './trader/fillSync.js';
import {
  initRestingFillWatcher,
  scheduleRestingFillWatch,
  stopAllRestingFillWatchers,
  hasActiveRestingFillWatch,
} from './trader/restingFillWatcher.js';
import * as martingale from './martingale/manager.js';
import { formatBankrollTelegramLines } from './martingale/bankroll.js';
import * as stats from './stats/manager.js';
import { notifyTelegram, escapeHtml } from './utils/telegram.js';
import { formatBeijingTime } from './utils/datetime.js';
import { scopedLogPath } from './utils/instancePaths.js';
import {
  shouldMgContFastPath,
  nextCycleStartTs,
  isWithinTradeWindow,
  resolveCycleSignalDelayMs,
} from './utils/fastPath.js';
import {
  isSignalDataNotReady,
  resolveSignalDataDeadlineMs,
} from './utils/signalData.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR    = join(__dirname, '..', 'logs');
const SIGNAL_LOG  = scopedLogPath(LOGS_DIR, 'signals.jsonl');
const SETTLE_LOG  = scopedLogPath(LOGS_DIR, 'settlements.jsonl');
const PENDING_FILE = scopedLogPath(LOGS_DIR, 'pending-bet.json');

const CYCLE_MS = config.cycleMinutes * 60 * 1000;
const TF_TAG = `[${String(config.symbol || '').split('/')[0] || '?'}·${config.timeframe}]`;

function tgHead(titleHtml) {
  return `${TF_TAG} ${titleHtml}`;
}

// Pending bet awaiting settlement. Shape:
//   { cycleStartTs, signal, actualBet, orderId?, limitPrice?, entryPrice?, fill? }
let pendingBet = null;

let shutdownRequested = false;
let cycleInProgress = null;
/** All in-flight cycle/fast-path work — awaited on graceful shutdown. */
const inFlightWork = new Set();
/** Serialize placeOrder across runCycle + settlement-driven MG_CONT fast path. */
let tradeLock = Promise.resolve();
/** Cycle starts that already have a live fill / resting watch. */
const orderedCycleTs = new Set();
let placingForCycle = null;

function trackWork(promise) {
  const wrapped = Promise.resolve(promise).finally(() => {
    inFlightWork.delete(wrapped);
  });
  inFlightWork.add(wrapped);
  return wrapped;
}


// ─────────────────────────────────────────
// Startup
// ─────────────────────────────────────────

function formatStatsTelegramBlock() {
  return stats.formatTelegramBlock();
}

/** 开单/结算共用：本链路累计盈亏 + 马丁进度 + 共享资金线 */
function formatChainTelegramLines(mgState = martingale.getState(), sizing = null) {
  const chainPnl = Number(mgState.chainPnlUsd) || 0;
  return (
    `本链路盈亏: <b>${stats.formatPnlUsd(chainPnl)}</b>\n` +
    `马丁: 默认首注 $${config.tradeBudgetUsd} · 连败 ${mgState.consecutiveLosses} · 本单注 $${mgState.currentBet}\n` +
    formatBankrollTelegramLines(sizing)
  );
}

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
// Telegram helpers
// ─────────────────────────────────────────

/**
 * @param {number|{ portfolio?: number, cash?: number, positionsValue?: number }} [balance]
 *   Portfolio number or breakdown; omitted → live fetch
 */
async function formatBalanceTelegramLine(balance) {
  try {
    let portfolio;
    let cash;
    let positionsValue;
    if (balance != null && typeof balance === 'object') {
      portfolio = Number(balance.portfolio);
      cash = Number(balance.cash);
      positionsValue = Number(balance.positionsValue);
    } else if (typeof balance === 'number') {
      portfolio = balance;
    } else {
      const b = await getBalanceBreakdown();
      portfolio = b.portfolio;
      cash = b.cash;
      positionsValue = b.positionsValue;
    }
    if (!(portfolio >= 0)) return '余额: <b>—</b>\n';
    let line = `Portfolio: <b>$${portfolio.toFixed(2)}</b>`;
    if (Number.isFinite(cash) && Number.isFinite(positionsValue)) {
      line += `（Cash $${cash.toFixed(2)} + 持仓 $${positionsValue.toFixed(2)}）`;
    }
    return `${line}\n`;
  } catch {
    return '余额: <b>—</b>\n';
  }
}

// ─────────────────────────────────────────
// Trade lock / ordered-cycle tracking
// ─────────────────────────────────────────

function pruneOrderedCycles(nowMs = Date.now()) {
  const cutoff = nowMs - CYCLE_MS * 3;
  for (const ts of orderedCycleTs) {
    if (ts < cutoff) orderedCycleTs.delete(ts);
  }
}

function markCycleOrdered(cycleStartTs) {
  pruneOrderedCycles();
  orderedCycleTs.add(cycleStartTs);
}

function unmarkCycleOrdered(cycleStartTs) {
  orderedCycleTs.delete(cycleStartTs);
}

function isCycleOrdered(cycleStartTs) {
  return orderedCycleTs.has(cycleStartTs) || placingForCycle === cycleStartTs;
}

/**
 * @template T
 * @param {number} cycleStartTs
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | { status: string }>}
 */
async function withTradeLock(cycleStartTs, fn) {
  const prev = tradeLock;
  let release;
  tradeLock = new Promise((r) => {
    release = r;
  });
  await prev;
  try {
    if (shutdownRequested) return { status: 'shutdown' };
    if (pendingBet) return { status: 'pending_unsettled' };
    if (hasActiveRestingFillWatch()) return { status: 'resting_fill_pending' };
    if (isCycleOrdered(cycleStartTs)) return { status: 'already_ordered' };
    placingForCycle = cycleStartTs;
    return await fn();
  } finally {
    if (placingForCycle === cycleStartTs) placingForCycle = null;
    release();
  }
}

function buildMgContSignal(lockedSignal, reason) {
  return {
    symbol: config.symbol,
    timeframe: config.timeframe,
    evaluatedAt: new Date().toISOString(),
    signal: lockedSignal,
    signalId: 'MG_CONT',
    reason,
    phase: 'in_chain',
    lockedSignal,
    kMinus2: null,
    kMinus1: null,
    bands: null,
    prevOutside: null,
  };
}

// ─────────────────────────────────────────
// Shared order placement (runCycle + MG_CONT fast path)
// ─────────────────────────────────────────

/**
 * Discover market + size + place order for a cycle window.
 * @returns {Promise<{ status: string, signal?: string, signalId?: string }>}
 */
async function executeTrade({ cycleStartTs, signalObj, source = 'cycle' }) {
  if (signalObj?.signal !== 'UP' && signalObj?.signal !== 'DOWN') {
    return { status: 'no_signal' };
  }

  if (!isWithinTradeWindow(Date.now(), cycleStartTs, CYCLE_MS, config.minTradeRemainingMs)) {
    logger.warn('[main] 周期剩余时间不足 — 跳过下单', {
      cycle: formatBeijingTime(cycleStartTs),
      source,
      minRemainingMs: config.minTradeRemainingMs,
    });
    return { status: 'too_late' };
  }

  if (isDailyLossExceeded()) {
    logger.warn('[main] 已达当日亏损上限 — 今日停止交易', {
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      source,
    });
    return { status: 'daily_loss_limit' };
  }

  return withTradeLock(cycleStartTs, async () => {
    const cycleEndMs = cycleStartTs + CYCLE_MS;
    const tradeDeadline = Math.min(
      Date.now() + config.cycleTimeoutMs,
      cycleEndMs - Math.min(5_000, config.minTradeRemainingMs / 2),
    );

    // Parallel: Gamma market + Portfolio (Cash + positions)
    const [market, bal] = await Promise.all([
      findCurrentCycleMarket(cycleStartTs, tradeDeadline),
      getBalanceBreakdown(),
    ]);
    const { portfolio: balance, cash: cashBalance } = bal;

    if (!market) {
      logger.warn('[main] 未找到 Polymarket 市场 — 跳过下单', {
        symbol: config.symbol,
        timeframe: config.timeframe,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        source,
      });
      return { status: 'market_not_found', signal: signalObj.signal, signalId: signalObj.signalId };
    }

    const pricePolicy = resolveOrderPricePolicy(market, signalObj.signal);
    if (pricePolicy.priceCapped) {
      const token = signalObj.signal === 'UP' ? 'YES' : 'NO';
      const marketPrice = signalObj.signal === 'UP'
        ? pricePolicy.originalYesPrice
        : pricePolicy.originalNoPrice;
      logger.info('[main] Gamma 参考价超阈值 — 下单前将以订单簿最优卖价复核', {
        token,
        gammaRefPrice: marketPrice,
        orderPriceCap: config.orderPriceCap,
        maxLimitPrice: pricePolicy.maxLimitPrice,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        source,
      });
    }

    if (balance < config.minBalanceUsd) {
      logger.warn('[main] Portfolio 低于下限', {
        portfolio: balance,
        cash: cashBalance,
        positionsValue: bal.positionsValue,
        min: config.minBalanceUsd,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        source,
      });
      return { status: 'low_balance', signal: signalObj.signal, signalId: signalObj.signalId };
    }

    const tokenID = signalObj.signal === 'UP' ? market.yesTokenId : market.noTokenId;
    let sizingPrice =
      signalObj.signal === 'UP'
        ? (pricePolicy.yesPrice ?? market.yesPrice)
        : (pricePolicy.noPrice ?? market.noPrice);
    try {
      const quote = await peekExpectedEntryPrice(tokenID);
      if (quote?.entryPrice > 0) sizingPrice = quote.entryPrice;
    } catch (err) {
      logger.warn('[main] 订单簿询价失败 — 用 Gamma 价估算仓位', {
        error: err?.message ?? String(err),
        sizingPrice,
      });
    }

    const mgState = martingale.getState();
    const { actualBet, skipReason, sizing } = martingale.prepareOrder(
      balance,
      sizingPrice,
      cashBalance,
    );
    if (skipReason) {
      logger.info('[main] 马丁格尔策略跳过下单', {
        skipReason,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        source,
        sizing,
        portfolio: balance,
        cash: cashBalance,
        ...stats.formatLogFields(),
      });
      return { status: `martingale_${skipReason}`, signal: signalObj.signal, signalId: signalObj.signalId };
    }

    const orderResult = await placeOrder({
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      conditionId: market.conditionId,
      cycleStartTs,
      actualBet,
      baseBet: config.tradeBudgetUsd,
      consecutiveLosses: mgState.consecutiveLosses,
      yesPrice: pricePolicy.yesPrice ?? market.yesPrice,
      noPrice: pricePolicy.noPrice ?? market.noPrice,
      maxLimitPrice: pricePolicy.maxLimitPrice,
      priceCapped: pricePolicy.priceCapped,
      originalYesPrice: pricePolicy.originalYesPrice,
      deadlineMs: tradeDeadline,
      sizing,
      // Top-up / spend clamp must use Cash, not mark-to-market Portfolio
      availableBalance: cashBalance,
    });

    if (orderResult.skipped) {
      logger.info('[main] 订单已跳过', {
        reason: orderResult.skipReason,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        source,
      });
      return {
        status: `order_${orderResult.skipReason ?? 'skipped'}`,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
      };
    }

    const spent = orderResult.usdcSpent || 0;

    if (spent > 0) {
      registerPendingBet({
        cycleStartTs,
        signal: signalObj.signal,
        actualBet: spent,
        orderId: orderResult.orderId,
        limitPrice: orderResult.limitPrice,
        fill: orderResult.fill,
      });

      const side = signalObj.signal === 'UP' ? '📈 买涨 UP' : '📉 买跌 DOWN';
      const fillNote = formatFillNote(orderResult.fill);
      const priceOdds = formatPriceOddsLines({
        fill: orderResult.fill,
        limitPrice: orderResult.limitPrice,
        signal: signalObj.signal,
        yesPrice: pricePolicy.yesPrice ?? market.yesPrice,
        noPrice: pricePolicy.noPrice ?? market.noPrice,
        amountUsdc: spent,
      });
      const capNote = pricePolicy.priceCapped
        ? `\n💰 ${signalObj.signal === 'UP' ? 'YES' : 'NO'} 盘口 $${signalObj.signal === 'UP' ? pricePolicy.originalYesPrice : pricePolicy.originalNoPrice} 超阈值 — 按 $${pricePolicy.maxLimitPrice} 挂单\n`
        : '';
      const sourceNote = source === 'mg_cont_fast' ? `\n⚡ 快路径: 结算输后续单\n` : '';
      // TG off critical path — do not hold tradeLock waiting on Telegram/balance.
      trackWork((async () => {
        await notifyTelegram(
          `${tgHead('🤖 <b>开单成交</b>')}\n` +
          `方向: <b>${side}</b> (${signalObj.signalId})\n` +
          `周期: ${config.timeframe}\n` +
          `原因: ${escapeHtml(signalObj.reason)}\n` +
          sourceNote +
          capNote +
          priceOdds +
          (fillNote ? `成交明细: ${escapeHtml(fillNote)}\n` : '') +
          formatChainTelegramLines(mgState, sizing) +
          `类型: ${orderResult.orderType ?? config.orderType}\n` +
          await formatBalanceTelegramLine(bal) +
          `盘口: ${market.slug}\n` +
          `时间: ${formatBeijingTime(cycleStartTs)}\n` +
          formatStatsTelegramBlock()
        );
      })().catch((err) => {
        logger.warn('[main] 开单成交 Telegram 推送失败', { error: err?.message });
      }));
      return { status: 'filled', signal: signalObj.signal, signalId: signalObj.signalId };
    }

    if (orderResult.resting) {
      markCycleOrdered(cycleStartTs);
      logger.info('[main] 限价单挂单中 — 监视成交', {
        orderId: orderResult.orderId,
        limitPrice: orderResult.limitPrice,
        source,
      });
      scheduleRestingFillWatch({
        orderId: orderResult.orderId,
        cycleStartTs,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        signalReason: signalObj.reason,
        cycleEndMs,
        limitPrice: orderResult.limitPrice,
        companionOrderIds: orderResult.companionOrderIds || (
          orderResult.topUpOrderId ? [orderResult.topUpOrderId] : []
        ),
        topUpOrderId: orderResult.topUpOrderId || null,
      });

      const side = signalObj.signal === 'UP' ? '📈 买涨 UP' : '📉 买跌 DOWN';
      const priceOdds = formatPriceOddsLines({
        limitPrice: orderResult.limitPrice,
        signal: signalObj.signal,
        yesPrice: pricePolicy.yesPrice ?? market.yesPrice,
        noPrice: pricePolicy.noPrice ?? market.noPrice,
        amountUsdc: actualBet,
      });
      const capNote = pricePolicy.priceCapped
        ? `\n💰 ${signalObj.signal === 'UP' ? 'YES' : 'NO'} 盘口 $${signalObj.signal === 'UP' ? pricePolicy.originalYesPrice : pricePolicy.originalNoPrice} 超阈值 — 按 $${pricePolicy.maxLimitPrice} 挂单\n`
        : '';
      const sourceNote = source === 'mg_cont_fast' ? `\n⚡ 快路径: 结算输后续单\n` : '';
      trackWork((async () => {
        await notifyTelegram(
          `${tgHead('⏳ <b>限价挂单</b>')}\n` +
          `方向: <b>${side}</b> (${signalObj.signalId})\n` +
          `周期: ${config.timeframe}\n` +
          `原因: ${escapeHtml(signalObj.reason)}\n` +
          sourceNote +
          capNote +
          priceOdds +
          formatChainTelegramLines(mgState, sizing) +
          await formatBalanceTelegramLine(bal) +
          `盘口: ${market.slug}\n` +
          `周期内自动监视成交\n` +
          formatStatsTelegramBlock()
        );
      })().catch((err) => {
        logger.warn('[main] 限价挂单 Telegram 推送失败', { error: err?.message });
      }));
      return { status: 'resting', signal: signalObj.signal, signalId: signalObj.signalId };
    }

    logger.warn('[main] 订单已接受但未成交且非挂单状态', {
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      source,
    });
    return { status: 'order_no_fill', signal: signalObj.signal, signalId: signalObj.signalId };
  });
}

/**
 * After loss settlement (not halted): immediately bet the next cycle window.
 */
async function maybeMgContFastPath(settledCycleStartTs) {
  const vg = vegasState.getState();
  if (!shouldMgContFastPath({
    enabled: config.mgContFastPath,
    won: false,
    halted: false,
    phase: vg.phase,
    lockedSignal: vg.lockedSignal,
  })) {
    return { status: 'not_eligible' };
  }

  const nextCycle = nextCycleStartTs(settledCycleStartTs, CYCLE_MS);
  if (!isWithinTradeWindow(Date.now(), nextCycle, CYCLE_MS, config.minTradeRemainingMs)) {
    logger.info('[main] MG_CONT 快路径 — 下一窗口剩余时间不足，交由常规调度', {
      nextCycle: formatBeijingTime(nextCycle),
    });
    return { status: 'too_late' };
  }

  const signalObj = buildMgContSignal(
    vg.lockedSignal,
    `结算输 — 同向快路径续单（锁定 ${vg.lockedSignal}）`,
  );
  writeSignalLog(signalObj);
  logger.info('[main] MG_CONT 快路径 — 结算输后立即续单', {
    settledCycle: formatBeijingTime(settledCycleStartTs),
    nextCycle: formatBeijingTime(nextCycle),
    lockedSignal: vg.lockedSignal,
    consecutiveLosses: martingale.getState().consecutiveLosses,
  });

  return executeTrade({
    cycleStartTs: nextCycle,
    signalObj,
    source: 'mg_cont_fast',
  });
}

// ─────────────────────────────────────────
// Core per-cycle logic
// ─────────────────────────────────────────

async function runCycle(cycleStartTs) {
  const cycleStartedAt = Date.now();
  let cycleStatus = 'ok';
  let cycleError = null;
  let lastSignal = null;
  let candles = null;

  logger.info('━━━ 周期开始', {
    cycle: formatBeijingTime(cycleStartTs),
    dryRun: config.dryRun,
  });

  clearOrderDedup();

  try {
    // ── Settle previous bet first (may trigger MG_CONT fast path for THIS cycle) ──
    if (pendingBet && pendingBet.cycleStartTs !== cycleStartTs) {
      const settleDeadline = resolveSignalDataDeadlineMs({
        nowMs: Date.now(),
        cycleStartTs,
        cycleMs: CYCLE_MS,
        maxWaitMs: config.signalDataMaxWaitMs,
        minTradeRemainingMs: config.minTradeRemainingMs,
      });
      let settleAttempt = 0;

      while (
        pendingBet &&
        pendingBet.cycleStartTs !== cycleStartTs &&
        !shutdownRequested &&
        Date.now() < settleDeadline
      ) {
        settleAttempt += 1;

        // Best-effort OHLCV for OKX settle / cross-check — do NOT block Chainlink settle
        if (!candles) {
          try {
            candles = await fetchClosedCandles(config.candleLimit);
          } catch (err) {
            logger.warn('[main] 结算辅助 K 线拉取失败（继续尝试结算）', {
              attempt: settleAttempt,
              error: err?.message,
              settleSource: config.settleSource,
            });
          }
        }

        const settled = await trySettlePending(pendingBet, {
          candles: candles || undefined,
        });
        if (settled) break;

        logger.warn('[main] 上笔尚未结算 — 周期内短间隔重试', {
          attempt: settleAttempt,
          pendingCycle: formatBeijingTime(pendingBet.cycleStartTs),
          retryMs: config.signalDataRetryMs,
          deadlineInMs: settleDeadline - Date.now(),
        });
        await sleepUntilShutdown(config.signalDataRetryMs);
      }
    }

    if (pendingBet) {
      if (pendingBet.cycleStartTs === cycleStartTs) {
        cycleStatus = 'already_ordered';
        logger.info('[main] 本周期已有待结算注单（快路径）— 跳过重复下单', {
          cycle: formatBeijingTime(cycleStartTs),
          signal: pendingBet.signal,
        });
        return;
      }
      cycleStatus = 'pending_unsettled';
      logger.warn('[main] 上笔注单尚未结算 — 跳过本周期下单', {
        pendingCycle: formatBeijingTime(pendingBet.cycleStartTs),
        pendingSignal: pendingBet.signal,
      });
      return;
    }

    if (hasActiveRestingFillWatch()) {
      cycleStatus = 'resting_fill_pending';
      logger.warn('[main] 仍有 GTC 挂单监视中 — 跳过本周期下单');
      return;
    }

    if (isCycleOrdered(cycleStartTs)) {
      cycleStatus = 'already_ordered';
      logger.info('[main] 本周期已下单（快路径）— 跳过重复下单', {
        cycle: formatBeijingTime(cycleStartTs),
      });
      return;
    }

    const vgEarly = vegasState.getState();
    const inChainCont =
      vgEarly.phase === 'in_chain' &&
      (vgEarly.lockedSignal === 'UP' || vgEarly.lockedSignal === 'DOWN');

    // ── in_chain: skip OHLCV/EMA — direction already locked ──
    if (inChainCont) {
      const signalObj = buildMgContSignal(
        vgEarly.lockedSignal,
        `马丁同向续单（锁定 ${vgEarly.lockedSignal}）`,
      );
      lastSignal = signalObj.signal;
      writeSignalLog(signalObj);
      logger.info('[main] 信号', {
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        reason: signalObj.reason,
        phase: signalObj.phase,
        lockedSignal: signalObj.lockedSignal,
        path: 'in_chain_fast',
      });

      const result = await executeTrade({
        cycleStartTs,
        signalObj,
        source: 'in_chain',
      });
      cycleStatus = result.status === 'filled' || result.status === 'resting' ? 'ok' : result.status;
      return;
    }

    // ── New signal path: fresh closed candles + OKX EMA (retry in-cycle if not ready) ──
    const dataDeadline = resolveSignalDataDeadlineMs({
      nowMs: Date.now(),
      cycleStartTs,
      cycleMs: CYCLE_MS,
      maxWaitMs: config.signalDataMaxWaitMs,
      minTradeRemainingMs: config.minTradeRemainingMs,
    });

    let signalObj = null;
    let dataAttempt = 0;
    let lastDataError = null;

    while (!shutdownRequested && Date.now() < dataDeadline) {
      dataAttempt += 1;

      try {
        candles = await fetchClosedCandles(config.candleLimit);
        lastDataError = null;
      } catch (err) {
        lastDataError = err?.message ?? String(err);
        logger.warn('[main] K 线拉取失败 — 周期内重试', {
          attempt: dataAttempt,
          error: lastDataError,
          retryMs: config.signalDataRetryMs,
          deadlineInMs: dataDeadline - Date.now(),
        });
        await sleepUntilShutdown(config.signalDataRetryMs);
        continue;
      }

      if (candles.length < MIN_SIGNAL_CANDLES) {
        logger.warn('[main] K 线数量不足 — 周期内重试', {
          attempt: dataAttempt,
          got: candles.length,
          need: MIN_SIGNAL_CANDLES,
        });
        await sleepUntilShutdown(config.signalDataRetryMs);
        continue;
      }

      const kMinus1 = candles.at(-1);
      const kMinus2 = candles.at(-2);
      if (!isCandleFresh(kMinus1, CYCLE_MS, { cycleStartTs })) {
        logger.warn('[main] K 线未新鲜 — 周期内重试', {
          attempt: dataAttempt,
          candleT: formatBeijingTime(kMinus1.t),
          expectedT: formatBeijingTime(cycleStartTs - CYCLE_MS),
          cycle: formatBeijingTime(cycleStartTs),
          retryMs: config.signalDataRetryMs,
          deadlineInMs: dataDeadline - Date.now(),
        });
        await sleepUntilShutdown(config.signalDataRetryMs);
        continue;
      }
      if (!areSignalCandlesAligned(kMinus2, kMinus1, CYCLE_MS)) {
        logger.warn('[main] 信号 K 线未对齐 — 周期内重试', {
          attempt: dataAttempt,
          kMinus2T: kMinus2 ? formatBeijingTime(kMinus2.t) : null,
          kMinus1T: formatBeijingTime(kMinus1.t),
          cycle: formatBeijingTime(cycleStartTs),
          retryMs: config.signalDataRetryMs,
          deadlineInMs: dataDeadline - Date.now(),
        });
        await sleepUntilShutdown(config.signalDataRetryMs);
        continue;
      }

      signalObj = await vegasState.resolveSignal(candles);

      if (isSignalDataNotReady(signalObj.reason, signalObj.retryable)) {
        logger.warn('[main] 信号数据未就绪（EMA/对齐）— 周期内重试', {
          attempt: dataAttempt,
          reason: signalObj.reason,
          phase: signalObj.phase,
          retryMs: config.signalDataRetryMs,
          deadlineInMs: dataDeadline - Date.now(),
        });
        signalObj = null;
        await sleepUntilShutdown(config.signalDataRetryMs);
        continue;
      }

      // VG entry must use this window's last two closed bars — else unlock & refetch.
      if (signalObj.signalId === 'VG_UP' || signalObj.signalId === 'VG_DOWN') {
        const expectedK1 = cycleStartTs - CYCLE_MS;
        const expectedK2 = expectedK1 - CYCLE_MS;
        const sigK1 = signalObj.kMinus1?.t;
        const sigK2 = signalObj.kMinus2?.t;
        const k1Ok = sigK1 != null && Math.abs(sigK1 - expectedK1) <= 2_000;
        const k2Ok = sigK2 != null && Math.abs(sigK2 - expectedK2) <= 2_000;
        if (!k1Ok || !k2Ok) {
          logger.warn('[main] 信号 K 线与窗口不对齐 — 撤销锁定并重拉重判', {
            attempt: dataAttempt,
            signalId: signalObj.signalId,
            kMinus2T: sigK2 != null ? formatBeijingTime(sigK2) : null,
            kMinus1T: sigK1 != null ? formatBeijingTime(sigK1) : null,
            expectedK2: formatBeijingTime(expectedK2),
            expectedK1: formatBeijingTime(expectedK1),
            cycle: formatBeijingTime(cycleStartTs),
            retryMs: config.signalDataRetryMs,
            deadlineInMs: dataDeadline - Date.now(),
          });
          vegasState.abortEntryLock('candle_misaligned_retry');
          signalObj = null;
          await sleepUntilShutdown(config.signalDataRetryMs);
          continue;
        }
      }

      break;
    }

    if (shutdownRequested) {
      cycleStatus = 'shutdown';
      return;
    }

    if (!signalObj) {
      cycleStatus = lastDataError ? 'ohlcv_failed' : 'signal_data_timeout';
      cycleError = lastDataError
        ?? `等待新鲜 K 线/EMA 对齐超时（attempts=${dataAttempt}）`;
      logger.error('[main] 周期内信号数据仍未就绪 — 保留窗口剩余时间不再强开', {
        attempts: dataAttempt,
        error: cycleError,
        deadline: formatBeijingTime(dataDeadline),
      });
      await notifyTelegram(
        `${tgHead('⚠️ <b>信号数据超时</b>')}\n` +
        `窗口: ${formatBeijingTime(cycleStartTs)}\n` +
        `标的: ${config.symbol} · ${config.timeframe}\n` +
        `重试: ${dataAttempt} 次后仍未就绪\n` +
        `原因: ${escapeHtml(cycleError)}\n` +
        await formatBalanceTelegramLine() +
        formatStatsTelegramBlock()
      );
      return;
    }

    lastSignal = signalObj.signal;
    writeSignalLog(signalObj);

    const vg = vegasState.getState();
    logger.info('[main] 信号', {
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      reason: signalObj.reason,
      phase: signalObj.phase ?? vg.phase,
      lockedSignal: signalObj.lockedSignal ?? vg.lockedSignal,
      path: 'vegas_entry',
      dataAttempts: dataAttempt,
    });

    if (signalObj.signal === 'NONE') {
      cycleStatus = 'no_signal';
      logger.info('[main] 无信号 — 跳过下单');
      await notifyTelegram(
        `${tgHead('⏭ <b>无信号 — 跳过本周期</b>')}\n` +
        `窗口: ${formatBeijingTime(cycleStartTs)}\n` +
        `标的: ${config.symbol} · ${config.timeframe}\n` +
        `阶段: ${escapeHtml(signalObj.phase ?? vg.phase)}\n` +
        `原因: ${escapeHtml(signalObj.reason)}\n` +
        await formatBalanceTelegramLine() +
        formatStatsTelegramBlock()
      );
      return;
    }

    const result = await executeTrade({
      cycleStartTs,
      signalObj,
      source: 'vegas_entry',
    });
    cycleStatus = result.status === 'filled' || result.status === 'resting' ? 'ok' : result.status;
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
      vegas: vegasState.getState(),
      dailyLossUsd: getDailyLossUsd(),
      ...stats.formatLogFields(),
      error: cycleError,
      shutdownRequested,
    });
  }
}

// ─────────────────────────────────────────
// Pending bet + settlement (OKX K 线 or Chainlink)
// ─────────────────────────────────────────

function registerPendingBet({
  cycleStartTs,
  signal,
  actualBet,
  orderId,
  limitPrice,
  entryPrice,
  fill,
}) {
  pendingBet = {
    cycleStartTs,
    signal,
    actualBet,
    orderId,
    limitPrice,
    entryPrice: entryPrice ?? fill?.entryPrice ?? limitPrice ?? null,
    fill: fill ?? null,
  };
  markCycleOrdered(cycleStartTs);
  savePending();
  scheduleChainlinkSettlement(pendingBet);
  // Prewarm NEXT window market so loss → MG_CONT can hit Gamma cache immediately.
  const nextCycle = cycleStartTs + CYCLE_MS;
  trackWork(
    findCurrentCycleMarket(nextCycle, nextCycle + CYCLE_MS).catch((err) => {
      logger.debug('[main] 下一周期盘口预热失败（不影响结算）', {
        nextCycle: formatBeijingTime(nextCycle),
        error: err?.message,
      });
    }),
  );
  logger.info('[main] 待结算注单已登记', {
    cycleStartTs: formatBeijingTime(cycleStartTs),
    signal,
    actualBet,
    orderId,
  });
}

async function confirmOrderFilled(pending) {
  if (config.dryRun) return true;
  if (!pending?.orderId) return true;

  // Order was already confirmed at placement / resting fill watch.
  if (Number(pending.fill?.usdcSpent) > 0 || Number(pending.actualBet) > 0) {
    return true;
  }

  try {
    const client = await getClobClient();
    const fill = await fetchFillFromOrder(client, pending.orderId);
    if (fill.usdcSpent > 0) return true;

    logger.warn('[settle] 结算时订单未成交 — 作废待结算注单', {
      orderId: pending.orderId,
      status: fill.status,
    });
    unmarkCycleOrdered(pending.cycleStartTs);
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
 * Apply settlement for a pending bet.
 * Returns true when settled; false when not ready or pending changed.
 */
async function applySettlement(pending, { candles } = {}) {
  if (!pending || pending !== pendingBet) return false;

  const result = await computeSettlement(pending, { candles });
  if (!result.ready) {
    const cycleEnd = pending.cycleStartTs + CYCLE_MS;
    const log = Date.now() > cycleEnd + CYCLE_MS ? logger.warn : logger.debug;
    log('[settle] 结算尚未就绪', {
      window: formatBeijingTime(pending.cycleStartTs),
      reason: result.reason,
      source: config.settleSource,
    });
    return false;
  }

  if (!(await confirmOrderFilled(pending))) {
    return false;
  }

  const candle = result.candle ?? candles?.find((k) => k.t === pending.cycleStartTs);
  const cross = usesChainlinkSettlement()
    ? crossCheckWithCandle(result, candle)
    : null;
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

  const { signal, cycleStartTs, actualBet, entryPrice, limitPrice } = pending;
  const { won, winningOutcome, targetPrice, closePrice, settleDelta } = result;
  const side = signal === 'UP' ? '📈 UP' : '📉 DOWN';
  const windowLabel = formatBeijingTime(cycleStartTs);
  const sourceLabel = result.sourceUsed === 'okx_fallback'
    ? `${settleSourceLabel()} → OKX 回退`
    : settleSourceLabel();
  const price = entryPrice ?? limitPrice ?? null;

  const pnlUsd = stats.computeSettlementPnl(won, actualBet, price);
  const { halted, chainPnlUsd } = martingale.onSettled(won, pnlUsd);
  vegasState.onSettled(won, halted);

  if (!won) recordLoss(actualBet);
  stats.recordSettlement({ won, pnlUsd });
  if (halted) stats.recordStopLoss();

  logger.info(`[settle] ${sourceLabel} 结算结果`, {
    window: windowLabel,
    targetPrice,
    closePrice,
    winningOutcome,
    signal,
    won,
    settleDelta,
    pnlUsd,
    actualBet,
    martingaleHalted: halted,
    chainPnlUsd,
    crossCheck: cross,
    ...stats.formatLogFields(),
  });

  pendingBet = null;
  savePending();

  writeSettlementLog({
    ts: new Date().toISOString(),
    cycleStartTs,
    timeframe: config.timeframe,
    instanceId: config.instanceId,
    signal,
    actualBet,
    entryPrice: price,
    pnlUsd,
    won,
    winningOutcome,
    targetPrice,
    closePrice,
    settleDelta,
    settleSource: config.settleSource,
    exchangeDirection: cross?.exchangeDirection ?? candleDirection(candle),
    crossMismatch: cross?.mismatch ?? false,
    martingaleHalted: halted,
    dryRun: config.dryRun,
  });

  const mg = martingale.getState();

  // Settlement-driven fast path FIRST — do not wait on Telegram/balance before re-entry.
  if (shouldMgContFastPath({
    enabled: config.mgContFastPath,
    won,
    halted,
    phase: vegasState.getState().phase,
    lockedSignal: vegasState.getState().lockedSignal,
  })) {
    const t0 = Date.now();
    const fastPromise = trackWork(
      maybeMgContFastPath(cycleStartTs).catch((err) => {
        logger.error('[main] MG_CONT 快路径异常', { error: err?.message, stack: err?.stack });
        return { status: 'error' };
      }),
    );
    const fastResult = await fastPromise;
    logger.info('[main] MG_CONT 快路径完成', {
      status: fastResult?.status,
      elapsedMs: Date.now() - t0,
    });
  }

  const resultEmoji = won ? '✅' : '❌';
  const resultText = won ? '赢' : '输';
  const mismatchNote = cross?.mismatch
    ? `\n⚠️ 交易所 K 线: ${escapeHtml(cross.exchangeDirection)} ≠ Chainlink ${escapeHtml(cross.chainlinkOutcome)}`
    : '';

  const haltNote = halted
    ? `\n⚠️ <b>马丁连亏止损</b> — 等待通道外实体后再检测；首注已重置为 $${mg.baseBet}`
    : won
      ? `\n⏹ <b>链路结束</b> — 等待通道外实体后再检测`
      : '';

  const priceLine = usesChainlinkSettlement()
    ? `目标价: $${targetPrice.toFixed(2)} → 收盘价: $${closePrice.toFixed(2)}\n`
    : `开盘: $${targetPrice.toFixed(2)} → 收盘: $${closePrice.toFixed(2)}\n`;

  // Telegram after MG_CONT so settle→order latency is not inflated by TG retries.
  trackWork((async () => {
    const balanceLine = await formatBalanceTelegramLine();
    await notifyTelegram(
      `${tgHead(`${resultEmoji} <b>结算${resultText}</b> (${sourceLabel})`)}\n` +
      `窗口: ${windowLabel}\n` +
      `周期: ${config.timeframe}\n` +
      `方向: ${side}\n` +
      formatSettlementTradeLines({
        entryPrice: price,
        actualBet,
        pnlUsd,
        formatPnl: stats.formatPnlUsd,
      }) +
      `本链路盈亏: <b>${stats.formatPnlUsd(chainPnlUsd)}</b>\n` +
      priceLine +
      `结果: <b>${winningOutcome}</b> (Δ ${settleDelta >= 0 ? '+' : ''}${settleDelta.toFixed(2)})\n` +
      mismatchNote + haltNote +
      `连败: ${mg.consecutiveLosses} · 默认首注 $${config.tradeBudgetUsd}\n` +
      formatBankrollTelegramLines() +
      `今日亏损: $${getDailyLossUsd().toFixed(2)} / $${config.maxDailyLossUsd}\n` +
      balanceLine +
      formatStatsTelegramBlock()
    );
  })().catch((err) => {
    logger.warn('[main] 结算 Telegram 推送失败', { error: err?.message });
  }));

  return true;
}

// ─────────────────────────────────────────
// Scheduler: align to UTC cycle boundaries (default 1h)
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
  const signalOhlcv = describeOhlcvSource();

  martingale.init();
  vegasState.init();
  stats.init();
  initDailyLoss();
  loadPending();
  warnOrderPolicyMismatch();

  let startupBalance = null;
  let startupBal = null;
  try {
    startupBal = await getBalanceBreakdown();
    startupBalance = startupBal.portfolio;
    martingale.bankroll.ensurePrincipal(startupBalance);
  } catch (err) {
    logger.warn('[main] 启动时读取 Portfolio 失败 — 本金将在首单前锁定', {
      error: err?.message ?? String(err),
    });
  }

  const br = martingale.bankroll.getState();

  logger.info('▶ 机器人启动', {
    symbol: config.symbol,
    timeframe: config.timeframe,
    instanceId: config.instanceId,
    strategy: 'vegas_channel_okx_ema144_169',
    signalOhlcv: {
      exchange: signalOhlcv.exchange,
      market: signalOhlcv.label,
      symbol: signalOhlcv.symbol,
      timeframe: signalOhlcv.timeframe,
    },
    dryRun: config.dryRun,
    cycleMinutes: config.cycleMinutes,
    signalDelayMs: config.signalDelayMs,
    inChainSignalDelayMs: config.inChainSignalDelayMs,
    prewarmMs: config.prewarmMs,
    mgContFastPath: config.mgContFastPath,
    signalDataRetryMs: config.signalDataRetryMs,
    signalDataMaxWaitMs: config.signalDataMaxWaitMs,
    cycleTimeoutMs: config.cycleTimeoutMs,
    settlement: config.settleSource,
    settleBufferMs: config.chainlink.settleBufferMs,
    tradeBudgetUsd: config.tradeBudgetUsd,
    martingaleMultiplier: config.martingaleMultiplier,
    martingaleMaxLosses: config.martingaleMaxLosses,
    bankroll: br,
    startupBalance,
    orderType: config.orderType,
    orderRetryDelayMs: config.orderRetryDelayMs,
    orderPriceCap: config.orderPriceCap,
    envFile: existsSync(join(__dirname, '..', '.env')) ? '.env loaded (override)' : '.env missing',
    vegas: vegasState.getState(),
    ...stats.formatLogFields(),
  });

  const tfMin = (() => {
    const m = String(config.timeframe).match(/^(\d+)(m|h)$/i);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2].toLowerCase() === 'h' ? n * 60 : n;
  })();
  if (tfMin != null && tfMin !== config.cycleMinutes) {
    logger.warn('[main] CANDLE_TIMEFRAME 与 MARKET_CYCLE_MINUTES 不一致 — 请检查配置', {
      timeframe: config.timeframe,
      cycleMinutes: config.cycleMinutes,
      expectedMinutes: tfMin,
    });
  }

  // Stagger startup TG across timeframe instances to reduce 429 bursts
  {
    const id = String(config.instanceId || '');
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    const staggerMs = (h % 3) * 1200;
    if (staggerMs > 0) {
      logger.info('[telegram] 启动通知错峰', { staggerMs, instanceId: id });
      await sleepUntilShutdown(staggerMs);
    }
  }

  await notifyTelegram(
    `${tgHead('▶ <b>机器人启动</b>')}\n` +
    `标的: ${config.symbol}\n` +
    `周期: ${config.timeframe} (${config.cycleMinutes}m)\n` +
    `实例: ${config.instanceId}\n` +
    `模式: ${config.dryRun ? 'DRY_RUN' : 'LIVE'}\n` +
    `结算: <b>${escapeHtml(settleSourceLabel())}</b> (${escapeHtml(config.settleSource)})\n` +
    `马丁: 默认$${config.tradeBudgetUsd} ×${config.martingaleMultiplier} / 连亏${config.martingaleMaxLosses}\n` +
    formatBankrollTelegramLines() +
    (startupBalance != null
      ? `启动 Portfolio: $${Number(startupBalance).toFixed(2)}` +
        (startupBal
          ? `（Cash $${Number(startupBal.cash).toFixed(2)} + 持仓 $${Number(startupBal.positionsValue).toFixed(2)}）`
          : '') +
        `\n`
      : '')
  );

  initChainlinkSettler({
    getPendingBet: () => pendingBet,
    settleFn: applySettlement,
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
      fill: ctx.fill,
    });

    const side = ctx.signal === 'UP' ? '📈 买涨 UP' : '📉 买跌 DOWN';
    const fillNote = formatFillNote(ctx.fill);
    const mgState = martingale.getState();
    const priceOdds = formatPriceOddsLines({
      fill: ctx.fill,
      limitPrice: ctx.limitPrice,
      signal: ctx.signal,
      amountUsdc: ctx.actualBet,
    });
    await notifyTelegram(
      `${tgHead('🤖 <b>限价单成交</b>')}\n` +
      `方向: <b>${side}</b> (${ctx.signalId ?? '—'})\n` +
      `周期: ${config.timeframe}\n` +
      (ctx.signalReason ? `原因: ${escapeHtml(ctx.signalReason)}\n` : '') +
      priceOdds +
      (fillNote ? `成交明细: ${escapeHtml(fillNote)}\n` : '') +
      formatChainTelegramLines(mgState) +
      `窗口: ${formatBeijingTime(ctx.cycleStartTs)}\n` +
      await formatBalanceTelegramLine() +
      formatStatsTelegramBlock()
    );
  });

  if (usesChainlinkSettlement()) {
    await startRtdsBuffer([config.symbol]);
  } else {
    logger.info(`[settle] 使用 OKX 永续 ${config.timeframe} K 线结算，Chainlink RTDS 已跳过`);
  }
  startChainlinkSettler();

  try {
    logger.info('[main] CLOB 预热中...');
    await getClobClient();
  } catch (err) {
    logger.error('[main] CLOB 预热失败 — 退出', { error: err?.message });
    stopChainlinkSettler();
    if (usesChainlinkSettlement()) stopRtdsBuffer();
    process.exit(1);
  }

  if (pendingBet) {
    scheduleChainlinkSettlement(pendingBet);
    logger.info('[settle] 重启后重新调度待结算注单', {
      pendingBet: {
        cycleStartTs: pendingBet.cycleStartTs,
        signal: pendingBet.signal,
      },
    });
  }

  writeHeartbeat({
    status: 'started',
    dryRun: config.dryRun,
    pendingBet: pendingBet
      ? { cycleStartTs: pendingBet.cycleStartTs, signal: pendingBet.signal }
      : null,
    ...stats.formatLogFields(),
  });

  // eslint-disable-next-line no-constant-condition
  while (!shutdownRequested) {
    const boundary = nextCycleBoundary();
    const waitMs = boundary - Date.now();
    const prewarmMs = config.prewarmMs;

    logger.debug('[scheduler] 等待下一周期边界', {
      boundary: formatBeijingTime(boundary),
      waitMs,
      prewarmMs,
    });

    // Prefetch Gamma / CLOB / balance before the boundary so order path is hot
    if (waitMs > prewarmMs && prewarmMs > 0) {
      await sleepUntilShutdown(waitMs - prewarmMs);
      if (shutdownRequested) break;

      const prewarmDeadline = boundary + Math.max(config.signalDelayMs, 10_000) + 30_000;
      logger.info('[scheduler] 周期前预热', {
        boundary: formatBeijingTime(boundary),
        prewarmMs,
      });
      await Promise.allSettled([
        findCurrentCycleMarket(boundary, prewarmDeadline),
        getBalanceBreakdown(),
        getClobClient(),
      ]);

      await sleepUntilShutdown(Math.max(0, boundary - Date.now()));
    } else {
      await sleepUntilShutdown(waitMs);
    }
    if (shutdownRequested) break;

    const vg = vegasState.getState();
    const delayMs = resolveCycleSignalDelayMs({
      phase: vg.phase,
      lockedSignal: vg.lockedSignal,
      hasPending: Boolean(pendingBet),
      signalDelayMs: config.signalDelayMs,
      inChainSignalDelayMs: config.inChainSignalDelayMs,
      settleBufferMs: config.chainlink.settleBufferMs,
    });

    logger.debug('[scheduler] 边界后信号延迟', {
      delayMs,
      phase: vg.phase,
      hasPending: Boolean(pendingBet),
    });

    await sleepUntilShutdown(delayMs);
    if (shutdownRequested) break;

    cycleInProgress = trackWork(
      runCycle(boundary)
        .catch((err) => {
          logger.error('[main] 周期执行异常', { error: err?.message, stack: err?.stack });
        })
        .finally(() => {
          cycleInProgress = null;
        }),
    );

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

    if (inFlightWork.size > 0) {
      await Promise.allSettled([...inFlightWork]);
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
