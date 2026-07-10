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

/** Parse timeframe like 5m / 15m / 1h → minutes. */
function timeframeToMinutes(tf) {
  const m = String(tf || '').trim().match(/^(\d+)(m|h)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === 'h' ? n * 60 : n;
}

const timeframe = optional('CANDLE_TIMEFRAME', '1h');
const derivedCycleMinutes = timeframeToMinutes(timeframe) ?? 60;

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

  // OHLCV — strategy signals only (Polymarket slug still uses TRADING_SYMBOL)
  ohlcvExchange: optional('OHLCV_EXCHANGE', 'okx'),
  /** spot | swap — default swap → OKX BTC/USDT:USDT 永续 */
  ohlcvMarketType: optional('OHLCV_MARKET_TYPE', 'swap'),
  /** Override CCXT symbol; empty → swap: BTC/USDT:USDT from TRADING_SYMBOL */
  ohlcvSymbol: optional('OHLCV_SYMBOL', ''),

  binance: {
    apiKey: optional('BINANCE_API_KEY', ''),
    secret: optional('BINANCE_SECRET', ''),
  },

  // Polymarket / Chainlink slug (not the OHLCV fetch symbol when OHLCV_MARKET_TYPE=swap)
  symbol: optional('TRADING_SYMBOL', 'BTC/USDT'),
  timeframe,
  candleLimit: num('CANDLE_FETCH_LIMIT', 200),
  signalDelayMs: num('SIGNAL_DELAY_MS', 10000),

  /**
   * Isolates pending-bet / heartbeat / stats / daily-loss when multiple
   * timeframe bots share one wallet & logs dir. Defaults to CANDLE_TIMEFRAME.
   */
  instanceId: (() => {
    const raw = optional('BOT_INSTANCE', timeframe);
    return String(raw).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  })(),

  // Bot — MARKET_CYCLE_MINUTES defaults from CANDLE_TIMEFRAME (5m→5, 1h→60)
  cycleMinutes: num('MARKET_CYCLE_MINUTES', derivedCycleMinutes),
  tradeBudgetUsd: num('TRADE_BUDGET_USD', 3),
  maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 10000),
  minBalanceUsd: num('MIN_BALANCE_USD', 0),
  maxBetUsd: num('MAX_BET_USD', 10000),
  orderType: optional('ORDER_TYPE', 'GTC'),
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
  martingaleMultiplier: num('MARTINGALE_MULTIPLIER', 3),
  martingaleMaxLosses: num('MARTINGALE_MAX_LOSSES', 5),

  // Telegram notifications
  telegram: {
    botToken: optional('TELEGRAM_BOT_TOKEN', ''),
    chatId: optional('TELEGRAM_CHAT_ID', ''),
  },

  // Risk — symmetric cap for YES/NO limit orders; 0 = no cap
  orderPriceCap: (() => {
    if (process.env.ORDER_PRICE_CAP !== undefined) return Number(process.env.ORDER_PRICE_CAP);
    if (process.env.YES_PRICE_MAX !== undefined) return Number(process.env.YES_PRICE_MAX);
    return 0.95;
  })(),
  /** Session gate config kept for offline backtest scripts; live bot does not use it. */
  sessionGate: {
    enabled: bool('SESSION_GATE_ENABLED', true),
    /** bars fetched for bar-volume evaluation (≥ activityWindowBars when dynamic gate on) */
    candleLimit: num('SESSION_CANDLE_LIMIT', 12),
    eventWindowEnabled: bool('EVENT_WINDOW_ENABLED', false),
    eventWindowHours: num('EVENT_WINDOW_HOURS', 1),
    /** Fixed US session window in Beijing time (NY trading days only) */
    usMarketOpenEnabled: bool('US_MARKET_OPEN_ENABLED', false),
    usMarketWindowStartBj: optional('US_MARKET_WINDOW_START_BJ', '19:30'),
    usMarketWindowEndBj: optional('US_MARKET_WINDOW_END_BJ', '23:59'),
    /** Fixed burst trigger when dynamicThresholdEnabled=false; also fallback threshold */
    barVolumeUsdtMin: num('BAR_VOLUME_USDT_MIN', 25_000_000),
    /** Burst gate duration after trigger; re-trigger refreshes from now (no stack) */
    volumeBurstMinutes: num('VOLUME_BURST_MINUTES', 21),
    /** Dynamic burst trigger: freq of probe hits over activityWindowBars → thresh min..max */
    dynamicThresholdEnabled: bool('DYNAMIC_THRESHOLD_ENABLED', true),
    activityWindowBars: num('ACTIVITY_WINDOW_BARS', 12),
    activityProbeUsdtMin: num('ACTIVITY_PROBE_USDT_MIN', 30_000_000),
    /** Min probe-line hits in activity window to allow new orders (Plan A: 11 of 12) */
    activityMinHits: num('ACTIVITY_MIN_HITS', 11),
    barVolumeUsdtMinDynamic: num('BAR_VOLUME_USDT_MIN_DYNAMIC', 20_000_000),
    barVolumeUsdtMaxDynamic: num('BAR_VOLUME_USDT_MAX_DYNAMIC', 37_000_000),
    /** @deprecated legacy compress/volume gate — unused in production gate v2 */
    volCompressLookback: num('VOL_COMPRESS_LOOKBACK', 96),
    volCompressPercentile: num('VOL_COMPRESS_PERCENTILE', 0.40),
    volCompressMinBars: num('VOL_COMPRESS_MIN_BARS', 12),
    volPeriodRatioMin: num('VOL_PERIOD_RATIO_MIN', 1.1),
    volSpikeMult: num('VOL_SPIKE_MULT', 1.3),
    volSpikeLookback: num('VOL_SPIKE_LOOKBACK', 12),
    volMomentumMult: num('VOL_MOMENTUM_MULT', 1.1),
    sessionObservationBars: num('SESSION_OBSERVATION_BARS', 24),
    atrPeriod: num('SESSION_ATR_PERIOD', 14),
    bigMoveConfirmBars: num('BIG_MOVE_CONFIRM_BARS', 2),
    bigMoveEndBars: num('BIG_MOVE_END_BARS', 3),
  },

  /** Settlement source: okx (OKX 永续 K 线) | chainlink (Polymarket RTDS oracle) */
  settleSource: optional('SETTLE_SOURCE', 'okx').toLowerCase(),

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
