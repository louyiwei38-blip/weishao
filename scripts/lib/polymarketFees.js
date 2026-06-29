/**
 * Polymarket Crypto taker fee — https://docs.polymarket.com/trading/fees
 * fee = C × feeRate × p × (1 - p)
 */

export const CRYPTO_TAKER_FEE_RATE = 0.07;

/** @param {number} stakeUsd USDC trade value (C × p) */
export function calcTakerFeeUsd(stakeUsd, entryPrice, feeRate = CRYPTO_TAKER_FEE_RATE) {
  const S = Number(stakeUsd);
  const p = Number(entryPrice);
  if (!Number.isFinite(S) || S <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const shares = S / p;
  const fee = shares * feeRate * p * (1 - p);
  return Math.round(fee * 100000) / 100000;
}

/** Effective fee / stake at entry price (Crypto taker). */
export function effectiveFeeRate(entryPrice, feeRate = CRYPTO_TAKER_FEE_RATE) {
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
export function computeNetSettlementPnl(won, stakeUsd, entryPrice, feeRate = CRYPTO_TAKER_FEE_RATE) {
  const S = Number(stakeUsd);
  if (!Number.isFinite(S) || S <= 0) return { pnlUsd: 0, feeUsd: 0, totalCost: 0 };
  const fee = calcTakerFeeUsd(S, entryPrice, feeRate);
  const totalCost = S + fee;
  if (won) {
    const p = Number(entryPrice);
    const payout = S / p;
    return { pnlUsd: payout - totalCost, feeUsd: fee, totalCost };
  }
  return { pnlUsd: -totalCost, feeUsd: fee, totalCost };
}
