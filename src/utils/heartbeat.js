import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const HEARTBEAT_FILE = join(LOGS_DIR, 'heartbeat.json');

/**
 * Write bot liveness snapshot for external monitoring (Uptime Kuma, cron curl, etc.).
 * @param {object} status
 */
export function writeHeartbeat(status) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(
      HEARTBEAT_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), ...status }, null, 2),
      'utf8'
    );
  } catch {
    // heartbeat must never break the trading loop
  }
}
