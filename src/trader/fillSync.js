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

/** 输则亏损 = −投入（不含手续费近似） */
export function calcLossPnl(amountUsdc) {
  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return -amount;
}

/**
 * Telegram：开单价格 + 投入 + 胜/负盈亏预览
 * @returns {string} HTML lines (may be empty)
 */
export function formatPriceOddsLines({
  fill, limitPrice, signal, yesPrice, noPrice, amountUsdc,
}) {
  const price = resolveEntryPrice({ fill, limitPrice, signal, yesPrice, noPrice });
  const amount = Number(amountUsdc) > 0
    ? Number(amountUsdc)
    : (fill?.usdcSpent > 0 ? fill.usdcSpent : null);

  const lines = [];
  if (price != null) {
    lines.push(`开单价格: <b>$${Number(price).toFixed(3)}</b>`);
  }
  if (amount != null) {
    lines.push(`投入: <b>$${amount.toFixed(2)}</b>`);
    const winNet = calcWinNetProfit(amount, price);
    if (winNet != null) {
      lines.push(`胜则盈亏: <b>+$${winNet.toFixed(2)}</b>`);
    }
    const loss = calcLossPnl(amount);
    if (loss != null) {
      lines.push(`输则盈亏: <b>-$${Math.abs(loss).toFixed(2)}</b>`);
    }
    if (fill?.shares != null && Number(fill.shares) > 0) {
      lines.push(`份数: ${Number(fill.shares).toFixed(2)}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Telegram：结算时回显开单价 + 本单盈亏
 */
export function formatSettlementTradeLines({ entryPrice, actualBet, pnlUsd, formatPnl }) {
  const lines = [];
  if (entryPrice != null && Number(entryPrice) > 0) {
    lines.push(`开单价格: <b>$${Number(entryPrice).toFixed(3)}</b>`);
  }
  if (actualBet != null && Number(actualBet) > 0) {
    lines.push(`投入: <b>$${Number(actualBet).toFixed(2)}</b>`);
  }
  if (pnlUsd != null && typeof formatPnl === 'function') {
    lines.push(`本单盈亏: <b>${formatPnl(pnlUsd)}</b>`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
