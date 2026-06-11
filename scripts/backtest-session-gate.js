/**
 * Session gate backtest: ACTIVE periods + halt-segment threshold analysis.
 * Usage:
 *   node scripts/backtest-session-gate.js --days=10
 *   node scripts/backtest-session-gate.js --days=365 --factor=compress --fetch
 *   node scripts/backtest-session-gate.js --days=30 --event-only --fetch
 *   node scripts/backtest-session-gate-all-factors.js --days=365 --fetch
 *
 * Factors: combo | compress | volume | period-vol | spike | momentum | event | macro | us
 */
import ccxt from 'ccxt';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import {
  evaluateSession,
  advanceSessionState,
  minSessionCandles,
  evaluateVolCompression,
  evaluateVolumeAnomaly,
} from '../src/session/sessionGate.js';
import { simulateMartingale, summarizeTrades } from './lib/backtestFactors.js';
import {
  evaluateCombinedEventWindow,
  isWithinUsMarketWindow,
  listUsMarketWindows,
  DEFAULT_US_WINDOW,
} from '../src/utils/usMarketOpen.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const CACHE_5M = join(OUT_DIR, 'ohlcv-5m-cache.json');
const OUT_FILE_DEFAULT = join(OUT_DIR, 'backtest-session-gate.json');
const OUT_FILE_VOLUME = join(OUT_DIR, 'backtest-session-gate-volume-only.json');
const OUT_FILE_EVENT = join(OUT_DIR, 'backtest-session-gate-event-only.json');
const EVENT_CALENDAR = join(__dirname, '..', 'config', 'event-calendar-backtest.json');

export const FACTOR_MODES = {
  combo: 'compress-and-volume',
  compress: 'compress-only',
  volume: 'volume-only',
  'period-vol': 'period-vol-only',
  spike: 'spike-only',
  momentum: 'momentum-only',
  event: 'event-only',
  macro: 'macro-only',
  us: 'us-only',
};

export const FACTOR_LABELS = {
  combo: '压缩∧异动',
  compress: '仅波动压缩',
  volume: '仅成交量异动(OR)',
  'period-vol': '仅 periodVolRatio',
  spike: '仅 spike',
  momentum: '仅 momentum',
  event: '事件窗口(宏观∨美股)',
  macro: '仅宏观日历±4h',
  us: '仅美股 19:30–23:30',
};

const EVENT_FACTORS = new Set(['event', 'macro', 'us']);
const VOLUME_SUB_FACTORS = new Set(['period-vol', 'spike', 'momentum']);

const SYMBOL = 'BTC/USDT';
const WARMUP_MS = 5 * 24 * 60 * 60_000;

function loadBacktestEvents() {
  if (!existsSync(EVENT_CALENDAR)) return [];
  try {
    const raw = JSON.parse(readFileSync(EVENT_CALENDAR, 'utf8'));
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

function evaluateEventWindowAt(nowMs, events, windowHours, { macro = true, us = true } = {}) {
  if (macro && us) {
    return evaluateCombinedEventWindow(nowMs, events, windowHours, {
      usOpen: true,
      usWindow: US_WINDOW,
    });
  }
  if (us) {
    const usWin = isWithinUsMarketWindow(nowMs, US_WINDOW);
    return {
      pass: usWin.pass,
      enabled: true,
      detail: usWin.pass ? usWin.detail : `不在美股窗口 ${US_WINDOW.startBj}–${US_WINDOW.endBj} 北京`,
      usMarketOpen: usWin,
    };
  }
  const windowMs = windowHours * 60 * 60 * 1000;
  const nearbyCal = events.filter((e) => Math.abs(e.ts - nowMs) <= windowMs);
  return {
    pass: nearbyCal.length > 0,
    enabled: true,
    detail: nearbyCal.length
      ? nearbyCal.map((e) => e.label).join('; ')
      : `±${windowHours}h 内无宏观事件`,
    events: nearbyCal.map((e) => ({ label: e.label, ts: e.ts })),
  };
}

const EVENT_WINDOW_HOURS = config.sessionGate.eventWindowHours;
const US_WINDOW = {
  startBj: config.sessionGate.usMarketWindowStartBj || DEFAULT_US_WINDOW.startBj,
  endBj: config.sessionGate.usMarketWindowEndBj || DEFAULT_US_WINDOW.endBj,
};

function parseArg(name, fallback = null, argv = process.argv) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

export function resolveFactor(argv = process.argv) {
  const explicit = parseArg('factor', null, argv);
  if (explicit) {
    if (!FACTOR_MODES[explicit]) {
      throw new Error(`Unknown factor "${explicit}". Use: ${Object.keys(FACTOR_MODES).join(', ')}`);
    }
    return explicit;
  }
  if (hasFlag('event-only', argv)) return 'event';
  if (hasFlag('volume-only', argv)) return 'volume';
  if (hasFlag('compress-only', argv)) return 'compress';
  return 'combo';
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

/** Single volume sub-factor (matches sessionGate thresholds). */
function evaluateVolumeSubFactor(candles5m, idx, sub) {
  const {
    volPeriodRatioMin,
    volSpikeMult,
    volSpikeLookback,
    volMomentumMult,
  } = config.sessionGate;
  const vol = evaluateVolumeAnomaly(candles5m, idx);
  const m = vol.metrics ?? {};

  if (sub === 'period-vol') {
    const pass = m.periodVolRatio != null && m.periodVolRatio > volPeriodRatioMin;
    return {
      pass,
      detail: pass ? `periodVolRatio=${m.periodVolRatio}` : 'periodVolRatio 未达标',
      metrics: vol.metrics,
    };
  }

  if (sub === 'spike') {
    let pass = false;
    if (idx >= volSpikeLookback && idx >= 1) {
      const pastAvg = avgVolume(candles5m, idx - volSpikeLookback, idx - 1);
      const v0 = Number(candles5m[idx]?.volume);
      const v1 = Number(candles5m[idx - 1]?.volume);
      if (pastAvg != null && pastAvg > 0 && Number.isFinite(v0) && Number.isFinite(v1)) {
        pass = v0 > pastAvg * volSpikeMult || v1 > pastAvg * volSpikeMult;
      }
    }
    return {
      pass,
      detail: pass ? `spike=${m.spikeRatio}×` : 'spike 未达标',
      metrics: vol.metrics,
    };
  }

  if (sub === 'momentum') {
    const pass = m.momentumRatio != null && m.momentumRatio > volMomentumMult;
    return {
      pass,
      detail: pass ? `momentum=${m.momentumRatio}×` : 'momentum 未达标',
      metrics: vol.metrics,
    };
  }

  return { pass: vol.pass, detail: vol.detail, metrics: vol.metrics };
}

function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function fmtBj(ms) {
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 16);
}

async function fetchAllCandles(exchange, symbol, timeframe, since, until) {
  const all = [];
  let cursor = since;
  const tfMs = 5 * 60_000;
  while (cursor < until) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, cursor, 300);
    if (!batch.length) break;
    for (const row of batch) {
      const [t, o, h, l, c, v] = row;
      if (t >= until) break;
      all.push({ t, open: o, high: h, low: l, close: c, volume: v });
    }
    const lastT = batch.at(-1)[0];
    if (lastT <= cursor) break;
    cursor = lastT + tfMs;
    await new Promise((r) => setTimeout(r, 80));
  }
  const dedup = new Map(all.map((c) => [c.t, c]));
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

async function ensureCandles(fromMs, toMs, forceFetch = false) {
  const needSince = fromMs - WARMUP_MS;
  let c5 = existsSync(CACHE_5M) ? JSON.parse(readFileSync(CACHE_5M, 'utf8')) : [];
  const cacheStart = c5[0]?.t ?? Infinity;
  const cacheEnd = c5.at(-1)?.t ?? 0;
  const tolerateMs = 2 * 60 * 60_000;
  const covers = c5.length && cacheStart <= needSince && cacheEnd >= toMs - tolerateMs;

  if (covers && !forceFetch) {
    console.log(`Using cache: ${fmtTs(cacheStart)} → ${fmtTs(cacheEnd)} (${c5.length} bars)`);
    return c5;
  }

  console.log(`Fetching OKX ${SYMBOL} 5m ${fmtTs(needSince)} → ${fmtTs(toMs)} ...`);
  const ex = new ccxt.okx({ enableRateLimit: true, timeout: 60_000 });
  c5 = await fetchAllCandles(ex, SYMBOL, '5m', needSince, toMs);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE_5M, JSON.stringify(c5));
  console.log(`Fetched ${c5.length} bars`);
  return c5;
}

/** Backtest overrides: single-factor gate modes. */
function evaluateSessionForBacktest(slice, barT, ctx) {
  const evaluation = evaluateSession(slice, barT);
  const { factor, events } = ctx;
  const alwaysPassCompress = {
    pass: true,
    detail: '压缩已禁用(始终通过)',
    thresholds: evaluation.volCompression?.thresholds ?? null,
    metrics: evaluation.volCompression?.metrics ?? null,
  };
  const alwaysPassVolume = {
    pass: true,
    detail: '异动已禁用(始终通过)',
    thresholds: evaluation.volumeAnomaly?.thresholds ?? null,
    metrics: evaluation.volumeAnomaly?.metrics ?? null,
  };

  if (factor === 'combo') return evaluation;

  if (factor === 'compress') {
    const evaluationPassed = evaluation.volCompression.pass;
    return {
      ...evaluation,
      volumeAnomaly: alwaysPassVolume,
      evaluationPassed,
      passReason: evaluationPassed ? '仅压缩通过' : '压缩未满足',
    };
  }

  if (factor === 'volume') {
    const evaluationPassed = evaluation.volumeAnomaly.pass;
    return {
      ...evaluation,
      volCompression: alwaysPassCompress,
      evaluationPassed,
      passReason: evaluationPassed ? '仅异动通过' : '异动未满足',
    };
  }

  if (VOLUME_SUB_FACTORS.has(factor)) {
    const sub = evaluateVolumeSubFactor(slice, slice.length - 1, factor);
    const volumeAnomaly = {
      pass: sub.pass,
      detail: sub.detail,
      thresholds: evaluation.volumeAnomaly?.thresholds ?? null,
      metrics: sub.metrics,
    };
    return {
      ...evaluation,
      volCompression: alwaysPassCompress,
      volumeAnomaly,
      evaluationPassed: sub.pass,
      passReason: sub.pass ? `仅${factor}通过` : `${factor} 未满足`,
    };
  }

  if (EVENT_FACTORS.has(factor)) {
    const eventOpts = factor === 'macro'
      ? { macro: true, us: false }
      : factor === 'us'
        ? { macro: false, us: true }
        : { macro: true, us: true };
    const eventWindow = evaluateEventWindowAt(barT, events, EVENT_WINDOW_HOURS, eventOpts);
    const evaluationPassed = eventWindow.pass;
    return {
      ...evaluation,
      volCompression: alwaysPassCompress,
      volumeAnomaly: alwaysPassVolume,
      eventWindow,
      evaluationPassed,
      passReason: evaluationPassed ? `事件窗口: ${eventWindow.detail}` : '无催化事件',
    };
  }

  return evaluation;
}

function simulateSessionTimeline(c5, fromMs, toMs, ctx) {
  let sessionCtx = {
    sessionState: 'IDLE',
    sessionStartedAt: null,
    barsInSession: 0,
    consecutiveEvalFail: 0,
    bigMoveConfirmed: false,
  };

  const timeline = [];
  const segments = [];
  let currentSeg = null;
  const minIdx = Math.max(minSessionCandles(), 110);

  for (let i = minIdx; i < c5.length; i += 1) {
    const barT = c5[i].t;
    if (barT < fromMs - 5 * 60_000 || barT >= toMs) continue;

    const slice = c5.slice(0, i + 1);
    const evaluation = evaluateSessionForBacktest(slice, barT, ctx);
    const prevState = sessionCtx.sessionState;
    sessionCtx = advanceSessionState(sessionCtx, evaluation, slice);
    sessionCtx.evaluation = evaluation;

    const tradeAllowed = sessionCtx.tradeAllowed;
    timeline.push({
      t: barT,
      sessionState: sessionCtx.sessionState,
      action: sessionCtx.action,
      tradeAllowed,
      evaluationPassed: evaluation.evaluationPassed,
      volCompressionPass: evaluation.volCompression.pass,
      volumeAnomalyPass: evaluation.volumeAnomaly.pass,
      eventWindowPass: evaluation.eventWindow?.pass ?? null,
      eventWindowDetail: evaluation.eventWindow?.detail ?? null,
      metrics: {
        atrPct: evaluation.volCompression.metrics?.atrPct,
        rvPct: evaluation.volCompression.metrics?.rvPct,
        consecutiveLow: evaluation.volCompression.metrics?.consecutiveLow,
        periodVolRatio: evaluation.volumeAnomaly.metrics?.periodVolRatio,
        spikeRatio: evaluation.volumeAnomaly.metrics?.spikeRatio,
        momentumRatio: evaluation.volumeAnomaly.metrics?.momentumRatio,
      },
    });

    const open = tradeAllowed;
    if (open && !currentSeg) {
      currentSeg = { start: barT, startAction: sessionCtx.action, state: sessionCtx.sessionState };
    } else if (!open && currentSeg) {
      currentSeg.end = barT;
      currentSeg.endAction = sessionCtx.action;
      currentSeg.durationBars = timeline.filter((x) => x.t >= currentSeg.start && x.t < barT).length;
      segments.push(currentSeg);
      currentSeg = null;
    } else if (open && currentSeg && sessionCtx.sessionState === 'RUNNING_BIG_MOVE' && prevState === 'ACTIVE') {
      currentSeg.bigMoveAt = barT;
    }

    if (sessionCtx.action === 'stop') {
      if (currentSeg) {
        currentSeg.end = barT;
        currentSeg.endAction = 'stop';
        currentSeg.durationBars = timeline.filter((x) => x.t >= currentSeg.start && x.t <= barT).length;
        segments.push(currentSeg);
        currentSeg = null;
      }
    }
  }

  if (currentSeg) {
    currentSeg.end = c5.at(-1).t;
    currentSeg.endAction = 'open';
    currentSeg.durationBars = timeline.filter((x) => x.t >= currentSeg.start).length;
    segments.push(currentSeg);
  }

  return { timeline, segments, finalCtx: sessionCtx };
}

function buildGatedTrades(c5, timeline, fromMs, toMs) {
  const allowedByT = new Map(timeline.filter((x) => x.tradeAllowed).map((x) => [x.t, x]));
  const raw = [];

  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + 5 * 60_000;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;

    const gateBar = allowedByT.get(k1.t);
    if (!gateBar) continue;

    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({
      t: tradeTs,
      k1t: k1.t,
      signalId: eval_.signalId,
      signal: eval_.signal,
      won,
      pnlUsd: won ? 0.5 : -0.5,
      sessionState: gateBar.sessionState,
      ...gateBar.metrics,
    });
  }

  return simulateMartingale(raw);
}

function extractHaltWindows(trades) {
  const windows = [];
  let streak = [];
  for (const t of trades) {
    if (!t.won) {
      streak.push(t);
      if (streak.length >= 4) {
        windows.push({
          start: streak[0].t,
          end: streak[3].t,
          trades: [...streak],
        });
        streak = [];
      }
    } else {
      streak = [];
    }
  }
  return windows;
}

function stats(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  return {
    n: v.length,
    min: sorted[0],
    p25: pct(0.25),
    med: pct(0.5),
    p75: pct(0.75),
    max: sorted.at(-1),
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

function compareGroups(trades, labelA, fnA, labelB, fnB) {
  const keys = ['periodVolRatio', 'spikeRatio', 'momentumRatio', 'atrPct', 'rvPct', 'consecutiveLow'];
  const out = {};
  for (const key of keys) {
    out[key] = {
      [labelA]: stats(trades.filter(fnA).map((t) => t[key])),
      [labelB]: stats(trades.filter(fnB).map((t) => t[key])),
    };
  }
  return out;
}

function gridThresholdSearch(allTimeline, haltGateOpens, profitGateOpens) {
  const compressP = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55];
  const compressBars = [8, 10, 12, 16, 20];
  const volRatio = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3];
  const spikeMult = [1.1, 1.2, 1.3, 1.4, 1.5];

  const results = [];
  for (const p of compressP) {
    for (const mb of compressBars) {
      for (const vr of volRatio) {
        for (const sm of spikeMult) {
          let passBars = 0;
          let haltOverlap = 0;
          let profitOverlap = 0;
          for (const row of allTimeline) {
            const comp = row._comp ?? row;
            const pass = comp.compressSim?.(p, mb) && comp.volSim?.(vr, sm);
            if (!pass) continue;
            passBars += 1;
            const t = row.t;
            if (haltGateOpens.some((h) => t >= h.start && t <= h.end)) haltOverlap += 1;
            if (profitGateOpens.some((h) => t >= h.start && t <= h.end)) profitOverlap += 1;
          }
          const score = profitOverlap - haltOverlap * 2;
          results.push({ p, mb, vr, sm, passBars, haltOverlap, profitOverlap, score });
        }
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 15);
}

function enrichTimelineForGrid(c5, timeline) {
  return timeline.map((row) => {
    const idx = c5.findIndex((c) => c.t === row.t);
    if (idx < 0) return row;
    const comp = evaluateVolCompression(c5, idx);
    const vol = evaluateVolumeAnomaly(c5, idx);
    const m = comp.metrics ?? {};
    const vm = vol.metrics ?? {};
    return {
      ...row,
      compressSim: (p, mb) => {
        if (!m.atrPct || !m.rvPct || !m.atrThreshold || !m.rvThreshold) return false;
        const thrA = m.atrThreshold; // note: uses current threshold; approximate with metrics
        return m.consecutiveLow >= mb;
      },
      volSim: (vr, sm) => {
        const ratio = vm.periodVolRatio ?? 0;
        const spike = vm.spikeRatio ?? 0;
        const mom = vm.momentumRatio ?? 0;
        return ratio > vr || spike > sm || mom > 1.1;
      },
      _rawComp: comp,
      _rawVol: vol,
    };
  });
}

export async function runSessionGateBacktest(opts = {}) {
  const argv = opts.argv ?? process.argv;
  const factor = opts.factor ?? resolveFactor(argv);
  const days = Number(opts.days ?? parseArg('days', '10', argv));
  const toMs = opts.toMs ?? (parseArg('to', null, argv) ? Date.parse(parseArg('to', null, argv)) : Date.now());
  const fromMs = opts.fromMs ?? (parseArg('from', null, argv) ? Date.parse(parseArg('from', null, argv)) : toMs - days * 24 * 60 * 60_000);
  const forceFetch = opts.fetch ?? hasFlag('fetch', argv);
  const quiet = opts.quiet ?? false;
  const events = EVENT_FACTORS.has(factor) ? loadBacktestEvents() : [];
  const ctx = { factor, events };
  const mode = FACTOR_MODES[factor];

  const c5 = opts.candles ?? await ensureCandles(fromMs, toMs, forceFetch);
  const { timeline, segments } = simulateSessionTimeline(c5, fromMs, toMs, ctx);
  const gatedTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const allTrades = buildGatedTrades(c5, timeline.map((x) => ({ ...x, tradeAllowed: true })), fromMs, toMs);

  const haltWindows = extractHaltWindows(gatedTrades);
  const haltTrades = gatedTrades.filter((t) => t.inHaltStreak || t.martingaleHalted);
  const profitTrades = gatedTrades.filter((t) => t.won);
  const lossTrades = gatedTrades.filter((t) => !t.won);

  const gateOpenBars = timeline.filter((x) => x.tradeAllowed).length;
  const evalPassBars = timeline.filter((x) => x.evaluationPassed).length;

  const factorCompare = compareGroups(
    gatedTrades,
    'haltRisk', (t) => t.inHaltStreak || t.martingaleHalted,
    'wins', (t) => t.won,
  );

  const gateOpenAtTrade = (t) => segments.some((s) => t.k1t >= s.start && t.k1t <= s.end);
  const haltSegmentOpens = haltWindows.map((w) => ({
    start: w.start - 5 * 60_000 * 12,
    end: w.end,
  }));
  const profitSegments = segments.filter((s) => {
    const segTrades = gatedTrades.filter((t) => t.k1t >= s.start && t.k1t <= s.end);
    return segTrades.some((t) => t.won) && segTrades.reduce((a, t) => a + t.pnlUsd, 0) > 0;
  }).map((s) => ({ start: s.start, end: s.end }));

  const enriched = enrichTimelineForGrid(c5, timeline);

  const report = {
    factor,
    mode,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    config: {
      ...config.sessionGate,
      factor,
      ...(EVENT_FACTORS.has(factor) ? {
        volCompressDisabled: true,
        volumeAnomalyDisabled: true,
        eventWindowEnabled: true,
        eventWindowHours: EVENT_WINDOW_HOURS,
        eventCalendar: EVENT_CALENDAR,
        events: events.map((e) => ({
          label: e.label,
          ts: fmtTs(e.ts),
          tsBj: fmtBj(e.ts),
        })),
        usMarketWindow: US_WINDOW,
        usMarketOpens: listUsMarketWindows(fromMs, toMs, US_WINDOW),
        eventSubMode: factor === 'macro' ? 'macro-only' : factor === 'us' ? 'us-only' : 'macro-or-us',
      } : {}),
      ...(factor === 'volume' || VOLUME_SUB_FACTORS.has(factor) ? { volCompressDisabled: true } : {}),
      ...(factor === 'compress' ? { volumeAnomalyDisabled: true } : {}),
    },
    summary: {
      totalBars: timeline.length,
      evalPassBars,
      evalPassPct: evalPassBars / (timeline.length || 1),
      gateOpenBars,
      gateOpenPct: gateOpenBars / (timeline.length || 1),
      sessionSegments: segments.length,
      gatedTrades: gatedTrades.length,
      haltEvents: haltWindows.length,
      gated: summarizeTrades(gatedTrades),
      alwaysOn: summarizeTrades(allTrades),
    },
    segments: segments.map((s) => ({
      start: fmtTs(s.start),
      startBj: fmtBj(s.start),
      end: fmtTs(s.end),
      endBj: fmtBj(s.end),
      durationBars: s.durationBars,
      durationHours: ((s.durationBars ?? 0) * 5 / 60).toFixed(1),
      bigMoveAt: s.bigMoveAt ? fmtBj(s.bigMoveAt) : null,
      tradesInSeg: gatedTrades.filter((t) => t.k1t >= s.start && t.k1t <= s.end).length,
      pnlInSeg: gatedTrades.filter((t) => t.k1t >= s.start && t.k1t <= s.end)
        .reduce((a, t) => a + t.pnlUsd, 0),
    })),
    haltWindows: haltWindows.map((w) => ({
      start: fmtBj(w.start),
      end: fmtBj(w.end),
      signals: w.trades.map((t) => t.signalId),
    })),
    factorCompare,
    thresholdHints: buildThresholdHints(factorCompare, timeline, haltTrades, profitTrades),
  };

  const outFile = opts.outFile ?? (
    factor === 'combo' ? OUT_FILE_DEFAULT
      : factor === 'volume' ? OUT_FILE_VOLUME
        : factor === 'event' ? OUT_FILE_EVENT
          : join(OUT_DIR, `backtest-session-gate-${factor}.json`)
  );
  writeFileSync(outFile, JSON.stringify(report, null, 2));

  if (!quiet) {
    printReport(report);
    console.log(`\nFull JSON: ${outFile}`);
  }
  return { report, outFile, candles: c5 };
}

async function main() {
  try {
    await runSessionGateBacktest();
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}

function buildThresholdHints(factorCompare, timeline, haltTrades, profitTrades) {
  const hints = [];

  const hr = factorCompare.periodVolRatio?.haltRisk;
  const wr = factorCompare.periodVolRatio?.wins;
  if (hr && wr) {
    hints.push({
      param: 'VOL_PERIOD_RATIO_MIN',
      current: config.sessionGate.volPeriodRatioMin,
      suggest: hr.p75 != null && wr.med != null
        ? `止损段 p75=${hr.p75?.toFixed(3)} vs 盈利 med=${wr.med?.toFixed(3)} → 建议 ≥ ${Math.max(1.05, (hr.p75 + wr.med) / 2).toFixed(2)} 过滤止损段放量假信号`
        : null,
    });
  }

  const hs = factorCompare.spikeRatio?.haltRisk;
  const ws = factorCompare.spikeRatio?.wins;
  if (hs && ws) {
    hints.push({
      param: 'VOL_SPIKE_MULT',
      current: config.sessionGate.volSpikeMult,
      suggest: hs.med != null
        ? `止损段 spike med=${hs.med?.toFixed(2)} → 若止损段 spike 偏低，可维持 ${config.sessionGate.volSpikeMult}；若偏高可提到 ${(hs.p25 ?? 1.3).toFixed(2)}`
        : null,
    });
  }

  const hc = factorCompare.consecutiveLow?.haltRisk;
  const wc = factorCompare.consecutiveLow?.wins;
  if (hc && wc) {
    hints.push({
      param: 'VOL_COMPRESS_MIN_BARS',
      current: config.sessionGate.volCompressMinBars,
      suggest: hc.med != null && wc.med != null
        ? `止损段连续压缩 med=${hc.med?.toFixed(0)} vs 盈利 med=${wc.med?.toFixed(0)} → 建议 minBars=${Math.round(Math.min(hc.med, wc.med))}~${Math.round(Math.max(hc.med, wc.med))}`
        : null,
    });
  }

  const evalAtHalt = timeline.filter((x) =>
    haltTrades.some((t) => Math.abs(x.t - t.k1t) < 5 * 60_000));
  const evalAtWin = timeline.filter((x) =>
    profitTrades.some((t) => Math.abs(x.t - t.k1t) < 5 * 60_000));

  hints.push({
    param: 'VOL_COMPRESS_PERCENTILE',
    current: config.sessionGate.volCompressPercentile,
    suggest: `止损前评估: 压缩pass率 ${pct(evalAtHalt, (x) => x.volCompressionPass)} | 盈利前: ${pct(evalAtWin, (x) => x.volCompressionPass)}`,
  });

  return hints;
}

function pct(arr, fn) {
  if (!arr.length) return 'N/A';
  return `${(arr.filter(fn).length / arr.length * 100).toFixed(0)}%`;
}

function printReport(r) {
  const modeLabel = FACTOR_LABELS[r.factor] ?? {
    'compress-and-volume': '压缩∧异动',
    'compress-only': '仅波动压缩',
    'volume-only': '仅成交量异动（压缩始终通过）',
    'period-vol-only': '仅 periodVolRatio',
    'spike-only': '仅 spike',
    'momentum-only': '仅 momentum',
    'event-only': `事件窗口 宏观±${r.config.eventWindowHours ?? 4}h + 美股 ${r.config.usMarketWindow?.startBj ?? '19:30'}–${r.config.usMarketWindow?.endBj ?? '23:30'} 北京`,
    'macro-only': `仅宏观日历 ±${r.config.eventWindowHours ?? 4}h`,
    'us-only': `仅美股 ${r.config.usMarketWindow?.startBj ?? '19:30'}–${r.config.usMarketWindow?.endBj ?? '23:30'} 北京`,
  }[r.mode] ?? r.mode;
  console.log(`\n=== 会话门控回测 · ${modeLabel} ===`);
  if (r.config.events?.length) {
    console.log('宏观事件:');
    for (const e of r.config.events) {
      console.log(`  · ${e.label}  ${e.tsBj}`);
    }
  }
  if (r.config.usMarketOpens?.length) {
    const w = r.config.usMarketWindow ?? DEFAULT_US_WINDOW;
    console.log(`美股窗口 北京 ${w.startBj}–${w.endBj}（NY 交易日，共 ${r.config.usMarketOpens.length} 天）`);
  }
  console.log(`区间: ${r.range.from} → ${r.range.to}`);
  console.log(`\n--- 覆盖率 ---`);
  console.log(`评估通过: ${r.summary.evalPassBars}/${r.summary.totalBars} (${(r.summary.evalPassPct * 100).toFixed(1)}%)`);
  console.log(`门控开启: ${r.summary.gateOpenBars}/${r.summary.totalBars} (${(r.summary.gateOpenPct * 100).toFixed(1)}%)`);
  console.log(`会话段数: ${r.summary.sessionSegments}`);
  console.log(`门控内交易: ${r.summary.gatedTrades} 笔 | 止损段: ${r.summary.haltEvents} 次`);
  console.log(`门控 PnL: ${r.summary.gated.pnl.toFixed(2)} (${r.summary.gated.trades}笔 WR ${(r.summary.gated.winRate * 100).toFixed(1)}% 止损${r.summary.gated.halts})`);
  console.log(`常开 PnL: ${r.summary.alwaysOn.pnl.toFixed(2)} (${r.summary.alwaysOn.trades}笔 WR ${(r.summary.alwaysOn.winRate * 100).toFixed(1)}% 止损${r.summary.alwaysOn.halts})`);
  console.log(`Δ PnL: ${(r.summary.gated.pnl - r.summary.alwaysOn.pnl).toFixed(2)}`);

  if (r.quietSegments) return;

  console.log(`\n--- 门控开启时间段 (${r.segments.length} 段) ---`);
  for (const s of r.segments) {
    const pnlStr = s.pnlInSeg >= 0 ? `+${s.pnlInSeg.toFixed(1)}` : s.pnlInSeg.toFixed(1);
    console.log(
      `${s.startBj} → ${s.endBj}  (${s.durationHours}h, ${s.tradesInSeg}笔, PnL ${pnlStr})` +
      (s.bigMoveAt ? `  🚀${s.bigMoveAt}` : ''),
    );
  }

  if (r.haltWindows.length) {
    console.log(`\n--- 止损段 (马丁4连亏) ---`);
    for (const w of r.haltWindows) {
      console.log(`${w.start} → ${w.end}  [${w.signals.join(', ')}]`);
    }
  } else {
    console.log(`\n--- 止损段: 无（门控开启期间未触发4连亏）---`);
  }

  console.log(`\n--- 因子对比（止损风险 vs 盈利单）---`);
  for (const [key, val] of Object.entries(r.factorCompare)) {
    const h = val.haltRisk;
    const w = val.wins;
    if (!h || !w) continue;
    console.log(
      `${key}: halt med=${fmt(h.med)} p75=${fmt(h.p75)} | win med=${fmt(w.med)} p75=${fmt(w.p75)}`,
    );
  }

  console.log(`\n--- 阈值反推建议 ---`);
  for (const h of r.thresholdHints) {
    console.log(`${h.param} (当前 ${h.current}): ${h.suggest}`);
  }
}

function fmt(n) {
  return n == null ? '—' : Number(n).toFixed(4);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
