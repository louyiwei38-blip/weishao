/**
 * Backtest by market volume time periods: high / neutral / low.
 * Usage: node scripts/backtest-vol-periods.js [--target=10000]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeSignalVolatility } from '../src/utils/volatility.js';
import {
  build1mIndex,
  computeTradeFactors,
  simulateMartingale,
  applyFilterStats,
  summarizeTrades,
} from './lib/backtestFactors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const CACHE_5M = join(OUT_DIR, 'ohlcv-5m-cache.json');
const CACHE_1M = join(OUT_DIR, 'ohlcv-1m-cache.json');
const OUT_FILE = join(OUT_DIR, 'backtest-vol-periods.json');

const TARGET = Number(process.argv.find((a) => a.startsWith('--target='))?.split('=')[1] ?? 10000);
const RV5_THRESH = 0.00045;
const RV15_THRESH = 0.00025;
const RV_RATIO_MAX = 1.05;
const SHORT_BARS = 12;   // 1h rolling avg volume
const LONG_BARS = 96;    // 8h baseline avg volume

function loadCandles() {
  if (!existsSync(CACHE_5M) || !existsSync(CACHE_1M)) {
    throw new Error('Missing OHLCV cache — run: node scripts/backtest-10k-vol.js');
  }
  return {
    c5: JSON.parse(readFileSync(CACHE_5M, 'utf8')),
    c1: JSON.parse(readFileSync(CACHE_1M, 'utf8')),
  };
}

function periodVolRatio(c5, i) {
  if (i < LONG_BARS) return null;
  let shortSum = 0;
  let longSum = 0;
  for (let j = i - SHORT_BARS + 1; j <= i; j += 1) {
    const v = Number(c5[j]?.volume);
    if (!Number.isFinite(v)) return null;
    shortSum += v;
  }
  for (let j = i - LONG_BARS + 1; j <= i; j += 1) {
    const v = Number(c5[j]?.volume);
    if (!Number.isFinite(v)) return null;
    longSum += v;
  }
  const shortAvg = shortSum / SHORT_BARS;
  const longAvg = longSum / LONG_BARS;
  if (longAvg <= 0) return null;
  return shortAvg / longAvg;
}

function classifyRegime(rv5, rv15) {
  if (rv5 != null && rv5 >= RV5_THRESH) return 'high';
  if (rv15 != null && rv15 >= RV15_THRESH) return 'high';
  if (rv5 != null && rv5 < RV5_THRESH && rv15 != null && rv15 < RV15_THRESH) return 'low';
  return 'high';
}

function buildPeriodMap(c5) {
  const ratios = [];
  for (let i = LONG_BARS; i < c5.length; i += 1) {
    const r = periodVolRatio(c5, i);
    if (r != null) ratios.push(r);
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const p33 = q(0.33);
  const p66 = q(0.66);

  const byIndex = new Map();
  for (let i = LONG_BARS; i < c5.length; i += 1) {
    const r = periodVolRatio(c5, i);
    if (r == null) continue;
    let period = 'neutral';
    if (r <= p33) period = 'low';
    else if (r >= p66) period = 'high';
    byIndex.set(i, { period, period_vol_ratio: r });
  }

  return { byIndex, thresholds: { p33, p66, shortBars: SHORT_BARS, longBars: LONG_BARS } };
}

function detectContiguousSegments(c5, byIndex) {
  const segments = [];
  let cur = null;
  for (let i = LONG_BARS; i < c5.length; i += 1) {
    const info = byIndex.get(i);
    if (!info) continue;
    if (!cur || cur.period !== info.period) {
      if (cur) segments.push(cur);
      cur = {
        period: info.period,
        startIdx: i,
        endIdx: i,
        startTs: c5[i].t,
        endTs: c5[i].t,
        bars: 1,
      };
    } else {
      cur.endIdx = i;
      cur.endTs = c5[i].t;
      cur.bars += 1;
    }
  }
  if (cur) segments.push(cur);
  return segments;
}

function buildTrades(c5, idx1m, byIndex, maxTrades, { rvRatioFilter = false } = {}) {
  const rvHistory = {};
  const raw = [];

  for (let i = Math.max(50, LONG_BARS); i < c5.length - 1; i += 1) {
    const pinfo = byIndex.get(i);
    if (!pinfo) continue;

    const k1 = c5[i];
    const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;
    const regime = classifyRegime(vol.rv_5m, vol.rv_15m);
    const f = computeTradeFactors(c5, idx1m, i, rvHistory);
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, regime);
    if (eval_.signal === 'NONE') continue;
    if (rvRatioFilter && regime === 'high' && f.rv_ratio != null && f.rv_ratio >= RV_RATIO_MAX) continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({
      ...f,
      signal: eval_.signal,
      signalId: eval_.signalId,
      volRegime: regime,
      volPeriod: pinfo.period,
      period_vol_ratio: pinfo.period_vol_ratio,
      won,
      pnlUsd: won ? 0.5 : -0.5,
      outcome,
    });

    if (raw.length >= maxTrades) break;
  }

  return simulateMartingale(raw);
}

function stats(arr) {
  if (!arr.length) return { n: 0, mean: null, median: null };
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: s[Math.floor(s.length / 2)],
  };
}

function segmentReport(trades, period) {
  const slice = trades.filter((t) => t.volPeriod === period);
  const sim = simulateMartingale(slice);
  const s = summarizeTrades(sim);
  const highVol = slice.filter((t) => t.volRegime === 'high');
  const lowVol = slice.filter((t) => t.volRegime === 'low');
  const halts = sim.filter((t) => t.martingaleHalted).length;
  return {
    period,
    trades: slice.length,
    share: trades.length ? slice.length / trades.length : 0,
    winRate: s.winRate,
    halts: s.halts,
    haltEvents: halts,
    pnl: s.pnl,
    roi: s.roi,
    highVolTrades: highVol.length,
    lowVolTrades: lowVol.length,
    highVolWinRate: highVol.length ? highVol.filter((t) => t.won).length / highVol.length : null,
    lowVolWinRate: lowVol.length ? lowVol.filter((t) => t.won).length / lowVol.length : null,
    periodVolRatio: stats(slice.map((t) => t.period_vol_ratio)),
    rvRatio: stats(slice.map((t) => t.rv_ratio).filter(Number.isFinite)),
  };
}

function fmtTs(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

async function main() {
  const { c5, c1 } = loadCandles();
  const idx1m = build1mIndex(c1);
  const { byIndex, thresholds } = buildPeriodMap(c5);
  const segments = detectContiguousSegments(c5, byIndex);

  const allTrades = buildTrades(c5, idx1m, byIndex, TARGET, { rvRatioFilter: false });
  const filteredTrades = buildTrades(c5, idx1m, byIndex, TARGET, { rvRatioFilter: true });
  const baseline = summarizeTrades(allTrades);
  const withRv = summarizeTrades(filteredTrades);

  const periodReports = ['high', 'neutral', 'low'].map((p) => segmentReport(allTrades, p));

  const segmentStats = ['high', 'neutral', 'low'].map((p) => {
    const segs = segments.filter((s) => s.period === p);
    const durations = segs.map((s) => s.bars * 5);
    return {
      period: p,
      episodeCount: segs.length,
      avgDurationMin: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      medianDurationMin: durations.length ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] : 0,
      totalBars: segs.reduce((a, s) => a + s.bars, 0),
    };
  });

  const onlyPeriodFilters = ['high', 'neutral', 'low'].map((p) => {
    const r = applyFilterStats(allTrades, (t) => t.volPeriod === p, 0);
    const sim = summarizeTrades(simulateMartingale(allTrades.filter((t) => t.volPeriod === p)));
    return {
      rule: `only trade during ${p} volume period`,
      ...r,
      martingale: sim,
    };
  });

  const skipLow = applyFilterStats(allTrades, (t) => t.volPeriod !== 'low', 0);
  const onlyHigh = applyFilterStats(allTrades, (t) => t.volPeriod === 'high', 0);

  const rvByPeriod = ['high', 'neutral', 'low'].map((p) => {
    const sub = allTrades.filter((t) => t.volPeriod === p);
    const r = applyFilterStats(sub, (t) =>
      t.volRegime !== 'high' || t.rv_ratio == null || t.rv_ratio < RV_RATIO_MAX, 0);
    return { period: p, trades: sub.length, rvFilter: r };
  });

  const output = {
    meta: {
      targetTrades: TARGET,
      actualTrades: allTrades.length,
      thresholds,
      periodDefinition: `period_vol_ratio = avg_vol(${SHORT_BARS}x5m) / avg_vol(${LONG_BARS}x5m); tercile split`,
    },
    baselineAllPeriods: baseline,
    baselineWithRvRatioFilter: withRv,
    periodSegmentReports: periodReports,
    contiguousSegmentStats: segmentStats,
    onlyTradeInOnePeriod: onlyPeriodFilters,
    skipLowVolumePeriod: skipLow,
    onlyHighVolumePeriod: onlyHigh,
    rvRatioFilterEffectByPeriod: rvByPeriod,
    sampleHighPeriods: segments.filter((s) => s.period === 'high').slice(0, 5).map((s) => ({
      start: fmtTs(s.startTs),
      end: fmtTs(s.endTs),
      bars: s.bars,
      durationMin: s.bars * 5,
    })),
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\nPeriod thresholds: low ≤ ${thresholds.p33.toFixed(3)}, high ≥ ${thresholds.p66.toFixed(3)}`);
  console.log('\n=== BASELINE (all periods) ===');
  console.log(JSON.stringify(baseline, null, 2));
  console.log('\n=== BY VOLUME PERIOD (subset martingale) ===');
  console.table(periodReports.map((r) => ({
    period: r.period,
    trades: r.trades,
    share: `${(r.share * 100).toFixed(1)}%`,
    winRate: `${(r.winRate * 100).toFixed(2)}%`,
    halts: r.halts,
    pnl: r.pnl.toFixed(1),
    periodVolMed: r.periodVolRatio.median?.toFixed(3),
  })));
  console.log('\n=== ONLY TRADE IN ONE PERIOD TYPE ===');
  console.table(onlyPeriodFilters.map((r) => ({
    rule: r.rule,
    coverage: `${(r.coverage * 100).toFixed(1)}%`,
    winRate: `${(r.winRate * 100).toFixed(2)}%`,
    halts: r.halts,
    pnl: r.pnl.toFixed(1),
  })));
  console.log(`\nFull output: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
