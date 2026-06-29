import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getBetForActivityTier } from '../session/activityTier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', '..', 'logs', 'martingale-state.json');
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

const MARTINGALE_KEY = `${config.symbol}:${config.timeframe}`;

/** @type {Record<string, {
 *   consecutiveLosses: number,
 *   baseBet: number,
 *   currentBet: number,
 *   lockedTier: number,
 *   isHalted: boolean
 * }>} */
let state = {};

function defaultEntry() {
  const baseBet = getBetForActivityTier(1);
  return {
    consecutiveLosses: 0,
    baseBet,
    currentBet: baseBet,
    lockedTier: 1,
    isHalted: false,
  };
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
    state[MARTINGALE_KEY] = defaultEntry();
  } else {
    const s = state[MARTINGALE_KEY];
    if (s.baseBet == null) s.baseBet = s.currentBet ?? config.tradeBudgetUsd;
    if (s.lockedTier == null) s.lockedTier = 1;
    if (s.consecutiveLosses === 0) s.currentBet = s.baseBet;
  }
}

function persist() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function refreshBaseFromTier(tier) {
  const s = state[MARTINGALE_KEY];
  const t = Math.min(12, Math.max(1, Math.round(tier ?? 1)));
  s.baseBet = getBetForActivityTier(t);
  s.currentBet = s.baseBet;
  s.lockedTier = t;
  s.consecutiveLosses = 0;
  s.isHalted = false;
}

// ─────────────────────────────────────────
// Public API
// ─────────────────────────────────────────

export function init() {
  loadState();
}

/**
 * @param {number} availableBalance
 * @returns {{ actualBet: number, skipReason: string | null }}
 */
export function prepareOrder(availableBalance) {
  const s = state[MARTINGALE_KEY];

  if (s.isHalted) {
    logger.warn('[martingale] 已触发止损 — 跳过本信号', {
      key: MARTINGALE_KEY,
      lockedTier: s.lockedTier,
      baseBet: s.baseBet,
    });
    s.isHalted = false;
    s.consecutiveLosses = 0;
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
 * @param {{ activityTier?: number }} [opts] — current activity tier; updates baseBet on win/halt only
 * @returns {{ halted: boolean }}
 */
export function onSettled(won, { activityTier } = {}) {
  const s = state[MARTINGALE_KEY];
  let halted = false;

  if (won) {
    const prev = { baseBet: s.baseBet, lockedTier: s.lockedTier, consecutiveLosses: s.consecutiveLosses };
    refreshBaseFromTier(activityTier);
    logger.info('[martingale] 赢 — 按活跃度档位更新首注', {
      key: MARTINGALE_KEY,
      prev,
      next: { baseBet: s.baseBet, lockedTier: s.lockedTier },
      activityTier: s.lockedTier,
    });
  } else {
    s.consecutiveLosses += 1;

    if (s.consecutiveLosses >= config.martingaleMaxLosses) {
      const prev = { baseBet: s.baseBet, lockedTier: s.lockedTier, consecutiveLosses: s.consecutiveLosses };
      refreshBaseFromTier(activityTier);
      s.isHalted = true;
      halted = true;
      logger.warn('[martingale] 连亏止损 — 按活跃度档位更新首注', {
        key: MARTINGALE_KEY,
        prev,
        next: { baseBet: s.baseBet, lockedTier: s.lockedTier },
        activityTier: s.lockedTier,
      });
    } else {
      s.currentBet = s.currentBet * config.martingaleMultiplier;
      logger.info('[martingale] 输 — 加倍下注（首注锁定）', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
        lockedTier: s.lockedTier,
        baseBet: s.baseBet,
        nextBet: s.currentBet,
      });
    }
  }

  persist();
  return { halted };
}

export function getState() {
  return { ...state[MARTINGALE_KEY] };
}
