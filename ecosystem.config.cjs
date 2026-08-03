/**
 * PM2 — multi-symbol × multi-timeframe from .env
 *
 * Only edit .env:
 *   TRADING_SYMBOLS=BTC,ETH
 *   CANDLE_TIMEFRAMES=5m,15m,1h
 *   STRATEGIES=vegas,jz     # 可选：同时跑维加斯+神奇九转（独立账本）
 *   PM2_NAME_PREFIX=V3          # 第二钱包同机部署时用 W2（见 ecosystem.wallet2.config.cjs）
 *
 * 模拟盘: npm run pm2:dry
 * 实盘:   npm run pm2:start
 *
 * 第二钱包（独立目录 + 新私钥）:
 *   npm run pm2:w2:dry / pm2:w2:start
 */
const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
  // dotenv optional at PM2 config load time
}

const { buildEcosystemApps } = require('./scripts/lib/buildEcosystemApps.cjs');

const { apps } = buildEcosystemApps(process.env, {
  cwd: __dirname,
  prefix: process.env.PM2_NAME_PREFIX || 'V3',
});

module.exports = { apps };
