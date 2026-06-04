#!/usr/bin/env node
/**
 * Generate Polymarket CLOB API credentials (key + secret + passphrase).
 * Requires POLY_PRIVATE_KEY or POLY_PRIVATE_KEY_ENCRYPTED + POLY_KEY_PASSWORD in .env
 *
 * Usage: node scripts/create-api-key.js
 */

import 'dotenv/config';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { resolvePrivateKey } from '../src/utils/secrets.js';

async function main() {
  const pk = resolvePrivateKey();
  if (!pk) {
    console.error('Error: set POLY_PRIVATE_KEY or POLY_PRIVATE_KEY_ENCRYPTED + POLY_KEY_PASSWORD');
    process.exit(1);
  }

  const { ClobClient } = await import('@polymarket/clob-client');
  const account = privateKeyToAccount(pk);
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  const client = new ClobClient('https://clob.polymarket.com', 137, signer);

  console.log('Deriving API key for', account.address, '...\n');
  const creds = await client.createOrDeriveApiKey();

  console.log('Add these to your .env:\n');
  console.log(`POLY_API_KEY=${creds.key}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
  console.log('\nDone. Keep secret and passphrase private.');
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
