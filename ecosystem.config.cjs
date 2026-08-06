/**
 * PM2 — multi-stream · 神奇九转 · 共用账本
 *
 * Only edit .env:
 *   TRADING_STREAMS=btc-5m,btc-15m,btc-1h,eth-5m,eth-15m,eth-1h,bnb-15m,bnb-1h,xrp-15m,xrp-1h,sol-15m,sol-1h
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
