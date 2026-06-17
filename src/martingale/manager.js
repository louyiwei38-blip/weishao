import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import {
  dynamicBaseBetEnabled,
  resolveBaseBetFromCandles,
  formatDynamicBaseBetSummary,
  activityTierTradeAllowed,
  minActivityTier,
} from './dynamicBaseBet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', '..', 'logs', 'martingale-state.json');
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

const MARTINGALE_KEY = `${config.symbol}:${config.timeframe}`;

/** @type {Record<string, {
 *   consecutiveLosses: number,
 *   currentBet: number,
 *   streakBaseBet: number|null,
 *   isHalted: boolean,
 *   activityTier?: number|null,
 *   activityHits?: number|null,
 * }>} */
let state = {};

function defaultBaseBet() {
  return config.tradeBudgetUsd;
}

function applyBaseBetResolved(resolved) {
  const s = state[MARTINGALE_KEY];
  s.currentBet = resolved.baseBet;
  s.streakBaseBet = resolved.baseBet;
  s.activityTier = resolved.tier ?? null;
  s.activityHits = resolved.hits ?? null;
}

// ─────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────

function loadState() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      logger.info('[martingale] 状态已恢复', { state });
    } catch {
      logger.warn('[martingale] 状态文件解析失败，从头开始');
      state = {};
    }
  }
  if (!state[MARTINGALE_KEY]) {
    state[MARTINGALE_KEY] = {
      consecutiveLosses: 0,
      currentBet: defaultBaseBet(),
      streakBaseBet: defaultBaseBet(),
      isHalted: false,
      activityTier: null,
      activityHits: null,
    };
  } else if (state[MARTINGALE_KEY].consecutiveLosses === 0 && !dynamicBaseBetEnabled()) {
    state[MARTINGALE_KEY].currentBet = defaultBaseBet();
    state[MARTINGALE_KEY].streakBaseBet = defaultBaseBet();
  } else if (state[MARTINGALE_KEY].streakBaseBet == null) {
    state[MARTINGALE_KEY].streakBaseBet = state[MARTINGALE_KEY].currentBet;
  }
  const s = state[MARTINGALE_KEY];
  if (!Number.isFinite(s.currentBet) || s.currentBet <= 0) {
    s.currentBet = Number.isFinite(s.streakBaseBet) && s.streakBaseBet > 0
      ? s.streakBaseBet
      : defaultBaseBet();
  }
}

function persist() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─────────────────────────────────────────
// Public API
// ─────────────────────────────────────────

export function init() {
  loadState();
}

/**
 * Refresh base bet from activity when starting a new martingale streak.
 * Call before prepareOrder each cycle (no-op while consecutiveLosses > 0).
 */
export function refreshBaseBetIfNewStreak(candles5m) {
  const s = state[MARTINGALE_KEY];
  if (s.consecutiveLosses !== 0) {
    return null;
  }

  if (!dynamicBaseBetEnabled()) {
    s.currentBet = defaultBaseBet();
    s.streakBaseBet = defaultBaseBet();
    s.activityTier = null;
    s.activityHits = null;
    persist();
    logger.debug('[martingale] 动态首注已关闭，使用 TRADE_BUDGET_USD', {
      baseBet: s.currentBet,
    });
    return { baseBet: s.currentBet, dynamic: false };
  }

  const resolved = resolveBaseBetFromCandles(candles5m);
  applyBaseBetResolved(resolved);
  persist();

  logger.info('[martingale] 动态首注已更新', {
    key: MARTINGALE_KEY,
    baseBet: resolved.baseBet,
    tier: resolved.tier,
    hits: resolved.hits,
    windowBars: resolved.windowBars,
    summary: formatDynamicBaseBetSummary(resolved),
  });

  return resolved;
}

/**
 * @param {number} availableBalance
 * @returns {{ actualBet: number, skipReason: string | null }}
 */
export function prepareOrder(availableBalance) {
  const s = state[MARTINGALE_KEY];

  if (s.isHalted) {
    logger.warn('[martingale] 已触发止损 — 跳过本信号并重置', {
      key: MARTINGALE_KEY,
    });
    s.isHalted = false;
    s.consecutiveLosses = 0;
    if (!dynamicBaseBetEnabled()) {
      s.currentBet = defaultBaseBet();
      s.streakBaseBet = defaultBaseBet();
    }
    s.activityTier = null;
    s.activityHits = null;
    persist();
    return { actualBet: 0, skipReason: 'halted' };
  }

  if (
    s.consecutiveLosses === 0
    && dynamicBaseBetEnabled()
    && minActivityTier() > 1
    && !activityTierTradeAllowed(s.activityTier)
  ) {
    logger.info('[martingale] 活跃度低于最低档 — 跳过本周期新开单', {
      key: MARTINGALE_KEY,
      activityTier: s.activityTier,
      minActivityTier: minActivityTier(),
      hits: s.activityHits,
    });
    return { actualBet: 0, skipReason: 'cold_tier' };
  }

  const martingaleBet = Number(s.currentBet);
  const normalizedBet = Number.isFinite(martingaleBet) && martingaleBet > 0
    ? martingaleBet
    : defaultBaseBet();
  const actualBet = Math.min(
    normalizedBet,
    config.maxBetUsd,
    availableBalance,
  );

  if (actualBet <= 0) {
    const skipReason = availableBalance <= 0 ? 'insufficient_balance' : 'invalid_bet_size';
    logger.warn('[martingale] 下注额度无效 — 跳过本周期', {
      key: MARTINGALE_KEY,
      skipReason,
      martingaleBet: s.currentBet,
      normalizedBet,
      maxBetUsd: config.maxBetUsd,
      availableBalance,
      activityTier: s.activityTier,
      consecutiveLosses: s.consecutiveLosses,
    });
    return { actualBet: 0, skipReason };
  }

  return { actualBet, skipReason: null };
}

/**
 * @param {boolean} won
 * @returns {{ halted: boolean }}
 */
export function onSettled(won) {
  const s = state[MARTINGALE_KEY];
  let halted = false;

  if (won) {
    logger.info('[martingale] 赢 — 重置下注', {
      key: MARTINGALE_KEY,
      prev: {
        consecutiveLosses: s.consecutiveLosses,
        currentBet: s.currentBet,
        activityTier: s.activityTier,
      },
    });
    s.consecutiveLosses = 0;
    s.isHalted = false;
    s.activityTier = null;
    s.activityHits = null;
    s.streakBaseBet = null;
    if (!dynamicBaseBetEnabled()) {
      s.currentBet = defaultBaseBet();
    }
  } else {
    s.consecutiveLosses += 1;

    if (s.consecutiveLosses >= config.martingaleMaxLosses) {
      logger.warn('[martingale] 连亏止损触发', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
      });
      s.isHalted = true;
      s.consecutiveLosses = 0;
      s.activityTier = null;
      s.activityHits = null;
      s.streakBaseBet = null;
      if (!dynamicBaseBetEnabled()) {
        s.currentBet = defaultBaseBet();
      }
      halted = true;
    } else {
      const prevBet = Number(s.currentBet);
      const base = Number.isFinite(prevBet) && prevBet > 0 ? prevBet : defaultBaseBet();
      s.currentBet = base * config.martingaleMultiplier;
      logger.info('[martingale] 输 — 加倍下注', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
        nextBet: s.currentBet,
        activityTier: s.activityTier,
      });
    }
  }

  persist();
  return { halted };
}

export function getState() {
  return { ...state[MARTINGALE_KEY] };
}
