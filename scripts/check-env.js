#!/usr/bin/env node
/** Check which .env vars are set (no secret values printed). */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

console.log('.env path:', envPath);
console.log('.env exists:', existsSync(envPath));
loadEnv({ path: envPath });

const checks = [
  'POLY_ADDRESS',
  'POLY_API_KEY',
  'POLY_API_SECRET',
  'POLY_PASSPHRASE',
  'POLY_PRIVATE_KEY_ENCRYPTED',
  'POLY_KEY_PASSWORD',
  'POLY_PRIVATE_KEY',
  'OHLCV_EXCHANGE',
  'DRY_RUN',
];

for (const name of checks) {
  const v = process.env[name]?.trim();
  const ok = !!v && v !== '0x...';
  console.log(`${ok ? 'OK' : 'MISSING'}  ${name}${ok ? ` (${v.length} chars)` : ''}`);
}
