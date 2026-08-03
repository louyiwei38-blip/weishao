/**
 * Cross-platform instance launcher.
 * Usage:
 *   node scripts/run-instance.js 15m
 *   node scripts/run-instance.js 5m --dry
 *   node scripts/run-instance.js 1h --dry --symbol=ETH/USDT
 *   node scripts/run-instance.js 5m --symbol=ETH/USDT --strategy=jz
 */
const tf = process.argv[2];
if (!tf || !/^\d+[mh]$/.test(tf)) {
  console.error(
    'Usage: node scripts/run-instance.js <5m|15m|1h> [--dry] [--symbol=ETH/USDT] [--strategy=vegas|jz]',
  );
  process.exit(1);
}

const cycleMinutes = tf.endsWith('h')
  ? String(Number(tf.replace('h', '')) * 60)
  : tf.replace('m', '');

const symbolArg = process.argv.find((a) => a.startsWith('--symbol='));
const symbol = symbolArg ? symbolArg.split('=').slice(1).join('=') : null;
const base = (symbol || process.env.TRADING_SYMBOL || 'BTC/USDT').split('/')[0].toLowerCase();

const strategyArg = process.argv.find((a) => a.startsWith('--strategy='));
const strategy = String(
  strategyArg ? strategyArg.split('=').slice(1).join('=') : process.env.STRATEGY || 'vegas',
)
  .trim()
  .toLowerCase();
if (strategy !== 'vegas' && strategy !== 'jz') {
  console.error('Invalid --strategy (use vegas or jz)');
  process.exit(1);
}

if (symbol) {
  process.env.TRADING_SYMBOL = symbol;
}

const suffix = strategy === 'jz' ? '-jz' : '';
process.env.STRATEGY = strategy;
process.env.BANKROLL_SCOPE = strategy === 'jz' ? 'jz' : 'vegas';
process.env.BOT_INSTANCE = process.env.BOT_INSTANCE || `${base}-${tf}${suffix}`;
process.env.CANDLE_TIMEFRAME = process.env.CANDLE_TIMEFRAME || tf;
process.env.MARKET_CYCLE_MINUTES = process.env.MARKET_CYCLE_MINUTES || cycleMinutes;
process.env.CANDLE_FETCH_LIMIT = process.env.CANDLE_FETCH_LIMIT || '200';

if (strategy === 'jz') {
  // Entry + 1 same-direction lock, then halt
  process.env.MARTINGALE_MAX_LOSSES = process.env.MARTINGALE_MAX_LOSSES || '2';
}

if (process.argv.includes('--dry')) {
  process.env.DRY_RUN = 'true';
}

await import('../src/index.js');
