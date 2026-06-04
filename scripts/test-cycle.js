#!/usr/bin/env node
/**
 * One-shot dry-run cycle test (no scheduler wait).
 * Usage: DRY_RUN=true node scripts/test-cycle.js
 */

import 'dotenv/config';
import { fetchClosedCandles } from '../src/collector/binance.js';
import { buildSignal } from '../src/strategy/reversalContinuation.js';
import { findNextCycleMarket, isPriceAcceptable } from '../src/market/polymarket.js';
import { placeOrder } from '../src/trader/executor.js';
import * as martingale from '../src/martingale/manager.js';
import config from '../src/config.js';

const CYCLE_MS = config.cycleMinutes * 60 * 1000;

async function main() {
  console.log('=== Dry-run cycle test ===');
  console.log('DRY_RUN:', config.dryRun);

  const cycleStartTs = Math.floor(Date.now() / CYCLE_MS) * CYCLE_MS;

  const candles = await fetchClosedCandles(config.candleLimit);
  const kMinus2 = candles.at(-2);
  const kMinus1 = candles.at(-1);

  const signalObj = buildSignal(kMinus2, kMinus1, config.symbol, config.timeframe);
  console.log('\n[1] Signal:', signalObj.signal, signalObj.signalId, '-', signalObj.reason);

  if (signalObj.signal === 'NONE') {
    console.log('No trade signal this cycle (normal). Pipeline OK through signal step.');
    return;
  }

  const market = await findNextCycleMarket(cycleStartTs);
  console.log('\n[2] Market:', market ? market.slug : 'NOT FOUND');
  if (!market) process.exit(1);

  console.log('    conditionId:', market.conditionId);
  console.log('    upPrice:', market.yesPrice);

  if (!isPriceAcceptable(market.yesPrice)) {
    console.log('[3] Price check FAILED');
    process.exit(1);
  }
  console.log('[3] Price check OK');

  martingale.init();
  const { actualBet, skipReason } = martingale.prepareOrder(9999);
  console.log('\n[4] Martingale bet:', actualBet, skipReason ?? 'ready');

  if (skipReason) {
    console.log('Skipped by martingale:', skipReason);
    return;
  }

  const order = await placeOrder({
    signal: signalObj.signal,
    signalId: signalObj.signalId,
    yesTokenId: market.yesTokenId,
    noTokenId: market.noTokenId,
    conditionId: market.conditionId,
    cycleStartTs,
    actualBet,
    baseBet: config.tradeBudgetUsd,
    consecutiveLosses: martingale.getState().consecutiveLosses,
    yesPrice: market.yesPrice,
  });

  console.log('\n[5] Order:', order);
  console.log('\n=== Full pipeline OK ===');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
