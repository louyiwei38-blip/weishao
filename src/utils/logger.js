import { createLogger, format, transports } from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { formatBeijingTime } from './datetime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const LEVEL = (process.env.LOG_LEVEL || 'INFO').toLowerCase();
const INSTANCE = (process.env.BOT_INSTANCE || process.env.CANDLE_TIMEFRAME || '')
  .replace(/[^a-zA-Z0-9_-]/g, '');

const consoleFormat = format.combine(
  format.colorize(),
  format((info) => {
    info.timestamp = formatBeijingTime();
    return info;
  })(),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const tag = INSTANCE ? `[${INSTANCE}] ` : '';
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${tag}${message}${extra}`;
  })
);

const fileFormat = format.combine(
  format.timestamp(),
  format.json()
);

const logFile = INSTANCE
  ? join(LOGS_DIR, `bot-${INSTANCE}.log`)
  : join(LOGS_DIR, 'bot.log');

const logger = createLogger({
  level: LEVEL,
  transports: [
    new transports.Console({ format: consoleFormat }),
    new transports.File({
      filename: logFile,
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

export default logger;
