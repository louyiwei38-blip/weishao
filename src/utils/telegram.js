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

/**
 * @param {string} text
 * @param {{ parseMode?: string, messageThreadId?: number|null }} [opts]
 */
async function postTelegram(text, { parseMode, messageThreadId } = {}) {
  const { botToken, chatId } = config.telegram;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;
  const threadId = messageThreadId ?? config.telegram.messageThreadId;
  if (Number.isFinite(threadId) && threadId > 0) {
    payload.message_thread_id = threadId;
  }

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
 * Routes to a forum topic when config.telegram.messageThreadId is set
 * (one group + Topics: BTC 5m / ETH 1h / …).
 *
 * @param {string} text  – message text (supports basic HTML in static parts;
 *                         use escapeHtml() for dynamic values containing & < >)
 */
export async function notifyTelegram(text) {
  const { botToken, chatId, messageThreadId } = config.telegram;
  if (!botToken || !chatId) {
    logger.debug('[telegram] 未配置 — 跳过通知');
    return;
  }

  try {
    let res = await postTelegram(text, {
      parseMode: 'HTML',
      messageThreadId,
    });

    if (!res.ok) {
      const body = await res.text();
      const threadMissing =
        Boolean(messageThreadId) &&
        (body.includes('message thread not found') ||
          body.includes('MESSAGE_THREAD_NOT_FOUND') ||
          body.includes('not a forum'));

      if (threadMissing) {
        logger.warn('[telegram] 话题无效 — 回退发到群（无 thread）', {
          messageThreadId,
          body: body.slice(0, 160),
        });
        res = await postTelegram(text, { parseMode: 'HTML', messageThreadId: null });
      } else if (res.status === 400 && body.includes("can't parse entities")) {
        logger.warn('[telegram] HTML 解析失败 — 降级为纯文本重试');
        res = await postTelegram(stripHtml(text), { messageThreadId });
      }

      if (!res.ok) {
        let retryBody = body;
        if (!res.bodyUsed) {
          retryBody = await res.text().catch(() => body);
        }
        logger.warn('[telegram] sendMessage 失败', {
          status: res.status,
          messageThreadId: messageThreadId ?? null,
          body: String(retryBody).slice(0, 200),
        });
      }
    }
  } catch (err) {
    logger.warn('[telegram] 通知发送异常', { error: err?.message });
  }
}