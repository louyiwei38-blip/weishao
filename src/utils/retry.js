import logger from './logger.js';

/**
 * Retry an async function with exponential backoff.
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number, label?: string }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, {
  maxAttempts = 3,
  baseDelayMs = 1000,
  label = 'op',
  deadlineMs,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deadlineMs && Date.now() >= deadlineMs) {
      throw new Error(`${label}: cycle deadline exceeded`);
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn(`[retry] ${label} 失败（第 ${attempt}/${maxAttempts} 次），${delay}ms 后重试`, {
        error: err?.message,
      });
      if (deadlineMs) {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) throw new Error(`${label}: cycle deadline exceeded`);
        await sleep(Math.min(delay, remaining));
      } else {
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
