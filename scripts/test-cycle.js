#!/usr/bin/env node
/**
 * One-shot dry-run cycle test (no scheduler wait).
 * Usage: DRY_RUN=true node scripts/test-cycle.js
 */

import 'dotenv/config';
import { fetchClosedCandles, fetchVolatilityCandles } from '../src/collector/binance.js';
import { buildSignal } from '../src/strategy/reversalContinuation.js';
import { computeSignalVolatility, classifyVolatilityRegime } from '../src/utils/volatility.js';
import { findCurrentCycleMarket, resolveOrderPricePolicy } from '../src/market/polymarket.js';
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

  const volCandles = await fetchVolatilityCandles();
  const rv = computeSignalVolatility(volCandles);
  const { regime, reason } = classifyVolatilityRegime(rv);
  console.log('\n[0] Volatility:', { regime, reason, rv_5m: rv.rv_5m, rv_15m: rv.rv_15m });

  const signalObj = buildSignal(kMinus2, kMinus1, config.symbol, config.timeframe, regime);
  console.log('\n[1] Signal:', signalObj.signal, signalObj.signalId, '-', signalObj.reason);

  if (signalObj.signal === 'NONE') {
    console.log('No trade signal this cycle (normal). Pipeline OK through signal step.');
    return;
  }

  const market = await findCurrentCycleMarket(cycleStartTs);
  console.log('\n[2] Market:', market ? market.slug : 'NOT FOUND');
  if (!market) process.exit(1);

  console.log('    conditionId:', market.conditionId);
  console.log('    upPrice:', market.yesPrice);

  const pricePolicy = resolveOrderPricePolicy(market, signalObj.signal);
  console.log(
    '[3] Price policy:',
    pricePolicy.priceCapped
      ? `capped @ ${pricePolicy.maxLimitPrice} (${signalObj.signal === 'UP' ? 'YES' : 'NO'})`
      : 'no cap'
  );

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
    yesPrice: pricePolicy.yesPrice ?? market.yesPrice,
    noPrice: pricePolicy.noPrice ?? market.noPrice,
    maxLimitPrice: pricePolicy.maxLimitPrice,
    priceCapped: pricePolicy.priceCapped,
    originalYesPrice: pricePolicy.originalYesPrice,
  });

  console.log('\n[5] Order:', order);
  console.log('\n=== Full pipeline OK ===');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
