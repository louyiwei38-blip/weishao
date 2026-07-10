/**
 * PM2 — 5m + 15m + 1h Vegas bots in parallel (same wallet / .env credentials)
 *
 * 模拟盘: npm run pm2:dry
 * 实盘:   npm run pm2:start
 * 日志:   pm2 logs
 * 停止:   npm run pm2:stop
 *
 * 这里只注入「多实例身份」相关变量。
 * TRADE_BUDGET / MARTINGALE / ORDER_TYPE / SETTLE_SOURCE / OHLCV 等一律读 .env
 *（见 src/config.js：.env override，再恢复下方 PM2 键）。
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

function app(name, tf, minutes) {
  const env = {
    BOT_INSTANCE: tf,
    CANDLE_TIMEFRAME: tf,
    MARKET_CYCLE_MINUTES: String(minutes),
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
