import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import { scopedLogPath } from '../utils/instancePaths.js';
import * as bankroll from './bankroll.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = scopedLogPath(LOGS_DIR, 'martingale-state.json');

const MARTINGALE_KEY = `${config.symbol}:${config.timeframe}`;

/** @type {Record<string, {
 *   consecutiveLosses: number,
 *   baseBet: number,
 *   currentBet: number,
 *   chainPnlUsd: number,
 * }>} */
let state = {};

function defaultEntry() {
  const baseBet = config.tradeBudgetUsd;
  return {
    consecutiveLosses: 0,
    baseBet,
    currentBet: baseBet,
    chainPnlUsd: 0,
  };
}

function loadState() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      logger.info('[martingale] state restored', { state });
    } catch {
      logger.warn('[martingale] state parse failed, start fresh');
      state = {};
    }
  }
  if (!state[MARTINGALE_KEY]) {
    state[MARTINGALE_KEY] = defaultEntry();
  } else {
    const s = state[MARTINGALE_KEY];
    s.baseBet = config.tradeBudgetUsd;
    if (s.consecutiveLosses === 0) s.currentBet = s.baseBet;
    if (!Number.isFinite(s.chainPnlUsd)) s.chainPnlUsd = 0;
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
  s.chainPnlUsd = 0;
}

export function init() {
  loadState();
  bankroll.init();
}

/**
 * Dynamic stake every shot (entry + MG_CONT). Martingale only tracks loss streak / halt.
 * @param {number} availableBalance
 * @param {number|null|undefined} entryPrice token price in (0,1)
 * @returns {{ actualBet: number, skipReason: string|null, sizing: object|null }}
 */
export function prepareOrder(availableBalance, entryPrice = null) {
  const s = state[MARTINGALE_KEY];
  bankroll.ensurePrincipal(availableBalance);

  const sizing = bankroll.computeStake({
    balance: availableBalance,
    entryPrice,
  });

  const actualBet = Math.min(
    sizing.stakeUsd,
    config.maxBetUsd,
    availableBalance,
  );

  // Keep currentBet in sync for Telegram / logs (size comes from bankroll, not mult path)
  s.baseBet = config.tradeBudgetUsd;
  s.currentBet = actualBet;

  if (actualBet <= 0) {
    return { actualBet: 0, skipReason: 'insufficient_balance', sizing };
  }

  logger.info('[martingale] prepareOrder dynamic stake', {
    key: MARTINGALE_KEY,
    mode: sizing.mode,
    actualBet,
    entryPrice: sizing.entryPrice,
    targetProfitUsd: sizing.targetProfitUsd,
    shares: sizing.shares,
    consecutiveLosses: s.consecutiveLosses,
    bankroll: bankroll.getState(),
  });

  return { actualBet, skipReason: null, sizing };
}

/**
 * @param {boolean} won
 * @param {number} [pnlUsd=0]
 * @returns {{ halted: boolean, chainPnlUsd: number, bankroll: object }}
 */
export function onSettled(won, pnlUsd = 0) {
  const s = state[MARTINGALE_KEY];
  let halted = false;

  s.chainPnlUsd = (Number(s.chainPnlUsd) || 0) + (Number(pnlUsd) || 0);
  const chainPnlUsd = s.chainPnlUsd;

  const br = bankroll.onSettled(won);

  if (won) {
    resetToBaseBet();
    logger.info('[martingale] win — reset streak', {
      key: MARTINGALE_KEY,
      baseBet: s.baseBet,
      chainPnlUsd,
      netCount: br.netCount,
    });
  } else {
    s.consecutiveLosses += 1;

    if (s.consecutiveLosses >= config.martingaleMaxLosses) {
      resetToBaseBet();
      halted = true;
      logger.warn('[martingale] max losses — halt and reset streak', {
        key: MARTINGALE_KEY,
        baseBet: s.baseBet,
        chainPnlUsd,
        netCount: br.netCount,
      });
    } else {
      // Multiplier kept for compatibility; live size is recomputed each shot via bankroll
      s.currentBet = s.currentBet * config.martingaleMultiplier;
      logger.info('[martingale] loss — streak++', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
        baseBet: s.baseBet,
        nextBetHint: s.currentBet,
        chainPnlUsd,
        netCount: br.netCount,
      });
    }
  }

  persist();
  return { halted, chainPnlUsd, bankroll: br };
}

export function getState() {
  const s = state[MARTINGALE_KEY] ?? defaultEntry();
  const br = bankroll.getState();
  return {
    consecutiveLosses: s.consecutiveLosses,
    baseBet: s.baseBet,
    currentBet: s.currentBet,
    chainPnlUsd: Number(s.chainPnlUsd) || 0,
    isHalted: false,
    bankroll: br,
  };
}

export { bankroll };
