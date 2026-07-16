const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {}

process.env.PM2_NAME_PREFIX = process.env.PM2_NAME_PREFIX || 'W2';

const { buildEcosystemApps } = require('./scripts/lib/buildEcosystemApps.cjs');

const { apps } = buildEcosystemApps(process.env, {
  cwd: __dirname,
  prefix: process.env.PM2_NAME_PREFIX,
});

module.exports = { apps };