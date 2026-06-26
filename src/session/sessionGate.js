import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../config.js';
import { escapeHtml } from '../utils/telegram.js';
import { computePeriodVolRatio, computeBarUsdtNotional, PERIOD_LONG_BARS } from '../utils/volumeFilter.js';
import { evaluateCombinedEventWindow } from '../utils/usMarketOpen.js';

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

function clampActivityWindowBars(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 12;
  // Safety cap: prevents misconfig like 285 from skewing tier calc when only a few candles were fetched.
  return Math.max(2, Math.min(96, Math.round(n)));
}

/** Minimum closed 5m bars for session gate evaluation. */
export function minSessionCandles() {
  if (!config.sessionGate.enabled) return 2;
  if (sg().dynamicThresholdEnabled) {
    return clampActivityWindowBars(sg().activityWindowBars);
  }
  return 2;
}

function countProbeHits(candles5m, idx, probeUsdt, windowBars) {
  const w = Math.min(windowBars, idx + 1);
  const startIdx = idx - w + 1;
  let hits = 0;
  for (let i = startIdx; i <= idx; i += 1) {
    const usdt = computeBarUsdtNotional(candles5m[i]);
    if (usdt != null && usdt >= probeUsdt) hits += 1;
  }
  return { hits, windowBars: w };
}

/** Map 12-bar hit freq → dynamic probe line (high freq → lower probe). */
export function computeDynamicProbeLine(freq, overrides = {}) {
  const cfg = { ...sg(), ...overrides };
  const lo = Math.min(cfg.activityProbeUsdtMinDynamic, cfg.activityProbeUsdtMaxDynamic);
  const hi = Math.max(cfg.activityProbeUsdtMinDynamic, cfg.activityProbeUsdtMaxDynamic);
  const clamped = Math.min(1, Math.max(0, freq));
  return Math.round(hi - clamped * (hi - lo));
}

/**
 * Resolve activity probe line (fixed or freq-mapped dynamic).
 * Dynamic: 近 activityWindowBars 根过线占比 → 探测线（与放量触发线同构）；2-pass 收敛。
 */
export function resolveProbeLineUsdt(candles5m, idx, overrides = {}) {
  const cfg = { ...sg(), ...overrides };
  const {
    dynamicProbeEnabled,
    activityProbeUsdtMin,
    activityProbeUsdtMinDynamic,
    activityProbeUsdtMaxDynamic,
    activityWindowBars: rawWindowBars,
  } = cfg;

  if (!dynamicProbeEnabled) {
    return {
      probeLineUsdt: activityProbeUsdtMin,
      dynamic: false,
      mapFreq: null,
      mapHits: null,
    };
  }

  const lo = Math.min(activityProbeUsdtMinDynamic, activityProbeUsdtMaxDynamic);
  const hi = Math.max(activityProbeUsdtMinDynamic, activityProbeUsdtMaxDynamic);
  const activityWindowBars = clampActivityWindowBars(rawWindowBars);

  let probeLineUsdt = hi;
  let mapHits = 0;
  let mapFreq = 0;
  let mapWindowBars = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const counted = countProbeHits(candles5m, idx, probeLineUsdt, activityWindowBars);
    mapHits = counted.hits;
    mapWindowBars = counted.windowBars;
    mapFreq = mapWindowBars > 0 ? mapHits / mapWindowBars : 0;
    probeLineUsdt = computeDynamicProbeLine(mapFreq, overrides);
  }

  return {
    probeLineUsdt,
    dynamic: true,
    mapFreq,
    mapHits,
    mapWindowBars,
    probeMin: lo,
    probeMax: hi,
  };
}

/**
 * Activity freq: share of recent 5m bars with USDT notional ≥ probe line.
 */
export function computeActivityFreq(candles5m, idx, overrides = {}) {
  const { activityWindowBars: rawWindowBars } = { ...sg(), ...overrides };
  const {
    probeLineUsdt,
    dynamic,
    mapFreq,
    mapHits,
    mapWindowBars,
    probeMin,
    probeMax,
  } = resolveProbeLineUsdt(candles5m, idx, overrides);

  if (dynamic) {
    return {
      freq: mapFreq,
      hits: mapHits,
      windowBars: mapWindowBars,
      probeLineUsdt,
      dynamic,
      mapFreq,
      mapHits,
      mapWindowBars,
      probeMin: probeMin ?? null,
      probeMax: probeMax ?? null,
    };
  }

  const activityWindowBars = clampActivityWindowBars(rawWindowBars);
  const { hits, windowBars } = countProbeHits(candles5m, idx, probeLineUsdt, activityWindowBars);
  const freq = windowBars > 0 ? hits / windowBars : 0;
  return {
    freq,
    hits,
    windowBars,
    probeLineUsdt,
    dynamic,
    mapFreq: null,
    mapHits: null,
    mapWindowBars: null,
    probeMin: probeMin ?? null,
    probeMax: probeMax ?? null,
  };
}

/** Map activity freq → burst trigger threshold (high freq → lower threshold). */
export function computeDynamicThreshold(freq) {
  const { barVolumeUsdtMinDynamic, barVolumeUsdtMaxDynamic } = sg();
  const lo = Math.min(barVolumeUsdtMinDynamic, barVolumeUsdtMaxDynamic);
  const hi = Math.max(barVolumeUsdtMinDynamic, barVolumeUsdtMaxDynamic);
  const clamped = Math.min(1, Math.max(0, freq));
  return Math.round(hi - clamped * (hi - lo));
}

/**
 * Resolve burst trigger USDT threshold for the current bar.
 * @returns {{ thresholdUsdt: number, dynamic: boolean, activity: object }}
 */
export function resolveBurstThresholdUsdt(candles5m, idx) {
  const { dynamicThresholdEnabled, barVolumeUsdtMin, barVolumeUsdtMinDynamic, barVolumeUsdtMaxDynamic } = sg();
  if (!dynamicThresholdEnabled) {
    return {
      thresholdUsdt: barVolumeUsdtMin,
      dynamic: false,
      activity: null,
    };
  }
  const activity = computeActivityFreq(candles5m, idx);
  const lo = Math.min(barVolumeUsdtMinDynamic, barVolumeUsdtMaxDynamic);
  const hi = Math.max(barVolumeUsdtMinDynamic, barVolumeUsdtMaxDynamic);
  return {
    thresholdUsdt: computeDynamicThreshold(activity.freq),
    dynamic: true,
    activity: {
      ...activity,
      threshMin: lo,
      threshMax: hi,
    },
  };
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

  if (!Array.isArray(candles5m) || idx < atrPeriod) {
    return {
      pass: false,
      detail: `K线不足: 需要≥${minSessionCandles()}根, 当前${candles5m?.length ?? 0}根`,
      thresholds,
      metrics: null,
    };
  }

  const windowStart = idx - volCompressLookback + 1;
  if (windowStart < atrPeriod) {
    return {
      pass: false,
      detail: `K线不足: 需要≥${minSessionCandles()}根(lookback=${volCompressLookback}+atr=${atrPeriod}), 当前${candles5m.length}根`,
      thresholds,
      metrics: null,
    };
  }

  const series = [];
  for (let i = windowStart; i <= idx; i += 1) {
    const atrVal = computeAtr(candles5m, i, atrPeriod);
    const rvVal = computeRvPct(candles5m, i, atrPeriod);
    const close = Number(candles5m[i]?.close);
    if (atrVal == null || rvVal == null || !Number.isFinite(close) || close <= 0) {
      return { pass: false, detail: `RV/ATR 计算失败 @bar${i}`, thresholds, metrics: null };
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
 * Scheduled always-open window: macro calendar ±hours OR US BJ session.
 * When both eventWindowEnabled and usMarketOpenEnabled are false → burst-only (never passes).
 */
export function evaluateScheduledWindow(nowMs = Date.now()) {
  const { eventWindowEnabled, eventWindowHours, usMarketOpenEnabled } = sg();

  if (!eventWindowEnabled && !usMarketOpenEnabled) {
    return { pass: false, enabled: false, detail: '仅放量窗（定时常开已关闭）' };
  }

  const events = eventWindowEnabled ? loadEventCalendar() : [];
  return evaluateCombinedEventWindow(nowMs, events, eventWindowHours, {
    usOpen: usMarketOpenEnabled,
    usWindow: {
      startBj: sg().usMarketWindowStartBj,
      endBj: sg().usMarketWindowEndBj,
    },
  });
}

/** @deprecated alias — use evaluateScheduledWindow */
export function evaluateEventWindow(nowMs = Date.now()) {
  if (!sg().eventWindowEnabled) {
    return { pass: false, enabled: false, detail: '事件窗口未启用' };
  }
  return evaluateScheduledWindow(nowMs);
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
 * Session gate: volume burst (default) or optional scheduled windows; burst refresh, no stack.
 * @param {Array} candles5m closed 5m OHLCV, oldest first
 * @param {number} [nowMs]
 * @param {{ volumeBurstUntilMs?: number|null }} [prevState]
 */
export function evaluateSession(candles5m, nowMs = Date.now(), prevState = {}) {
  if (!config.sessionGate.enabled) {
    return {
      sessionGateEnabled: false,
      evaluationPassed: true,
      tradeAllowed: true,
      gateMode: 'disabled',
      scheduledWindow: { pass: true, detail: '门控已关闭' },
      volumeBurst: null,
      barUsdt: null,
      volumeBurstUntilMs: null,
      passReason: 'SESSION_GATE_ENABLED=false',
    };
  }

  const idx = candles5m.length - 1;
  const bar = candles5m[idx];
  const barUsdt = computeBarUsdtNotional(bar);
  const { volumeBurstMinutes } = sg();
  const { thresholdUsdt, dynamic, activity } = resolveBurstThresholdUsdt(candles5m, idx);
  const scheduledWindow = evaluateScheduledWindow(nowMs);

  let volumeBurstUntilMs = prevState.volumeBurstUntilMs ?? null;
  const barTriggered = barUsdt != null && barUsdt >= thresholdUsdt;
  if (barTriggered) {
    volumeBurstUntilMs = nowMs + volumeBurstMinutes * 60_000;
  }

  const burstActive = volumeBurstUntilMs != null && nowMs < volumeBurstUntilMs;
  const scheduledActive = scheduledWindow.pass;

  let gateMode = 'idle';
  let tradeAllowed = false;
  if (scheduledActive) {
    gateMode = 'scheduled';
    tradeAllowed = true;
  } else if (burstActive) {
    gateMode = 'volume_burst';
    tradeAllowed = true;
  }

  const activityHint = dynamic && activity
    ? `活跃 ${activity.hits}/${activity.windowBars} (探测≥${formatUsdtM(activity.probeLineUsdt)}) → 触发线 ${formatUsdtM(thresholdUsdt)}`
    : `触发线 ${formatUsdtM(thresholdUsdt)}`;

  const passReason = scheduledActive
    ? `定时常开: ${scheduledWindow.detail}`
    : burstActive
      ? `放量窗口至 ${new Date(volumeBurstUntilMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} (本根 ${formatUsdtM(barUsdt)}${barTriggered ? ' 触发刷新' : ''}; ${activityHint})`
      : barUsdt != null
        ? `休眠 — 本根 ${formatUsdtM(barUsdt)} < ${formatUsdtM(thresholdUsdt)} (${activityHint})`
        : '休眠 — 成交额不可用';

  return {
    sessionGateEnabled: true,
    barTime: bar?.t ?? null,
    scheduledWindow,
    volumeBurst: {
      active: burstActive,
      untilMs: volumeBurstUntilMs,
      untilBj: volumeBurstUntilMs
        ? new Date(volumeBurstUntilMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        : null,
      barTriggered,
      thresholdUsdt,
      dynamicThreshold: dynamic,
      durationMinutes: volumeBurstMinutes,
      activityFreq: activity?.freq ?? null,
      activityHits: activity?.hits ?? null,
      activityWindowBars: activity?.windowBars ?? null,
      probeLineUsdt: activity?.probeLineUsdt ?? null,
      threshMin: activity?.threshMin ?? null,
      threshMax: activity?.threshMax ?? null,
    },
    barUsdt,
    gateMode,
    evaluationPassed: tradeAllowed,
    tradeAllowed,
    volumeBurstUntilMs,
    passReason,
  };
}

function formatUsdtM(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function loadSessionState() {
  const defaults = {
    sessionState: 'IDLE',
    sessionStartedAt: null,
    volumeBurstUntilMs: null,
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
      volumeBurstUntilMs: Number.isFinite(raw.volumeBurstUntilMs) ? raw.volumeBurstUntilMs : null,
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
 * Apply evaluation → session context; detect start/stop transitions.
 */
export function advanceSessionState(prev, evaluation, candles5m) {
  if (!config.sessionGate.enabled) {
    return {
      ...prev,
      sessionState: 'ACTIVE',
      action: 'continue',
      evaluationPassed: true,
      tradeAllowed: true,
      gateMode: 'disabled',
    };
  }

  const tradeAllowed = evaluation.tradeAllowed === true;
  const prevAllowed = prev.tradeAllowed === true;
  let action = 'none';
  if (tradeAllowed && !prevAllowed) action = 'start';
  else if (!tradeAllowed && prevAllowed) action = 'stop';
  else if (tradeAllowed && evaluation.volumeBurst?.barTriggered) action = 'burst_refresh';

  const sessionState = tradeAllowed ? 'ACTIVE' : 'IDLE';

  return buildResult({
    sessionState,
    action,
    sessionStartedAt: tradeAllowed
      ? (prev.sessionStartedAt ?? evaluation.barTime ?? Date.now())
      : null,
    volumeBurstUntilMs: evaluation.volumeBurstUntilMs ?? null,
    gateMode: evaluation.gateMode,
    evaluation,
    tradeAllowed,
  });
}

function buildResult(fields) {
  return {
    ...fields,
    lastEvaluation: {
      evaluationPassed: fields.evaluation.evaluationPassed,
      passReason: fields.evaluation.passReason,
      gateMode: fields.evaluation.gateMode,
      scheduledWindow: fields.evaluation.scheduledWindow,
      volumeBurst: fields.evaluation.volumeBurst,
      barUsdt: fields.evaluation.barUsdt,
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
    gateMode: ev.gateMode ?? sessionCtx.gateMode ?? null,
    evaluationPassed: ev.evaluationPassed ?? null,
    sessionPassReason: ev.passReason ?? null,
    scheduledWindow: ev.scheduledWindow ?? null,
    volumeBurst: ev.volumeBurst ?? null,
    barUsdt: ev.barUsdt ?? null,
    volumeBurstUntilMs: sessionCtx.volumeBurstUntilMs ?? null,
    tradeAllowed: sessionCtx.tradeAllowed ?? null,
  };
}

export function formatSessionTelegramBlock(sessionCtx) {
  if (!sessionCtx?.evaluation && !sessionCtx?.lastEvaluation) return '';

  const ev = sessionCtx.evaluation ?? sessionCtx.lastEvaluation;
  const state = sessionCtx.sessionState ?? 'IDLE';
  const stateZh = { IDLE: '休眠', ACTIVE: '运行中', RUNNING_BIG_MOVE: '运行中' }[state] ?? state;
  const modeZh = {
    scheduled: '定时常开',
    volume_burst: '放量窗口',
    idle: '休眠',
    disabled: '门控关闭',
  }[ev.gateMode] ?? ev.gateMode ?? '—';

  const barStr = ev.barUsdt != null ? `${formatUsdtM(ev.barUsdt)} USDT` : '—';
  const burst = ev.volumeBurst;
  const activityLine = burst?.dynamicThreshold && burst.activityHits != null
    ? `\n活跃: <b>${burst.activityHits}/${burst.activityWindowBars}</b> (${Math.round((burst.activityFreq ?? 0) * 100)}%)` +
      ` 探测≥${escapeHtml(formatUsdtM(burst.probeLineUsdt))}` +
      ` → 触发线 <b>${escapeHtml(formatUsdtM(burst.thresholdUsdt))}</b>` +
      ` (${escapeHtml(formatUsdtM(burst.threshMin))}–${escapeHtml(formatUsdtM(burst.threshMax))})`
    : burst?.thresholdUsdt
      ? `\n触发线: <b>${escapeHtml(formatUsdtM(burst.thresholdUsdt))}</b> (固定)`
      : '';
  const burstLine = burst?.active
    ? `\n放量窗: 至 ${escapeHtml(burst.untilBj)}${burst.barTriggered ? ' (本根刷新)' : ''}`
    : burst?.thresholdUsdt
      ? `\n放量触发: 本根 ≥ ${escapeHtml(formatUsdtM(burst.thresholdUsdt))} → 开 ${burst.durationMinutes} 分钟`
      : '';

  const sched = ev.scheduledWindow?.pass
    ? `\n定时: ✓ ${escapeHtml(ev.scheduledWindow.detail)}`
    : ev.scheduledWindow?.enabled !== false
      ? `\n定时: ✗ ${escapeHtml(ev.scheduledWindow.detail ?? '非事件/美股时段')}`
      : '';

  return (
    `\n🎯 <b>会话</b>: <b>${escapeHtml(stateZh)}</b> · ${escapeHtml(modeZh)} (${escapeHtml(sessionCtx.action ?? '—')})\n` +
    `门控: ${ev.evaluationPassed ? '✓ 开启' : '✗ 关闭'} — ${escapeHtml(ev.passReason ?? '—')}\n` +
    `本根成交额: ${escapeHtml(barStr)}` +
    activityLine +
    sched +
    burstLine
  );
}
