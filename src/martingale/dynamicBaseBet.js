/**
 * 12-tier hybrid base bet from session-gate activity (probe hits in last N bars).
 * Default: tier1=$2 | tier2-6 $2→$3 | tier7-8 $3 | tier9-12 $4→$12
 */

import config from '../config.js';
import { computeActivityFreq } from '../session/sessionGate.js';

export const TIER_COUNT = 12;

function roundBet(n) {
  if (!Number.isFinite(n)) return config.tradeBudgetUsd;
  return Math.round(n * 100) / 100;
}

export function dynamicBaseBetEnabled() {
  return config.dynamicBaseBet.enabled;
}

export function getDynamicBaseBetOpts() {
  const c = config.dynamicBaseBet;
  return {
    tier1Usd: c.tier1Usd,
    weakMinUsd: c.weakMinUsd,
    weakMaxUsd: c.weakMaxUsd,
    ampMinUsd: c.ampMinUsd,
    ampMaxUsd: c.ampMaxUsd,
  };
}

/** Map probe hits (0..windowBars) → tier 1..12 (cold→hot). */
export function activityHitsToTier(hits, windowBars = TIER_COUNT) {
  const h = Math.min(Math.max(0, hits), windowBars);
  if (windowBars <= 0) return 1;
  return Math.max(1, Math.min(TIER_COUNT, Math.round((h / windowBars) * (TIER_COUNT - 1)) + 1));
}

/**
 * Hybrid tier → base bet USD.
 * @param {number} tier 1..12
 * @param {object} [opts] override config.dynamicBaseBet fields
 */
export function resolveHybridTierBaseBet(tier, opts = null) {
  const c = opts ?? config.dynamicBaseBet;
  const tier1 = Number(c.tier1Usd ?? c.weakMinUsd);
  const weakMin = Math.min(Number(c.weakMinUsd), Number(c.weakMaxUsd));
  const weakMax = Math.max(Number(c.weakMinUsd), Number(c.weakMaxUsd));
  const ampMin = Math.min(Number(c.ampMinUsd), Number(c.ampMaxUsd));
  const ampMax = Math.max(Number(c.ampMinUsd), Number(c.ampMaxUsd));
  const t = Math.max(1, Math.min(TIER_COUNT, tier));

  if (t <= 1) return roundBet(tier1);
  if (t <= 6) return roundBet(weakMin + ((t - 2) / (6 - 2)) * (weakMax - weakMin));
  if (t <= 8) return roundBet(weakMax);
  return roundBet(ampMin + ((t - 9) / (12 - 9)) * (ampMax - ampMin));
}

/**
 * Resolve base bet from closed 5m candles (uses last bar for activity).
 */
export function resolveBaseBetFromCandles(candles5m) {
  if (!dynamicBaseBetEnabled()) {
    return {
      baseBet: config.tradeBudgetUsd,
      tier: null,
      hits: null,
      windowBars: null,
      dynamic: false,
    };
  }

  if (!Array.isArray(candles5m) || candles5m.length < 1) {
    return {
      baseBet: config.tradeBudgetUsd,
      tier: null,
      hits: null,
      windowBars: null,
      dynamic: false,
      reason: 'no_candles',
    };
  }

  const idx = candles5m.length - 1;
  const activity = computeActivityFreq(candles5m, idx);
  const tier = activityHitsToTier(activity.hits, activity.windowBars);
  const baseBet = resolveHybridTierBaseBet(tier);

  return {
    baseBet,
    tier,
    hits: activity.hits,
    windowBars: activity.windowBars,
    dynamic: true,
  };
}

/** Human-readable tier bet table for logs / Telegram. */
export function formatTierBetTable() {
  return Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    baseBet: resolveHybridTierBaseBet(i + 1),
  }));
}

export function formatDynamicBaseBetSummary(ctx) {
  if (!ctx?.dynamic) return '';
  return `活跃 ${ctx.hits}/${ctx.windowBars} → ${ctx.tier}档 $${ctx.baseBet}`;
}
