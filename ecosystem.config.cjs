/**
 * PM2 进程管理配置
 * 启动: pm2 start ecosystem.config.cjs
 * 查看: pm2 logs polymarket-bot
 * 停止: pm2 stop polymarket-bot
 */
module.exports = {
  apps: [
    {
      name: 'polymarket-bot-v2',
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
      // 解密密码建议用 pm2 ecosystem 或服务器环境变量注入，勿提交 git
      // env: { POLY_KEY_PASSWORD: 'your-password' },
      env: {
        NODE_ENV: 'production',
        DRY_RUN: 'false',
      },
      env_dry: {
        NODE_ENV: 'production',
        DRY_RUN: 'true',
      },
    },
  ],
};
