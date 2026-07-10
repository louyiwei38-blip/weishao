/**
 * Per-bot instance log file names so 5m / 15m / 1h can run in parallel.
 */
import { join } from 'path';
import config from '../config.js';

/** @param {string} baseName e.g. pending-bet.json → pending-bet-15m.json */
export function scopedLogName(baseName) {
  const id = config.instanceId;
  if (!id) return baseName;
  const dot = baseName.lastIndexOf('.');
  if (dot < 0) return `${baseName}-${id}`;
  return `${baseName.slice(0, dot)}-${id}${baseName.slice(dot)}`;
}

/** @param {string} logsDir @param {string} baseName */
export function scopedLogPath(logsDir, baseName) {
  return join(logsDir, scopedLogName(baseName));
}
