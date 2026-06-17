/**
 * 12-tier activity → 4-bucket base bet (1-9 / 10 / 11 / 12).
 * Default: 1-9=$1 | 10=$6 | 11=$6 | 12=$32 | min tier 10 to open
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
    tier1_9Usd: c.tier1_9Usd,
    tier10Usd: c.tier10Usd,
    tier11Usd: c.tier11Usd,
    tier12Usd: c.tier12Usd,
  };
}

/** Map probe hits (0..windowBars) → tier 1..12 (cold→hot). */
export function activityHitsToTier(hits, windowBars = TIER_COUNT) {
  const h = Math.min(Math.max(0, hits), windowBars);
  if (windowBars <= 0) return 1;
  return Math.max(1, Math.min(TIER_COUNT, Math.round((h / windowBars) * (TIER_COUNT - 1)) + 1));
}

/**
 * Activity tier 1..12 → base bet USD (4 buckets).
 * @param {number} tier 1..12
 * @param {object} [opts] override config.dynamicBaseBet fields
 */
export function resolveTierBaseBet(tier, opts = null) {
  const c = opts ?? config.dynamicBaseBet;
  const t = Math.max(1, Math.min(TIER_COUNT, tier));

  if (t <= 9) return roundBet(Number(c.tier1_9Usd));
  if (t === 10) return roundBet(Number(c.tier10Usd));
  if (t === 11) return roundBet(Number(c.tier11Usd));
  return roundBet(Number(c.tier12Usd));
}

/** @deprecated Use resolveTierBaseBet */
export function resolveHybridTierBaseBet(tier, opts = null) {
  return resolveTierBaseBet(tier, opts);
}

export function formatTierParamLabel(opts = null) {
  const c = opts ?? config.dynamicBaseBet;
  return `1-9档=$${c.tier1_9Usd} | 10档=$${c.tier10Usd} | 11档=$${c.tier11Usd} | 12档=$${c.tier12Usd}`;
}

export function minActivityTier() {
  const n = Number(config.dynamicBaseBet.minActivityTier);
  return Number.isFinite(n) ? Math.max(1, Math.min(TIER_COUNT, Math.round(n))) : 1;
}

/** New streak: allow open only when activity tier ≥ minActivityTier. */
export function activityTierTradeAllowed(tier) {
  if (tier == null) return true;
  return tier >= minActivityTier();
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
  const baseBet = resolveTierBaseBet(tier);

  const tradeAllowed = activityTierTradeAllowed(tier);

  return {
    baseBet,
    tier,
    hits: activity.hits,
    windowBars: activity.windowBars,
    dynamic: true,
    tradeAllowed,
    minActivityTier: minActivityTier(),
  };
}

/** Human-readable tier bet table for logs / Telegram. */
export function formatTierBetTable() {
  return Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    baseBet: resolveTierBaseBet(i + 1),
  }));
}

export function formatDynamicBaseBetSummary(ctx) {
  if (!ctx?.dynamic) return '';
  const minT = ctx.minActivityTier ?? minActivityTier();
  const gate = ctx.tradeAllowed === false ? ` · 低于${minT}档跳过` : '';
  return `活跃 ${ctx.hits}/${ctx.windowBars} → ${ctx.tier}档 $${ctx.baseBet}${gate}`;
}
