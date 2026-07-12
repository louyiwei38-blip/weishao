/**
 * One-shot: load pending-bet for an instance and attempt settlement.
 *
 * Usage:
 *   node scripts/force-settle-pending.js --instance=xrp-5m
 *   node scripts/force-settle-pending.js --instance=xrp-5m --symbol=XRP/USDT
 *   node scripts/force-settle-pending.js --instance=xrp-5m --clear   # void pending without settling
 */
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const instanceArg = args.find((a) => a.startsWith('--instance='));
const symbolArg = args.find((a) => a.startsWith('--symbol='));
const clearOnly = args.includes('--clear');

if (!instanceArg) {
  console.error('Usage: node scripts/force-settle-pending.js --instance=xrp-5m [--symbol=XRP/USDT] [--clear]');
  process.exit(1);
}

const instance = instanceArg.split('=')[1];
const symbol = symbolArg ? symbolArg.split('=').slice(1).join('=') : null;

process.env.BOT_INSTANCE = instance;
if (symbol) process.env.TRADING_SYMBOL = symbol;

const tfMatch = instance.match(/(\d+[mh])$/i);
if (tfMatch) {
  const tf = tfMatch[1].toLowerCase();
  process.env.CANDLE_TIMEFRAME = tf;
  process.env.MARKET_CYCLE_MINUTES = tf.endsWith('h')
    ? String(Number(tf.replace('h', '')) * 60)
    : tf.replace('m', '');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, '..', 'logs');
const pendingPath = join(logsDir, `pending-bet-${instance}.json`);

if (!existsSync(pendingPath)) {
  console.log(`No pending file: ${pendingPath}`);
  process.exit(0);
}

const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
console.log('Pending bet:', JSON.stringify(pending, null, 2));

if (clearOnly) {
  rmSync(pendingPath);
  console.log('Cleared pending (martingale/stats NOT updated).');
  process.exit(0);
}

const { computeSettlement } = await import('../src/trader/chainlinkSettle.js');
const { fetchClosedCandles } = await import('../src/collector/binance.js');
const { formatBeijingTime } = await import('../src/utils/datetime.js');
import config from '../src/config.js';

const candles = await fetchClosedCandles(50);
const result = await computeSettlement(pending, { candles });

console.log('Settlement result:', JSON.stringify(result, null, 2));
console.log('Window:', formatBeijingTime(pending.cycleStartTs));
console.log('Settle source config:', config.settleSource);

if (!result.ready) {
  console.error('\nSettlement not ready — restart bot after deploying latest code, or use --clear if order never filled.');
  process.exit(1);
}

console.log('\nSettlement is ready. Restart the bot (pm2 restart) to apply martingale/stats via normal flow,');
console.log('or delete pending manually if you only need to unblock new orders:');
console.log(`  rm ${pendingPath}`);
