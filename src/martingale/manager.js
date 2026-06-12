import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import {
  dynamicBaseBetEnabled,
  resolveBaseBetFromCandles,
  formatDynamicBaseBetSummary,
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

  const actualBet = Math.min(
    s.currentBet,
    config.maxBetUsd,
    availableBalance,
  );

  if (actualBet <= 0) {
    return { actualBet: 0, skipReason: 'insufficient_balance' };
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
      s.currentBet = s.currentBet * config.martingaleMultiplier;
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
