/**
 * Volume-confirmation filter backtest (10k trades) vs rv_ratio baseline.
 * Usage: node scripts/backtest-10k-vol.js [--target=10000] [--min-coverage=0.65]
 */
import ccxt from 'ccxt';
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
  MARTINGALE_MAX,
} from './lib/backtestFactors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const CACHE_5M = join(OUT_DIR, 'ohlcv-5m-cache.json');
const CACHE_1M = join(OUT_DIR, 'ohlcv-1m-cache.json');
const OUT_FILE = join(OUT_DIR, 'backtest-10k-vol.json');

const SYMBOL = 'BTC/USDT';
const TARGET = Number(process.argv.find((a) => a.startsWith('--target='))?.split('=')[1] ?? 10000);
const MIN_COVERAGE = Number(process.argv.find((a) => a.startsWith('--min-coverage='))?.split('=')[1] ?? 0.65);
const RV5_THRESH = 0.00045;
const RV15_THRESH = 0.00025;
const RV_RATIO_MAX = 1.05;

const VOL_FACTORS = ['vol_ratio_5', 'vol_ratio_20', 'vol_accel'];

async function fetchAllCandles(exchange, symbol, timeframe, since, until) {
  const all = [];
  let cursor = since;
  const tfMs = timeframe === '5m' ? 5 * 60_000 : 60_000;
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
    await new Promise((r) => setTimeout(r, 60));
  }
  const dedup = new Map(all.map((c) => [c.t, c]));
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

async function loadCandles() {
  if (existsSync(CACHE_5M) && existsSync(CACHE_1M)) {
    return {
      c5: JSON.parse(readFileSync(CACHE_5M, 'utf8')),
      c1: JSON.parse(readFileSync(CACHE_1M, 'utf8')),
    };
  }
  const ex = new ccxt.okx({ enableRateLimit: true, timeout: 30_000 });
  const until = Date.now();
  const since = until - 120 * 24 * 60 * 60_000;
  const [c5, c1] = await Promise.all([
    fetchAllCandles(ex, SYMBOL, '5m', since, until),
    fetchAllCandles(ex, SYMBOL, '1m', since, until),
  ]);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE_5M, JSON.stringify(c5));
  writeFileSync(CACHE_1M, JSON.stringify(c1));
  return { c5, c1 };
}

function classifyRegime(rv5, rv15) {
  if (rv5 != null && rv5 >= RV5_THRESH) return 'high';
  if (rv15 != null && rv15 >= RV15_THRESH) return 'high';
  if (rv5 != null && rv5 < RV5_THRESH && rv15 != null && rv15 < RV15_THRESH) return 'low';
  return 'high';
}

function passesRvRatioFilter(f, regime) {
  if (regime !== 'high') return true;
  if (f.rv_ratio == null) return true;
  return f.rv_ratio < RV_RATIO_MAX;
}

function buildTrades(c5, idx1m, maxTrades, { rvRatioFilter = false } = {}) {
  const rvHistory = {};
  const raw = [];

  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;
    const regime = classifyRegime(vol.rv_5m, vol.rv_15m);
    const f = computeTradeFactors(c5, idx1m, i, rvHistory);
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, regime);
    if (eval_.signal === 'NONE') continue;
    if (rvRatioFilter && !passesRvRatioFilter(f, regime)) continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({
      ...f,
      signal: eval_.signal,
      signalId: eval_.signalId,
      volRegime: regime,
      won,
      pnlUsd: won ? 0.5 : -0.5,
      outcome,
    });

    if (raw.length >= maxTrades) break;
  }

  return simulateMartingale(raw);
}

function stats(arr) {
  if (!arr.length) return { n: 0, mean: null, median: null, p25: null, p75: null };
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.floor(p * (s.length - 1))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: q(0.5),
    p25: q(0.25),
    p75: q(0.75),
  };
}

function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let correct = 0;
  let total = 0;
  for (const p of pos) {
    for (const n of neg) {
      total += 1;
      if (p > n) correct += 1;
      else if (p === n) correct += 0.5;
    }
  }
  return correct / total;
}

function findProfitSegments(trades, minWinRate = 0.55, minLen = 6) {
  const segments = [];
  let start = 0;
  while (start < trades.length) {
    let best = null;
    for (let end = start + minLen - 1; end < trades.length; end += 1) {
      const slice = trades.slice(start, end + 1);
      const wins = slice.filter((t) => t.won).length;
      const wr = wins / slice.length;
      const pnl = slice.reduce((s, t) => s + t.pnlUsd, 0);
      if (wr >= minWinRate && pnl > 0) best = { start, end, wr, pnl, len: slice.length };
    }
    if (best) {
      segments.push(best);
      start = best.end + 1;
    } else {
      start += 1;
    }
  }
  return segments;
}

function buildComparisonSamples(trades) {
  const segments = findProfitSegments(trades);
  const profitIdx = new Set();
  for (const seg of segments) {
    for (let i = seg.start; i <= seg.end; i += 1) profitIdx.add(i);
  }
  const profitTrades = [...profitIdx].map((i) => trades[i]);
  const haltLoss = trades.filter((t) => t.inHaltStreak || t.martingaleHalted);
  return { profitTrades, haltLoss, segments };
}

function rankVolFactors(profitTrades, haltLoss) {
  const rows = [];
  for (const key of VOL_FACTORS) {
    const pv = profitTrades.map((t) => t[key]).filter(Number.isFinite);
    const lv = haltLoss.map((t) => t[key]).filter(Number.isFinite);
    const ps = stats(pv);
    const ls = stats(lv);
    const higherIsProfit = ps.mean != null && ls.mean != null ? ps.mean > ls.mean : null;
    const aucVal = higherIsProfit ? auc(pv, lv) : auc(lv, pv);
    rows.push({
      factor: key,
      profitMedian: ps.median,
      profitP25: ps.p25,
      profitP75: ps.p75,
      haltMedian: ls.median,
      haltP25: ls.p25,
      haltP75: ls.p75,
      profitMean: ps.mean,
      haltMean: ls.mean,
      discrimination: aucVal != null ? Number(aucVal.toFixed(3)) : null,
      higherInProfit: higherIsProfit,
    });
  }
  rows.sort((a, b) => (b.discrimination ?? 0) - (a.discrimination ?? 0));
  return rows;
}

function gridSearch(trades, baseline, field, thresholds, highVolOnly = true) {
  const results = [];
  for (const th of thresholds) {
    const fn = (t) => {
      if (highVolOnly && t.volRegime !== 'high') return true;
      return t[field] == null || t[field] >= th;
    };
    const r = applyFilterStats(trades, fn, MIN_COVERAGE);
    if (!r) continue;
    results.push({
      rule: `${field} >= ${th}${highVolOnly ? ' (high-vol only)' : ''}`,
      field,
      threshold: th,
      highVolOnly,
      ...r,
      score: r.haltReduction * 1.2 + r.coverage * 0.6 + Math.min(r.pnlDelta, 150) / 100,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

function applyNamedFilter(trades, name, fn, minCov = MIN_COVERAGE) {
  const r = applyFilterStats(trades, fn, minCov);
  return r ? { name, ...r } : null;
}

async function main() {
  console.log('Loading OHLCV...');
  const { c5, c1 } = await loadCandles();
  const idx1m = build1mIndex(c1);
  console.log(`5m=${c5.length}, building ${TARGET} baseline trades...`);

  const baselineTrades = buildTrades(c5, idx1m, TARGET, { rvRatioFilter: false });
  const baseline = summarizeTrades(baselineTrades);
  const { profitTrades, haltLoss, segments } = buildComparisonSamples(baselineTrades);
  const factorRanking = rankVolFactors(profitTrades, haltLoss);

  const grids = {
    vol_ratio_5: [0.7, 0.8, 0.9, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.8, 2.0],
    vol_ratio_20: [0.7, 0.8, 0.9, 1.0, 1.05, 1.1, 1.2, 1.3, 1.5, 1.8, 2.0],
    vol_accel: [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 1.8, 2.0, 2.5, 3.0],
  };

  const gridResults65 = [];
  const gridResultsAll = [];
  for (const [field, thresholds] of Object.entries(grids)) {
    for (const th of thresholds) {
      const fn = (t) => {
        if (t.volRegime !== 'high') return true;
        return t[field] == null || t[field] >= th;
      };
      const rAll = applyFilterStats(baselineTrades, fn, 0);
      if (!rAll) continue;
      const row = {
        rule: `${field} >= ${th} (high-vol only)`,
        field,
        threshold: th,
        ...rAll,
        score: rAll.haltReduction * 1.2 + rAll.coverage * 0.6 + Math.min(rAll.pnlDelta, 150) / 100,
        meetsCoverage65: rAll.coverage >= MIN_COVERAGE,
      };
      gridResultsAll.push(row);
      if (row.meetsCoverage65) gridResults65.push(row);
    }
  }
  gridResultsAll.sort((a, b) => b.score - a.score);
  gridResults65.sort((a, b) => b.score - a.score);

  const rvRatioBaseline = applyNamedFilter(
    baselineTrades,
    `rv_ratio < ${RV_RATIO_MAX} (current Scheme A)`,
    (t) => t.volRegime !== 'high' || t.rv_ratio == null || t.rv_ratio < RV_RATIO_MAX,
    0,
  );

  const topVol = gridResults65.filter((r) => r.pnl > baseline.pnl && r.haltReduction > 0);
  const bestVol65 = topVol[0] ?? gridResults65[0] ?? null;
  const bestVolAny = gridResultsAll
    .filter((r) => r.pnl > baseline.pnl)
    .sort((a, b) => b.pnl - a.pnl)[0] ?? null;

  let comboBest = null;
  if (bestVolAny) {
    const th = bestVolAny.threshold;
    const field = bestVolAny.field;
    comboBest = applyNamedFilter(
      baselineTrades,
      `${field}>=${th} + rv_ratio<${RV_RATIO_MAX}`,
      (t) => {
        if (t.volRegime !== 'high') return true;
        const volOk = t[field] == null || t[field] >= th;
        const rvOk = t.rv_ratio == null || t.rv_ratio < RV_RATIO_MAX;
        return volOk && rvOk;
      },
      0,
    );
  }

  const recommended65 = gridResults65
    .filter((r) => r.pnlDelta > 0)
    .sort((a, b) => {
      const sa = a.haltReduction * 1.5 + a.pnlDelta / 80 + a.coverage;
      const sb = b.haltReduction * 1.5 + b.pnlDelta / 80 + b.coverage;
      return sb - sa;
    })
    .slice(0, 10);

  const recommendedAny = gridResultsAll
    .filter((r) => r.pnlDelta > 0 && r.coverage >= 0.30)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 15);
  const beatsRvRatio = (bestVol65 ?? bestVolAny) && rvRatioBaseline
    ? (bestVol65 ?? bestVolAny).pnl > rvRatioBaseline.pnl
      && (bestVol65 ?? bestVolAny).halts <= rvRatioBaseline.halts
    : false;

  const output = {
    meta: {
      symbol: SYMBOL,
      targetTrades: TARGET,
      actualTrades: baselineTrades.length,
      minCoverage: MIN_COVERAGE,
      rv5mThreshold: RV5_THRESH,
      rv15mThreshold: RV15_THRESH,
      rvRatioMax: RV_RATIO_MAX,
      martingaleMaxLosses: MARTINGALE_MAX,
    },
    baseline,
    profitSegmentCount: segments.length,
    profitSegmentTrades: profitTrades.length,
    haltRiskTrades: haltLoss.length,
    factorRanking,
    currentRvRatioFilter: rvRatioBaseline,
    topVolumeFiltersCoverage65: recommended65,
    topVolumeFiltersAnyCoverage: recommendedAny,
    bestVolumeFilterCoverage65: bestVol65,
    bestVolumeFilterAnyCoverage: bestVolAny,
    bestVolumePlusRvRatio: comboBest,
    allGridResults: gridResultsAll.slice(0, 45),
    gridResultsMeetingCoverage65: gridResults65,
    conclusion: {
      beatsCurrentRvRatioFilter: beatsRvRatio,
      recommendReplaceRvRatio: beatsRvRatio,
      volumeFilterMeetsCoverage65: gridResults65.length > 0,
      profitTypicalVolume: factorRanking.map((r) => ({
        factor: r.factor,
        median: r.profitMedian,
        p25: r.profitP25,
        p75: r.profitP75,
        auc: r.discrimination,
      })),
    },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log('\n=== BASELINE (no volume/rv filter) ===');
  console.log(JSON.stringify(baseline, null, 2));
  console.log('\n=== VOLUME FACTOR RANKING (profit segments vs halt-risk) ===');
  console.table(factorRanking);
  console.log('\n=== CURRENT rv_ratio FILTER ===');
  console.table(rvRatioBaseline ? [{
    rule: rvRatioBaseline.name,
    coverage: `${(rvRatioBaseline.coverage * 100).toFixed(1)}%`,
    halts: rvRatioBaseline.halts,
    pnl: rvRatioBaseline.pnl.toFixed(1),
    haltReduction: `${(rvRatioBaseline.haltReduction * 100).toFixed(0)}%`,
  }] : []);
  console.log('\n=== TOP VOLUME FILTERS (any coverage, pnl>baseline) ===');
  console.table(recommendedAny.slice(0, 10).map((r) => ({
    rule: r.rule,
    coverage: `${(r.coverage * 100).toFixed(1)}%`,
    halts: r.halts,
    haltCut: `${(r.haltReduction * 100).toFixed(0)}%`,
    pnl: r.pnl.toFixed(1),
    pnlDelta: r.pnlDelta.toFixed(1),
  })));
  console.log(`\nfilters meeting coverage≥65%: ${gridResults65.length}`);
  console.log(`beats rv_ratio filter: ${beatsRvRatio}`);
  console.log(`Full output: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
