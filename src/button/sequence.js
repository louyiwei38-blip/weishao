/**
 * Per-instance Telegram button sequence (6-cycle UP/DOWN).
 * Shared bankroll sizing; separate chain P&L display.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import { scopedLogPath } from '../utils/instancePaths.js';
import { formatPnlUsd } from '../stats/manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = scopedLogPath(LOGS_DIR, 'button-sequence.json');

const CYCLES_TOTAL = 6;

/** @type {{
 *   active: boolean,
 *   direction: 'UP'|'DOWN'|null,
 *   cyclesTotal: number,
 *   cyclesElapsed: number,
 *   pendingStart: boolean,
 *   chainPnlUsd: number,
 *   wins: number,
 *   losses: number,
 *   startedAt: string|null,
 *   updatedAt: string|null,
 * }} */
let cache = defaultState();

function defaultState() {
  return {
    active: false,
    direction: null,
    cyclesTotal: CYCLES_TOTAL,
    cyclesElapsed: 0,
    pendingStart: false,
    chainPnlUsd: 0,
    wins: 0,
    losses: 0,
    startedAt: null,
    updatedAt: null,
  };
}

function readDisk() {
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const direction = raw.direction === 'UP' || raw.direction === 'DOWN' ? raw.direction : null;
    return {
      active: Boolean(raw.active),
      direction,
      cyclesTotal: CYCLES_TOTAL,
      cyclesElapsed: Math.max(0, Math.trunc(Number(raw.cyclesElapsed) || 0)),
      pendingStart: Boolean(raw.pendingStart),
      chainPnlUsd: Number(raw.chainPnlUsd) || 0,
      wins: Math.max(0, Math.trunc(Number(raw.wins) || 0)),
      losses: Math.max(0, Math.trunc(Number(raw.losses) || 0)),
      startedAt: raw.startedAt ?? null,
      updatedAt: raw.updatedAt ?? null,
    };
  } catch {
    logger.warn('[buttonSeq] state parse failed — reset');
    return defaultState();
  }
}

function writeDisk(state) {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const payload = {
    ...state,
    cyclesTotal: CYCLES_TOTAL,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  cache = payload;
}

function reload() {
  cache = readDisk();
  return cache;
}

export function init() {
  reload();
  logger.info('[buttonSeq] loaded', { state: cache, file: STATE_FILE });
}

export function getState() {
  reload();
  return { ...cache };
}

export function isActive() {
  const s = getState();
  return s.active && s.cyclesElapsed < s.cyclesTotal;
}

export function remainingCycles() {
  const s = getState();
  return Math.max(0, s.cyclesTotal - s.cyclesElapsed);
}

/**
 * Start or overwrite a 6-cycle sequence. First slot opens on next cycle boundary.
 * @param {'UP'|'DOWN'} direction
 */
export function startSequence(direction) {
  if (direction !== 'UP' && direction !== 'DOWN') {
    throw new Error(`invalid button direction: ${direction}`);
  }
  cache = {
    active: true,
    direction,
    cyclesTotal: CYCLES_TOTAL,
    cyclesElapsed: 0,
    pendingStart: true,
    chainPnlUsd: 0,
    wins: 0,
    losses: 0,
    startedAt: new Date().toISOString(),
    updatedAt: null,
  };
  writeDisk(cache);
  logger.info('[buttonSeq] sequence started (overwrite)', {
    direction,
    instanceId: config.instanceId,
  });
  return getState();
}

/**
 * Consume one cycle slot (bet, merge, or reverse skip).
 * @param {{ kind?: 'bet'|'skip'|'merge' }} [opts]
 * @returns {{ consumed: boolean } & ReturnType<typeof getState>}
 */
export function consumeSlot(opts = {}) {
  reload();
  if (!cache.active) {
    logger.info('[buttonSeq] slot skipped — sequence inactive', {
      kind: opts.kind ?? null,
      cyclesElapsed: cache.cyclesElapsed,
    });
    return { consumed: false, ...getState() };
  }
  cache.pendingStart = false;
  cache.cyclesElapsed += 1;
  if (cache.cyclesElapsed >= cache.cyclesTotal) {
    cache.active = false;
    logger.info('[buttonSeq] sequence completed', {
      direction: cache.direction,
      cyclesElapsed: cache.cyclesElapsed,
      chainPnlUsd: cache.chainPnlUsd,
      wins: cache.wins,
      losses: cache.losses,
      lastKind: opts.kind ?? null,
    });
  } else {
    logger.debug('[buttonSeq] slot consumed', {
      kind: opts.kind ?? null,
      cyclesElapsed: cache.cyclesElapsed,
      remaining: cache.cyclesTotal - cache.cyclesElapsed,
    });
  }
  writeDisk(cache);
  return { consumed: true, ...getState() };
}

/** @param {boolean} won @param {number} pnlUsd */
export function onSettled(won, pnlUsd = 0) {
  reload();
  cache.chainPnlUsd = (Number(cache.chainPnlUsd) || 0) + (Number(pnlUsd) || 0);
  if (won) cache.wins += 1;
  else cache.losses += 1;
  writeDisk(cache);
  logger.info('[buttonSeq] settled', {
    won,
    pnlUsd,
    chainPnlUsd: cache.chainPnlUsd,
    wins: cache.wins,
    losses: cache.losses,
    cyclesElapsed: cache.cyclesElapsed,
    active: cache.active,
  });
  return getState();
}

export function clearPendingStart() {
  reload();
  if (!cache.pendingStart) return getState();
  cache.pendingStart = false;
  writeDisk(cache);
  return getState();
}

export function formatTelegramLines() {
  const s = getState();
  if (!s.active && s.cyclesElapsed === 0 && !s.startedAt) return '';
  const dir = s.direction === 'UP' ? '买涨' : s.direction === 'DOWN' ? '买跌' : '—';
  const rem = Math.max(0, s.cyclesTotal - s.cyclesElapsed);
  const status = s.active
    ? (s.pendingStart ? '待下周期首注' : `剩余 ${rem}/${s.cyclesTotal} 周期`)
    : '已结束';
  return (
    `🔘 按钮链路: <b>${dir}</b> · ${status} · 本链 <b>${formatPnlUsd(s.chainPnlUsd)}</b>` +
    ` (${s.wins}胜${s.losses}负)\n`
  );
}

export function buildButtonSignal(direction, reason) {
  return {
    symbol: config.symbol,
    timeframe: config.timeframe,
    evaluatedAt: new Date().toISOString(),
    signal: direction,
    signalId: direction === 'UP' ? 'BTN_UP' : 'BTN_DOWN',
    reason: reason || `按钮序列 — 连续买${direction === 'UP' ? '涨' : '跌'}`,
    phase: 'button_seq',
    lockedSignal: direction,
    kMinus2: null,
    kMinus1: null,
    bands: null,
    prevOutside: null,
  };
}

/** @returns {boolean} */
export function shouldButtonSeqFastPath() {
  const s = getState();
  return s.active && s.cyclesElapsed < s.cyclesTotal && !s.pendingStart;
}

export function resetStateFile() {
  cache = defaultState();
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
}
