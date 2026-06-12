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
import {
  fetchClosedCandles,
  fetchVolatilityCandles,
  fetchSessionCandles,
  isCandleFresh,
  describeOhlcvSource,
} from './collector/binance.js';
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
  computeSettlement,
  crossCheckWithCandle,
  candleDirection,
  usesChainlinkSettlement,
  settleSourceLabel,
} from './trader/chainlinkSettle.js';
import { buildSignal } from './strategy/reversalContinuation.js';
import { findCurrentCycleMarket, resolveOrderPricePolicy } from './market/polymarket.js';
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
import { dynamicBaseBetEnabled, formatTierBetTable } from './martingale/dynamicBaseBet.js';
import * as stats from './stats/manager.js';
import { notifyTelegram, escapeHtml } from './utils/telegram.js';
import { formatBeijingTime } from './utils/datetime.js';
import {
  computeSignalVolatility,
  formatLogFields as formatVolatilityLogFields,
  snapshotForPending,
  formatTelegramBlock as formatVolatilityTelegramBlock,
} from './utils/volatility.js';
import {
  evaluateSession,
  advanceSessionState,
  loadSessionState,
  saveSessionState,
  formatSessionLogFields,
  formatSessionTelegramBlock,
  minSessionCandles,
} from './session/sessionGate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR    = join(__dirname, '..', 'logs');
const SIGNAL_LOG  = join(LOGS_DIR, 'signals.jsonl');
const SESSION_LOG = join(LOGS_DIR, 'session.jsonl');
const SETTLE_LOG  = join(LOGS_DIR, 'settlements.jsonl');
const PENDING_FILE = join(LOGS_DIR, 'pending-bet.json');

const CYCLE_MS = config.cycleMinutes * 60 * 1000;

// Pending bet awaiting settlement. Shape:
//   { cycleStartTs, signal, actualBet, targetPrice?, orderId? }
let pendingBet = null;

let shutdownRequested = false;
let cycleInProgress = null;
let sessionCtx = loadSessionState();

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
// Telegram helpers
// ─────────────────────────────────────────

/** @param {number} [balance] – if omitted, fetches live balance */
async function formatBalanceTelegramLine(balance) {
  try {
    const value = balance ?? await getBalance();
    return `余额: <b>$${value.toFixed(2)}</b>\n`;
  } catch {
    return '余额: <b>—</b>\n';
  }
}

// ─────────────────────────────────────────
// Volatility context (rv metrics for logging; direction is always continuation)
// ─────────────────────────────────────────

async function fetchVolatilityContext() {
  let volCandles;
  try {
    volCandles = await fetchVolatilityCandles();
  } catch (err) {
    logger.error('[main] 波动率 K 线拉取失败', { error: err?.message });
    return {
      rv: null,
      regime: 'low',
      regimeReason: '固定低波动反转（K 线拉取失败，仍按反转模式）',
      partial: true,
    };
  }

  const rv = computeSignalVolatility(volCandles);

  logger.info('[main] 波动率', {
    barTimeframe: rv.barTimeframe,
    rv_1m: rv.rv_1m,
    rv_5m: rv.rv_5m,
    rv_15m: rv.rv_15m,
    mode: 'low_reversal_only',
  });

  return {
    rv,
    regime: 'low',
    regimeReason: '固定低波动反转模式',
    partial: false,
  };
}

// ─────────────────────────────────────────
// Core per-cycle logic
// ─────────────────────────────────────────

async function runCycle(cycleStartTs) {
  const cycleStartedAt = Date.now();
  let cycleStatus = 'ok';
  let cycleError = null;
  let lastSignal = null;
  let lastVolCtx = null;
  let lastSessionCtx = null;

  logger.info('━━━ 周期开始', {
    cycle: formatBeijingTime(cycleStartTs),
    dryRun: config.dryRun,
    sessionState: sessionCtx.sessionState,
  });

  clearOrderDedup();

  try {
    // ── FR-1: Fetch OHLCV (extended when session gate enabled) ──
    let candles;
    try {
      candles = config.sessionGate.enabled
        ? await fetchSessionCandles()
        : await fetchClosedCandles(config.candleLimit);
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

    if (config.sessionGate.enabled && candles.length < minSessionCandles()) {
      logger.warn('[main] 会话评估 K 线不足', { got: candles.length, need: minSessionCandles() });
    }

    // ── Settle the PREVIOUS cycle's bet (OKX K 线 or Chainlink) ──
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

    // ── Session gate: 5m bar volume shrink (≤ threshold opens gate; refresh, no stack) ──
    const evaluation = evaluateSession(candles, Date.now(), sessionCtx);
    sessionCtx = advanceSessionState(sessionCtx, evaluation, candles);
    sessionCtx.evaluation = evaluation;
    lastSessionCtx = sessionCtx;
    saveSessionState(sessionCtx);

    try {
      appendJsonl(SESSION_LOG, {
        t: new Date().toISOString(),
        cycleStartTs,
        ...formatSessionLogFields(sessionCtx),
      }, config.jsonlMaxBytes);
    } catch (err) {
      logger.warn('[session] 写入 session 日志失败', { error: err?.message });
    }

    logger.info('[main] 会话评估', {
      ...formatSessionLogFields(sessionCtx),
    });

    if (sessionCtx.action === 'start' || sessionCtx.action === 'stop') {
      const emoji = sessionCtx.action === 'start' ? '▶️' : '⏸';
      const label = sessionCtx.action === 'start' ? '门控开启' : '门控关闭';
      await notifyTelegram(
        `${emoji} <b>${label}</b>\n` +
        `窗口: ${formatBeijingTime(cycleStartTs)}\n` +
        `状态: <b>${sessionCtx.sessionState}</b>\n` +
        formatSessionTelegramBlock(sessionCtx) +
        stats.formatTelegramBlock()
      );
    }

    if (!sessionCtx.tradeAllowed) {
      cycleStatus = 'session_idle';
      logger.info('[main] 会话休眠 — 跳过本周期下单', {
        ...formatSessionLogFields(sessionCtx),
      });
      // 每周期推送；action=stop 时上面已发过「会话停止」，避免重复
      if (sessionCtx.action !== 'stop') {
        await notifyTelegram(
          `💤 <b>会话休眠 — 本周期跳过</b>\n` +
          `窗口: ${formatBeijingTime(cycleStartTs)}\n` +
          `标的: ${config.symbol}\n` +
          formatSessionTelegramBlock(sessionCtx) +
          await formatBalanceTelegramLine() +
          stats.formatTelegramBlock()
        );
      }
      return;
    }

    // ── FR-2: Signal evaluation (S1/S2 low-vol reversal) ──
    const volCtx = await fetchVolatilityContext();
    lastVolCtx = volCtx;
    const signalObj = buildSignal(
      kMinus2,
      kMinus1,
      config.symbol,
      config.timeframe,
      'low',
    );
    lastSignal = signalObj.signal;
    writeSignalLog({
      ...signalObj,
      ...formatVolatilityLogFields(volCtx, signalObj),
      ...formatSessionLogFields(sessionCtx),
    });

    logger.info('[main] 信号', {
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      reason: signalObj.reason,
      filterSkipReason: signalObj.filterSkipReason ?? null,
      ...formatVolatilityLogFields(volCtx, signalObj),
    });

    if (signalObj.signal === 'NONE') {
      cycleStatus = 'no_signal';
      logger.info('[main] 无信号 — 跳过下单');
      await notifyTelegram(
        `⏭ <b>无信号 — 跳过本周期</b>\n` +
        `窗口: ${formatBeijingTime(cycleStartTs)}\n` +
        `标的: ${config.symbol}\n` +
        `原因: ${escapeHtml(signalObj.reason)}\n` +
        await formatBalanceTelegramLine() +
        `波动率: ${escapeHtml(volCtx.regimeReason)}` +
        formatVolatilityTelegramBlock(volCtx.rv, volCtx.regime) +
        formatSessionTelegramBlock(sessionCtx) +
        stats.formatTelegramBlock()
      );
      return;
    }

    if (isDailyLossExceeded()) {
      cycleStatus = 'daily_loss_limit';
      logger.warn('[main] 已达当日亏损上限 — 今日停止交易', {
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        ...formatVolatilityLogFields(volCtx),
      });
      return;
    }

    const tradeDeadline = Date.now() + config.cycleTimeoutMs;

    // ── FR-3: Market discovery ──
    const market = await findCurrentCycleMarket(cycleStartTs, tradeDeadline);
    if (!market) {
      cycleStatus = 'market_not_found';
      logger.warn('[main] 未找到 Polymarket 5 分钟市场 — 跳过下单', {
        symbol: config.symbol,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        ...formatVolatilityLogFields(volCtx),
      });
      return;
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
      });
    }

    // ── FR-4.5 / FR-4.6: Martingale bet sizing ──
    const balance = await getBalance();

    if (balance < config.minBalanceUsd) {
      cycleStatus = 'low_balance';
      logger.warn('[main] pUSD 余额低于下限', {
        balance,
        min: config.minBalanceUsd,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        ...formatVolatilityLogFields(volCtx),
      });
      return;
    }

    const mgBefore = martingale.getState();
    const dynamicCtx = martingale.refreshBaseBetIfNewStreak(candles);
    const mg = martingale.getState();
    const { actualBet, skipReason } = martingale.prepareOrder(balance);

    if (!skipReason && mgBefore.consecutiveLosses === 0) {
      logger.info('[main] 本单下注额度', {
        dynamicBaseBet: dynamicBaseBetEnabled(),
        streakBaseBet: mg.streakBaseBet,
        martingaleBet: mg.currentBet,
        actualBet,
        activityTier: mg.activityTier,
        activityHits: mg.activityHits,
        consecutiveLosses: mg.consecutiveLosses,
        dynamicRefresh: dynamicCtx?.dynamic ?? false,
      });
    }

    if (skipReason) {
      cycleStatus = `martingale_${skipReason}`;
      logger.info('[main] 马丁格尔策略跳过下单', {
        skipReason,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        ...formatVolatilityLogFields(volCtx),
        ...stats.formatLogFields(),
      });
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
      baseBet: mg.streakBaseBet ?? mg.currentBet,
      martingaleBet: mg.currentBet,
      activityTier: mg.activityTier,
      activityHits: mg.activityHits,
      dynamicBaseBet: dynamicBaseBetEnabled(),
      consecutiveLosses: mg.consecutiveLosses,
      yesPrice: pricePolicy.yesPrice ?? market.yesPrice,
      noPrice: pricePolicy.noPrice ?? market.noPrice,
      maxLimitPrice: pricePolicy.maxLimitPrice,
      priceCapped: pricePolicy.priceCapped,
      originalYesPrice: pricePolicy.originalYesPrice,
      deadlineMs: tradeDeadline,
      volatility: formatVolatilityLogFields(volCtx),
    });

    if (orderResult.skipped) {
      cycleStatus = `order_${orderResult.skipReason ?? 'skipped'}`;
      logger.info('[main] 订单已跳过', {
        reason: orderResult.skipReason,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        ...formatVolatilityLogFields(volCtx),
      });
      return;
    }

    const spent = orderResult.usdcSpent || 0;
    const cycleEndMs = cycleStartTs + CYCLE_MS;

    if (spent > 0) {
      registerPendingBet({
        cycleStartTs,
        signal: signalObj.signal,
        actualBet: spent,
        baseBet: mg.streakBaseBet ?? mg.currentBet,
        activityTier: mg.activityTier,
        activityHits: mg.activityHits,
        orderId: orderResult.orderId,
        limitPrice: orderResult.limitPrice,
        fill: orderResult.fill,
        ...snapshotForPending(volCtx, signalObj),
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
      await notifyTelegram(
        `🤖 <b>开单成交</b>\n` +
        `方向: <b>${side}</b> (${signalObj.signalId})\n` +
        `原因: ${escapeHtml(signalObj.reason)}\n` +
        capNote +
        priceOdds +
        `金额: <b>${escapeHtml(fillNote || `$${spent.toFixed(2)}`)}</b>  (连败 ${mg.consecutiveLosses}` +
        (mg.activityTier != null ? ` · ${mg.activityTier}档首注$${(mg.streakBaseBet ?? mg.currentBet).toFixed(2)}` : '') +
        `)\n` +
        `类型: ${orderResult.orderType ?? config.orderType}\n` +
        await formatBalanceTelegramLine(balance) +
        `盘口: ${market.slug}\n` +
        `时间: ${formatBeijingTime(cycleStartTs)}\n` +
        `波动率: ${escapeHtml(volCtx.regimeReason)}` +
        formatVolatilityTelegramBlock(volCtx.rv, volCtx.regime) +
        formatSessionTelegramBlock(sessionCtx) +
        stats.formatTelegramBlock()
      );
    } else if (orderResult.resting) {
      logger.info('[main] 限价单挂单中 — 监视成交', {
        orderId: orderResult.orderId,
        limitPrice: orderResult.limitPrice,
        ...formatVolatilityLogFields(volCtx),
      });
      scheduleRestingFillWatch({
        orderId: orderResult.orderId,
        cycleStartTs,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        signalReason: signalObj.reason,
        cycleEndMs,
        limitPrice: orderResult.limitPrice,
        actualBet,
        baseBet: mg.streakBaseBet ?? mg.currentBet,
        activityTier: mg.activityTier,
        activityHits: mg.activityHits,
        ...snapshotForPending(volCtx, signalObj),
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
      await notifyTelegram(
        `⏳ <b>限价挂单</b>\n` +
        `方向: <b>${side}</b> (${signalObj.signalId})\n` +
        `原因: ${escapeHtml(signalObj.reason)}\n` +
        capNote +
        priceOdds +
        `预算: $${actualBet}  (连败 ${mg.consecutiveLosses}` +
        (mg.activityTier != null ? ` · ${mg.activityTier}档首注$${(mg.streakBaseBet ?? mg.currentBet).toFixed(2)}` : '') +
        `)\n` +
        await formatBalanceTelegramLine(balance) +
        `盘口: ${market.slug}\n` +
        `周期内自动监视成交\n` +
        `波动率: ${escapeHtml(volCtx.regimeReason)}` +
        formatVolatilityTelegramBlock(volCtx.rv, volCtx.regime) +
        formatSessionTelegramBlock(sessionCtx) +
        stats.formatTelegramBlock()
      );
    } else {
      cycleStatus = 'order_no_fill';
      logger.warn('[main] 订单已接受但未成交且非挂单状态', {
        signal: signalObj.signal,
        signalId: signalObj.signalId,
        ...formatVolatilityLogFields(volCtx),
      });
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
      ...formatVolatilityLogFields(lastVolCtx),
      ...formatSessionLogFields(lastSessionCtx),
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
  baseBet,
  activityTier,
  activityHits,
  orderId,
  limitPrice,
  entryPrice,
  fill,
  volatility,
  volRegime,
  volRegimeReason,
}) {
  const openSnap = usesChainlinkSettlement()
    ? getChainlinkOpenPrice(config.symbol, cycleStartTs)
    : null;
  pendingBet = {
    cycleStartTs,
    signal,
    actualBet,
    baseBet: baseBet ?? null,
    activityTier: activityTier ?? null,
    activityHits: activityHits ?? null,
    targetPrice: openSnap?.price,
    orderId,
    limitPrice,
    entryPrice: entryPrice ?? fill?.entryPrice ?? limitPrice ?? null,
    volatility: volatility ?? null,
    volRegime: volRegime ?? null,
    volRegimeReason: volRegimeReason ?? null,
  };
  savePending();
  scheduleChainlinkSettlement(pendingBet);
  logger.info('[main] 待结算注单已登记', {
    cycleStartTs: formatBeijingTime(cycleStartTs),
    signal,
    actualBet,
    baseBet: pendingBet.baseBet,
    activityTier: pendingBet.activityTier,
    activityHits: pendingBet.activityHits,
    orderId,
    targetPrice: pendingBet.targetPrice,
    volRegime,
    volRegimeReason,
    rv_1m: volatility?.rv_1m ?? null,
    rv_5m: volatility?.rv_5m ?? null,
    rv_15m: volatility?.rv_15m ?? null,
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
 * Apply settlement for a pending bet.
 * Returns true when settled; false when not ready or pending changed.
 */
async function applySettlement(pending, { candles } = {}) {
  if (!pending || pending !== pendingBet) return false;

  const result = await computeSettlement(pending, { candles });
  if (!result.ready) {
    logger.debug('[settle] 结算尚未就绪', {
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

  const { signal, actualBet, cycleStartTs, entryPrice, limitPrice } = pending;
  const { won, winningOutcome, targetPrice, closePrice, settleDelta } = result;
  const side = signal === 'UP' ? '📈 UP' : '📉 DOWN';
  const windowLabel = formatBeijingTime(cycleStartTs);
  const pnlUsd = stats.computeSettlementPnl(won, actualBet, entryPrice ?? limitPrice);
  const sourceLabel = settleSourceLabel();

  const { halted } = martingale.onSettled(won);
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
    martingaleHalted: halted,
    crossCheck: cross,
    volRegime: pending.volRegime ?? null,
    volRegimeReason: pending.volRegimeReason ?? null,
    rv_1m: pending.volatility?.rv_1m ?? null,
    rv_5m: pending.volatility?.rv_5m ?? null,
    rv_15m: pending.volatility?.rv_15m ?? null,
    ...stats.formatLogFields(),
  });

  pendingBet = null;
  savePending();

  writeSettlementLog({
    ts: new Date().toISOString(),
    cycleStartTs,
    signal,
    actualBet,
    baseBet: pending.baseBet ?? null,
    activityTier: pending.activityTier ?? null,
    activityHits: pending.activityHits ?? null,
    entryPrice: entryPrice ?? limitPrice ?? null,
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
    volRegime: pending.volRegime ?? null,
    volRegimeReason: pending.volRegimeReason ?? null,
    rv_1m: pending.volatility?.rv_1m ?? null,
    rv_5m: pending.volatility?.rv_5m ?? null,
    rv_15m: pending.volatility?.rv_15m ?? null,
    ...stats.formatLogFields(),
  });

  const mg = martingale.getState();
  const balanceLine = await formatBalanceTelegramLine();

  const resultEmoji = won ? '✅' : '❌';
  const resultText = won ? '赢' : '输';
  const mismatchNote = cross?.mismatch
    ? `\n⚠️ 交易所 K 线: ${escapeHtml(cross.exchangeDirection)} ≠ Chainlink ${escapeHtml(cross.chainlinkOutcome)}`
    : '';

  const haltNote = halted
    ? `\n⚠️ <b>马丁连亏止损触发</b> — 下周期重置为基础注`
    : '';

  const priceLine = usesChainlinkSettlement()
    ? `目标价: $${targetPrice.toFixed(2)} → 收盘价: $${closePrice.toFixed(2)}\n`
    : `开盘: $${targetPrice.toFixed(2)} → 收盘: $${closePrice.toFixed(2)}\n`;

  await notifyTelegram(
    `${resultEmoji} <b>结算${resultText}</b> (${sourceLabel})\n` +
    `窗口: ${windowLabel}\n` +
    `下注: ${side} $${actualBet}\n` +
    priceLine +
    `结果: <b>${winningOutcome}</b> (Δ ${settleDelta >= 0 ? '+' : ''}${settleDelta.toFixed(2)})\n` +
    `本单盈亏: <b>${stats.formatPnlUsd(pnlUsd)}</b>` +
    mismatchNote + haltNote + '\n' +
    `下一注: <b>$${mg.currentBet}</b>  (连败 ${mg.consecutiveLosses})\n` +
    `今日亏损: $${getDailyLossUsd().toFixed(2)} / $${config.maxDailyLossUsd}\n` +
    balanceLine +
    (pending.volRegimeReason ? `波动率: ${escapeHtml(pending.volRegimeReason)}` : '') +
    formatVolatilityTelegramBlock(pending.volatility, pending.volRegime) +
    stats.formatTelegramBlock()
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
  const signalOhlcv = describeOhlcvSource();
  const volOhlcv = describeOhlcvSource(config.volatilityBarTimeframe);

  logger.info('▶ 机器人启动', {
    symbol: config.symbol,
    timeframe: config.timeframe,
    signalOhlcv: {
      exchange: signalOhlcv.exchange,
      market: signalOhlcv.label,
      symbol: signalOhlcv.symbol,
      timeframe: signalOhlcv.timeframe,
    },
    volatilityOhlcv: {
      exchange: volOhlcv.exchange,
      market: volOhlcv.label,
      symbol: volOhlcv.symbol,
      timeframe: volOhlcv.timeframe,
    },
    dryRun: config.dryRun,
    cycleMinutes: config.cycleMinutes,
    signalDelayMs: config.signalDelayMs,
    cycleTimeoutMs: config.cycleTimeoutMs,
    settlement: config.settleSource,
    volatilityStrategy: {
      barTimeframe: config.volatilityBarTimeframe,
      mode: 'low_reversal_only',
    },
    sessionGate: {
      enabled: config.sessionGate.enabled,
      state: sessionCtx.sessionState,
    },
    dynamicBaseBet: config.dynamicBaseBet.enabled
      ? {
          enabled: true,
          tier1Usd: config.dynamicBaseBet.tier1Usd,
          weakMinUsd: config.dynamicBaseBet.weakMinUsd,
          weakMaxUsd: config.dynamicBaseBet.weakMaxUsd,
          ampMinUsd: config.dynamicBaseBet.ampMinUsd,
          ampMaxUsd: config.dynamicBaseBet.ampMaxUsd,
        }
      : { enabled: false, fallbackUsd: config.tradeBudgetUsd },
    ...stats.formatLogFields(),
  });

  martingale.init();
  if (dynamicBaseBetEnabled()) {
    logger.info('[martingale] 动态首注已启用（12档混合）', {
      tiers: formatTierBetTable(),
      ...config.dynamicBaseBet,
    });
  } else {
    logger.warn('[martingale] 动态首注已关闭 — 每轮固定 TRADE_BUDGET_USD', {
      tradeBudgetUsd: config.tradeBudgetUsd,
      hint: '设置 DYNAMIC_BASE_BET_ENABLED=true 启用',
    });
  }
  stats.init();
  initDailyLoss();
  loadPending();
  sessionCtx = loadSessionState();
  if (!config.sessionGate.enabled) {
    sessionCtx = {
      ...sessionCtx,
      sessionState: 'ACTIVE',
      tradeAllowed: true,
    };
  }

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
      baseBet: ctx.baseBet,
      activityTier: ctx.activityTier,
      activityHits: ctx.activityHits,
      orderId: ctx.orderId,
      limitPrice: ctx.limitPrice,
      fill: ctx.fill,
      volatility: ctx.volatility,
      volRegime: ctx.volRegime,
      volRegimeReason: ctx.volRegimeReason,
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
      (ctx.signalReason ? `原因: ${escapeHtml(ctx.signalReason)}\n` : '') +
      priceOdds +
      `金额: <b>${escapeHtml(fillNote || `$${ctx.actualBet.toFixed(2)}`)}</b>\n` +
      `窗口: ${formatBeijingTime(ctx.cycleStartTs)}\n` +
      await formatBalanceTelegramLine() +
      (ctx.volRegimeReason ? `波动率: ${escapeHtml(ctx.volRegimeReason)}` : '') +
      formatVolatilityTelegramBlock(ctx.volatility, ctx.volRegime) +
      stats.formatTelegramBlock()
    );
  });

  if (usesChainlinkSettlement()) {
    await startRtdsBuffer([config.symbol]);
  } else {
    logger.info('[settle] 使用 OKX 永续 5m K 线结算，Chainlink RTDS 已跳过');
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
    ...stats.formatLogFields(),
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
