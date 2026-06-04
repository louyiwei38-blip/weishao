import logger from './logger.js';

/**
 * Retry an async function with exponential backoff.
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number, label?: string }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000, label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn(`[retry] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`, {
        error: err?.message,
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
