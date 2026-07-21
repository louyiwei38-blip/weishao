import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolvePrivateKey } from './utils/secrets.js';
import { defaultSignalDelayMs } from './utils/fastPath.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

/**
 * PM2 会先注入 process.env；dotenv 默认不覆盖已有键，导致 .env 形同虚设。
 * 策略：用 .env 覆盖全部键，再恢复「多实例身份」相关键（由 ecosystem 控制）。
 */
const PM2_OWNED_KEYS = [
  'BOT_INSTANCE',
  'CANDLE_TIMEFRAME',
  'MARKET_CYCLE_MINUTES',
  'TRADING_SYMBOL',
  'DRY_RUN',
  'NODE_ENV',
  /** Per-instance Telegram forum topic (injected by ecosystem from TELEGRAM_THREAD_*). */
  'TELEGRAM_MESSAGE_THREAD_ID',
];

const pm2Owned = {};
for (const key of PM2_OWNED_KEYS) {
  if (process.env[key] !== undefined) pm2Owned[key] = process.env[key];
}

if (existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
} else {
  dotenv.config({ override: true });
}

Object.assign(process.env, pm2Owned);

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

const timeframe = optional('CANDLE_TIMEFRAME', '5m');
const derivedCycleMinutes = timeframeToMinutes(timeframe) ?? 5;

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
  /** Override CCXT symbol; empty → swap from TRADING_SYMBOL */
  ohlcvSymbol: optional('OHLCV_SYMBOL', ''),

  binance: {
    apiKey: optional('BINANCE_API_KEY', ''),
    secret: optional('BINANCE_SECRET', ''),
  },

  // Polymarket / Chainlink slug (not the OHLCV fetch symbol when OHLCV_MARKET_TYPE=swap)
  // PM2 multi-symbol: set TRADING_SYMBOLS=BTC,ETH in .env; ecosystem injects TRADING_SYMBOL per process
  symbol: optional('TRADING_SYMBOL', 'BTC/USDT'),
  /**
   * Bases for PM2 universe (informational). Live process uses `symbol` only.
   * Parsed from TRADING_SYMBOLS, else TRADING_SYMBOL.
   */
  tradingSymbolBases: (() => {
    const multi = optional('TRADING_SYMBOLS', '');
    const raw = multi && String(multi).trim()
      ? multi
      : optional('TRADING_SYMBOL', 'BTC/USDT');
    const bases = [];
    const seen = new Set();
    for (const tok of String(raw).split(/[,;\s]+/)) {
      const t = tok.trim();
      if (!t) continue;
      const base = (t.includes('/') ? t.split('/')[0] : t)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      if (!base || seen.has(base)) continue;
      seen.add(base);
      bases.push(base);
    }
    return bases.length ? bases : ['BTC'];
  })(),
  /** Timeframes for PM2 universe (informational). Live process uses `timeframe`. */
  candleTimeframes: (() => {
    // Default: single timeframe (project runs one symbol × one TF)
    const raw = optional('CANDLE_TIMEFRAMES', '5m');
    const allowed = new Set(['1m', '5m', '15m', '30m', '1h', '4h']);
    const out = [];
    const seen = new Set();
    for (const tok of String(raw).split(/[,;\s]+/)) {
      const tf = tok.trim().toLowerCase();
      if (!allowed.has(tf) || seen.has(tf)) continue;
      seen.add(tf);
      out.push(tf);
    }
    return out.length ? out : ['5m'];
  })(),
  timeframe,
  candleLimit: num('CANDLE_FETCH_LIMIT', 200),
  /** New-signal delay after UTC boundary; timeframe-aware default (5m→3s, 15m→4s, 1h→5s). */
  signalDelayMs: num('SIGNAL_DELAY_MS', defaultSignalDelayMs(timeframe)),
  /** in_chain MG_CONT: short delay (no candle/EMA needed). Fallback when settle fast-path misses. */
  inChainSignalDelayMs: num('IN_CHAIN_SIGNAL_DELAY_MS', 100),
  /** Prefetch Gamma/CLOB/balance this many ms before the next boundary. */
  prewarmMs: num('PREWARM_MS', 5000),
  /** After Chainlink/OKX loss (< max losses): place next-cycle order immediately. */
  mgContFastPath: bool('MG_CONT_FAST_PATH', true),
  /** Skip order if fewer than this many ms remain in the cycle window. */
  minTradeRemainingMs: num('MIN_TRADE_REMAINING_MS', 15_000),
  /** New-signal path: retry interval when candle stale / EMA not aligned. */
  signalDataRetryMs: num('SIGNAL_DATA_RETRY_MS', 800),
  /** New-signal path: max wait for fresh candle + aligned EMA (still within cycle). */
  signalDataMaxWaitMs: num('SIGNAL_DATA_MAX_WAIT_MS', 60_000),

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
  /** Default stake when bankroll is on/ahead of target line */
  tradeBudgetUsd: num('TRADE_BUDGET_USD', 10),
  maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 10000),
  minBalanceUsd: num('MIN_BALANCE_USD', 0),
  maxBetUsd: num('MAX_BET_USD', 30),
  /**
   * Shared dynamic bankroll (P/N + catch-up queue).
   * Catch-up: play front layer L with win profit T = L + step; stake = T×p/(1−p).
   * See src/martingale/bankroll.js
   */
  bankroll: {
    /** Equity step per net win (also used in target = P + N * step) */
    stepUsd: num('BANKROLL_STEP_USD', 10),
    /** Hard cap on catch-up target profit T = layer + step */
    catchUpProfitCapUsd: num('BANKROLL_CATCHUP_T_CAP', 20),
    /** Cap on computed stake per order */
    stakeMaxUsd: num('BANKROLL_STAKE_MAX_USD', 30),
  },
  orderType: optional('ORDER_TYPE', 'GTC'),
  orderFillAttempts: num('ORDER_FILL_ATTEMPTS', 8),
  /** FOK retry gap — keep short so failed eats retry quickly inside the window. */
  orderRetryDelayMs: num('ORDER_RETRY_DELAY_MS', 1000),
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
  martingaleMultiplier: num('MARTINGALE_MULTIPLIER', 1),
  martingaleMaxLosses: num('MARTINGALE_MAX_LOSSES', 5),

  // Telegram notifications (one forum group + per-instance topic thread)
  telegram: {
    botToken: optional('TELEGRAM_BOT_TOKEN', ''),
    chatId: optional('TELEGRAM_CHAT_ID', ''),
    /**
     * Forum topic thread id. Resolution order:
     * 1) TELEGRAM_MESSAGE_THREAD_ID (PM2 per-process, from ecosystem)
     * 2) TELEGRAM_THREAD_{INSTANCE} e.g. TELEGRAM_THREAD_BTC_5M for BOT_INSTANCE=btc-5m
     */
    messageThreadId: (() => {
      const rawInstance = optional('BOT_INSTANCE', timeframe);
      const instanceId = String(rawInstance).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
      const pick = (raw) => {
        if (raw === undefined || String(raw).trim() === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      const fromPm2 = pick(process.env.TELEGRAM_MESSAGE_THREAD_ID);
      if (fromPm2 != null) return fromPm2;
      const key = `TELEGRAM_THREAD_${instanceId.replace(/-/g, '_').toUpperCase()}`;
      return pick(process.env[key]);
    })(),
    /** Poll interval for callback_query (all PM2 processes share offset via lock). */
    callbackPollMs: num('TELEGRAM_CALLBACK_POLL_MS', 2000),
    /** Inline button validity window (callback_data expiry). */
    buttonValidityMs: num('TELEGRAM_BUTTON_VALIDITY_MS', 3_600_000),
    /** Only this BOT_INSTANCE may execute bankroll reset from TG button. */
    resetInstanceId: (() => {
      const raw = optional('TELEGRAM_RESET_INSTANCE', 'btc-5m');
      return String(raw).replace(/[^a-zA-Z0-9_-]/g, '') || 'btc-5m';
    })(),
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
  settleSource: optional('SETTLE_SOURCE', 'chainlink').toLowerCase(),

  // Chainlink RTDS settlement (Polymarket official oracle)
  chainlink: {
    settleBufferMs: num('CHAINLINK_SETTLE_BUFFER_MS', 1500),
    settleMaxWaitMs: num('CHAINLINK_SETTLE_MAX_WAIT_MS', 15000),
    openWindowMs: num('CHAINLINK_OPEN_WINDOW_MS', 5000),
    bufferMinutes: num('CHAINLINK_BUFFER_MINUTES', 30),
    safetyIntervalMs: num('CHAINLINK_SAFETY_INTERVAL_MS', 60_000),
  },
};

export default config;
