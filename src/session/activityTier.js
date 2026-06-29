import config from '../config.js';
import { computeActivityFreq } from './sessionGate.js';

export const ACTIVITY_TIER_COUNT = 12;

/**
 * Map probe-line hit count (0..windowBars) → tier 1..12.
 * 0 hits → tier 1 (最低活跃), 11+ hits → tier 12.
 */
export function hitsToActivityTier(hits) {
  const h = Number.isFinite(hits) ? hits : 0;
  return Math.min(ACTIVITY_TIER_COUNT, Math.max(1, h + 1));
}

/** Resolve activity tier from closed 5m candles (last bar). */
export function resolveActivityTier(candles5m) {
  if (!Array.isArray(candles5m) || candles5m.length === 0) return 1;
  const idx = candles5m.length - 1;
  const activity = computeActivityFreq(candles5m, idx);
  return hitsToActivityTier(activity.hits);
}

/** First-bet USD for tier 1..12 (from ACTIVITY_TIER_BETS). */
export function getBetForActivityTier(tier) {
  const idx = Math.min(ACTIVITY_TIER_COUNT, Math.max(1, Math.round(tier))) - 1;
  const bets = config.activityTierBets;
  return bets[idx] ?? config.tradeBudgetUsd;
}
