/**
 * PM2 — 5m + 15m + 1h Vegas bots in parallel (same wallet / .env credentials)
 *
 * 模拟盘: npm run pm2:dry
 * 实盘:   npm run pm2:start
 * 日志:   pm2 logs
 * 停止:   npm run pm2:stop
 */
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

const martingale = {
  TRADE_BUDGET_USD: '3',
  MARTINGALE_MULTIPLIER: '3',
  MARTINGALE_MAX_LOSSES: '5',
  OHLCV_EXCHANGE: 'okx',
  OHLCV_MARKET_TYPE: 'swap',
  ORDER_TYPE: 'GTC',
  // 不要在此写 SETTLE_SOURCE：PM2 env 会盖住 .env（dotenv 不覆盖已有变量）
  // 结算请在 .env 设 SETTLE_SOURCE=chainlink|okx；未设时代码默认 chainlink
  CANDLE_FETCH_LIMIT: '200',
};

function app(name, tf, minutes) {
  const env = {
    BOT_INSTANCE: tf,
    CANDLE_TIMEFRAME: tf,
    MARKET_CYCLE_MINUTES: String(minutes),
    ...martingale,
  };
  return {
    ...shared,
    name,
    error_file: `logs/pm2-${tf}-error.log`,
    out_file: `logs/pm2-${tf}-out.log`,
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

module.exports = {
  apps: [
    app('V3-5m', '5m', 5),
    app('V3-15m', '15m', 15),
    app('V3-1h', '1h', 60),
  ],
};
