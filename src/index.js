/**
 * Polymarket Vegas Channel Bot — entry point
 * OKX OHLCV | EMA144/169 Vegas cross-entry | Same-dir Martingale ×3 / 5-loss stop
 * Multi-instance: BOT_INSTANCE + CANDLE_TIMEFRAME (PM2: 15m + 5m)
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
  isCandleFresh,
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
import { EMA_SLOW } from './strategy/vegasChannel.js';
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
  hasActiveRestingFillWatch,
} from './trader/restingFillWatcher.js';
import * as martingale from './martingale/manager.js';
import * as stats from './stats/manager.js';
import { notifyTelegram, escapeHtml } from './utils/telegram.js';
import { formatBeijingTime } from './utils/datetime.js';
import { scopedLogPath } from './utils/instancePaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR    = join(__dirname, '..', 'logs');
const SIGNAL_LOG  = scopedLogPath(LOGS_DIR, 'signals.jsonl');
const SETTLE_LOG  = scopedLogPath(LOGS_DIR, 'settlements.jsonl');
const PENDING_FILE = scopedLogPath(LOGS_DIR, 'pending-bet.json');

const CYCLE_MS = config.cycleMinutes * 60 * 1000;
const TF_TAG = `[${config.timeframe}]`;

function tgHead(titleHtml) {
  return `${TF_TAG} ${titleHtml}`;
}

// Pending bet awaiting settlement. Shape:
//   { cycleStartTs, signal, actualBet, orderId?, limitPrice?, entryPrice?, fill? }
let pendingBet = null;

let shutdownRequested = false;
let cycleInProgress = null;

// ─────────────────────────────────────────
// Startup
// ─────────────────────────────────────────

function formatStatsTelegramBlock() {
  return stats.formatTelegramBlock();
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
    // ── FR-1: Fetch OHLCV for signals ──
    let candles;
    try {
      candles = await fetchClosedCandles(config.candleLimit);
    } catch (err) {
      cycleStatus = 'ohlcv_failed';
      cycleError = err?.message;
      logger.error('[main] K 线拉取失败', { error: err?.message });
      return;
    }

    if (candles.length < EMA_SLOW + 1) {
      cycleStatus = 'insufficient_candles';
      logger.warn('[main] K 线数量不足（EMA169）', {
        got: candles.length,
        need: EMA_SLOW + 1,
      });
      return;
    }

    // ── Settle the PREVIOUS cycle's bet (OKX K 线 or Chainlink) ──
    if (pendingBet) {
      await trySettlePending(pendingBet, { candles });
    }

    // Never open a new position while a prior bet is still unsettled
    if (pendingBet) {
      cycleStatus = 'pending_unsettled';
      logger.warn('[main] 上笔注单尚未结算 — 跳过本周期下单', {
        pendingCycle: formatBeijingTime(pendingBet.cycleStartTs),
        pendingSignal: pendingBet.signal,
      });
      return;
    }

    // GTC resting fill still being watched — avoid stacking orders
    if (hasActiveRestingFillWatch()) {
      cycleStatus = 'resting_fill_pending';
      logger.warn('[main] 仍有 GTC 挂单监视中 — 跳过本周期下单');
      return;
    }

    const kMinus1 = candles.at(-1);

    if (!isCandleFresh(kMinus1, CYCLE_MS)) {
      cycleStatus = 'stale_candle';
      logger.warn('[main] K 线过期 — 跳过本周期');
      return;
    }

    // ── FR-2: Vegas channel signal / martingale continuation ──
    const signalObj = vegasState.resolveSignal(candles);
    lastSignal = signalObj.signal;
    writeSignalLog(signalObj);

    const vg = vegasState.getState();
    logger.info('[main] 信号', {
      signal: signalObj.signal,
      signalId: signalObj.signalId,
      reason: signalObj.reason,
      phase: signalObj.phase ?? vg.phase,
      lockedSignal: signalObj.lockedSignal ?? vg.lockedSignal,
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

    if (isDailyLossExceeded()) {
      cycleStatus = 'daily_loss_limit';
      logger.warn('[main] 已达当日亏损上限 — 今日停止交易', {
        signal: signalObj.signal,
        signalId: signalObj.signalId,
      });
      return;
    }

    const tradeDeadline = Date.now() + config.cycleTimeoutMs;

    // ── FR-3: Market discovery ──
    const market = await findCurrentCycleMarket(cycleStartTs, tradeDeadline);
    if (!market) {
      cycleStatus = 'market_not_found';
      logger.warn('[main] 未找到 Polymarket 市场 — 跳过下单', {
        symbol: config.symbol,
        timeframe: config.timeframe,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
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
      });
      return;
    }

    const mgState = martingale.getState();
    const { actualBet, skipReason } = martingale.prepareOrder(balance);

    if (skipReason) {
      cycleStatus = `martingale_${skipReason}`;
      logger.info('[main] 马丁格尔策略跳过下单', {
        skipReason,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
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
      baseBet: mgState.baseBet,
      consecutiveLosses: mgState.consecutiveLosses,
      yesPrice: pricePolicy.yesPrice ?? market.yesPrice,
      noPrice: pricePolicy.noPrice ?? market.noPrice,
      maxLimitPrice: pricePolicy.maxLimitPrice,
      priceCapped: pricePolicy.priceCapped,
      originalYesPrice: pricePolicy.originalYesPrice,
      deadlineMs: tradeDeadline,
    });

    if (orderResult.skipped) {
      cycleStatus = `order_${orderResult.skipReason ?? 'skipped'}`;
      logger.info('[main] 订单已跳过', {
        reason: orderResult.skipReason,
        signal: signalObj.signal,
        signalId: signalObj.signalId,
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
      await notifyTelegram(
        `${tgHead('🤖 <b>开单成交</b>')}\n` +
        `方向: <b>${side}</b> (${signalObj.signalId})\n` +
        `周期: ${config.timeframe}\n` +
        `原因: ${escapeHtml(signalObj.reason)}\n` +
        capNote +
        priceOdds +
        `金额: <b>${escapeHtml(fillNote || `$${spent.toFixed(2)}`)}</b>\n` +
        `(首注 $${mgState.baseBet} · 连败 ${mgState.consecutiveLosses})\n` +
        `类型: ${orderResult.orderType ?? config.orderType}\n` +
        await formatBalanceTelegramLine(balance) +
        `盘口: ${market.slug}\n` +
        `时间: ${formatBeijingTime(cycleStartTs)}\n` +
        formatStatsTelegramBlock()
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
        signalReason: signalObj.reason,
        cycleEndMs,
        limitPrice: orderResult.limitPrice,
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
        `${tgHead('⏳ <b>限价挂单</b>')}\n` +
        `方向: <b>${side}</b> (${signalObj.signalId})\n` +
        `周期: ${config.timeframe}\n` +
        `原因: ${escapeHtml(signalObj.reason)}\n` +
        capNote +
        priceOdds +
        `预算: $${actualBet}\n` +
        `(首注 $${mgState.baseBet} · 连败 ${mgState.consecutiveLosses})\n` +
        await formatBalanceTelegramLine(balance) +
        `盘口: ${market.slug}\n` +
        `周期内自动监视成交\n` +
        formatStatsTelegramBlock()
      );
    } else {
      cycleStatus = 'order_no_fill';
      logger.warn('[main] 订单已接受但未成交且非挂单状态', {
        signal: signalObj.signal,
        signalId: signalObj.signalId,
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
  savePending();
  scheduleChainlinkSettlement(pendingBet);
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

  const { signal, cycleStartTs, actualBet, entryPrice, limitPrice } = pending;
  const { won, winningOutcome, targetPrice, closePrice, settleDelta } = result;
  const side = signal === 'UP' ? '📈 UP' : '📉 DOWN';
  const windowLabel = formatBeijingTime(cycleStartTs);
  const sourceLabel = settleSourceLabel();
  const price = entryPrice ?? limitPrice ?? null;

  const { halted } = martingale.onSettled(won);
  vegasState.onSettled(won, halted);

  const pnlUsd = stats.computeSettlementPnl(won, actualBet, price);

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
  const balanceLine = await formatBalanceTelegramLine();

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

  await notifyTelegram(
    `${tgHead(`${resultEmoji} <b>结算${resultText}</b> (${sourceLabel})`)}\n` +
    `窗口: ${windowLabel}\n` +
    `周期: ${config.timeframe}\n` +
    `下注: ${side} $${actualBet}\n` +
    priceLine +
    `结果: <b>${winningOutcome}</b> (Δ ${settleDelta >= 0 ? '+' : ''}${settleDelta.toFixed(2)})\n` +
    `本单盈亏: <b>${stats.formatPnlUsd(pnlUsd)}</b>\n` +
    mismatchNote + haltNote +
    `下一注: <b>$${mg.currentBet}</b>  (首注 $${mg.baseBet} · 连败 ${mg.consecutiveLosses})\n` +
    `今日亏损: $${getDailyLossUsd().toFixed(2)} / $${config.maxDailyLossUsd}\n` +
    balanceLine +
    formatStatsTelegramBlock()
  );

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

  logger.info('▶ 机器人启动', {
    symbol: config.symbol,
    timeframe: config.timeframe,
    instanceId: config.instanceId,
    strategy: 'vegas_channel_ema144_169',
    signalOhlcv: {
      exchange: signalOhlcv.exchange,
      market: signalOhlcv.label,
      symbol: signalOhlcv.symbol,
      timeframe: signalOhlcv.timeframe,
    },
    dryRun: config.dryRun,
    cycleMinutes: config.cycleMinutes,
    signalDelayMs: config.signalDelayMs,
    cycleTimeoutMs: config.cycleTimeoutMs,
    settlement: config.settleSource,
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

  await notifyTelegram(
    `${tgHead('▶ <b>机器人启动</b>')}\n` +
    `标的: ${config.symbol}\n` +
    `周期: ${config.timeframe} (${config.cycleMinutes}m)\n` +
    `实例: ${config.instanceId}\n` +
    `模式: ${config.dryRun ? 'DRY_RUN' : 'LIVE'}\n` +
    `马丁: $${config.tradeBudgetUsd} ×${config.martingaleMultiplier} / 连亏${config.martingaleMaxLosses}`
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
      `金额: <b>${escapeHtml(fillNote || `$${ctx.actualBet.toFixed(2)}`)}</b>\n` +
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
