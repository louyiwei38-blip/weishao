/**
 * Pure helpers for settlement-driven MG_CONT fast path + cycle timing.
 * Kept side-effect free so scripts can verify gating without live APIs.
 */

/**
 * After a loss settlement: continue same-direction martingale immediately?
 * @param {{
 *   enabled?: boolean,
 *   won: boolean,
 *   halted: boolean,
 *   phase: string,
 *   lockedSignal: string | null,
 * }} p
 */
export function shouldMgContFastPath(p) {
  if (p.enabled === false) return false;
  if (p.won || p.halted) return false;
  if (p.phase !== 'in_chain') return false;
  if (p.lockedSignal !== 'UP' && p.lockedSignal !== 'DOWN') return false;
  return true;
}

export function nextCycleStartTs(cycleStartTs, cycleMs) {
  return cycleStartTs + cycleMs;
}

/**
 * Still enough time left in the window to place an order.
 * @param {number} nowMs
 * @param {number} cycleStartTs
 * @param {number} cycleMs
 * @param {number} [minRemainingMs=15000]
 */
export function isWithinTradeWindow(nowMs, cycleStartTs, cycleMs, minRemainingMs = 15_000) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(cycleStartTs) || !Number.isFinite(cycleMs)) {
    return false;
  }
  if (nowMs < cycleStartTs) return false;
  return nowMs < cycleStartTs + cycleMs - minRemainingMs;
}

/**
 * First cycle window for a button sequence started at nowMs.
 * Click before the upcoming boundary → that boundary (e.g. 17:54 → 17:55).
 * Click within the first 30s after a boundary → that same window.
 * @param {number} nowMs
 * @param {number} cycleMs
 * @param {number} [minRemainingMs=15000]
 */
export function firstButtonCycleStartTs(nowMs, cycleMs, minRemainingMs = 15_000) {
  const current = Math.floor(nowMs / cycleMs) * cycleMs;
  const msIntoCycle = nowMs - current;
  if (
    msIntoCycle <= 30_000 &&
    isWithinTradeWindow(nowMs, current, cycleMs, minRemainingMs)
  ) {
    return current;
  }
  return current + cycleMs;
}

/**
 * Delay after UTC boundary before runCycle.
 * - pending unsettled OR resting GTC watch: wait at least settle buffer so wake aligns with oracle
 * - in_chain continuation: use short delay (candle/EMA not needed)
 * - new signal: full SIGNAL_DELAY_MS (candle must close)
 *
 * Callers should pass hasPending=true when prior pendingBet OR any resting fill watch is active.
 */
export function resolveCycleSignalDelayMs({
  phase,
  lockedSignal,
  hasPending,
  signalDelayMs,
  inChainSignalDelayMs,
  settleBufferMs,
}) {
  if (hasPending) {
    return Math.max(signalDelayMs, (settleBufferMs ?? 0) + 200);
  }
  if (
    phase === 'in_chain' &&
    (lockedSignal === 'UP' || lockedSignal === 'DOWN')
  ) {
    return Math.min(signalDelayMs, inChainSignalDelayMs);
  }
  return signalDelayMs;
}

/** Default SIGNAL_DELAY by timeframe — keep freshness gate; do not go to 0. */
export function defaultSignalDelayMs(timeframe) {
  const m = String(timeframe || '').trim().match(/^(\d+)(m|h)$/i);
  if (!m) return 5000;
  const n = Number(m[1]);
  const mins = m[2].toLowerCase() === 'h' ? n * 60 : n;
  if (mins <= 5) return 3000;
  if (mins <= 15) return 4000;
  return 5000;
}