/**
 * GTC resting orders: after short fillSync, keep polling getOrder until cycle end.
 * On fill → callback to open pending bet + schedule settlement.
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { formatBeijingTime } from '../utils/datetime.js';
import { getClobClient, clobHasL2Creds } from './executor.js';
import { fetchFillFromOrder, formatFillNote } from './fillSync.js';

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

  const client = await getClobClient();
  if (!clobHasL2Creds(client)) {
    logger.warn('[fillWatch] 无 L2 CLOB 凭证，无法监视挂单');
    return;
  }

  logger.info(
    `[fillWatch] 监视挂单至 ${formatBeijingTime(cycleEndMs)} ` +
    `orderId=${orderId}`
  );

  while (Date.now() < cycleEndMs) {
    if (entry.abort) return;

    try {
      const fill = await fetchFillFromOrder(client, orderId);
      if (fill.usdcSpent > 0) {
        const tag = fill.resting ? '部分成交' : '已成交';
        logger.info(
          `[fillWatch] ${tag} | ${formatFillNote(fill)} | orderId=${orderId}`
        );
        if (onOrderFilled) {
          await onOrderFilled({
            ...ctx,
            actualBet: fill.usdcSpent,
            fill,
          });
        }
        return;
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
