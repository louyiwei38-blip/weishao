import config from '../config.js';
import logger from './logger.js';

/**
 * Send a message to Telegram. Non-blocking and fail-safe: never throws, so a
 * notification failure can't break the trading loop.
 *
 * @param {string} text  – message text (supports basic HTML)
 */
export async function notifyTelegram(text) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) {
    logger.debug('[telegram] not configured — skipping notification');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn('[telegram] sendMessage failed', { status: res.status, body: body.slice(0, 200) });
    }
  } catch (err) {
    logger.warn('[telegram] notification error', { error: err?.message });
  }
}
