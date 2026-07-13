#!/usr/bin/env node
/**
 * Quick Telegram connectivity / topic routing test.
 *
 * Usage:
 *   node scripts/test-telegram.js
 *   node scripts/test-telegram.js --instance=btc-5m
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const instanceArg = process.argv.find((a) => a.startsWith('--instance='));
const instanceId = instanceArg ? instanceArg.slice('--instance='.length) : (process.env.BOT_INSTANCE || '');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

function resolveThreadId(id) {
  if (process.env.TELEGRAM_MESSAGE_THREAD_ID) {
    const n = Number(process.env.TELEGRAM_MESSAGE_THREAD_ID);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (!id) return null;
  const key = `TELEGRAM_THREAD_${String(id).replace(/-/g, '_').toUpperCase()}`;
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const threadId = resolveThreadId(instanceId);

console.log('hasToken :', Boolean(token));
console.log('chatId   :', chatId || '(empty)');
console.log('instance :', instanceId || '(none)');
console.log('threadId :', threadId ?? '(none — sends to group root)');

if (!token || !chatId) {
  console.error('\n[FAIL] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in .env');
  process.exit(1);
}

const payload = {
  chat_id: chatId,
  text: threadId
    ? `Telegram topic test OK — instance=${instanceId || '?'} thread=${threadId}`
    : 'Telegram test OK — no thread id (group root / General).',
  disable_web_page_preview: true,
};
if (threadId) payload.message_thread_id = threadId;

try {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  console.log('\nHTTP status:', res.status);
  console.log('Response   :', await res.text());

  if (res.ok) {
    console.log('\n[OK] Message sent. Check your Telegram topic/group.');
  } else {
    console.log('\n[FAIL] Telegram rejected the request (see response above).');
    process.exit(1);
  }
} catch (err) {
  console.error('\n[ERROR]', err?.message);
  process.exit(1);
}