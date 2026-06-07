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

/** MIN_RV_* preferred; MAX_RV_* kept as legacy alias (same numeric value, inverted semantics). */
function minRvThreshold(name, legacyName) {
  if (process.env[name] !== undefined) return Number(process.env[name]);
  if (process.env[legacyName] !== undefined) return Number(process.env[legacyName]);
  return 0;
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
  orderFillAttempts: num('ORDER_FILL_ATTEMPTS', 8),
  orderRetryDelayMs: num('ORDER_RETRY_DELAY_MS', 10000),
  /** Limit order: tick offset from best ask (0 = at best ask) */
  limitPriceOffsetTicks: num('LIMIT_PRICE_OFFSET_TICKS', 0),
  /** Short poll after order post (ms) */
  fillSyncPollMs: num('FILL_SYNC_POLL_MS', 500),
  /** Max wait for fill sync after limit/market post (ms) */
  fillSyncMaxWaitMs: num('FILL_SYNC_MAX_WAIT_MS', 8000),
  gammaFetchTimeoutMs: num('GAMMA_FETCH_TIMEOUT_MS', 30_000),
  gammaFetchAttempts: num('GAMMA_FETCH_ATTEMPTS', 6),
  gammaFetchRetryDelayMs: num('GAMMA_FETCH_RETRY_DELAY_MS', 3000),
  /** Max ms for market discovery + order placement per cycle (after signal) */
  cycleTimeoutMs: num('CYCLE_TIMEOUT_MS', 90_000),
  /** Rotate signals.jsonl / trades.jsonl when file exceeds this size */
  jsonlMaxBytes: num('JSONL_MAX_BYTES', 10 * 1024 * 1024),
  dryRun: bool('DRY_RUN', false),
  logLevel: optional('LOG_LEVEL', 'INFO'),

  // Martingale
  martingaleMultiplier: num('MARTINGALE_MULTIPLIER', 2),
  martingaleMaxLosses: num('MARTINGALE_MAX_LOSSES', 4),

  // Telegram notifications
  telegram: {
    botToken: optional('TELEGRAM_BOT_TOKEN', ''),
    chatId: optional('TELEGRAM_CHAT_ID', ''),
  },

  // Risk
  skipIfYesPriceOutOfRange: bool('SKIP_IF_YES_PRICE_OUT_OF_RANGE', true),
  yesPriceMin: num('YES_PRICE_MIN', 0.05),
  yesPriceMax: num('YES_PRICE_MAX', 0.95),
  /** Finer OHLCV for realized-volatility gate (independent of signal timeframe) */
  volatilityBarTimeframe: optional('VOLATILITY_BAR_TIMEFRAME', '1m'),
  volatilityCandleLimit: num('VOLATILITY_CANDLE_LIMIT', 20),
  /** Log-return std minimum; skip when rv < threshold; 0 = disabled */
  minRv1m: minRvThreshold('MIN_RV_1M', 'MAX_RV_1M'),
  minRv5m: minRvThreshold('MIN_RV_5M', 'MAX_RV_5M'),
  minRv15m: minRvThreshold('MIN_RV_15M', 'MAX_RV_15M'),

  // Chainlink RTDS settlement (Polymarket official oracle)
  chainlink: {
    settleBufferMs: num('CHAINLINK_SETTLE_BUFFER_MS', 3000),
    settleMaxWaitMs: num('CHAINLINK_SETTLE_MAX_WAIT_MS', 15000),
    openWindowMs: num('CHAINLINK_OPEN_WINDOW_MS', 5000),
    bufferMinutes: num('CHAINLINK_BUFFER_MINUTES', 30),
    safetyIntervalMs: num('CHAINLINK_SAFETY_INTERVAL_MS', 60_000),
  },
};

export default config;
