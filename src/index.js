/**
 * Polymarket bot — entry point
 * Strategy: 神奇九转 (Magic Nine)
 * Multi-instance: BOT_INSTANCE + CANDLE_TIMEFRAME; all share BANKROLL_SCOPE=jz
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
  isChainlinkFeedHealthy,
  captureCycleTargetPrice,
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
import * as strategyState from './strategy/activeStrategy.js';
import { MIN_SIGNAL_CANDLES } from './strategy/activeStrategy.js';
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
import { fetchCombinedFillFromOrders, formatFillNote, formatPriceOddsLines, formatSettlementTradeLines } from './trader/fillSync.js';
import {
  initRestingFillWatcher,
  scheduleRestingFillWatch,
  stopAllRestingFillWatchers,
  stopRestingFillWatch,
  stopRestingFillWatchesForCycle,
  stopRestingFillWatchesForOrders,
  hasActiveRestingFillWatch,
  hasActiveRestingFillWatchForCycle,
} from './trader/restingFillWatcher.js';
import * as martingale from './martingale/manager.js';
import { formatBankrollTelegramLines } from './martingale/bankroll.js';
import * as stats from './stats/manager.js';
import * as buttonSequence from './button/sequence.js';
import { notifyTelegram, escapeHtml } from './utils/telegram.js';
import { startCallbackPoller, stopCallbackPoller, drainCommandQueue } from './telegram/callbackPoller.js';
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
function tgHead(titleHtml) {
  const base = String(config.symbol || '').split('/')[0] || '?';
  return `[${base}·${config.timeframe}·九转] ${titleHtml}`;
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
/** Cycles already settled or voided — ignore late fillWatch callbacks. */
const closedCycleTs = new Set();
let placingForCycle = null;
/** Avoid spamming TG for the same stuck pending cycle. */
let lastStuckSettleNotifyKey = null;

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
  const statsEquity = config.bankrollUseStatsEquity
    ? martingale.resolveSizingEquity()
    : null;
  return (
    `本链路盈亏: <b>${stats.formatPnlUsd(chainPnl)}</b>\n` +
    `马丁: 默认首注 $${config.tradeBudgetUsd} · 连败 ${mgState.consecutiveLosses} · 本单注 $${mgState.currentBet}\n` +
    formatBankrollTelegramLines(sizing, { statsEquity }) +
    buttonSequence.formatTelegramLines()
  );
}

function formatTradeSourceNote(source, sources = ['project']) {
  if (source === 'mg_cont_fast') return `\n⚡ 快路径: 结算输后续单\n`;
  if (source === 'button_seq_fast') return `\n⚡ 快路径: 按钮序列续单\n`;
  if (source === 'button_seq') return `\n🔘 按钮序列开单\n`;
  if (sources.includes('button') && sources.includes('project')) {
    return `\n🔘 项目+按钮同向合并\n`;
  }
  return '';
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
  for (const ts of closedCycleTs) {
    if (ts < cutoff) closedCycleTs.delete(ts);
  }
}

function markCycleOrdered(cycleStartTs) {
  pruneOrderedCycles();
  orderedCycleTs.add(cycleStartTs);
}

function unmarkCycleOrdered(cycleStartTs) {
  orderedCycleTs.delete(cycleStartTs);
}

function markCycleClosed(cycleStartTs) {
  pruneOrderedCycles();
  closedCycleTs.add(cycleStartTs);
}

function isCycleClosed(cycleStartTs) {
  return closedCycleTs.has(cycleStartTs);
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
    // Only block if THIS cycle still has an open GTC watch — prior-cycle watches must not block MG_CONT
    if (hasActiveRestingFillWatchForCycle(cycleStartTs)) {
      return { status: 'resting_fill_pending' };
    }
    if (isCycleOrdered(cycleStartTs)) return { status: 'already_ordered' };
    placingForCycle = cycleStartTs;
    return await fn();
  } finally {
    if (placingForCycle === cycleStartTs) placingForCycle = null;
    release();
  }
}

/**
 * Attach active button sequence to a pending project order (same direction merge).
 * @param {number} cycleStartTs
 */
function tryAttachButtonToPending(cycleStartTs) {
  if (!pendingBet || pendingBet.cycleStartTs !== cycleStartTs) return;
  const btn = buttonSequence.getState();
  if (!btn.active || btn.cyclesElapsed >= btn.cyclesTotal) return;
  if (pendingBet.sources?.includes('button')) return;
  if (pendingBet.signal !== btn.direction) return;
  pendingBet.sources = [...(pendingBet.sources || ['project']), 'button'];
  const slot = buttonSequence.consumeSlot({ kind: 'merge' });
  if (!slot.consumed) return;
  savePending();
  logger.info('[main] 按钮序列并入待结算注单', {
    cycle: formatBeijingTime(cycleStartTs),
    signal: pendingBet.signal,
    sources: pendingBet.sources,
  });
}

/**
 * Resolve project + button sequence for one cycle window.
 * @returns {Promise<{ handled: boolean, result?: object }>}
 */
async function processCycleTradeDecision({ cycleStartTs, projectSignalObj, projectSource }) {
  const btn = buttonSequence.getState();
  const btnSlotActive = btn.active && btn.cyclesElapsed < btn.cyclesTotal;

  if (btn.pendingStart && btnSlotActive) {
    buttonSequence.clearPendingStart();
  }

  const projectDir = (projectSignalObj?.signal === 'UP' || projectSignalObj?.signal === 'DOWN')
    ? projectSignalObj.signal
    : null;
  const btnDir = btnSlotActive ? btn.direction : null;

  if (btnSlotActive && btnDir) {
    if (projectDir && projectDir !== btnDir) {
      const slot = buttonSequence.consumeSlot({ kind: 'skip' });
      if (!slot.consumed) {
        return { handled: false };
      }
      logger.info('[main] 按钮反向跳过 — 按项目信号', {
        projectDir,
        btnDir,
        cycle: formatBeijingTime(cycleStartTs),
      });
      const result = await executeTrade({
        cycleStartTs,
        signalObj: projectSignalObj,
        source: projectSource,
        sources: ['project'],
      });
      return { handled: true, result };
    }

    if (projectDir && projectDir === btnDir) {
      const slot = buttonSequence.consumeSlot({ kind: 'merge' });
      if (!slot.consumed) {
        return { handled: false };
      }
      const result = await executeTrade({
        cycleStartTs,
        signalObj: projectSignalObj,
        source: projectSource,
        sources: ['project', 'button'],
      });
      return { handled: true, result };
    }

    const slot = buttonSequence.consumeSlot({ kind: 'bet' });
    if (!slot.consumed) {
      return { handled: false };
    }
    const btnSignal = buttonSequence.buildButtonSignal(
      btnDir,
      `按钮序列第 ${slot.cyclesElapsed}/${slot.cyclesTotal} 周期`,
    );
    writeSignalLog(btnSignal);
    logger.info('[main] 按钮序列开单', {
      signal: btnDir,
      cycle: formatBeijingTime(cycleStartTs),
      slot: slot.cyclesElapsed,
    });
    const result = await executeTrade({
      cycleStartTs,
      signalObj: btnSignal,
      source: 'button_seq',
      sources: ['button'],
    });
    return { handled: true, result };
  }

  if (projectDir) {
    const result = await executeTrade({
      cycleStartTs,
      signalObj: projectSignalObj,
      source: projectSource,
      sources: ['project'],
    });
    return { handled: true, result };
  }

  return { handled: false };
}

async function handleTelegramCommand(cmd) {
  if (cmd.action === 'reset') {
    if (config.instanceId !== config.telegram.resetInstanceId) return;
    const bal = await getBalanceBreakdown();
    const st = martingale.bankroll.resetPrincipalAndNet(bal.portfolio);
    await notifyTelegram(
      `${tgHead('🔄 <b>本金/净胜负已重置</b>')}\n` +
      `本金 P: <b>$${Number(st.principal).toFixed(2)}</b>（当前 Portfolio）\n` +
      `净胜负 N: <b>0</b>\n` +
      `补队列: <b>已清空</b>\n` +
      `目标线: <b>$${Number(st.targetBalance).toFixed(2)}</b>\n` +
      await formatBalanceTelegramLine(bal) +
      formatStatsTelegramBlock(),
    );
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
async function executeTrade({ cycleStartTs, signalObj, source = 'cycle', sources = ['project'] }) {
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

  // Optional: block opens when Chainlink RTDS is down (CHAINLINK_REQUIRE_FOR_OPEN=true).
  // Default false — open on signal; settlement still falls back to OKX so ledger can advance.
  if (usesChainlinkSettlement() && config.chainlink.requireForOpen) {
    const feed = isChainlinkFeedHealthy(config.symbol);
    if (!feed.ok) {
      logger.warn('[main] Chainlink 未就绪 — 跳过下单（CHAINLINK_REQUIRE_FOR_OPEN=true）', {
        cycle: formatBeijingTime(cycleStartTs),
        source,
        reason: feed.reason,
        connected: feed.connected,
        tickAgeMs: feed.tickAgeMs,
        requireFreshMs: config.chainlink.requireFreshMs,
      });
      return {
        status: 'chainlink_unavailable',
        signal: signalObj.signal,
        signalId: signalObj.signalId,
      };
    }
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
    // ORDER_PRICE_CAP only used to clip limit price before; catch-up stake = T×p/(1−p)
    // must use the same capped p, or a 0.92 book ask blows up size while we hang @0.70.
    {
      const cap =
        pricePolicy.maxLimitPrice ??
        (config.orderPriceCap > 0 ? config.orderPriceCap : null);
      if (cap > 0 && Number(sizingPrice) > cap) {
        logger.info('[main] 算仓价按 ORDER_PRICE_CAP 封顶', {
          rawSizingPrice: sizingPrice,
          orderPriceCap: cap,
          signal: signalObj.signal,
        });
        sizingPrice = cap;
      }
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
    const companionOrderIds = orderResult.companionOrderIds || (
      orderResult.topUpOrderId ? [orderResult.topUpOrderId] : []
    );

    if (spent > 0) {
      registerPendingBet({
        cycleStartTs,
        signal: signalObj.signal,
        actualBet: spent,
        orderId: orderResult.orderId,
        limitPrice: orderResult.limitPrice,
        fill: orderResult.fill,
        companionOrderIds,
        sources,
        signalId: signalObj.signalId,
      });

      const stillResting = orderResult.resting || orderResult.fill?.resting;
      if (stillResting) {
        scheduleRestingFillWatch({
          orderId: orderResult.orderId,
          cycleStartTs,
          signal: signalObj.signal,
          signalId: signalObj.signalId,
          cycleEndMs,
          limitPrice: orderResult.limitPrice,
          companionOrderIds,
        });
      }

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
      const sourceNote = formatTradeSourceNote(source, sources);
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
      const sourceNote = formatTradeSourceNote(source, sources);
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

async function maybeButtonSeqFastPath(settledCycleStartTs) {
  if (!buttonSequence.shouldButtonSeqFastPath()) {
    return { status: 'not_eligible' };
  }

  const btn = buttonSequence.getState();
  const vg = strategyState.getState();
  const projectDir = vg.phase === 'in_chain' ? vg.lockedSignal : null;

  if (projectDir && projectDir !== btn.direction) {
    logger.info('[main] 按钮快路径 defer — 下周期与项目反向，交由常规调度跳过', {
      projectDir,
      btnDir: btn.direction,
    });
    return { status: 'defer_reverse' };
  }

  const nextCycle = nextCycleStartTs(settledCycleStartTs, CYCLE_MS);
  if (!isWithinTradeWindow(Date.now(), nextCycle, CYCLE_MS, config.minTradeRemainingMs)) {
    logger.info('[main] 按钮快路径 — 下一窗口剩余时间不足，交由常规调度', {
      nextCycle: formatBeijingTime(nextCycle),
    });
    return { status: 'too_late' };
  }

  if (projectDir && projectDir === btn.direction) {
    const slot = buttonSequence.consumeSlot({ kind: 'merge' });
    if (!slot.consumed) {
      return { status: 'sequence_done' };
    }
    const signalObj = buildMgContSignal(
      projectDir,
      `按钮+项目同向快路径（锁定 ${projectDir}）`,
    );
    writeSignalLog(signalObj);
    logger.info('[main] 按钮快路径 — 与项目同向合并', {
      settledCycle: formatBeijingTime(settledCycleStartTs),
      nextCycle: formatBeijingTime(nextCycle),
      direction: projectDir,
    });
    return executeTrade({
      cycleStartTs: nextCycle,
      signalObj,
      source: 'button_seq_fast',
      sources: ['project', 'button'],
    });
  }

  const slot = buttonSequence.consumeSlot({ kind: 'bet' });
  if (!slot.consumed) {
    logger.info('[main] 按钮快路径 — 序列已结束，跳过续单', {
      settledCycle: formatBeijingTime(settledCycleStartTs),
      cyclesElapsed: slot.cyclesElapsed,
    });
    return { status: 'sequence_done' };
  }
  const signalObj = buttonSequence.buildButtonSignal(
    btn.direction,
    '按钮序列 — 结算后快路径续单',
  );
  writeSignalLog(signalObj);
  logger.info('[main] 按钮快路径 — 结算后立即续单', {
    settledCycle: formatBeijingTime(settledCycleStartTs),
    nextCycle: formatBeijingTime(nextCycle),
    direction: btn.direction,
    cyclesElapsed: slot.cyclesElapsed,
  });

  return executeTrade({
    cycleStartTs: nextCycle,
    signalObj,
    source: 'button_seq_fast',
    sources: ['button'],
  });
}

/**
 * After loss settlement (not halted): immediately bet the next cycle window.
 */
async function maybeMgContFastPath(settledCycleStartTs) {
  const vg = strategyState.getState();
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
        tryAttachButtonToPending(cycleStartTs);
        cycleStatus = 'already_ordered';
        logger.info('[main] 本周期已有待结算注单（快路径）— 跳过重复下单', {
          cycle: formatBeijingTime(cycleStartTs),
          signal: pendingBet.signal,
          sources: pendingBet.sources,
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

    if (hasActiveRestingFillWatchForCycle(cycleStartTs)) {
      cycleStatus = 'resting_fill_pending';
      logger.warn('[main] 本周期 GTC 挂单仍在监视 — 跳过重复下单', {
        cycle: formatBeijingTime(cycleStartTs),
      });
      return;
    }

    if (isCycleOrdered(cycleStartTs)) {
      cycleStatus = 'already_ordered';
      logger.info('[main] 本周期已下单（快路径）— 跳过重复下单', {
        cycle: formatBeijingTime(cycleStartTs),
      });
      return;
    }

    const btnPendingStart = buttonSequence.getState();
    if (btnPendingStart.active && btnPendingStart.pendingStart) {
      const btnFirst = await processCycleTradeDecision({
        cycleStartTs,
        projectSignalObj: null,
        projectSource: 'button_seq',
      });
      if (btnFirst.handled) {
        cycleStatus = btnFirst.result?.status === 'filled' || btnFirst.result?.status === 'resting'
          ? 'ok'
          : (btnFirst.result?.status ?? 'ok');
        logger.info('[main] 按钮序列首注（周期初快路径）', {
          cycle: formatBeijingTime(cycleStartTs),
          status: btnFirst.result?.status,
        });
        return;
      }
    }

    const vgEarly = strategyState.getState();
    const inChainCont =
      vgEarly.phase === 'in_chain' &&
      (vgEarly.lockedSignal === 'UP' || vgEarly.lockedSignal === 'DOWN');

    // ── in_chain: skip OHLCV — direction already locked ──
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

      const result = await processCycleTradeDecision({
        cycleStartTs,
        projectSignalObj: signalObj,
        projectSource: 'in_chain',
      });
      cycleStatus = result.result?.status === 'filled' || result.result?.status === 'resting'
        ? 'ok'
        : (result.result?.status ?? 'ok');
      return;
    }

    // ── New signal path: fresh closed candles (retry in-cycle if not ready) ──
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

      signalObj = await strategyState.resolveSignal(candles);

      if (isSignalDataNotReady(signalObj.reason, signalObj.retryable)) {
        logger.warn('[main] 信号数据未就绪（K线/对齐）— 周期内重试', {
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
          strategyState.abortEntryLock('candle_misaligned_retry');
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
        ?? `等待新鲜 K 线对齐超时（attempts=${dataAttempt}）`;
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

    const vg = strategyState.getState();
    logger.info('[main] 信号', {
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      reason: signalObj.reason,
      phase: signalObj.phase ?? vg.phase,
      lockedSignal: signalObj.lockedSignal ?? vg.lockedSignal,
      path: 'jz_entry',
      dataAttempts: dataAttempt,
    });

    if (signalObj.signal === 'NONE') {
      const btnDecision = await processCycleTradeDecision({
        cycleStartTs,
        projectSignalObj: signalObj,
        projectSource: 'jz_entry',
      });
      if (btnDecision.handled) {
        cycleStatus = btnDecision.result?.status === 'filled' || btnDecision.result?.status === 'resting'
          ? 'ok'
          : (btnDecision.result?.status ?? 'ok');
        return;
      }
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

    const resultWrap = await processCycleTradeDecision({
      cycleStartTs,
      projectSignalObj: signalObj,
      projectSource: 'jz_entry',
    });
    const result = resultWrap.result ?? { status: 'no_trade' };
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
        bankroll: {
          netCount: mg.bankroll?.netCount ?? null,
          targetBalance: mg.bankroll?.targetBalance ?? null,
          catchUpQueue: mg.bankroll?.catchUpQueue ?? [],
        },
      },
      strategyState: strategyState.getState(),
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
  companionOrderIds = [],
  sources = ['project'],
  signalId = null,
}) {
  // Persist cycle open target so settlement still works after RTDS buffer rolls off
  let targetPrice = null;
  let targetKind = null;
  if (usesChainlinkSettlement()) {
    const snap = captureCycleTargetPrice(config.symbol, cycleStartTs);
    if (snap) {
      targetPrice = snap.targetPrice;
      targetKind = snap.targetKind;
    } else {
      logger.warn('[main] 开单时未能锁定 Chainlink 开盘价 — 结算将依赖 OKX 回退', {
        cycle: formatBeijingTime(cycleStartTs),
      });
    }
  }

  pendingBet = {
    cycleStartTs,
    signal,
    actualBet,
    orderId,
    limitPrice,
    entryPrice: entryPrice ?? fill?.entryPrice ?? limitPrice ?? null,
    fill: fill ?? null,
    companionOrderIds: companionOrderIds.filter(Boolean),
    sources,
    signalId,
    targetPrice,
    targetKind,
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
    targetPrice,
    targetKind,
  });
}

function updatePendingBetFill({ actualBet, fill, companionOrderIds }) {
  if (!pendingBet) return;
  const prev = Number(pendingBet.actualBet) || 0;
  const next = Number(actualBet) || 0;
  if (next <= prev + 1e-6) return;

  pendingBet.actualBet = next;
  pendingBet.fill = fill ?? pendingBet.fill;
  if (companionOrderIds?.length) {
    pendingBet.companionOrderIds = companionOrderIds.filter(Boolean);
  }
  pendingBet.entryPrice = fill?.entryPrice ?? pendingBet.entryPrice;
  savePending();
  logger.info('[main] 待结算注单成交已更新', {
    cycleStartTs: formatBeijingTime(pendingBet.cycleStartTs),
    prevBet: prev,
    actualBet: next,
  });
}

async function confirmOrderFilled(pending) {
  if (config.dryRun) return true;
  if (!pending?.orderId) return Number(pending?.actualBet) > 0;

  try {
    const client = await getClobClient();
    const orderIds = [
      pending.orderId,
      ...(pending.companionOrderIds || []),
    ].filter(Boolean);
    const combined = await fetchCombinedFillFromOrders(client, orderIds);

    if (combined.usdcSpent > 0) {
      const prev = Number(pending.actualBet) || 0;
      if (Math.abs(combined.usdcSpent - prev) > 1e-6) {
        logger.info('[settle] 结算前刷新成交合计', {
          orderIds,
          prevBet: prev,
          refreshedBet: combined.usdcSpent,
        });
      }
      pending.actualBet = combined.usdcSpent;
      pending.fill = combined;
      pending.entryPrice = combined.entryPrice ?? pending.entryPrice ?? pending.limitPrice ?? null;
      savePending();
      return true;
    }

    if (Number(pending.actualBet) > 0) {
      logger.warn('[settle] getOrder 无成交记录 — 沿用 pending actualBet', {
        orderId: pending.orderId,
        actualBet: pending.actualBet,
      });
      return true;
    }

    const snapshot = {
      cycleStartTs: pending.cycleStartTs,
      signal: pending.signal,
      orderId: pending.orderId,
      actualBet: pending.actualBet,
    };
    logger.warn('[settle] 结算时订单未成交 — 作废待结算注单', {
      orderId: pending.orderId,
    });
    const voidOrderIds = [
      pending.orderId,
      ...(pending.companionOrderIds || []),
    ].filter(Boolean);
    unmarkCycleOrdered(pending.cycleStartTs);
    markCycleClosed(pending.cycleStartTs);
    stopRestingFillWatchesForOrders(voidOrderIds);
    stopRestingFillWatchesForCycle(pending.cycleStartTs);
    pendingBet = null;
    savePending();
    trackWork((async () => {
      await notifyTelegram(
        `${tgHead('⚠️ <b>结算跳过</b>（订单未成交，已作废）')}\n` +
        `窗口: ${formatBeijingTime(snapshot.cycleStartTs)}\n` +
        `方向: ${snapshot.signal === 'UP' ? '📈 UP' : '📉 DOWN'}\n` +
        `orderId: <code>${escapeHtml(String(snapshot.orderId || '—'))}</code>\n` +
        `周期: ${config.timeframe}\n` +
        formatStatsTelegramBlock(),
      );
    })().catch((err) => {
      logger.warn('[settle] 作废通知 Telegram 失败', { error: err?.message });
    }));
    return false;
  } catch (err) {
    if (Number(pending.actualBet) > 0) {
      logger.warn('[settle] 成交刷新失败 — 沿用 pending actualBet', { error: err?.message });
      return true;
    }
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

  // Late-fill target capture if open missed storing it
  if (
    usesChainlinkSettlement() &&
    !Number.isFinite(Number(pending.targetPrice))
  ) {
    const snap = captureCycleTargetPrice(config.symbol, pending.cycleStartTs);
    if (snap) {
      pending.targetPrice = snap.targetPrice;
      pending.targetKind = snap.targetKind;
      savePending();
      logger.info('[settle] 已补录 Chainlink 开盘价', {
        window: formatBeijingTime(pending.cycleStartTs),
        targetPrice: snap.targetPrice,
        targetKind: snap.targetKind,
      });
    }
  }

  const result = await computeSettlement(pending, { candles });
  if (!result.ready) {
    const cycleEnd = pending.cycleStartTs + CYCLE_MS;
    const overdueMs = Date.now() - (cycleEnd + config.chainlink.settleBufferMs);
    const log = overdueMs > CYCLE_MS ? logger.warn : logger.debug;
    log('[settle] 结算尚未就绪', {
      window: formatBeijingTime(pending.cycleStartTs),
      reason: result.reason,
      chainlinkReason: result.chainlinkReason,
      source: config.settleSource,
      overdueMs,
    });

    // Alert once when stuck past one cycle — ledger gap risk
    if (overdueMs >= CYCLE_MS) {
      const key = `${pending.cycleStartTs}:${result.reason}`;
      if (lastStuckSettleNotifyKey !== key) {
        lastStuckSettleNotifyKey = key;
        trackWork((async () => {
          await notifyTelegram(
            `${tgHead('⚠️ <b>结算卡住</b>')}\n` +
            `窗口: ${formatBeijingTime(pending.cycleStartTs)}\n` +
            `方向: ${pending.signal === 'UP' ? '📈 UP' : '📉 DOWN'}\n` +
            `原因: <code>${escapeHtml(String(result.reason || 'unknown'))}</code>\n` +
            (result.chainlinkReason
              ? `Chainlink: <code>${escapeHtml(String(result.chainlinkReason))}</code>\n`
              : '') +
            `已超时: ${Math.round(overdueMs / 1000)}s\n` +
            `将继续重试（含 OKX 回退）— 账本待结算完成后才入账\n` +
            `周期: ${config.timeframe}`,
          );
        })().catch((err) => {
          logger.warn('[settle] 卡住通知 Telegram 失败', { error: err?.message });
        }));
      }
    }
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

  const { pnlUsd, feeUsd } = stats.computeSettlementDetail(won, actualBet, price);

  const sources = pending.sources || ['project'];
  const hadProject = sources.includes('project');
  const hadButton = sources.includes('button');

  // Stats first so bankroll gap uses up-to-date cumulative P&L in stats-equity mode.
  stats.recordSettlement({ won, pnlUsd });

  let settleEquity = null;
  if (config.bankrollUseStatsEquity) {
    settleEquity = martingale.resolveSizingEquity();
  } else {
    try {
      const bd = await getBalanceBreakdown();
      settleEquity = bd.portfolio;
    } catch (err) {
      logger.warn('[settle] 拉取 Portfolio 失败 — 补队列可能无法按真实 gap 更新', {
        error: err?.message,
      });
    }
  }

  let halted = false;
  let chainPnlUsd = 0;

  if (hadProject) {
    const mgResult = martingale.onSettled(won, pnlUsd, settleEquity);
    halted = mgResult.halted;
    chainPnlUsd = mgResult.chainPnlUsd;
    strategyState.onSettled(won, halted);
  } else {
    martingale.bankroll.onSettled(won, settleEquity, pnlUsd);
  }

  if (hadButton) {
    buttonSequence.onSettled(won, pnlUsd);
  }

  if (!won) recordLoss(-pnlUsd);
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
    feeUsd,
    actualBet,
    martingaleHalted: halted,
    chainPnlUsd,
    crossCheck: cross,
    ...stats.formatLogFields(),
  });

  const settledOrderIds = [
    pending.orderId,
    ...(pending.companionOrderIds || []),
  ].filter(Boolean);

  pendingBet = null;
  savePending();
  lastStuckSettleNotifyKey = null;
  unmarkCycleOrdered(cycleStartTs);
  markCycleClosed(cycleStartTs);
  // Prior GTC watch must not block MG_CONT / next-cycle placeOrder
  stopRestingFillWatchesForOrders(settledOrderIds);
  stopRestingFillWatchesForCycle(cycleStartTs);

  writeSettlementLog({
    ts: new Date().toISOString(),
    cycleStartTs,
    timeframe: config.timeframe,
    instanceId: config.instanceId,
    signal,
    actualBet,
    entryPrice: price,
    pnlUsd,
    feeUsd,
    feeIncluded: true,
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
    sources,
    hadButton,
  });

  const mg = martingale.getState();

  const resultEmoji = won ? '✅' : '❌';
  const resultText = won ? '赢' : '输';
  const mismatchNote = cross?.mismatch
    ? `\n⚠️ 交易所 K 线: ${escapeHtml(cross.exchangeDirection)} ≠ Chainlink ${escapeHtml(cross.chainlinkOutcome)}`
    : '';

  const brAfter = mg.bankroll;
  const haltNote = halted
    ? `\n⚠️ <b>马丁连亏止损</b> — 等待下一次九转；连败计数已清零` +
      `\n本金/净胜负保持` +
      (brAfter?.principal != null ? ` P=$${Number(brAfter.principal).toFixed(2)}` : '') +
      (brAfter?.netCount != null ? ` · N=${brAfter.netCount}` : '')
    : won
      ? `\n⏹ <b>链路结束</b> — 等待下一次九转`
      : '';

  const priceLine = usesChainlinkSettlement()
    ? `目标价: $${targetPrice.toFixed(2)} → 收盘价: $${closePrice.toFixed(2)}\n`
    : `开盘: $${targetPrice.toFixed(2)} → 收盘: $${closePrice.toFixed(2)}\n`;

  const statsEquity = config.bankrollUseStatsEquity
    ? martingale.resolveSizingEquity()
    : null;

  // Fire settle TG before MG_CONT so notify isn't starved by open-order bursts / 429.
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
        feeUsd,
        formatPnl: stats.formatPnlUsd,
      }) +
      `本链路盈亏: <b>${stats.formatPnlUsd(chainPnlUsd)}</b>\n` +
      priceLine +
      `结果: <b>${winningOutcome}</b> (Δ ${settleDelta >= 0 ? '+' : ''}${settleDelta.toFixed(2)})\n` +
      mismatchNote + haltNote +
      `连败: ${mg.consecutiveLosses} · 默认首注 $${config.tradeBudgetUsd}\n` +
      formatBankrollTelegramLines(null, { statsEquity }) +
      buttonSequence.formatTelegramLines() +
      `今日亏损: $${getDailyLossUsd().toFixed(2)} / $${config.maxDailyLossUsd}\n` +
      balanceLine +
      formatStatsTelegramBlock()
    );
  })().catch((err) => {
    logger.warn('[main] 结算 Telegram 推送失败', { error: err?.message });
  }));

  // Fast path after settle TG is queued (do not await Telegram).
  const nextCycle = nextCycleStartTs(cycleStartTs, CYCLE_MS);

  if (shouldMgContFastPath({
    enabled: config.mgContFastPath,
    won,
    halted,
    phase: strategyState.getState().phase,
    lockedSignal: strategyState.getState().lockedSignal,
  })) {
    const t0 = Date.now();
    const fastPromise = trackWork(
      maybeMgContFastPath(cycleStartTs).catch((err) => {
        logger.error('[main] MG_CONT 快路径异常', { error: err?.message, stack: err?.stack });
        return { status: 'error' };
      }),
    );
    const fastResult = await fastPromise;
    tryAttachButtonToPending(nextCycle);
    logger.info('[main] MG_CONT 快路径完成', {
      status: fastResult?.status,
      elapsedMs: Date.now() - t0,
    });
  }

  if (buttonSequence.shouldButtonSeqFastPath()) {
    if (pendingBet) {
      tryAttachButtonToPending(nextCycle);
    }
    if (
      buttonSequence.shouldButtonSeqFastPath() &&
      !pendingBet?.sources?.includes('button')
    ) {
      const t0 = Date.now();
      const btnFast = await trackWork(
        maybeButtonSeqFastPath(cycleStartTs).catch((err) => {
          logger.error('[main] 按钮快路径异常', { error: err?.message, stack: err?.stack });
          return { status: 'error' };
        }),
      );
      logger.info('[main] 按钮快路径完成', {
        status: btnFast?.status,
        elapsedMs: Date.now() - t0,
      });
    }
  }

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
    await drainCommandQueue(handleTelegramCommand);
    await sleep(Math.min(step, remaining));
    remaining -= step;
  }
}

async function scheduler() {
  const signalOhlcv = describeOhlcvSource();

  martingale.init();
  strategyState.init();
  stats.init();
  buttonSequence.init();
  initDailyLoss();
  loadPending();
  warnOrderPolicyMismatch();
  startCallbackPoller();

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
    strategy: strategyState.strategyLogId(),
    strategyScope: config.strategy,
    bankrollScope: config.bankrollScope,
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
    bankrollUseStatsEquity: config.bankrollUseStatsEquity,
    startupBalance,
    orderType: config.orderType,
    orderRetryDelayMs: config.orderRetryDelayMs,
    orderPriceCap: config.orderPriceCap,
    envFile: existsSync(join(__dirname, '..', '.env')) ? '.env loaded (override)' : '.env missing',
    strategyState: strategyState.getState(),
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
    `策略: <b>${escapeHtml(strategyState.strategyLabel())}</b>\n` +
    `标的: ${config.symbol}\n` +
    `周期: ${config.timeframe} (${config.cycleMinutes}m)\n` +
    `实例: ${config.instanceId}\n` +
    `模式: ${config.dryRun ? 'DRY_RUN' : 'LIVE'}\n` +
    `结算: <b>${escapeHtml(settleSourceLabel())}</b> (${escapeHtml(config.settleSource)})\n` +
    `马丁: 默认$${config.tradeBudgetUsd} ×${config.martingaleMultiplier} / 连亏${config.martingaleMaxLosses}` +
    ` (胜结束·输锁1次)\n` +
    `账本: ${escapeHtml(config.bankrollScope)}（多标的多周期共用）\n` +
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
    if (isCycleClosed(ctx.cycleStartTs)) {
      logger.debug('[fillWatch] 周期已结算/作废 — 忽略迟到成交回调', {
        cycle: formatBeijingTime(ctx.cycleStartTs),
      });
      return;
    }

    const companionOrderIds = ctx.companionOrderIds || (
      ctx.topUpOrderId ? [ctx.topUpOrderId] : []
    );
    const sameCycle = pendingBet?.cycleStartTs === ctx.cycleStartTs;
    const sameOrder = pendingBet?.orderId === ctx.orderId;

    if (ctx.isUpdate || (sameCycle && sameOrder)) {
      updatePendingBetFill({
        actualBet: ctx.actualBet,
        fill: ctx.fill,
        companionOrderIds,
      });
      return;
    }

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
      companionOrderIds,
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
  }, {
    onEnded: ({ cycleStartTs, registered, aborted }) => {
      // Unfilled GTC watch ended without pending — clear already_ordered so future logic stays clean
      if (!registered && !aborted && Number.isFinite(Number(cycleStartTs))) {
        unmarkCycleOrdered(cycleStartTs);
        logger.info('[fillWatch] 未成交监视结束 — 已清除周期下单标记', {
          cycle: formatBeijingTime(cycleStartTs),
        });
      }
    },
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
    await drainCommandQueue(handleTelegramCommand);

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

    await drainCommandQueue(handleTelegramCommand);

    const vg = strategyState.getState();
    const btnForDelay = buttonSequence.getState();
    const delayMs = resolveCycleSignalDelayMs({
      phase: vg.phase,
      lockedSignal: vg.lockedSignal,
      // Wait for settle wake when prior bet OR prior GTC watch is still alive
      hasPending: Boolean(pendingBet) || hasActiveRestingFillWatch(),
      signalDelayMs: config.signalDelayMs,
      inChainSignalDelayMs: btnForDelay.pendingStart
        ? Math.min(config.signalDelayMs, config.inChainSignalDelayMs)
        : config.inChainSignalDelayMs,
      settleBufferMs: config.chainlink.settleBufferMs,
    });

    logger.debug('[scheduler] 边界后信号延迟', {
      delayMs,
      phase: vg.phase,
      hasPending: Boolean(pendingBet),
      hasRestingWatch: hasActiveRestingFillWatch(),
      buttonPendingStart: btnForDelay.pendingStart,
    });

    await sleepUntilShutdown(delayMs);
    if (shutdownRequested) break;

    await drainCommandQueue(handleTelegramCommand);

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
    await stopCallbackPoller();

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
