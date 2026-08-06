#!/usr/bin/env node
/**
 * One-shot dry-run cycle test (no scheduler wait).
 * Usage: DRY_RUN=true node scripts/test-cycle.js
 */

import 'dotenv/config';
import { fetchClosedCandles } from '../src/collector/binance.js';
import * as strategyState from '../src/strategy/activeStrategy.js';
import { findCurrentCycleMarket, resolveOrderPricePolicy } from '../src/market/polymarket.js';
import { placeOrder } from '../src/trader/executor.js';
import * as martingale from '../src/martingale/manager.js';
import config from '../src/config.js';

const CYCLE_MS = config.cycleMinutes * 60 * 1000;

async function main() {
  console.log('=== Dry-run cycle test (神奇九转) ===');
  console.log('DRY_RUN:', config.dryRun);
  console.log('timeframe:', config.timeframe, 'cycleMinutes:', config.cycleMinutes);

  const cycleStartTs = Math.floor(Date.now() / CYCLE_MS) * CYCLE_MS;

  martingale.init();
  strategyState.init();

  const candles = await fetchClosedCandles(config.candleLimit);
  console.log('candles:', candles.length, 'last:', candles.at(-1)?.t);

  const signalObj = await strategyState.resolveSignal(candles);
  const st = strategyState.getState();
  console.log('\n[1] Phase:', st.phase, 'locked:', st.lockedSignal);
  console.log('    Signal:', signalObj.signal, signalObj.signalId, '-', signalObj.reason);

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
      ? `capped → $${pricePolicy.maxLimitPrice}`
      : 'ok',
  );

  const mg = martingale.getState();
  const actualBet = Math.min(mg.currentBet, config.maxBetUsd);
  console.log('\n[4] Martingale bet:', actualBet, `(base $${mg.baseBet}, losses ${mg.consecutiveLosses})`);

  const orderResult = await placeOrder({
    signal: signalObj.signal,
    signalId: signalObj.signalId,
    yesTokenId: market.yesTokenId,
    noTokenId: market.noTokenId,
    conditionId: market.conditionId,
    cycleStartTs,
    actualBet,
    baseBet: mg.baseBet,
    consecutiveLosses: mg.consecutiveLosses,
    yesPrice: pricePolicy.yesPrice ?? market.yesPrice,
    noPrice: pricePolicy.noPrice ?? market.noPrice,
    maxLimitPrice: pricePolicy.maxLimitPrice,
    priceCapped: pricePolicy.priceCapped,
    originalYesPrice: pricePolicy.originalYesPrice,
  });

  console.log('\n[5] Order result:', {
    skipped: orderResult.skipped,
    skipReason: orderResult.skipReason,
    orderId: orderResult.orderId,
    usdcSpent: orderResult.usdcSpent,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
