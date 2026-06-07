import config from '../config.js';
import logger from './logger.js';

/** Escape dynamic text for Telegram HTML parse_mode (& < > must not appear raw). */
export function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function postTelegram(text, { parseMode } = {}) {
  const { botToken, chatId } = config.telegram;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
}

function stripHtml(text) {
  return String(text).replace(/<[^>]*>/g, '');
}

/**
 * Send a message to Telegram. Non-blocking and fail-safe: never throws, so a
 * notification failure can't break the trading loop.
 *
 * @param {string} text  – message text (supports basic HTML in static parts;
 *                         use escapeHtml() for dynamic values containing & < >)
 */
export async function notifyTelegram(text) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) {
    logger.debug('[telegram] 未配置 — 跳过通知');
    return;
  }

  try {
    let res = await postTelegram(text, { parseMode: 'HTML' });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 400 && body.includes("can't parse entities")) {
        logger.warn('[telegram] HTML 解析失败 — 降级为纯文本重试');
        res = await postTelegram(stripHtml(text));
      }
      if (!res.ok) {
        const retryBody = await res.text();
        logger.warn('[telegram] sendMessage 失败', {
          status: res.status,
          body: retryBody.slice(0, 200),
        });
      }
    }
  } catch (err) {
    logger.warn('[telegram] 通知发送异常', { error: err?.message });
  }
}
