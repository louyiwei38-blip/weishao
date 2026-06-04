import { createLogger, format, transports } from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const LEVEL = (process.env.LOG_LEVEL || 'INFO').toLowerCase();

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${message}${extra}`;
  })
);

const fileFormat = format.combine(
  format.timestamp(),
  format.json()
);

const logger = createLogger({
  level: LEVEL,
  transports: [
    new transports.Console({ format: consoleFormat }),
    new transports.File({
      filename: join(LOGS_DIR, 'bot.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

export default logger;
