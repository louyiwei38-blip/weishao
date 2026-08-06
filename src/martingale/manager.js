import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config, { resolveUsdCap } from '../config.js';
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
    delete s.isHalted; // legacy field; halt is returned from onSettled()
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

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Equity for gap / catch-up sizing.
 * Stats mode: P + wallet-shared realizedPnlUsd (all instances write into bankroll-state).
 * Legacy mode: live Polymarket Portfolio (Cash + positions).
 * @param {number|null|undefined} portfolioBalance Fallback when P not locked or stats mode off
 */
export function resolveSizingEquity(portfolioBalance = null) {
  if (!config.bankrollUseStatsEquity) {
    const fb = Number(portfolioBalance);
    return Number.isFinite(fb) ? fb : null;
  }

  const br = bankroll.getState();
  const P = br.principal;
  if (P == null) {
    const fb = Number(portfolioBalance);
    return Number.isFinite(fb) ? fb : null;
  }

  // Prefer shared wallet ledger — per-instance stats would collapse catch-up queues across TFs
  if (br.ledgerEquity != null) return br.ledgerEquity;
  return round2(P + (Number(br.realizedPnlUsd) || 0));
}

/**
 * Dynamic stake every shot (entry + MG_CONT). Martingale only tracks loss streak / halt.
 * @param {number} portfolioBalance Polymarket Portfolio — locks P; legacy gap source
 * @param {number|null|undefined} entryPrice token price in (0,1)
 * @param {number|null|undefined} cashBalance Spendable Cash for order spend clamp
 * @returns {{ actualBet: number, skipReason: string|null, sizing: object|null }}
 */
export function prepareOrder(portfolioBalance, entryPrice = null, cashBalance = null) {
  const s = state[MARTINGALE_KEY];
  bankroll.ensurePrincipal(portfolioBalance);

  const sizingEquity = resolveSizingEquity(portfolioBalance);
  const spendable =
    cashBalance != null && Number.isFinite(Number(cashBalance))
      ? Number(cashBalance)
      : portfolioBalance;

  const sizing = bankroll.computeStake({
    balance: sizingEquity ?? portfolioBalance,
    entryPrice,
    spendCap: spendable,
  });

  const actualBet = Math.min(
    sizing.stakeUsd,
    resolveUsdCap(config.maxBetUsd),
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
    portfolioBalance,
    sizingEquity,
    statsEquityMode: config.bankrollUseStatsEquity,
    cashBalance: spendable,
    entryPrice: sizing.entryPrice,
    gapUsd: sizing.gapUsd,
    layerUsd: sizing.layerUsd,
    layerIndex: sizing.layerIndex,
    catchUpQueue: sizing.catchUpQueue,
    targetProfitUsd: sizing.targetProfitUsd,
    shares: sizing.shares,
    consecutiveLosses: s.consecutiveLosses,
    bankroll: bankroll.getState(),
    walletRealizedPnlUsd: config.bankrollUseStatsEquity
      ? bankroll.getState().realizedPnlUsd
      : undefined,
  });

  return { actualBet, skipReason: null, sizing };
}

/**
 * @param {boolean} won
 * @param {number} [pnlUsd=0]
 * @param {number|null|undefined} [equityBalance=null] Sizing equity after settle (stats or Portfolio)
 * @returns {{ halted: boolean, chainPnlUsd: number, bankroll: object }}
 */
export function onSettled(won, pnlUsd = 0, equityBalance = null) {
  const s = state[MARTINGALE_KEY];
  let halted = false;

  s.chainPnlUsd = (Number(s.chainPnlUsd) || 0) + (Number(pnlUsd) || 0);
  const chainPnlUsd = s.chainPnlUsd;

  /** Always update N + catch-up queue; max-loss halt does NOT reset P/N. */
  const br = bankroll.onSettled(won, equityBalance, pnlUsd);

  if (won) {
    resetToBaseBet();
    logger.info('[martingale] win — reset streak', {
      key: MARTINGALE_KEY,
      baseBet: s.baseBet,
      chainPnlUsd,
      netCount: br.netCount,
      principal: br.principal,
      catchUpQueue: br.catchUpQueue,
    });
  } else {
    s.consecutiveLosses += 1;
    s.currentBet = s.currentBet * config.martingaleMultiplier;

    if (s.consecutiveLosses >= config.martingaleMaxLosses) {
      resetToBaseBet();
      halted = true;
      logger.warn('[martingale] max losses — halt streak only (P/N kept)', {
        key: MARTINGALE_KEY,
        baseBet: s.baseBet,
        chainPnlUsd,
        netCount: br.netCount,
        principal: br.principal,
        catchUpQueue: br.catchUpQueue,
        equityBalance: Number.isFinite(Number(equityBalance)) ? Number(equityBalance) : null,
      });
    } else {
      logger.info('[martingale] loss — streak++', {
        key: MARTINGALE_KEY,
        consecutiveLosses: s.consecutiveLosses,
        baseBet: s.baseBet,
        nextBetHint: s.currentBet,
        chainPnlUsd,
        netCount: br.netCount,
        catchUpQueue: br.catchUpQueue,
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
    bankroll: br,
  };
}

export { bankroll };
