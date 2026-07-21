/**
 * Poll Telegram callback_query updates; route commands to per-instance queues.
 * Only TELEGRAM_CALLBACK_LEADER (default btc-5m) calls getUpdates — Telegram allows one poller per bot token.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { answerCallbackQuery, notifyTelegram } from '../utils/telegram.js';
import { parseCallbackData } from './inlineButtons.js';
import { scopedLogPath } from '../utils/instancePaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const OFFSET_FILE = join(LOGS_DIR, 'tg-callback-offset.json');
const POLL_LOCK = join(LOGS_DIR, 'tg-callback-poll.lock');

/** @type {boolean} */
let running = false;
/** @type {Promise<void>|null} */
let loopPromise = null;

function cmdQueuePath(instanceId) {
  const safe = String(instanceId).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  return join(LOGS_DIR, `tg-cmd-${safe}.json`);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function withPollLock(fn) {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  for (let i = 0; i < 40; i += 1) {
    let fd;
    try {
      fd = openSync(POLL_LOCK, 'wx');
    } catch {
      sleepSync(30);
      continue;
    }
    try {
      return fn();
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(POLL_LOCK); } catch { /* ignore */ }
    }
  }
  return null;
}

function readOffset() {
  if (!existsSync(OFFSET_FILE)) return 0;
  try {
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8'));
    return Math.trunc(Number(raw.offset) || 0);
  } catch {
    return 0;
  }
}

function writeOffset(offset) {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(OFFSET_FILE, JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2));
}

/** @param {string} instanceId @param {object} cmd */
function enqueueCommand(instanceId, cmd) {
  const path = cmdQueuePath(instanceId);
  /** @type {object[]} */
  let queue = [];
  if (existsSync(path)) {
    try {
      queue = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(queue)) queue = [];
    } catch {
      queue = [];
    }
  }
  queue.push({ ...cmd, enqueuedAt: new Date().toISOString() });
  writeFileSync(path, JSON.stringify(queue, null, 2), 'utf8');
}

/**
 * Drain commands for this process instance.
 * @param {(cmd: object) => Promise<void>} handler
 */
export async function drainCommandQueue(handler) {
  const path = scopedLogPath(LOGS_DIR, 'tg-cmd.json');
  if (!existsSync(path)) return;
  /** @type {object[]} */
  let queue;
  try {
    queue = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(queue) || queue.length === 0) return;
  } catch {
    return;
  }
  writeFileSync(path, '[]', 'utf8');
  for (const cmd of queue) {
    try {
      await handler(cmd);
    } catch (err) {
      logger.warn('[tgCallback] command handler failed', {
        cmd,
        error: err?.message,
      });
    }
  }
}

async function fetchUpdates(offset) {
  const { botToken } = config.telegram;
  if (!botToken) return [];
  const url = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=0&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['callback_query']))}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text();
    logger.warn('[tgCallback] getUpdates failed', { status: res.status, body: body.slice(0, 200) });
    return [];
  }
  const json = await res.json();
  if (!json.ok || !Array.isArray(json.result)) return [];
  return json.result;
}

async function handleCallbackQuery(query) {
  const parsed = parseCallbackData(query.data);
  const queryId = query.id;

  if (!parsed.ok) {
    await answerCallbackQuery(queryId, parsed.reason === 'expired' ? '按钮已过期（1小时）' : '无效按钮');
    return;
  }

  const { action, instanceId } = parsed;
  const resetInstance = config.telegram.resetInstanceId;

  if (action === 'reset') {
    if (instanceId !== resetInstance) {
      await answerCallbackQuery(queryId, '重置仅 btc-5m 可用');
      return;
    }
    enqueueCommand(resetInstance, { action: 'reset', queryId, from: query.from?.username ?? null });
    await answerCallbackQuery(queryId, '已排队：重置本金/净胜负');
    return;
  }

  if (action === 'seq_up' || action === 'seq_down') {
    enqueueCommand(instanceId, {
      action,
      queryId,
      direction: action === 'seq_up' ? 'UP' : 'DOWN',
      from: query.from?.username ?? null,
    });
    await answerCallbackQuery(
      queryId,
      action === 'seq_up' ? '已启动：6周期买涨' : '已启动：6周期买跌',
    );
    return;
  }

  await answerCallbackQuery(queryId, '未知操作');
}

async function pollOnce() {
  if (!config.telegram.botToken) return;

  let offset = readOffset();
  const updates = await fetchUpdates(offset);
  if (updates.length === 0) return;

  for (const upd of updates) {
    offset = Math.max(offset, upd.update_id + 1);
    if (upd.callback_query) {
      try {
        await handleCallbackQuery(upd.callback_query);
      } catch (err) {
        logger.warn('[tgCallback] handle failed', { error: err?.message });
      }
    }
  }
  writeOffset(offset);
}

async function ensureNoWebhook() {
  const { botToken } = config.telegram;
  if (!botToken) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/deleteWebhook?drop_pending_updates=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      logger.info('[tgCallback] deleteWebhook OK — 使用 getUpdates 轮询');
    }
  } catch (err) {
    logger.warn('[tgCallback] deleteWebhook 失败', { error: err?.message });
  }
}

export function isCallbackLeader() {
  return config.instanceId === config.telegram.callbackLeaderInstanceId;
}

export function startCallbackPoller() {
  if (running) return;
  if (!config.telegram.botToken || !config.telegram.chatId) {
    logger.debug('[tgCallback] 未配置 Telegram — 跳过 callback 轮询');
    return;
  }
  const leader = config.telegram.callbackLeaderInstanceId;
  if (!isCallbackLeader()) {
    logger.info('[tgCallback] 非 callback leader — 仅消费本实例命令队列', {
      instanceId: config.instanceId,
      leader,
    });
    return;
  }
  running = true;
  loopPromise = (async () => {
    await ensureNoWebhook();
    logger.info('[tgCallback] 轮询已启动（唯一 leader）', {
      instanceId: config.instanceId,
      leader,
      pollMs: config.telegram.callbackPollMs,
    });
    while (running) {
      try {
        await pollOnce();
      } catch (err) {
        logger.warn('[tgCallback] poll error', { error: err?.message });
      }
      await sleep(config.telegram.callbackPollMs);
    }
  })();
}

export async function stopCallbackPoller() {
  running = false;
  if (loopPromise) await loopPromise;
  loopPromise = null;
}

/** @param {string} text */
export async function notifyCommandResult(text) {
  await notifyTelegram(text);
}
