'use strict';

const {
  parseTradingSymbolBases,
  parseCandleTimeframes,
  parseStrategies,
} = require('./tradingUniverse.cjs');

function sanitizePrefix(raw) {
  const p = String(raw || 'V3')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return p || 'V3';
}

function threadIdFor(instanceId, env) {
  const key = 'TELEGRAM_THREAD_' + String(instanceId).replace(/-/g, '_').toUpperCase();
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Build PM2 apps: symbols × timeframes × 神奇九转.
 * All apps share BANKROLL_SCOPE=jz (one P/N/补队列 across BTC/ETH × 5m/15m/1h).
 */
function buildEcosystemApps(env, opts) {
  const cwd = opts.cwd;
  const prefix = opts.prefix !== undefined ? opts.prefix : env.PM2_NAME_PREFIX;
  const pm2Prefix = sanitizePrefix(prefix);
  const shared = {
    script: 'src/index.js',
    cwd,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    merge_logs: true,
    time: true,
  };

  function app(base, tf, minutes) {
    const id = base.toLowerCase() + '-' + tf;
    const threadId = threadIdFor(id, env);
    const pm2Name = pm2Prefix + '-' + id;
    const instanceEnv = {
      BOT_INSTANCE: id,
      CANDLE_TIMEFRAME: tf,
      MARKET_CYCLE_MINUTES: String(minutes),
      TRADING_SYMBOL: base + '/USDT',
      STRATEGY: 'jz',
      BANKROLL_SCOPE: 'jz',
      // Entry + 1 same-direction lock, then halt
      MARTINGALE_MAX_LOSSES: '2',
    };
    if (threadId != null) instanceEnv.TELEGRAM_MESSAGE_THREAD_ID = String(threadId);
    return {
      ...shared,
      name: pm2Name,
      error_file: 'logs/pm2-' + pm2Prefix.toLowerCase() + '-' + id + '-error.log',
      out_file: 'logs/pm2-' + pm2Prefix.toLowerCase() + '-' + id + '-out.log',
      env_dry: { NODE_ENV: 'production', DRY_RUN: 'true', ...instanceEnv },
      env_live: { NODE_ENV: 'production', DRY_RUN: 'false', ...instanceEnv },
    };
  }

  const symbols = parseTradingSymbolBases(env);
  const timeframes = parseCandleTimeframes(env);
  const strategies = parseStrategies(env); // always ['jz']
  const apps = symbols.flatMap((base) =>
    timeframes.map(([tf, minutes]) => app(base, tf, minutes)),
  );
  return { apps, prefix: pm2Prefix, symbols, timeframes, strategies };
}

module.exports = { buildEcosystemApps, sanitizePrefix };
