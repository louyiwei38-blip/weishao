/**
 * PM2 — multi-symbol × multi-timeframe from .env
 *
 * Only edit .env:
 *   TRADING_SYMBOLS=BTC,ETH
 *   CANDLE_TIMEFRAMES=5m,15m,1h
 *
 * 模拟盘: npm run pm2:dry
 * 实盘:   npm run pm2:start
 *
 * Identity vars are injected per process; budget/bankroll/martingale/order
 * settings always come from .env (see src/config.js).
 */
const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
  // dotenv optional at PM2 config load time
}

const {
  parseTradingSymbolBases,
  parseCandleTimeframes,
} = require('./scripts/lib/tradingUniverse.cjs');

const shared = {
  script: 'src/index.js',
  cwd: __dirname,
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '500M',
  merge_logs: true,
  time: true,
};

/** BOT_INSTANCE id → TELEGRAM_THREAD_BTC_5M env key */
function threadIdFor(instanceId) {
  const key = `TELEGRAM_THREAD_${String(instanceId).replace(/-/g, '_').toUpperCase()}`;
  const raw = process.env[key];
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @param {string} base @param {string} tf @param {number} minutes */
function app(base, tf, minutes) {
  const id = `${base.toLowerCase()}-${tf}`;
  const threadId = threadIdFor(id);
  const env = {
    BOT_INSTANCE: id,
    CANDLE_TIMEFRAME: tf,
    MARKET_CYCLE_MINUTES: String(minutes),
    TRADING_SYMBOL: `${base}/USDT`,
    ...(threadId != null ? { TELEGRAM_MESSAGE_THREAD_ID: String(threadId) } : {}),
  };
  return {
    ...shared,
    name: `V3-${id}`,
    error_file: `logs/pm2-${id}-error.log`,
    out_file: `logs/pm2-${id}-out.log`,
    env_dry: {
      NODE_ENV: 'production',
      DRY_RUN: 'true',
      ...env,
    },
    env_live: {
      NODE_ENV: 'production',
      DRY_RUN: 'false',
      ...env,
    },
  };
}

const SYMBOLS = parseTradingSymbolBases(process.env);
const TIMEFRAMES = parseCandleTimeframes(process.env);

module.exports = {
  apps: SYMBOLS.flatMap((base) =>
    TIMEFRAMES.map(([tf, minutes]) => app(base, tf, minutes)),
  ),
};