import config from '../config.js';
import { computeActivityFreq } from './sessionGate.js';

export const ACTIVITY_TIER_COUNT = 12;

const DEFAULT_TIER_BETS = [3, 3, 3, 3, 3, 3, 3, 3, 6, 9, 15, 24];
const DEFAULT_MIN_OPEN_TIERS = [8, 9, 10, 11, 12];

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

function tierBets() {
  const bets = config.activityTierBets;
  if (Array.isArray(bets) && bets.length >= ACTIVITY_TIER_COUNT) return bets;
  return DEFAULT_TIER_BETS;
}

function minOpenTiers() {
  const tiers = config.minOpenTiers;
  if (Array.isArray(tiers) && tiers.length > 0) return tiers;
  return DEFAULT_MIN_OPEN_TIERS;
}

/** First-bet USD for tier 1..12 (offline backtests). */
export function getBetForActivityTier(tier) {
  const idx = Math.min(ACTIVITY_TIER_COUNT, Math.max(1, Math.round(tier))) - 1;
  return tierBets()[idx] ?? config.tradeBudgetUsd;
}

/** Lowest configured min-open tier (default 8). */
export function minOpenTierFloor() {
  const tiers = minOpenTiers();
  return tiers.length ? Math.min(...tiers) : ACTIVITY_TIER_COUNT;
}

/** Min-open tiers eligible when current activity tier is T. */
export function getEligibleMinOpenTiers(activityTier) {
  const t = Math.round(Number(activityTier)) || 0;
  return minOpenTiers().filter((m) => t >= m);
}

/** Virtual tracks for dry-run backtests: one bet per eligible min-open tier. */
export function buildMinOpenTracks(activityTier, balance) {
  return getEligibleMinOpenTiers(activityTier)
    .map((minOpenTier) => ({
      minOpenTier,
      actualBet: Math.min(
        getBetForActivityTier(minOpenTier),
        Number(config.maxBetUsd) > 0 ? config.maxBetUsd : Infinity,
        balance,
      ),
    }))
    .filter((tr) => tr.actualBet > 0);
}
