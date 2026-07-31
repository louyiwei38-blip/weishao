/**
 * Polymarket Crypto taker fee — https://docs.polymarket.com/trading/fees
 * fee = C × feeRate × p × (1 - p)  (C = shares, p = entry price)
 */

import config from '../config.js';

export const CRYPTO_TAKER_FEE_RATE = 0.07;

export function resolveFeeRate() {
  const rate = Number(config.cryptoTakerFeeRate);
  return Number.isFinite(rate) && rate >= 0 ? rate : CRYPTO_TAKER_FEE_RATE;
}

export function feesEnabled() {
  return config.includeTradingFees !== false;
}

/** @param {number} stakeUsd USDC trade value (shares × p) */
export function calcTakerFeeUsd(stakeUsd, entryPrice, feeRate = resolveFeeRate()) {
  if (!feesEnabled()) return 0;

  const S = Number(stakeUsd);
  const p = Number(entryPrice);
  if (!Number.isFinite(S) || S <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;

  const shares = S / p;
  const fee = shares * feeRate * p * (1 - p);
  return Math.round(fee * 100000) / 100000;
}

/** Effective fee / stake at entry price (Crypto taker). */
export function effectiveFeeRate(entryPrice, feeRate = resolveFeeRate()) {
  if (!feesEnabled()) return 0;

  const p = Number(entryPrice);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return feeRate * (1 - p);
}

/**
 * Net PnL after taker fee (fee paid on entry regardless of outcome).
 * @param {boolean} won
 * @param {number} stakeUsd
 * @param {number} entryPrice
 */
export function computeNetSettlementPnl(won, stakeUsd, entryPrice, feeRate = resolveFeeRate()) {
  const S = Number(stakeUsd);
  if (!Number.isFinite(S) || S <= 0) return { pnlUsd: 0, feeUsd: 0, totalCost: 0 };

  const fee = calcTakerFeeUsd(S, entryPrice, feeRate);
  const totalCost = S + fee;

  if (won) {
    const p = Number(entryPrice);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) {
      const fallback = calcTakerFeeUsd(S, 0.5, feeRate);
      const fallbackCost = S + fallback;
      return { pnlUsd: S * 2 - fallbackCost, feeUsd: fallback, totalCost: fallbackCost };
    }
    const payout = S / p;
    return { pnlUsd: payout - totalCost, feeUsd: fee, totalCost };
  }

  return { pnlUsd: -totalCost, feeUsd: fee, totalCost };
}
