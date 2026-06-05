#!/usr/bin/env node
/**
 * Quick Telegram connectivity test.
 *
 * Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from .env and sends one message,
 * printing the raw Telegram API response so misconfig is obvious.
 *
 * Usage:  node scripts/test-telegram.js
 */
import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log('hasToken :', Boolean(token));
console.log('chatId   :', chatId || '(empty)');

if (!token || !chatId) {
  console.error('\n[FAIL] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in .env');
  process.exit(1);
}

try {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: 'Telegram test OK - bot can reach this chat.',
    }),
    signal: AbortSignal.timeout(10_000),
  });

  console.log('\nHTTP status:', res.status);
  console.log('Response   :', await res.text());

  if (res.ok) {
    console.log('\n[OK] Message sent. Check your Telegram.');
  } else {
    console.log('\n[FAIL] Telegram rejected the request (see response above).');
  }
} catch (err) {
  console.error('\n[ERROR]', err?.message);
  process.exit(1);
}
