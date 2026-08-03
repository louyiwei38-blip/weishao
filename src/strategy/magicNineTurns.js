/**
 * TD Sequential "Magic Nine Turns" (神奇九转) setup detection.
 *
 * Buy Setup:  close[i] < close[i-4] → count+1, else reset
 * Sell Setup: close[i] > close[i-4] → count+1, else reset
 * When count hits 9 on bar i → setup complete; counter resets to 0 so the
 * next bar (if still valid) starts from 1 again (no Perfect / TD13).
 *
 * Open on the following Polymarket cycle (bar i+1): Buy→UP, Sell→DOWN.
 * Buy and Sell both complete on the same bar → skip.
 */

export const MIN_SIGNAL_CANDLES = 13; // 9 setup + 4 lookback

/**
 * Forward TD Setup scan through candles[4..endIdx].
 * After each completion of 9, that side's counter resets to 0.
 *
 * @param {Array<{ close: number }>} candles
 * @param {number} endIdx inclusive
 * @returns {{
 *   buyCount: number,
 *   sellCount: number,
 *   completedBuy: boolean,
 *   completedSell: boolean,
 * }}
 */
export function scanSetupThrough(candles, endIdx) {
  let buyCount = 0;
  let sellCount = 0;
  let completedBuy = false;
  let completedSell = false;

  if (!Array.isArray(candles) || endIdx < 4) {
    return { buyCount: 0, sellCount: 0, completedBuy: false, completedSell: false };
  }

  for (let i = 4; i <= endIdx; i += 1) {
    const c = Number(candles[i]?.close);
    const c4 = Number(candles[i - 4]?.close);
    if (!Number.isFinite(c) || !Number.isFinite(c4)) {
      buyCount = 0;
      sellCount = 0;
      completedBuy = false;
      completedSell = false;
      continue;
    }

    if (c < c4) {
      buyCount += 1;
      sellCount = 0;
    } else if (c > c4) {
      sellCount += 1;
      buyCount = 0;
    } else {
      buyCount = 0;
      sellCount = 0;
    }

    completedBuy = false;
    completedSell = false;

    if (buyCount === 9) {
      completedBuy = true;
      buyCount = 0; // 满 9 清零，下一根从 1 再起算
    }
    if (sellCount === 9) {
      completedSell = true;
      sellCount = 0;
    }
  }

  return { buyCount, sellCount, completedBuy, completedSell };
}

/**
 * Consecutive setup count ending at index (debug / display only).
 * Prefer scanSetupThrough for live signals — that resets after each 9.
 */
export function countSetupEndingAt(candles, idx, dir) {
  const scan = scanSetupThrough(candles, idx);
  // After a completion on idx, counters are already 0; report 9 if just completed.
  if (dir === 'buy') {
    return scan.completedBuy ? 9 : scan.buyCount;
  }
  return scan.completedSell ? 9 : scan.sellCount;
}

/**
 * @param {Array<{ t?: number, open?: number, high?: number, low?: number, close: number }>} candles
 * @param {number} idx index of latest closed bar (setup completion bar)
 * @returns {{ signal: 'UP'|'DOWN'|'NONE', signalId: string|null, reason: string, buyCount: number, sellCount: number }}
 */
export function evaluateMagicNineAt(candles, idx) {
  const { buyCount, sellCount, completedBuy, completedSell } = scanSetupThrough(
    candles,
    idx,
  );

  // Dual completion on same bar (theoretical) → skip
  if (completedBuy && completedSell) {
    return {
      signal: 'NONE',
      signalId: null,
      reason: '九转 Buy/Sell 同时完成 — 跳过',
      buyCount: 9,
      sellCount: 9,
    };
  }

  if (completedBuy) {
    return {
      signal: 'UP',
      signalId: 'JZ_UP',
      reason: 'Buy Setup 九转: 连续9根收盘 < 4根前收盘 → 本周期买涨(反转)；计数已清零',
      buyCount: 9,
      sellCount,
    };
  }
  if (completedSell) {
    return {
      signal: 'DOWN',
      signalId: 'JZ_DOWN',
      reason: 'Sell Setup 九转: 连续9根收盘 > 4根前收盘 → 本周期买跌(反转)；计数已清零',
      buyCount,
      sellCount: 9,
    };
  }

  return {
    signal: 'NONE',
    signalId: null,
    reason:
      buyCount > 0 || sellCount > 0
        ? `九转未完成 (买Setup=${buyCount}/9 · 卖Setup=${sellCount}/9)`
        : '九转无 Setup 计数',
    buyCount,
    sellCount,
  };
}

export function buildJzSignal(candles, symbol, timeframe, evaluation) {
  const last = candles?.at(-1) ?? null;
  const prev = candles?.length > 1 ? candles[candles.length - 2] : null;
  return {
    symbol,
    timeframe,
    evaluatedAt: new Date().toISOString(),
    kMinus2: prev
      ? { t: prev.t, o: prev.open, h: prev.high, l: prev.low, c: prev.close }
      : null,
    kMinus1: last
      ? { t: last.t, o: last.open, h: last.high, l: last.low, c: last.close }
      : null,
    bands: null,
    prevOutside: null,
    signal: evaluation.signal,
    signalId: evaluation.signalId,
    reason: evaluation.reason,
    buyCount: evaluation.buyCount,
    sellCount: evaluation.sellCount,
  };
}
