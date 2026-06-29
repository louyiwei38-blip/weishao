/**
 * PM2 进程管理配置
 * 模拟盘: pm2 start ecosystem.config.cjs --env dry
 * 实盘:   pm2 start ecosystem.config.cjs --env live
 * 查看:   pm2 logs V3
 */
module.exports = {
  apps: [
    {
      name: 'V3',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
      env_dry: {
        NODE_ENV: 'production',
        DRY_RUN: 'true',
        OHLCV_EXCHANGE: 'okx',
        OHLCV_MARKET_TYPE: 'swap',
        ORDER_TYPE: 'GTC',
        SETTLE_SOURCE: 'okx',
        SESSION_GATE_ENABLED: 'true',
        ACTIVITY_PROBE_USDT_MIN: '30000000',
        ACTIVITY_MIN_HITS: '11',
        ACTIVITY_TIER_BETS: '3,3,3,3,3,3,3,3,6,9,15,24',
        MIN_OPEN_TIERS: '8,9,10,11,12',
        TRADE_BUDGET_USD: '3',
      },
      env_live: {
        NODE_ENV: 'production',
        DRY_RUN: 'false',
        OHLCV_EXCHANGE: 'okx',
        OHLCV_MARKET_TYPE: 'swap',
        ORDER_TYPE: 'GTC',
        SETTLE_SOURCE: 'okx',
        SESSION_GATE_ENABLED: 'true',
        ACTIVITY_PROBE_USDT_MIN: '30000000',
        ACTIVITY_MIN_HITS: '11',
        ACTIVITY_TIER_BETS: '3,3,3,3,3,3,3,3,6,9,15,24',
        MIN_OPEN_TIERS: '8,9,10,11,12',
        TRADE_BUDGET_USD: '3',
      },
    },
  ],
};
