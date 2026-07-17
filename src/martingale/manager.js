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
 * @param {number} equityBalance Portfolio (Cash + positions) — drives bankroll target line
 * @param {number|null|undefined} entryPrice token price in (0,1)
 * @param {number|null|undefined} cashBalance Spendable Cash; defaults to equityBalance
 * @returns {{ actualBet: number, skipReason: string|null, sizing: object|null }}
 */
export function prepareOrder(equityBalance, entryPrice = null, cashBalance = null) {
  const s = state[MARTINGALE_KEY];
  bankroll.ensurePrincipal(equityBalance);

  const sizing = bankroll.computeStake({
    balance: equityBalance,
    entryPrice,
  });

  const spendable =
    cashBalance != null && Number.isFinite(Number(cashBalance))
      ? Number(cashBalance)
      : equityBalance;

  const actualBet = Math.min(
    sizing.stakeUsd,
    config.maxBetUsd,
    Math.max(0, spendable),
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
    equityBalance,
    cashBalance: spendable,
    entryPrice: sizing.entryPrice,
    gapUsd: sizing.gapUsd,
    catchUpTier: sizing.catchUpTier,
    catchUpFraction: sizing.catchUpFraction,
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
 * @param {number|null|undefined} [equityBalance=null] Portfolio at halt — re-locks bankroll P
 * @returns {{ halted: boolean, chainPnlUsd: number, bankroll: object }}
 */
export function onSettled(won, pnlUsd = 0, equityBalance = null) {
  const s = state[MARTINGALE_KEY];
  let halted = false;

  s.chainPnlUsd = (Number(s.chainPnlUsd) || 0) + (Number(pnlUsd) || 0);
  const chainPnlUsd = s.chainPnlUsd;

  /** @type {object} */
  let br;

  if (won) {
    br = bankroll.onSettled(true);
    resetToBaseBet();
    logger.info('[martingale] win — reset streak', {
      key: MARTINGALE_KEY,
      baseBet: s.baseBet,
      chainPnlUsd,
      netCount: br.netCount,
      principal: br.principal,
    });
  } else {
    s.consecutiveLosses += 1;

    if (s.consecutiveLosses >= config.martingaleMaxLosses) {
      resetToBaseBet();
      halted = true;
      // Epoch restart: re-lock P from Portfolio, N → 0 (no ±1 for this settle)
      br = bankroll.resetOnMaxLossHalt(equityBalance);
      logger.warn('[martingale] max losses — halt, reset streak + bankroll P/N', {
        key: MARTINGALE_KEY,
        baseBet: s.baseBet,
        chainPnlUsd,
        netCount: br.netCount,
        principal: br.principal,
        principalUpdated: br.principalUpdated,
      });
    } else {
      br = bankroll.onSettled(false);
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
