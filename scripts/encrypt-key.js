#!/usr/bin/env node
/**
 * One-time tool: encrypt wallet private key for server deployment.
 *
 * Usage:
 *   node scripts/encrypt-key.js
 *   node scripts/encrypt-key.js --key 0xabc... --password "your-strong-password"
 *
 * Output: POLY_PRIVATE_KEY_ENCRYPTED=...  (paste into server .env)
 *         Remove POLY_PRIVATE_KEY from .env after migration.
 *         Set POLY_KEY_PASSWORD on server (systemd/docker env, not git).
 */

import { createInterface } from 'readline';
import { encryptSecret } from '../src/utils/secrets.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let key = '';
  let password = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) key = args[++i];
    if (args[i] === '--password' && args[i + 1]) password = args[++i];
  }
  return { key, password };
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('=== Polymarket Bot — Private Key Encryptor ===\n');

  let { key, password } = parseArgs();

  if (!key) {
    key = await promptHidden('Enter private key (0x...): ');
  }
  if (!key.startsWith('0x')) {
    key = key.startsWith('0x') ? key : `0x${key}`;
  }

  if (!password) {
    password = await promptHidden('Enter encryption password (>1 char): ');
    const confirm = await promptHidden('Confirm password: ');
    if (password !== confirm) {
      console.error('\nError: passwords do not match.');
      process.exit(1);
    }
  }

  const encrypted = encryptSecret(key, password);

  console.log('\n--- Copy the following into your server .env ---\n');
  console.log('# Delete or comment out POLY_PRIVATE_KEY after migration');
  console.log(`POLY_PRIVATE_KEY_ENCRYPTED=${encrypted}`);
  console.log('\n--- Set decryption password on server (do NOT commit to git) ---\n');
  console.log('# Option A: export before start');
  console.log('#   export POLY_KEY_PASSWORD="your-strong-password"');
  console.log('# Option B: systemd Environment=POLY_KEY_PASSWORD=...');
  console.log('# Option C: add to .env on server only, chmod 600 .env\n');
  console.log('Done. Plaintext private key was NOT saved to disk by this script.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
