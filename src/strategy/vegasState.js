/**
 * Vegas strategy phase state machine (persisted).
 *
 *   need_outside → armed → in_chain → need_outside (win or max-loss halt)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';
import { scopedLogPath } from '../utils/instancePaths.js';
import {
  buildSignal,
  vegasBands,
  evaluateVegasEntryAt,
  bodyOutsideAt,
  EMA_SLOW,
} from './vegasChannel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = scopedLogPath(LOGS_DIR, 'vegas-state.json');

const STATE_KEY = `${config.symbol}:${config.timeframe}`;

/** @typedef {'need_outside' | 'armed' | 'in_chain'} VegasPhase */

/** @type {Record<string, {
 *   phase: VegasPhase,
 *   lockedSignal: 'UP' | 'DOWN' | null,
 *   outsideSeenAt: number | null,
 * }>} */
let state = {};

function defaultEntry() {
  return {
    phase: 'need_outside',
    lockedSignal: null,
    outsideSeenAt: null,
  };
}

function loadState() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      logger.info('[vegas] 状态已恢复', { state });
    } catch {
      logger.warn('[vegas] 状态文件解析失败，从头开始');
      state = {};
    }
  }
  if (!state[STATE_KEY]) {
    state[STATE_KEY] = defaultEntry();
  } else {
    const s = state[STATE_KEY];
    if (!['need_outside', 'armed', 'in_chain'].includes(s.phase)) {
      s.phase = 'need_outside';
    }
    if (s.phase !== 'in_chain') {
      s.lockedSignal = null;
    }
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
    outsideSeenAt: s.outsideSeenAt,
  };
}

/**
 * Resolve this cycle's trade signal from phase + candles.
 * @param {object[]} candles
 * @returns {object} signal object (buildSignal shape) + phase meta
 */
export function resolveSignal(candles) {
  const s = entry();
  const symbol = config.symbol;
  const timeframe = config.timeframe;
  const iCurr = candles?.length ? candles.length - 1 : -1;

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
      reason: `马丁同向续单（锁定 ${s.lockedSignal}）`,
      phase: s.phase,
      lockedSignal: s.lockedSignal,
    };
    logger.info('[vegas] 链路中 — 跳过新信号检测', {
      lockedSignal: s.lockedSignal,
      phase: s.phase,
    });
    return signalObj;
  }

  if (!candles || candles.length < EMA_SLOW + 1 || iCurr < 1) {
    const signalObj = buildSignal(candles, symbol, timeframe, {
      signal: 'NONE',
      signalId: null,
      reason: `K 线不足（需 ≥ ${EMA_SLOW + 1}）`,
      bands: null,
      prevOutside: null,
      kMinus2: null,
      kMinus1: null,
    });
    signalObj.phase = s.phase;
    signalObj.lockedSignal = null;
    return signalObj;
  }

  // Single EMA pass per cycle
  const bands = vegasBands(candles);

  if (s.phase === 'need_outside') {
    const check = bodyOutsideAt(candles, bands, iCurr);
    if (check.outside) {
      s.phase = 'armed';
      s.outsideSeenAt = check.candle?.t ?? null;
      s.lockedSignal = null;
      persist();
      logger.info('[vegas] 已见通道外实体 — 进入 armed', {
        side: check.side,
        outsideSeenAt: s.outsideSeenAt,
        upper: check.bands?.upper,
        lower: check.bands?.lower,
      });
      // Fall through to armed evaluation in the same cycle
    } else {
      const signalObj = buildSignal(candles, symbol, timeframe, {
        signal: 'NONE',
        signalId: null,
        reason: '等待至少一根 K 线实体完全在维加斯通道外',
        bands: check.bands,
        prevOutside: null,
        kMinus2: candles.at(-2) ?? null,
        kMinus1: candles.at(-1) ?? null,
      });
      signalObj.phase = s.phase;
      signalObj.lockedSignal = null;
      return signalObj;
    }
  }

  // armed (or just armed this cycle)
  const evaluation = evaluateVegasEntryAt(candles, bands, iCurr);
  if (evaluation.signal === 'UP' || evaluation.signal === 'DOWN') {
    s.phase = 'in_chain';
    s.lockedSignal = evaluation.signal;
    persist();
    logger.info('[vegas] 穿越入场 — 锁定方向进入链路', {
      signal: evaluation.signal,
      signalId: evaluation.signalId,
      reason: evaluation.reason,
    });

    const signalObj = buildSignal(candles, symbol, timeframe, evaluation);
    signalObj.phase = s.phase;
    signalObj.lockedSignal = s.lockedSignal;
    return signalObj;
  }

  if (s.phase !== 'armed') {
    s.phase = 'armed';
    persist();
  }

  const signalObj = buildSignal(candles, symbol, timeframe, evaluation);
  signalObj.phase = s.phase;
  signalObj.lockedSignal = null;
  return signalObj;
}

/**
 * After settlement: win or max-loss halt → need_outside; loss continue → stay in_chain.
 * @param {boolean} won
 * @param {boolean} halted
 */
export function onSettled(won, halted) {
  const s = entry();

  if (won || halted) {
    s.phase = 'need_outside';
    s.lockedSignal = null;
    persist();
    logger.info('[vegas] 链路结束 — 回到 need_outside', {
      won,
      halted,
    });
    return;
  }

  if (s.phase !== 'in_chain' || !s.lockedSignal) {
    logger.warn('[vegas] 结算亏损但状态非 in_chain — 强制保持/恢复链路', {
      phase: s.phase,
      lockedSignal: s.lockedSignal,
    });
  }
  s.phase = 'in_chain';
  persist();
}
