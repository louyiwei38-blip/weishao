import { createLogger, format, transports } from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { formatBeijingTime } from './datetime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const LEVEL = (process.env.LOG_LEVEL || 'INFO').toLowerCase();

const consoleFormat = format.combine(
  format.colorize(),
  format((info) => {
    info.timestamp = formatBeijingTime();
    return info;
  })(),
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
    // Winston built-in rotation: bot.log → bot.log.1 … bot.log.5
    new transports.File({
      filename: join(LOGS_DIR, 'bot.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

export default logger;
