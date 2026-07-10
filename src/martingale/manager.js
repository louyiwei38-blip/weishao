import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import { scopedLogPath } from '../utils/instancePaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = scopedLogPath(LOGS_DIR, 'martingale-state.json');

const MARTINGALE_KEY = `${config.symbol}:${config.timeframe}`;

/** @type {Record<string, {
 *   consecutiveLosses: number,
 *   baseBet: number,
 *   currentBet: number,
 * }>} */
let state = {};

function defaultEntry() {
  const baseBet = config.tradeBudgetUsd;
  return {
    consecutiveLosses: 0,
    baseBet,
    currentBet: baseBet,
  };
}

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
    s.baseBet = config.tradeBudgetUsd;
    if (s.consecutiveLosses === 0) s.currentBet = s.baseBet;
    delete s.isHalted;
  }
}

function persist() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function resetToBaseBet() {
  const s = state[MARTINGALE_KEY];
  s.baseBet = config.tradeBudgetUsd;
  s.currentBet = s.baseBet;
  s.consecutiveLosses = 0;
}

export function init() {
  loadState();
}

/**
 * @param {number} availableBalance
 * @returns {{ actualBet: number, skipReason: string | null }}
 */
export function prepareOrder(availableBalance) {
  const s = state[MARTINGALE_KEY];

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
    resetToBaseBet();
    logger.info('[martingale] 赢 — 重置首注', {
      key: MARTINGALE_KEY,
      baseBet: s.baseBet,
    });
  } else {
    s.consecutiveLosses += 1;

    if (s.consecutiveLosses >= config.martingaleMaxLosses) {
      resetToBaseBet();
      halted = true;
      logger.warn('[martingale] 连亏止损 — 重置首注', {
        key: MARTINGALE_KEY,
        baseBet: s.baseBet,
      });
    } else {
      s.currentBet = s.currentBet * config.martingaleMultiplier;
      logger.info('[martingale] 输 — 加倍下注', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
        baseBet: s.baseBet,
        nextBet: s.currentBet,
      });
    }
  }

  persist();
  return { halted };
}

export function getState() {
  const s = state[MARTINGALE_KEY] ?? defaultEntry();
  return {
    consecutiveLosses: s.consecutiveLosses,
    baseBet: s.baseBet,
    currentBet: s.currentBet,
    isHalted: false,
  };
}
