import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../config.js';
import {
  computePeriodVolRatio,
  PERIOD_LONG_BARS,
} from '../utils/volumeFilter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', '..', 'logs', 'session-state.json');

const SESSION_STATES = ['IDLE', 'ACTIVE', 'RUNNING_BIG_MOVE'];

function round(n, digits = 6) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function sg() {
  return config.sessionGate;
}

/** @param {Array<{ high: number, low: number, close: number, open?: number, volume?: number }>} candles */
export function computeAtr(candles, idx, period = sg().atrPeriod) {
  if (!Array.isArray(candles) || idx < period) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    sum += tr;
  }
  return sum / period;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

function avgVolume(candles, startIdx, endIdx) {
  if (startIdx < 0 || endIdx >= candles.length || startIdx > endIdx) return null;
  let sum = 0;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const v = Number(candles[i]?.volume);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / (endIdx - startIdx + 1);
}

/** Realized vol (log-return stdev) on 5m closes — RV leg of compression check. */
export function computeRvPct(candles, idx, period = sg().atrPeriod) {
  if (!Array.isArray(candles) || idx < period) return null;
  const returns = [];
  for (let i = idx - period + 1; i <= idx; i += 1) {
    const prev = Number(candles[i - 1]?.close);
    const cur = Number(candles[i]?.close);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) return null;
    returns.push(Math.log(cur / prev));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Element 1 — RV/ATR compression on 5m bars.
 * pass: current ATR% and RV at/below lookback percentile AND consecutive low bars ≥ minBars.
 */
export function evaluateVolCompression(candles5m, idx) {
  const { volCompressLookback, volCompressPercentile, volCompressMinBars, atrPeriod } = sg();
  const thresholds = {
    lookback: volCompressLookback,
    percentile: volCompressPercentile,
    minBars: volCompressMinBars,
    atrPeriod,
  };

  if (!Array.isArray(candles5m) || idx < volCompressLookback - 1 || idx < atrPeriod) {
    return { pass: false, detail: '样本不足', thresholds, metrics: null };
  }

  const series = [];
  for (let i = idx - volCompressLookback + 1; i <= idx; i += 1) {
    const atrVal = computeAtr(candles5m, i, atrPeriod);
    const rvVal = computeRvPct(candles5m, i, atrPeriod);
    const close = Number(candles5m[i]?.close);
    if (atrVal == null || rvVal == null || !Number.isFinite(close) || close <= 0) {
      return { pass: false, detail: 'RV/ATR 样本不足', thresholds, metrics: null };
    }
    series.push({ i, atrPct: atrVal / close, rvPct: rvVal });
  }

  const atrValues = series.map((s) => s.atrPct);
  const rvValues = series.map((s) => s.rvPct);
  const atrThreshold = percentile(atrValues, volCompressPercentile);
  const rvThreshold = percentile(rvValues, volCompressPercentile);
  const current = series.at(-1);

  const isLow = (s) => s.atrPct <= atrThreshold && s.rvPct <= rvThreshold;

  let consecutiveLow = 0;
  for (let j = series.length - 1; j >= 0; j -= 1) {
    if (isLow(series[j])) consecutiveLow += 1;
    else break;
  }

  const pass = isLow(current) && consecutiveLow >= volCompressMinBars;
  return {
    pass,
    detail: pass
      ? `ATR%=${round(current.atrPct, 6)} RV=${round(current.rvPct, 6)} ≤ 分位阈值, 连续 ${consecutiveLow} 根偏低`
      : `ATR%=${round(current.atrPct, 6)}/${round(atrThreshold, 6)} RV=${round(current.rvPct, 6)}/${round(rvThreshold, 6)} 连续 ${consecutiveLow}/${volCompressMinBars}`,
    thresholds,
    metrics: {
      atrPct: round(current.atrPct, 6),
      rvPct: round(current.rvPct, 6),
      atrThreshold: round(atrThreshold, 6),
      rvThreshold: round(rvThreshold, 6),
      consecutiveLow,
    },
  };
}

/**
 * Element 2 — volume anomaly (any one sub-condition).
 */
export function evaluateVolumeAnomaly(candles5m, idx) {
  const {
    volPeriodRatioMin,
    volSpikeMult,
    volSpikeLookback,
    volMomentumMult,
  } = sg();
  const thresholds = {
    periodRatioMin: volPeriodRatioMin,
    spikeMult: volSpikeMult,
    spikeLookback: volSpikeLookback,
    momentumMult: volMomentumMult,
  };

  if (!Array.isArray(candles5m) || idx < PERIOD_LONG_BARS - 1) {
    return { pass: false, detail: '样本不足', thresholds, metrics: null };
  }

  const periodVolRatio = computePeriodVolRatio(candles5m, idx);
  const ratioPass = periodVolRatio != null && periodVolRatio > volPeriodRatioMin;

  let spikePass = false;
  let spikeRatio = null;
  if (idx >= volSpikeLookback && idx >= 1) {
    const pastAvg = avgVolume(candles5m, idx - volSpikeLookback, idx - 1);
    const v0 = Number(candles5m[idx]?.volume);
    const v1 = Number(candles5m[idx - 1]?.volume);
    if (pastAvg != null && pastAvg > 0 && Number.isFinite(v0) && Number.isFinite(v1)) {
      const r0 = v0 / pastAvg;
      const r1 = v1 / pastAvg;
      spikeRatio = Math.max(r0, r1);
      spikePass = v0 > pastAvg * volSpikeMult || v1 > pastAvg * volSpikeMult;
    }
  }

  let momentumPass = false;
  let momentumRatio = null;
  if (idx >= 7) {
    const recent2Avg = avgVolume(candles5m, idx - 1, idx);
    const prev6Avg = avgVolume(candles5m, idx - 7, idx - 2);
    if (recent2Avg != null && prev6Avg != null && prev6Avg > 0) {
      momentumRatio = recent2Avg / prev6Avg;
      momentumPass = momentumRatio > volMomentumMult;
    }
  }

  const pass = ratioPass || spikePass || momentumPass;
  const hits = [
    ratioPass ? `periodVolRatio=${periodVolRatio}` : null,
    spikePass ? `spike=${round(spikeRatio, 4)}×` : null,
    momentumPass ? `momentum=${round(momentumRatio, 4)}×` : null,
  ].filter(Boolean);

  return {
    pass,
    detail: pass ? hits.join(', ') : '无量能异动',
    thresholds,
    metrics: {
      periodVolRatio,
      spikeRatio: round(spikeRatio, 4),
      momentumRatio: round(momentumRatio, 4),
    },
  };
}

/**
 * Element 3 — optional event window (log only, never vetoes).
 */
export function evaluateEventWindow(nowMs = Date.now()) {
  const { eventWindowEnabled, eventWindowHours } = sg();
  if (!eventWindowEnabled) {
    return { pass: false, enabled: false, detail: '未启用，不参与否决' };
  }

  const events = loadEventCalendar();
  const windowMs = eventWindowHours * 60 * 60 * 1000;
  const nearby = events.filter((e) => Math.abs(e.ts - nowMs) <= windowMs);

  if (nearby.length === 0) {
    return {
      pass: false,
      enabled: true,
      detail: `±${eventWindowHours}h 内无日历事件`,
    };
  }

  const label = nearby.map((e) => e.label).join('; ');
  return {
    pass: true,
    enabled: true,
    detail: `催化临近: ${label}`,
    events: nearby.map((e) => ({ label: e.label, ts: e.ts })),
  };
}

function loadEventCalendar() {
  const path = join(__dirname, '..', '..', 'config', 'event-calendar.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => ({
        label: String(e.label ?? e.name ?? 'event'),
        ts: Date.parse(e.ts ?? e.time ?? ''),
      }))
      .filter((e) => Number.isFinite(e.ts));
  } catch {
    return [];
  }
}

/** Compression releasing: recent ATR%/RV rising vs compression baseline. */
export function detectRelease(candles5m, idx, compressMetrics) {
  if (!compressMetrics?.atrThreshold || idx < sg().atrPeriod + 3) {
    return { hasRelease: false, detail: '无释放迹象' };
  }

  const atrNow = computeAtr(candles5m, idx, sg().atrPeriod);
  const atr3 = computeAtr(candles5m, idx - 3, sg().atrPeriod);
  const rvNow = computeRvPct(candles5m, idx, sg().atrPeriod);
  const close = Number(candles5m[idx]?.close);
  if (atrNow == null || atr3 == null || rvNow == null || !Number.isFinite(close) || close <= 0) {
    return { hasRelease: false, detail: '无释放迹象' };
  }

  const pctNow = atrNow / close;
  const pct3 = atr3 / close;
  const atrThreshold = compressMetrics.atrThreshold;
  const rvThreshold = compressMetrics.rvThreshold;
  const expanding = pctNow > pct3 * 1.02;
  const aboveCompress = pctNow > atrThreshold * 1.05 || rvNow > rvThreshold * 1.05;

  const hasRelease = expanding || aboveCompress;
  return {
    hasRelease,
    detail: hasRelease
      ? `ATR% 抬升 ${round(pct3, 6)} → ${round(pctNow, 6)}, RV=${round(rvNow, 6)}`
      : '波动仍处压缩区',
    metrics: { atrPctNow: round(pctNow, 6), atrPct3: round(pct3, 6), rvNow: round(rvNow, 6) },
  };
}

function detectBigMoveConfirmed(candles5m, idx, volCompression, volumeAnomaly, release) {
  if (!release.hasRelease) return false;
  if (!volumeAnomaly.pass) return false;

  const { bigMoveConfirmBars, atrPeriod } = sg();
  if (idx < bigMoveConfirmBars + atrPeriod) return false;

  let expandBars = 0;
  for (let b = 0; b < bigMoveConfirmBars; b += 1) {
    const i = idx - b;
    const atrA = computeAtr(candles5m, i, atrPeriod);
    const atrB = computeAtr(candles5m, i - 2, atrPeriod);
    const close = Number(candles5m[i]?.close);
    if (atrA == null || atrB == null || !Number.isFinite(close) || close <= 0) continue;
    if (atrA / close > atrB / close) expandBars += 1;
  }

  return expandBars >= bigMoveConfirmBars;
}

function detectBigMoveEnded(candles5m, idx, volCompression, volumeAnomaly) {
  const { bigMoveEndBars } = sg();
  if (idx < bigMoveEndBars) return false;

  let weakBars = 0;
  for (let b = 0; b < bigMoveEndBars; b += 1) {
    const i = idx - b;
    const comp = evaluateVolCompression(candles5m, i);
    const vol = evaluateVolumeAnomaly(candles5m, i);
    const syncWeak = !comp.pass && !vol.pass;
    if (syncWeak) weakBars += 1;
  }

  return weakBars >= bigMoveEndBars;
}

/**
 * Full session evaluation for the latest 5m bar.
 * @param {Array} candles5m closed 5m OHLCV, oldest first
 * @param {number} [nowMs]
 */
export function evaluateSession(candles5m, nowMs = Date.now()) {
  if (!config.sessionGate.enabled) {
    return {
      sessionGateEnabled: false,
      evaluationPassed: true,
      volCompression: { pass: true, detail: '门控已关闭' },
      volumeAnomaly: { pass: true, detail: '门控已关闭' },
      eventWindow: { pass: false, enabled: false, detail: '门控已关闭' },
      release: { hasRelease: true, detail: '门控已关闭' },
      action: 'continue',
      passReason: 'SESSION_GATE_ENABLED=false',
    };
  }

  const idx = candles5m.length - 1;
  const volCompression = evaluateVolCompression(candles5m, idx);
  const volumeAnomaly = evaluateVolumeAnomaly(candles5m, idx);
  const eventWindow = evaluateEventWindow(nowMs);
  const release = detectRelease(candles5m, idx, volCompression.metrics);

  const evaluationPassed = volCompression.pass && volumeAnomaly.pass;
  const passReason = evaluationPassed
    ? '压缩∧异动同时满足'
    : [
      !volCompression.pass ? '压缩未满足' : null,
      !volumeAnomaly.pass ? '异动未满足' : null,
    ].filter(Boolean).join('；');

  return {
    sessionGateEnabled: true,
    barTime: candles5m[idx]?.t ?? null,
    volCompression,
    volumeAnomaly,
    eventWindow,
    release,
    evaluationPassed,
    passReason,
    riskPreference: 'miss_big_move > small_loss',
  };
}

export function loadSessionState() {
  const defaults = {
    sessionState: 'IDLE',
    sessionStartedAt: null,
    barsInSession: 0,
    consecutiveEvalFail: 0,
    bigMoveConfirmed: false,
    lastEvaluation: null,
    updatedAt: null,
  };

  if (!existsSync(STATE_FILE)) return { ...defaults };

  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      ...defaults,
      ...raw,
      sessionState: SESSION_STATES.includes(raw.sessionState) ? raw.sessionState : 'IDLE',
    };
  } catch {
    return { ...defaults };
  }
}

export function saveSessionState(state) {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({
    ...state,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

/**
 * Advance session state machine from evaluation + candles context.
 * @returns {{ sessionState, action, evaluationPassed, bigMoveConfirmed, ... }}
 */
export function advanceSessionState(prev, evaluation, candles5m) {
  if (!config.sessionGate.enabled) {
    return {
      ...prev,
      sessionState: 'ACTIVE',
      action: 'continue',
      evaluationPassed: true,
      bigMoveConfirmed: false,
      tradeAllowed: true,
    };
  }

  const idx = candles5m.length - 1;
  const obsBars = sg().sessionObservationBars;
  let {
    sessionState,
    sessionStartedAt,
    barsInSession,
    consecutiveEvalFail,
    bigMoveConfirmed,
  } = prev;

  const { evaluationPassed, release, volCompression, volumeAnomaly } = evaluation;
  let action = 'none';

  if (sessionState === 'IDLE') {
    if (evaluationPassed) {
      sessionState = 'ACTIVE';
      action = 'start';
      sessionStartedAt = evaluation.barTime ?? Date.now();
      barsInSession = 1;
      consecutiveEvalFail = 0;
      bigMoveConfirmed = false;
    } else {
      action = 'idle';
    }

    return buildResult({
      sessionState,
      action,
      sessionStartedAt,
      barsInSession,
      consecutiveEvalFail,
      bigMoveConfirmed,
      evaluation,
      tradeAllowed: sessionState !== 'IDLE',
    });
  }

  barsInSession += 1;
  if (evaluationPassed) {
    consecutiveEvalFail = 0;
  } else {
    consecutiveEvalFail += 1;
  }

  if (!bigMoveConfirmed && detectBigMoveConfirmed(candles5m, idx, volCompression, volumeAnomaly, release)) {
    bigMoveConfirmed = true;
    sessionState = 'RUNNING_BIG_MOVE';
    action = 'big_move';
    return buildResult({
      sessionState,
      action,
      sessionStartedAt,
      barsInSession,
      consecutiveEvalFail,
      bigMoveConfirmed,
      evaluation,
      tradeAllowed: true,
    });
  }

  if (sessionState === 'RUNNING_BIG_MOVE') {
    if (detectBigMoveEnded(candles5m, idx, volCompression, volumeAnomaly)) {
      sessionState = 'IDLE';
      action = 'stop';
      sessionStartedAt = null;
      barsInSession = 0;
      consecutiveEvalFail = 0;
      bigMoveConfirmed = false;
    } else {
      action = 'continue';
    }

    return buildResult({
      sessionState,
      action,
      sessionStartedAt,
      barsInSession,
      consecutiveEvalFail,
      bigMoveConfirmed: sessionState === 'RUNNING_BIG_MOVE',
      evaluation,
      tradeAllowed: sessionState !== 'IDLE',
    });
  }

  // ACTIVE — default continue; stop only on long fail + no release
  if (consecutiveEvalFail >= obsBars && !release.hasRelease) {
    sessionState = 'IDLE';
    action = 'stop';
    sessionStartedAt = null;
    barsInSession = 0;
    consecutiveEvalFail = 0;
    bigMoveConfirmed = false;
  } else {
    action = 'continue';
  }

  return buildResult({
    sessionState,
    action,
    sessionStartedAt,
    barsInSession,
    consecutiveEvalFail,
    bigMoveConfirmed,
    evaluation,
    tradeAllowed: sessionState !== 'IDLE',
  });
}

function buildResult(fields) {
  return {
    ...fields,
    lastEvaluation: {
      evaluationPassed: fields.evaluation.evaluationPassed,
      passReason: fields.evaluation.passReason,
      volCompression: fields.evaluation.volCompression,
      volumeAnomaly: fields.evaluation.volumeAnomaly,
      eventWindow: fields.evaluation.eventWindow,
      release: fields.evaluation.release,
      barTime: fields.evaluation.barTime,
    },
  };
}

export function formatSessionLogFields(sessionCtx) {
  if (!sessionCtx) return {};
  const ev = sessionCtx.lastEvaluation ?? sessionCtx.evaluation ?? {};
  return {
    sessionState: sessionCtx.sessionState ?? null,
    sessionAction: sessionCtx.action ?? null,
    evaluationPassed: ev.evaluationPassed ?? null,
    sessionPassReason: ev.passReason ?? null,
    volCompression: ev.volCompression ?? null,
    volumeAnomaly: ev.volumeAnomaly ?? null,
    eventWindow: ev.eventWindow ?? null,
    release: ev.release ?? null,
    tradeAllowed: sessionCtx.tradeAllowed ?? null,
    barsInSession: sessionCtx.barsInSession ?? null,
    consecutiveEvalFail: sessionCtx.consecutiveEvalFail ?? null,
    bigMoveConfirmed: sessionCtx.bigMoveConfirmed ?? null,
  };
}

export function formatSessionTelegramBlock(sessionCtx) {
  if (!sessionCtx?.evaluation && !sessionCtx?.lastEvaluation) return '';

  const ev = sessionCtx.evaluation ?? sessionCtx.lastEvaluation;
  const state = sessionCtx.sessionState ?? 'IDLE';
  const stateZh = {
    IDLE: '休眠',
    ACTIVE: '运行中',
    RUNNING_BIG_MOVE: '大行情段',
  }[state] ?? state;

  const c1 = ev.volCompression?.pass ? '✓' : '✗';
  const c2 = ev.volumeAnomaly?.pass ? '✓' : '✗';
  const t1 = ev.volCompression?.thresholds
    ? `p${((ev.volCompression.thresholds.percentile ?? 0) * 100).toFixed(0)}/${ev.volCompression.thresholds.minBars}根`
    : '';
  const t2 = ev.volumeAnomaly?.thresholds
    ? `ratio>${ev.volumeAnomaly.thresholds.periodRatioMin} spike×${ev.volumeAnomaly.thresholds.spikeMult}`
    : '';
  const ev3 = ev.eventWindow?.enabled
    ? `\n催化: ${ev.eventWindow.pass ? '✓' : '—'} ${ev.eventWindow.detail}`
    : '';

  return (
    `\n🎯 <b>会话</b>: <b>${stateZh}</b> (${sessionCtx.action ?? '—'})\n` +
    `评估: ${ev.evaluationPassed ? '✓ 通过' : '✗ 未通过'} — ${ev.passReason ?? '—'}\n` +
    `压缩 ${c1}${t1 ? ` [${t1}]` : ''}: ${ev.volCompression?.detail ?? '—'}\n` +
    `异动 ${c2}${t2 ? ` [${t2}]` : ''}: ${ev.volumeAnomaly?.detail ?? '—'}` +
    ev3
  );
}
