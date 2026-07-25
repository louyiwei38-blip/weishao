/**
 * PM2 — manual order tracker (phone + desktop sync on port 8787)
 * npm run pm2:manual:start
 */
module.exports = {
  apps: [{
    name: 'manual-tracker',
    cwd: __dirname,
    script: 'scripts/manual-tracker-server.js',
    interpreter: 'node',
    autorestart: true,
    max_restarts: 20,
    env: {
      NODE_ENV: 'production',
      MANUAL_TRACKER_PORT: process.env.MANUAL_TRACKER_PORT || '8787',
    },
  }],
};