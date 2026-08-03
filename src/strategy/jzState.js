/**
 * 神奇九转 strategy phase state (persisted).
 *
 *   idle → in_chain (on JZ_UP/JZ_DOWN) → idle (win or halt after 1 lock)
 *
 * Loss without halt → stay in_chain for same-direction 锁单 (exactly once via
 * MARTINGALE_MAX_LOSSES=2: entry loss + one lock, then halt).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import { scopedLogPath } from '../utils/instancePaths.js';
import {
  MIN_SIGNAL_CANDLES,
  evaluateMagicNineAt,
  buildJzSignal,
} from './magicNineTurns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = scopedLogPath(LOGS_DIR, 'jz-state.json');

const STATE_KEY = `${config.symbol}:${config.timeframe}`;

/** @typedef {'idle' | 'in_chain'} JzPhase */

/** @type {Record<string, { phase: JzPhase, lockedSignal: 'UP'|'DOWN'|null }>} */
let state = {};

function defaultEntry() {
  return { phase: 'idle', lockedSignal: null };
}

function loadState() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      logger.info('[jz] 状态已恢复', { state });
    } catch {
      logger.warn('[jz] 状态文件解析失败，从头开始');
      state = {};
    }
  }
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = defaultEntry();
  } else {
    const s = state[STATE_KEY];
    if (!['idle', 'in_chain'].includes(s.phase)) s.phase = 'idle';
    if (s.phase !== 'in_chain') s.lockedSignal = null;
  }
}

function persist() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function entry() {
  if (!state[STATE_KEY]) state[STATE_KEY] = defaultEntry();
  return state[STATE_KEY];
}

export function init() {
  loadState();
}

export function getState() {
  const s = entry();
  return {
    phase: s.phase,
    lockedSignal: s.lockedSignal,
    outsideSeenAt: null,
  };
}

/**
 * @param {object[]} candles
 */
export async function resolveSignal(candles) {
  const s = entry();
  const symbol = config.symbol;
  const timeframe = config.timeframe;

  if (s.phase === 'in_chain' && (s.lockedSignal === 'UP' || s.lockedSignal === 'DOWN')) {
    const last = candles?.at(-1);
    const signalObj = {
      symbol,
      timeframe,
      evaluatedAt: new Date().toISOString(),
      kMinus2: null,
      kMinus1: last
        ? { t: last.t, o: last.open, h: last.high, l: last.low, c: last.close }
        : null,
      bands: null,
      prevOutside: null,
      signal: s.lockedSignal,
      signalId: 'MG_CONT',
      reason: `九转锁单续单（同向 ${s.lockedSignal} · 仅1次）`,
      phase: s.phase,
      lockedSignal: s.lockedSignal,
      retryable: false,
      buyCount: null,
      sellCount: null,
    };
    logger.info('[jz] 锁单链路中 — 跳过新九转检测', {
      lockedSignal: s.lockedSignal,
      phase: s.phase,
    });
    return signalObj;
  }

  if (!candles || candles.length < MIN_SIGNAL_CANDLES) {
    const signalObj = buildJzSignal(candles, symbol, timeframe, {
      signal: 'NONE',
      signalId: null,
      reason: `K 线不足（需 ≥ ${MIN_SIGNAL_CANDLES}）`,
      buyCount: 0,
      sellCount: 0,
    });
    signalObj.phase = s.phase;
    signalObj.lockedSignal = null;
    signalObj.retryable = true;
    return signalObj;
  }

  const idx = candles.length - 1;
  const evaluation = evaluateMagicNineAt(candles, idx);

  if (evaluation.signal === 'UP' || evaluation.signal === 'DOWN') {
    s.phase = 'in_chain';
    s.lockedSignal = evaluation.signal;
    persist();
    logger.info('[jz] 九转完成 — 锁定方向进入链路', {
      signal: evaluation.signal,
      signalId: evaluation.signalId,
      buyCount: evaluation.buyCount,
      sellCount: evaluation.sellCount,
    });

    const signalObj = buildJzSignal(candles, symbol, timeframe, evaluation);
    signalObj.phase = s.phase;
    signalObj.lockedSignal = s.lockedSignal;
    signalObj.retryable = false;
    return signalObj;
  }

  const signalObj = buildJzSignal(candles, symbol, timeframe, evaluation);
  signalObj.phase = s.phase;
  signalObj.lockedSignal = null;
  signalObj.retryable = false;
  return signalObj;
}

/**
 * Win or max-loss halt → idle; loss continue → stay in_chain for one lock.
 * @param {boolean} won
 * @param {boolean} halted
 */
export function onSettled(won, halted) {
  const s = entry();

  if (won || halted) {
    s.phase = 'idle';
    s.lockedSignal = null;
    persist();
    logger.info('[jz] 链路结束 — 回到 idle', { won, halted });
    return;
  }

  s.phase = 'in_chain';
  persist();
  logger.info('[jz] 亏损 — 保持 in_chain 等待锁单1次', {
    lockedSignal: s.lockedSignal,
  });
}

export function abortEntryLock(reason = 'aborted') {
  const s = entry();
  if (s.phase !== 'in_chain') return false;
  const prev = s.lockedSignal;
  s.phase = 'idle';
  s.lockedSignal = null;
  persist();
  logger.warn('[jz] 已撤销入场锁定 — 回到 idle', { reason, previousLocked: prev });
  return true;
}
