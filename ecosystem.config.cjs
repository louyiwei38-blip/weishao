/**
 * PM2 — multi-symbol × multi-timeframe · 神奇九转 · 共用账本
 *
 * Only edit .env:
 *   TRADING_SYMBOLS=BTC,ETH
 *   CANDLE_TIMEFRAMES=5m,15m,1h
 *   PM2_NAME_PREFIX=V3          # 第二钱包同机部署时用 W2
 *
 * All apps: STRATEGY=jz, BANKROLL_SCOPE=jz (logs/bankroll-state-jz.json)
 *
 * 模拟盘: npm run pm2:dry
 * 实盘:   npm run pm2:start
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
