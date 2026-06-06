/**
 * Order fill resolution: post response → poll getOrder → fallback estimate.
 */

import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';

/** Parse BUY fill from CLOB post response (making=USDC, taking=shares). */
export function deriveFillFromPost(parsed, { limitPrice } = {}) {
  const taking = parseFloat(parsed?.takingAmount || 0);
  const making = parseFloat(parsed?.makingAmount || 0);
  const price = parseFloat(limitPrice) || 0;

  if (taking > 0 && making > 0) {
    return {
      usdcSpent: making,
      shares: taking,
      entryPrice: making / taking,
      source: 'post',
    };
  }

  if (making > 0 && price > 0) {
    const shares = taking > 0 ? taking : making / price;
    return {
      usdcSpent: making,
      shares,
      entryPrice: shares > 0 ? making / shares : price,
      source: 'post',
    };
  }

  if (taking > 0 && price > 0) {
    const usdc = making > 0 ? making : taking * price;
    return {
      usdcSpent: usdc,
      shares: taking,
      entryPrice: price,
      source: 'post',
    };
  }

  return null;
}

/** Read matched size from getOrder (limit BUY: size_matched × price). */
export async function fetchFillFromOrder(client, orderId) {
  const order = await client.getOrder(orderId);
  if (!order) {
    return {
      usdcSpent: 0,
      shares: 0,
      entryPrice: null,
      source: 'getOrder',
      resting: true,
      status: 'not_found',
      order: null,
    };
  }

  const matched = parseFloat(order.size_matched || 0);
  const price = parseFloat(order.price || 0);
  const original = parseFloat(order.original_size || 0);

  if (matched <= 0) {
    return {
      usdcSpent: 0,
      shares: 0,
      entryPrice: price,
      source: 'getOrder',
      resting: true,
      status: order.status,
      order,
    };
  }

  const usdcSpent = matched * price;
  return {
    usdcSpent,
    shares: matched,
    entryPrice: price > 0 ? price : null,
    source: 'getOrder',
    resting: original > matched + 1e-9,
    status: order.status,
    order,
  };
}

/**
 * Resolve actual fill: post → poll getOrder → estimate / unfilled resting.
 */
export async function resolveActualFill(client, parsed, {
  orderId,
  estUsd,
  limitPrice,
  pollMs = config.fillSyncPollMs,
  maxWaitMs = config.fillSyncMaxWaitMs,
} = {}) {
  const est = parseFloat(estUsd) || 0;
  const fromPost = deriveFillFromPost(parsed, { limitPrice });
  if (fromPost?.usdcSpent > 0) {
    return { ...fromPost, estUsd: est };
  }

  if (!client || !orderId) {
    return fallbackEstimate(est, limitPrice, 'estimate');
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() <= deadline) {
    try {
      const fromOrder = await fetchFillFromOrder(client, orderId);
      if (fromOrder.usdcSpent > 0) {
        return { ...fromOrder, estUsd: est };
      }
      if (!parsed?.resting) break;
      await sleep(pollMs);
    } catch (err) {
      logger.warn(`[fillSync] getOrder(${orderId?.slice(0, 10)}…) 失败: ${err?.message}`);
      break;
    }
  }

  if (parsed?.resting) {
    return {
      usdcSpent: 0,
      shares: 0,
      entryPrice: parseFloat(limitPrice) || null,
      source: 'unfilled',
      estUsd: est,
      resting: true,
    };
  }

  return fallbackEstimate(est, limitPrice, 'estimate');
}

function fallbackEstimate(estUsd, limitPrice, source) {
  const est = parseFloat(estUsd) || 0;
  const price = parseFloat(limitPrice) || 0;
  return {
    usdcSpent: est,
    shares: price > 0 ? est / price : null,
    entryPrice: price > 0 ? price : null,
    source,
    estUsd: est,
    resting: false,
  };
}

export function formatFillNote(fill) {
  if (!fill || fill.usdcSpent <= 0) return '';
  const parts = [
    `$${fill.usdcSpent.toFixed(2)}`,
    fill.shares != null ? `${fill.shares} 份` : null,
    fill.entryPrice != null ? `@$${fill.entryPrice.toFixed(2)}` : null,
    fill.source !== 'estimate' ? `[${fill.source}]` : '[est]',
  ].filter(Boolean);
  return parts.join(' ');
}

/** 解析成交单价（0–1），优先实际成交价，其次限价/盘口价 */
export function resolveEntryPrice({ fill, limitPrice, signal, yesPrice, noPrice }) {
  if (fill?.entryPrice > 0) return fill.entryPrice;
  if (limitPrice > 0) return limitPrice;
  if (signal === 'UP' && yesPrice > 0) return yesPrice;
  if (signal === 'DOWN') {
    if (noPrice > 0) return noPrice;
    if (yesPrice > 0) return 1 - yesPrice;
  }
  return null;
}

/** 胜则净赚 = 份数 × $1 − 投入 = amount/price − amount */
export function calcWinNetProfit(amountUsdc, entryPrice) {
  const amount = Number(amountUsdc);
  const price = Number(entryPrice);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return amount / price - amount;
}

/** Telegram 通知用的价格 + 胜则净赚行 */
export function formatPriceOddsLines({
  fill, limitPrice, signal, yesPrice, noPrice, amountUsdc,
}) {
  const price = resolveEntryPrice({ fill, limitPrice, signal, yesPrice, noPrice });
  if (price == null) return '';

  const amount = Number(amountUsdc) > 0
    ? Number(amountUsdc)
    : (fill?.usdcSpent > 0 ? fill.usdcSpent : null);

  let lines = `价格: <b>$${price.toFixed(3)}</b>\n`;
  if (amount != null) {
    const netProfit = calcWinNetProfit(amount, price);
    if (netProfit != null) {
      lines += `胜则净赚: <b>$${netProfit.toFixed(2)}</b> (投入 $${amount.toFixed(2)})\n`;
    }
  }
  return lines;
}
