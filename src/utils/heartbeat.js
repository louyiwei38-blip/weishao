import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scopedLogPath } from './instancePaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

/**
 * Write bot liveness snapshot for external monitoring (Uptime Kuma, cron curl, etc.).
 * @param {object} status
 */
export function writeHeartbeat(status) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    const file = scopedLogPath(LOGS_DIR, 'heartbeat.json');
    writeFileSync(
      file,
      JSON.stringify({ updatedAt: new Date().toISOString(), ...status }, null, 2),
      'utf8'
    );
  } catch {
    // heartbeat must never break the trading loop
  }
}
