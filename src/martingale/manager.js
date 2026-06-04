import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', '..', 'logs', 'martingale-state.json');
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

const MARTINGALE_KEY = `${config.symbol}:${config.timeframe}`;

/** @type {Record<string, { consecutiveLosses: number, currentBet: number, isHalted: boolean }>} */
let state = {};

// ─────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────

function loadState() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      logger.info('[martingale] state restored', { state });
    } catch {
      logger.warn('[martingale] failed to parse state file, starting fresh');
      state = {};
    }
  }
  // Ensure the key exists with defaults
  if (!state[MARTINGALE_KEY]) {
    state[MARTINGALE_KEY] = {
      consecutiveLosses: 0,
      currentBet: config.tradeBudgetUsd,
      isHalted: false,
    };
  } else if (state[MARTINGALE_KEY].consecutiveLosses === 0) {
    state[MARTINGALE_KEY].currentBet = config.tradeBudgetUsd;
  }
}

function persist() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─────────────────────────────────────────
// Public API
// ─────────────────────────────────────────

/**
 * Call once at startup to restore persisted state.
 */
export function init() {
  loadState();
}

/**
 * Called before placing an order. Returns the actual bet size to use,
 * or a skipReason string if the order should be skipped.
 *
 * @param {number} availableBalance  – current pUSD balance
 * @returns {{ actualBet: number, skipReason: string | null }}
 */
export function prepareOrder(availableBalance) {
  const s = state[MARTINGALE_KEY];

  if (s.isHalted) {
    logger.warn('[martingale] halted — skipping this signal and resetting', {
      key: MARTINGALE_KEY,
    });
    s.isHalted = false;
    s.consecutiveLosses = 0;
    s.currentBet = config.tradeBudgetUsd;
    persist();
    return { actualBet: 0, skipReason: 'halted' };
  }

  const actualBet = Math.min(
    s.currentBet,
    config.maxBetUsd,
    availableBalance
  );

  if (actualBet <= 0) {
    return { actualBet: 0, skipReason: 'insufficient_balance' };
  }

  return { actualBet, skipReason: null };
}

/**
 * Call after a Polymarket market resolves.
 * @param {boolean} won
 */
export function onSettled(won) {
  const s = state[MARTINGALE_KEY];

  if (won) {
    logger.info('[martingale] WIN — resetting bet', {
      key: MARTINGALE_KEY,
      prev: { consecutiveLosses: s.consecutiveLosses, currentBet: s.currentBet },
    });
    s.consecutiveLosses = 0;
    s.currentBet = config.tradeBudgetUsd;
    s.isHalted = false;
  } else {
    s.consecutiveLosses += 1;

    if (s.consecutiveLosses >= config.martingaleMaxLosses) {
      logger.warn('[martingale] stop-loss triggered', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
      });
      s.isHalted = true;
      s.consecutiveLosses = 0;
      s.currentBet = config.tradeBudgetUsd;
    } else {
      s.currentBet = s.currentBet * config.martingaleMultiplier;
      logger.info('[martingale] LOSS — doubling bet', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
        nextBet: s.currentBet,
      });
    }
  }

  persist();
}

/**
 * Return a snapshot of current martingale state (read-only).
 */
export function getState() {
  return { ...state[MARTINGALE_KEY] };
}
