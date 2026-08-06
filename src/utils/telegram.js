import config from '../config.js';
import logger from './logger.js';
import { sleep } from './retry.js';
import { buildInlineKeyboard } from '../telegram/inlineButtons.js';

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
 * @param {{ parseMode?: string, messageThreadId?: number|null, replyMarkup?: object|null }} [opts]
 */
async function postTelegram(text, { parseMode, messageThreadId, replyMarkup } = {}) {
  const { botToken, chatId } = config.telegram;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const threadId = messageThreadId === undefined
    ? config.telegram.messageThreadId
    : messageThreadId;
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

function parseRetryAfterSec(status, bodyText) {
  if (status !== 429) return null;
  try {
    const j = JSON.parse(bodyText);
    const n = Number(j?.parameters?.retry_after ?? j?.retry_after);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 30);
  } catch {
    // ignore
  }
  const m = String(bodyText).match(/retry after (\d+)/i);
  if (m) return Math.min(Number(m[1]), 30);
  return 3;
}

/**
 * Send a message to Telegram. Non-blocking and fail-safe: never throws.
 * Retries on HTTP 429 using Telegram's retry_after (multi-instance startups).
 *
 * @param {string} text
 * @param {{ replyMarkup?: object|null, withButtons?: boolean }} [opts]
 */
export async function notifyTelegram(text, opts = {}) {
  const { botToken, chatId, messageThreadId } = config.telegram;
  if (!botToken || !chatId) {
    logger.debug('[telegram] 未配置 — 跳过通知');
    return;
  }

  let replyMarkup = opts.replyMarkup ?? null;
  if (opts.withButtons !== false && !replyMarkup) {
    try {
      replyMarkup = buildInlineKeyboard();
    } catch (err) {
      logger.warn('[telegram] inline buttons unavailable', { error: err?.message });
    }
  }
  if (!replyMarkup?.inline_keyboard?.length) {
    replyMarkup = null;
  }

  const maxAttempts = 4;
  let threadId = messageThreadId;
  let parseMode = 'HTML';
  let payloadText = text;
  let markup = replyMarkup;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await postTelegram(payloadText, {
        parseMode,
        messageThreadId: threadId,
        replyMarkup: markup,
      });

      if (res.ok) {
        if (attempt > 1) {
          logger.info('[telegram] 重试后发送成功', {
            attempt,
            messageThreadId: threadId ?? null,
          });
        }
        return;
      }

      const body = await res.text();
      const retryAfter = parseRetryAfterSec(res.status, body);

      if (retryAfter != null && attempt < maxAttempts) {
        logger.warn('[telegram] 限流 — 等待后重试', {
          attempt,
          retryAfterSec: retryAfter,
          messageThreadId: threadId ?? null,
        });
        await sleep(retryAfter * 1000 + 200);
        continue;
      }

      const threadMissing =
        Boolean(threadId) &&
        (body.includes('message thread not found') ||
          body.includes('MESSAGE_THREAD_NOT_FOUND') ||
          body.includes('not a forum'));

      if (threadMissing && attempt < maxAttempts) {
        logger.warn('[telegram] 话题无效 — 回退发到群（无 thread）', {
          messageThreadId: threadId,
          body: body.slice(0, 160),
        });
        threadId = null;
        continue;
      }

      if (
        parseMode === 'HTML' &&
        res.status === 400 &&
        body.includes("can't parse entities") &&
        attempt < maxAttempts
      ) {
        logger.warn('[telegram] HTML 解析失败 — 降级为纯文本重试');
        parseMode = undefined;
        payloadText = stripHtml(text);
        continue;
      }

      if (
        res.status === 400 &&
        markup &&
        (body.includes('BUTTON_DATA_INVALID') ||
          body.includes('reply markup') ||
          body.includes('REPLY_MARKUP'))
      ) {
        logger.warn('[telegram] inline 按钮无效 — 降级为无按钮重试', {
          body: body.slice(0, 200),
        });
        markup = null;
        continue;
      }

      logger.warn('[telegram] sendMessage 失败', {
        status: res.status,
        attempt,
        messageThreadId: threadId ?? null,
        body: body.slice(0, 200),
      });
      return;
    }
  } catch (err) {
    logger.warn('[telegram] 通知发送异常', { error: err?.message });
  }
}

/**
 * Acknowledge an inline button press (toast in Telegram client).
 * @param {string} callbackQueryId
 * @param {string} [text]
 */
export async function answerCallbackQuery(callbackQueryId, text = '') {
  const { botToken } = config.telegram;
  if (!botToken || !callbackQueryId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    const payload = { callback_query_id: callbackQueryId };
    if (text) payload.text = text.slice(0, 200);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn('[telegram] answerCallbackQuery failed', {
        status: res.status,
        body: body.slice(0, 160),
      });
    }
  } catch (err) {
    logger.warn('[telegram] answerCallbackQuery error', { error: err?.message });
  }
}