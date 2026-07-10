/**
 * Cross-platform instance launcher.
 * Usage:
 *   node scripts/run-instance.js 15m
 *   node scripts/run-instance.js 5m --dry
 *   node scripts/run-instance.js 1h --dry --symbol=ETH/USDT
 */
const tf = process.argv[2];
if (!tf || !/^\d+[mh]$/.test(tf)) {
  console.error('Usage: node scripts/run-instance.js <5m|15m|1h> [--dry] [--symbol=ETH/USDT]');
  process.exit(1);
}

const cycleMinutes = tf.endsWith('h')
  ? String(Number(tf.replace('h', '')) * 60)
  : tf.replace('m', '');

const symbolArg = process.argv.find((a) => a.startsWith('--symbol='));
const symbol = symbolArg ? symbolArg.split('=').slice(1).join('=') : null;
const base = (symbol || process.env.TRADING_SYMBOL || 'BTC/USDT').split('/')[0].toLowerCase();

if (symbol) {
  process.env.TRADING_SYMBOL = symbol;
}

process.env.BOT_INSTANCE = process.env.BOT_INSTANCE || `${base}-${tf}`;
process.env.CANDLE_TIMEFRAME = process.env.CANDLE_TIMEFRAME || tf;
process.env.MARKET_CYCLE_MINUTES = process.env.MARKET_CYCLE_MINUTES || cycleMinutes;
process.env.CANDLE_FETCH_LIMIT = process.env.CANDLE_FETCH_LIMIT || '200';

if (process.argv.includes('--dry')) {
  process.env.DRY_RUN = 'true';
}

await import('../src/index.js');
