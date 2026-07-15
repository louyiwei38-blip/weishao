/**
 * GTC resting orders: after short fillSync, keep polling getOrder until cycle end.
 * On fill → callback to open pending bet + schedule settlement.
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { getClobClient, clobHasL2Creds } from './executor.js';
import { fetchFillFromOrder } from './fillSync.js';

/** @type {Map<string, { abort: boolean }>} */
const active = new Map();

/** @type {(ctx: object) => Promise<void>|void} */
let onOrderFilled = null;

export function initRestingFillWatcher(handler) {
  onOrderFilled = handler;
}

async function pollUntilFilledOrCycleEnd(entry) {
  const { orderId, cycleEndMs, ctx } = entry;
  const pollMs = config.fillSyncPollMs;
  const companionIds = Array.isArray(ctx.companionOrderIds)
    ? ctx.companionOrderIds.filter(Boolean)
    : (ctx.topUpOrderId ? [ctx.topUpOrderId] : []);
  const allIds = [orderId, ...companionIds].filter(Boolean);

  const client = await getClobClient();
  if (!clobHasL2Creds(client)) {
    logger.warn('[fillWatch] 无 L2 CLOB 凭证，无法监视挂单');
    return;
  }

  logger.info(
    `[fillWatch] 监视挂单至 ${formatBeijingTime(cycleEndMs)} ` +
    `orderIds=${allIds.join(',')}`
  );

  while (Date.now() < cycleEndMs) {
    if (entry.abort) return;

    try {
      let totalSpent = 0;
      let lastFill = null;
      let anyFill = false;
      for (const id of allIds) {
        const fill = await fetchFillFromOrder(client, id);
        if (fill.usdcSpent > 0) {
          anyFill = true;
          totalSpent += fill.usdcSpent;
          lastFill = fill;
        }
      }
      if (anyFill && totalSpent > 0) {
        // Wait until primary has fill, or no companions, before registering
        const primaryFill = await fetchFillFromOrder(client, orderId);
        if (primaryFill.usdcSpent > 0 || companionIds.length === 0) {
          let spent = primaryFill.usdcSpent || 0;
          for (const id of companionIds) {
            const f = await fetchFillFromOrder(client, id);
            spent += f.usdcSpent || 0;
          }
          logger.info(
            `[fillWatch] 已成交合计 $${spent.toFixed(2)} | orderIds=${allIds.join(',')}`
          );
          if (onOrderFilled) {
            await onOrderFilled({
              ...ctx,
              actualBet: spent,
              fill: {
                ...(lastFill || primaryFill),
                usdcSpent: spent,
              },
            });
          }
          return;
        }
      }
    } catch (err) {
      logger.warn(`[fillWatch] getOrder 失败: ${err?.message}`);
    }

    const remaining = cycleEndMs - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  if (!entry.abort) {
    logger.info(`[fillWatch] 周期结束前未成交，停止监视 orderId=${orderId}`);
  }
}

/**
 * Register a resting GTC order for background fill polling (non-blocking).
 * @param {{ orderId: string, cycleStartTs: number, signal: string, cycleEndMs: number, signalId?: string, limitPrice?: number }} ctx
 */
export function scheduleRestingFillWatch(ctx) {
  const { orderId, cycleEndMs } = ctx;
  if (!orderId || config.dryRun) return;

  if (!Number.isFinite(cycleEndMs) || cycleEndMs <= Date.now()) {
    logger.debug('[fillWatch] 周期已结束，跳过监视');
    return;
  }

  stopRestingFillWatch(orderId);

  const entry = { orderId, cycleEndMs, ctx, abort: false };
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

export function stopAllRestingFillWatchers() {
  for (const entry of active.values()) entry.abort = true;
  active.clear();
}

/** True while any GTC resting order is still being polled. */
export function hasActiveRestingFillWatch() {
  return active.size > 0;
}
