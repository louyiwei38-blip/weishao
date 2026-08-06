/**
 * Signal-data readiness helpers: stale candles / EMA misalignment are retryable
 * within the same cycle (not a definitive "no trade" skip).
 */

const RETRYABLE_REASON_RE =
  /未对齐|拉取失败|K 线不足|K 线索引无效|EMA 通道尚未对齐|EMA 尚未就绪|信号数据未就绪/i;

/**
 * @param {string|null|undefined} reason
 * @param {boolean} [explicitRetryable]
 */
export function isSignalDataNotReady(reason, explicitRetryable) {
  if (explicitRetryable === true) return true;
  if (explicitRetryable === false) return false;
  return RETRYABLE_REASON_RE.test(String(reason || ''));
}

/**
 * Deadline for waiting on OKX candle/EMA readiness while still leaving
 * enough time to place an order in the current window.
 */
export function resolveSignalDataDeadlineMs({
  nowMs,
  cycleStartTs,
  cycleMs,
  maxWaitMs,
  minTradeRemainingMs,
}) {
  const byBudget = nowMs + maxWaitMs;
  const byWindow = cycleStartTs + cycleMs - minTradeRemainingMs;
  return Math.min(byBudget, byWindow);
}