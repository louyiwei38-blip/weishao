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

const dryRun = process.env.DRY_RUN?.toLowerCase() !== 'false';

function status(name) {
  const v = process.env[name]?.trim();
  const ok = !!v && v !== '0x...';
  console.log(`${ok ? 'OK' : 'MISSING'}  ${name}${ok ? ` (${v.length} chars)` : ''}`);
}

console.log(`\nMode: ${dryRun ? 'DRY_RUN' : 'LIVE'}\n`);

const hasPlain = !!(process.env.POLY_PRIVATE_KEY?.trim() && process.env.POLY_PRIVATE_KEY !== '0x...');
const hasEnc = !!process.env.POLY_PRIVATE_KEY_ENCRYPTED?.trim();
const hasPwd = !!process.env.POLY_KEY_PASSWORD?.trim();
const hasPk = hasPlain || (hasEnc && hasPwd);

const hasApi = ['POLY_API_KEY', 'POLY_API_SECRET', 'POLY_PASSPHRASE']
  .every((n) => !!process.env[n]?.trim());

console.log('--- Private key ---');
console.log(`${hasPlain ? 'OK' : '—'}  POLY_PRIVATE_KEY (plaintext)`);
console.log(`${hasEnc && hasPwd ? 'OK' : hasEnc ? 'PARTIAL' : '—'}  POLY_PRIVATE_KEY_ENCRYPTED + POLY_KEY_PASSWORD`);

if (!dryRun) {
  console.log(`\n${hasPk ? 'OK' : 'MISSING'}  private key required for LIVE`);
} else {
  console.log('\nDRY_RUN: private key optional (needs network for OHLCV + Chainlink)');
}

console.log('\n--- L2 API creds (optional) ---');
console.log(`${hasApi ? 'OK' : '—'}  POLY_API_KEY + SECRET + PASSPHRASE`);
console.log('    If missing: auto createOrDeriveApiKey() when private key is set');

console.log('\n--- Recommended ---');
status('OHLCV_EXCHANGE');

console.log('\nDocs: docs/ARCHITECTURE.md');
