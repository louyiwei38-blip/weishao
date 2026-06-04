import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolvePrivateKey } from './utils/secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name, defaultValue) {
  return process.env[name] ?? defaultValue;
}

function num(name, defaultValue) {
  const v = process.env[name];
  return v !== undefined ? Number(v) : defaultValue;
}

function bool(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v.toLowerCase() === 'true';
}

const config = {
  // Polymarket
  poly: {
    address: optional('POLY_ADDRESS', ''),
    funderAddress: optional('POLY_FUNDER_ADDRESS', ''), // Polymarket proxy wallet (auto-detected if empty)
    privateKey: resolvePrivateKey(),
    apiKey: optional('POLY_API_KEY', ''),
    apiSecret: optional('POLY_API_SECRET', ''),
    passphrase: optional('POLY_PASSPHRASE', ''),
    builderCode: optional('POLY_BUILDER_CODE', ''),
    clobHost: 'https://clob.polymarket.com',
    gammaApi: 'https://gamma-api.polymarket.com',
    chainId: 137,
  },

  // OHLCV data source (binance | okx | bybit). If primary fails, auto-fallback.
  ohlcvExchange: optional('OHLCV_EXCHANGE', 'okx'),

  binance: {
    apiKey: optional('BINANCE_API_KEY', ''),
    secret: optional('BINANCE_SECRET', ''),
  },

  // Strategy
  symbol: optional('TRADING_SYMBOL', 'BTC/USDT'),
  timeframe: optional('CANDLE_TIMEFRAME', '5m'),
  candleLimit: num('CANDLE_FETCH_LIMIT', 5),
  signalDelayMs: num('SIGNAL_DELAY_MS', 10000),

  // Bot
  cycleMinutes: num('MARKET_CYCLE_MINUTES', 5),
  tradeBudgetUsd: num('TRADE_BUDGET_USD', 1),
  maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 50),
  minBalanceUsd: num('MIN_BALANCE_USD', 20),
  maxBetUsd: num('MAX_BET_USD', 200),
  orderType: optional('ORDER_TYPE', 'FOK'),
  dryRun: bool('DRY_RUN', false),
  logLevel: optional('LOG_LEVEL', 'INFO'),

  // Martingale
  martingaleMultiplier: num('MARTINGALE_MULTIPLIER', 2),
  martingaleMaxLosses: num('MARTINGALE_MAX_LOSSES', 4),

  // Risk
  skipIfYesPriceOutOfRange: bool('SKIP_IF_YES_PRICE_OUT_OF_RANGE', true),
  yesPriceMin: num('YES_PRICE_MIN', 0.05),
  yesPriceMax: num('YES_PRICE_MAX', 0.95),
};

export default config;
