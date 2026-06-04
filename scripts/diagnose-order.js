#!/usr/bin/env node
/**
 * Diagnose why orders are rejected (HTTP 400) on Polymarket.
 *
 * It picks the CURRENT 5m market, prints the order book / best price for the
 * token we would buy, then attempts a real market order and dumps the FULL
 * raw API response (including the `error` field) so we can see the exact reason.
 *
 * Usage (on the server):
 *   POLY_KEY_PASSWORD='...' node scripts/diagnose-order.js [UP|DOWN] [amountUsd]
 */

import 'dotenv/config';
import config from '../src/config.js';
import { findCurrentCycleMarket } from '../src/market/polymarket.js';
import { getClobClient } from '../src/trader/executor.js';
import { OrderType, Side } from '@polymarket/clob-client-v2';

const CYCLE_MS = config.cycleMinutes * 60 * 1000;

async function main() {
  const signal = (process.argv[2] || 'DOWN').toUpperCase(); // UP -> Up token, DOWN -> Down token
  const amount = Number(process.argv[3] || config.tradeBudgetUsd || 2);

  const cycleStartTs = Math.floor(Date.now() / CYCLE_MS) * CYCLE_MS;
  console.log('=== Order diagnosis ===');
  console.log('cycleStartTs:', new Date(cycleStartTs).toISOString());
  console.log('signal:', signal, 'amount:', amount, 'dryRun:', config.dryRun);

  const market = await findCurrentCycleMarket(cycleStartTs);
  if (!market) {
    console.error('No current market found for this window.');
    process.exit(1);
  }
  const tokenID = signal === 'UP' ? market.yesTokenId : market.noTokenId;
  console.log('\nMarket:', market.slug);
  console.log('conditionId:', market.conditionId);
  console.log('tokenID:', tokenID);
  console.log('upPrice (yes):', market.yesPrice);

  const client = await getClobClient();

  // ── Inspect tick size / negRisk / order book ──
  try {
    const tickSize = await client.getTickSize(tokenID);
    console.log('\ntickSize:', tickSize);
  } catch (e) { console.log('tickSize err:', e.message); }

  try {
    const negRisk = await client.getNegRisk(tokenID);
    console.log('negRisk:', negRisk);
  } catch (e) { console.log('negRisk err:', e.message); }

  try {
    const book = await client.getOrderBook(tokenID);
    console.log('\norder book best asks (what a BUY hits):');
    console.log(JSON.stringify(book?.asks?.slice(-5) ?? book?.asks, null, 2));
    console.log('order book best bids:');
    console.log(JSON.stringify(book?.bids?.slice(-5) ?? book?.bids, null, 2));
  } catch (e) { console.log('order book err:', e.message); }

  try {
    const price = await client.getPrice(tokenID, 'BUY');
    console.log('\ngetPrice(BUY):', JSON.stringify(price));
  } catch (e) { console.log('getPrice err:', e.message); }

  if (config.dryRun) {
    console.log('\nDRY_RUN=true → not sending a real order. Set DRY_RUN=false to test placement.');
    return;
  }

  // ── Attempt the real order and dump the full raw response ──
  const tickSize = await client.getTickSize(tokenID).catch(() => undefined);
  const negRisk = await client.getNegRisk(tokenID).catch(() => false);

  console.log('\n--- placing FOK market order ---');
  try {
    const resp = await client.createAndPostMarketOrder(
      { tokenID, amount, side: Side.BUY },
      { tickSize, negRisk },
      OrderType.FOK
    );
    console.log('RAW RESPONSE:\n', JSON.stringify(resp, null, 2));
  } catch (e) {
    console.log('THREW:', e.message);
    if (e.data) console.log('e.data:', JSON.stringify(e.data, null, 2));
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message, e.stack);
  process.exit(1);
});
