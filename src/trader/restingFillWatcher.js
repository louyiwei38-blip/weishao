/**
 * GTC resting orders: after short fillSync, keep polling getOrder until cycle end + grace.
 * On fill → callback to open pending bet + schedule settlement.
 *
 * Watches are scoped by cycleStartTs so a prior cycle's watch cannot block the next cycle's order.
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { getClobClient, clobHasL2Creds } from './executor.js';
import { fetchFillFromOrder } from './fillSync.js';

/** @type {Map<string, { abort: boolean, orderId: string, cycleEndMs: number, watchUntilMs: number, ctx: object }>} */
const active = new Map();

/** @type {(ctx: object) => Promise<void>|void} */
let onOrderFilled = null;

/** @type {(ctx: { orderId: string, cycleStartTs?: number, registered: boolean }) => void} */
let onWatchEnded = null;

/** Extra watch after cycle end so late GTC fills still register pending + settle. */
function watchGraceMs() {
  const buffer = Number(config.chainlink?.settleBufferMs) || 1500;
  return buffer + 90_000;
}

export function initRestingFillWatcher(handler, { onEnded } = {}) {
  onOrderFilled = handler;
  onWatchEnded = typeof onEnded === 'function' ? onEnded : null;
}

async function pollUntilFilledOrCycleEnd(entry) {
  const { orderId, cycleEndMs, watchUntilMs, ctx } = entry;
  const pollMs = config.fillSyncPollMs;
  const companionIds = Array.isArray(ctx.companionOrderIds)
    ? ctx.companionOrderIds.filter(Boolean)
    : (ctx.topUpOrderId ? [ctx.topUpOrderId] : []);
  const allIds = [orderId, ...companionIds].filter(Boolean);
  const deadline = Number.isFinite(watchUntilMs) ? watchUntilMs : cycleEndMs;

  const client = await getClobClient();
  if (!clobHasL2Creds(client)) {
    logger.warn('[fillWatch] 无 L2 CLOB 凭证，无法监视挂单');
    return;
  }

  logger.info(
    `[fillWatch] 监视挂单至 ${formatBeijingTime(deadline)} ` +
    `(周期结束 ${formatBeijingTime(cycleEndMs)}) orderIds=${allIds.join(',')}`
  );

  let registered = false;
  let lastSpent = 0;

  while (Date.now() < deadline) {
    if (entry.abort) return;

    try {
      const primaryFill = await fetchFillFromOrder(client, orderId);
      if (primaryFill.usdcSpent > 0 || companionIds.length === 0) {
        let spent = primaryFill.usdcSpent || 0;
        let lastFill = primaryFill.usdcSpent > 0 ? primaryFill : null;
        for (const id of companionIds) {
          const f = await fetchFillFromOrder(client, id);
          spent += f.usdcSpent || 0;
          if (f.usdcSpent > 0) lastFill = f;
        }
        if (spent > lastSpent + 1e-6) {
          const isUpdate = registered;
          lastSpent = spent;
          logger.info(
            `[fillWatch] 成交合计 $${spent.toFixed(2)}${isUpdate ? ' (追加)' : ''}` +
            `${Date.now() > cycleEndMs ? ' (周期后)' : ''} | ` +
            `orderIds=${allIds.join(',')}`
          );
          if (onOrderFilled) {
            await onOrderFilled({
              ...ctx,
              actualBet: spent,
              fill: {
                ...(lastFill || primaryFill),
                usdcSpent: spent,
              },
              isUpdate,
            });
          }
          registered = true;
        }
      }
    } catch (err) {
      logger.warn(`[fillWatch] getOrder 失败: ${err?.message}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  if (!entry.abort) {
    if (registered) {
      logger.info(
        `[fillWatch] 监视结束，最终成交 $${lastSpent.toFixed(2)} orderId=${orderId}`
      );
    } else {
      logger.info(`[fillWatch] 监视窗口结束仍未成交，停止监视 orderId=${orderId}`);
    }
  }

  if (onWatchEnded) {
    try {
      onWatchEnded({
        orderId,
        cycleStartTs: ctx.cycleStartTs,
        registered,
        aborted: Boolean(entry.abort),
      });
    } catch (err) {
      logger.warn('[fillWatch] onWatchEnded 失败', { error: err?.message });
    }
  }
}

/**
 * Register a resting GTC order for background fill polling (non-blocking).
 * @param {{ orderId: string, cycleStartTs: number, signal: string, cycleEndMs: number, signalId?: string, limitPrice?: number }} ctx
 */
export function scheduleRestingFillWatch(ctx) {
  const { orderId, cycleEndMs } = ctx;
  if (!orderId || config.dryRun) return;

  if (!Number.isFinite(cycleEndMs)) {
    logger.debug('[fillWatch] 无效 cycleEndMs，跳过监视');
    return;
  }

  const watchUntilMs = cycleEndMs + watchGraceMs();
  if (watchUntilMs <= Date.now()) {
    logger.debug('[fillWatch] 监视窗口已过，跳过');
    return;
  }

  stopRestingFillWatch(orderId);

  const entry = { orderId, cycleEndMs, watchUntilMs, ctx, abort: false };
  active.set(orderId, entry);

  pollUntilFilledOrCycleEnd(entry)
    .catch((err) => {
      logger.warn('[fillWatch] 监视器异常', { error: err?.message });
    })
    .finally(() => {
      if (active.get(orderId) === entry) active.delete(orderId);
    });
}

export function stopRestingFillWatch(orderId) {
  const entry = active.get(orderId);
  if (entry) {
    entry.abort = true;
    active.delete(orderId);
  }
}

/** Stop all watches for a cycle (e.g. after that cycle has settled). */
export function stopRestingFillWatchesForCycle(cycleStartTs) {
  const ts = Number(cycleStartTs);
  if (!Number.isFinite(ts)) return;
  for (const [id, entry] of active.entries()) {
    if (Number(entry.ctx?.cycleStartTs) === ts) {
      entry.abort = true;
      active.delete(id);
    }
  }
}

export function stopRestingFillWatchesForOrders(orderIds) {
  for (const id of (orderIds || []).filter(Boolean)) {
    stopRestingFillWatch(id);
  }
}

export function stopAllRestingFillWatchers() {
  for (const entry of active.values()) entry.abort = true;
  active.clear();
}

/** True while any GTC resting order is still being polled. */
export function hasActiveRestingFillWatch() {
  return active.size > 0;
}

/** True only if a watch belongs to this cycle window (do not block next cycle). */
export function hasActiveRestingFillWatchForCycle(cycleStartTs) {
  const ts = Number(cycleStartTs);
  if (!Number.isFinite(ts)) return false;
  for (const entry of active.values()) {
    if (Number(entry.ctx?.cycleStartTs) === ts) return true;
  }
  return false;
}
