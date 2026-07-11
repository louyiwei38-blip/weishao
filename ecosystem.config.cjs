/**
 * PM2 — BTC + ETH × (5m + 15m + 1h) 六实例并行（同一钱包 / .env 凭证）
 *
 * 模拟盘: npm run pm2:dry
 * 实盘:   npm run pm2:start
 * 单标的: npm run pm2:btc:start / pm2:eth:start
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

/** @param {'BTC'|'ETH'} base @param {'5m'|'15m'|'1h'} tf @param {number} minutes */
function app(base, tf, minutes) {
  const id = `${base.toLowerCase()}-${tf}`;
  const env = {
    BOT_INSTANCE: id,
    CANDLE_TIMEFRAME: tf,
    MARKET_CYCLE_MINUTES: String(minutes),
    TRADING_SYMBOL: `${base}/USDT`,
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

const TIMEFRAMES = [
  ['5m', 5],
  ['15m', 15],
  ['1h', 60],
];

const SYMBOLS = ['BTC', 'ETH'];

module.exports = {
  apps: SYMBOLS.flatMap((base) =>
    TIMEFRAMES.map(([tf, minutes]) => app(base, tf, minutes)),
  ),
};
