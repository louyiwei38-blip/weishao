/**
 * Real-time volume filter backtest vs oracle daily threshold.
 * Usage: node scripts/backtest-volume-filter-realtime.js [--full-days=365]
 *
 * Strategy: high-vol continuation only (no rv_ratio filter)
 * Compares: rolling24h | period_ratio | oracle daily >= 825M USDT (post-hoc only)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeSignalVolatility } from '../src/utils/volatility.js';
import {
  computeRolling24hUsdt,
  computePeriodVolRatio,
  ROLLING_24H_BARS,
} from '../src/utils/volumeFilter.js';
import {
  build1mIndex,
  computeTradeFactors,
  simulateMartingale,
  summarizeTrades,
} from './lib/backtestFactors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const CACHE_5M = join(OUT_DIR, 'ohlcv-5m-cache.json');
const CACHE_1M = join(OUT_DIR, 'ohlcv-1m-cache.json');
const OUT_FILE = join(OUT_DIR, 'backtest-volume-filter-realtime.json');

const FULL_DAY_BARS = 280;
const FULL_DAYS_TARGET = Number(
  process.argv.find((a) => a.startsWith('--full-days='))?.split('=')[1] ?? 365,
);
const ORACLE_DAILY_MIN = 825_000_000;
const ACCEPT_ROI = 0.015;
const ACCEPT_COVERAGE = 0.15;
const ACCEPT_ROI_RATIO = 0.8;

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function loadCandles() {
  if (!existsSync(CACHE_5M) || !existsSync(CACHE_1M)) {
    throw new Error('Missing OHLCV cache — run: node scripts/backtest-daily-vol-pnl.js --days=365 --fetch');
  }
  return {
    c5: JSON.parse(readFileSync(CACHE_5M, 'utf8')),
    c1: JSON.parse(readFileSync(CACHE_1M, 'utf8')),
  };
}

function buildTrades(c5, idx1m, fromMs, toMs) {
  const rvHistory = {};
  const raw = [];
  const dayVolUsdt = new Map();

  for (let i = 0; i < c5.length; i += 1) {
    const dk = dayKey(c5[i].t);
    const v = Number(c5[i].volume) || 0;
    const close = Number(c5[i].close) || 0;
    dayVolUsdt.set(dk, (dayVolUsdt.get(dk) ?? 0) + v * close);
  }

  for (let i = Math.max(50, ROLLING_24H_BARS - 1); i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + 5 * 60_000;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;

    const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;
    const f = computeTradeFactors(c5, idx1m, i, rvHistory);
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    const dk = dayKey(tradeTs);
    raw.push({
      ...f,
      signal: eval_.signal,
      signalId: eval_.signalId,
      volRegime: 'high',
      rolling24hUsdt: computeRolling24hUsdt(c5, i),
      periodVolRatio: computePeriodVolRatio(c5, i),
      dayAvgVolumeUsdt: dayVolUsdt.get(dk) ?? null,
      won,
      pnlUsd: won ? 0.5 : -0.5,
      outcome,
    });
  }

  return simulateMartingale(raw);
}

function filterReport(trades, fn, label) {
  const kept = trades.filter(fn);
  const sim = simulateMartingale(kept);
  const s = summarizeTrades(sim);
  return {
    rule: label,
    kept: kept.length,
    skipped: trades.length - kept.length,
    coverage: kept.length / (trades.length || 1),
    ...s,
  };
}

function gridRolling24h(trades, baseline, oracleRoi) {
  const results = [];
  for (let th = 400_000_000; th <= 950_000_000; th += 25_000_000) {
    const r = filterReport(
      trades,
      (t) => t.rolling24hUsdt != null && t.rolling24hUsdt >= th,
      `rolling24h >= ${(th / 1e6).toFixed(0)}M`,
    );
    results.push({
      mode: 'rolling24h',
      threshold: th,
      thresholdLabel: `${(th / 1e6).toFixed(0)}M`,
      ...r,
      roiVsOracle: oracleRoi ? r.roi / oracleRoi : null,
      pnlDelta: r.pnl - baseline.pnl,
      passesAcceptance: r.roi >= ACCEPT_ROI && r.coverage >= ACCEPT_COVERAGE,
      passesOracleRatio: oracleRoi ? r.roi >= oracleRoi * ACCEPT_ROI_RATIO : false,
    });
  }
  results.sort((a, b) => {
    const score = (r) => (r.passesAcceptance ? 1000 : 0)
      + (r.passesOracleRatio ? 500 : 0)
      + r.roi * 100
      + r.coverage * 10;
    return score(b) - score(a);
  });
  return results;
}

function gridPeriodRatio(trades, baseline, oracleRoi) {
  const results = [];
  for (let th = 0.75; th <= 1.45; th += 0.025) {
    const thR = Number(th.toFixed(3));
    const r = filterReport(
      trades,
      (t) => t.periodVolRatio != null && t.periodVolRatio >= thR,
      `period_ratio >= ${thR}`,
    );
    results.push({
      mode: 'period_ratio',
      threshold: thR,
      thresholdLabel: String(thR),
      ...r,
      roiVsOracle: oracleRoi ? r.roi / oracleRoi : null,
      pnlDelta: r.pnl - baseline.pnl,
      passesAcceptance: r.roi >= ACCEPT_ROI && r.coverage >= ACCEPT_COVERAGE,
      passesOracleRatio: oracleRoi ? r.roi >= oracleRoi * ACCEPT_ROI_RATIO : false,
    });
  }
  results.sort((a, b) => {
    const score = (r) => (r.passesAcceptance ? 1000 : 0)
      + (r.passesOracleRatio ? 500 : 0)
      + r.roi * 100
      + r.coverage * 10;
    return score(b) - score(a);
  });
  return results;
}

function pickRecommended(rollingGrid, ratioGrid) {
  const inBand = (r) => r.coverage >= ACCEPT_COVERAGE && r.coverage <= 0.35;
  const byRoi = (a, b) => b.roi - a.roi;
  const highRoiRoll = rollingGrid.filter(inBand).sort(byRoi)[0];
  const highRoiRatio = ratioGrid.filter(inBand).sort(byRoi)[0];
  const maxPnlRoll = [...rollingGrid].sort((a, b) => b.pnl - a.pnl)[0];

  const highRoi = [highRoiRoll, highRoiRatio].filter(Boolean).sort(byRoi)[0] ?? highRoiRoll;
  const maxPnl = maxPnlRoll;

  const deployReady = Boolean(
    (highRoiRoll?.passesAcceptance || highRoiRoll?.passesOracleRatio)
    || (highRoiRatio?.passesAcceptance || highRoiRatio?.passesOracleRatio),
  );

  const recommended = deployReady ? highRoi : null;
  return { deployReady, recommended, highRoi, maxPnl };
}

function main() {
  const { c5, c1 } = loadCandles();
  const idx1m = build1mIndex(c1);

  const completeDaySet = new Set();
  const dayBars = new Map();
  for (const bar of c5) {
    const dk = dayKey(bar.t);
    dayBars.set(dk, (dayBars.get(dk) ?? 0) + 1);
    if ((dayBars.get(dk) ?? 0) >= FULL_DAY_BARS) completeDaySet.add(dk);
  }
  const completeDays = [...completeDaySet].sort();
  const analysisDays = completeDays.slice(-FULL_DAYS_TARGET);
  const fromMs = Date.parse(`${analysisDays[0]}T00:00:00.000Z`);
  const toMs = Date.parse(`${analysisDays.at(-1)}T00:00:00.000Z`) + 24 * 60 * 60_000;
  const daySet = new Set(analysisDays);

  const allTrades = buildTrades(c5, idx1m, fromMs, toMs);
  const inWindow = allTrades.filter((t) => daySet.has(dayKey(t.t)));
  const baseline = summarizeTrades(inWindow);

  const oracle = filterReport(
    inWindow,
    (t) => t.dayAvgVolumeUsdt != null && t.dayAvgVolumeUsdt >= ORACLE_DAILY_MIN,
    `oracle daily >= ${ORACLE_DAILY_MIN / 1e6}M USDT (post-hoc)`,
  );

  const rollingGrid = gridRolling24h(inWindow, baseline, oracle.roi);
  const ratioGrid = gridPeriodRatio(inWindow, baseline, oracle.roi);
  const bestRolling = rollingGrid.find((r) => r.passesAcceptance || r.passesOracleRatio)
    ?? rollingGrid[0];
  const bestRatio = ratioGrid.find((r) => r.passesAcceptance || r.passesOracleRatio)
    ?? ratioGrid[0];

  const { deployReady, recommended, highRoi, maxPnl } = pickRecommended(rollingGrid, ratioGrid);

  const output = {
    meta: {
      from: analysisDays[0],
      to: analysisDays.at(-1),
      fullDays: analysisDays.length,
      strategy: 'high-vol continuation only (no rv_ratio filter)',
      oracleReference: {
        dailyMinUsdt: ORACLE_DAILY_MIN,
        roi: oracle.roi,
        coverage: oracle.coverage,
        note: 'Oracle uses full-day USDT volume — NOT deployable in real-time (lag)',
      },
      acceptance: {
        minRoi: ACCEPT_ROI,
        minCoverage: ACCEPT_COVERAGE,
        minRoiVsOracle: oracle.roi * ACCEPT_ROI_RATIO,
      },
      deployReady,
      recommendedConfig: recommended ? {
        volumeFilterMode: recommended.mode,
        ...(recommended.mode === 'rolling24h'
          ? { rolling24hUsdtMin: recommended.threshold }
          : { periodVolRatioMin: recommended.threshold }),
      } : null,
      alternativeMaxPnl: maxPnl ? {
        volumeFilterMode: maxPnl.mode,
        ...(maxPnl.mode === 'rolling24h'
          ? { rolling24hUsdtMin: maxPnl.threshold }
          : { periodVolRatioMin: maxPnl.threshold }),
        coverage: maxPnl.coverage,
        roi: maxPnl.roi,
        pnl: maxPnl.pnl,
      } : null,
      documentation: {
        whyNotDailyCumulative:
          'UTC 日累计成交量在当天结束前无法确定，信号时刻不可用；仅作 oracle 对照。',
        rolling24h:
          '过去 288 根 5m K 线的 Σ(base_volume×close)，每 5m 更新，无日历边界滞后。',
        periodVolRatio:
          'avg_vol(12×5m)/avg_vol(96×5m)，衡量近 1h 相对 8h 的量能，每 5m 更新。',
        hotUpdate:
          '修改 .env 中 VOLUME_FILTER_MODE / ROLLING_24H_USDT_MIN / PERIOD_VOL_RATIO_MIN 后 pm2 restart 即可，无需改代码。',
      },
    },
    baseline,
    oracle,
    bestRolling24h: bestRolling,
    bestPeriodRatio: bestRatio,
    recommendedHighRoi: highRoi,
    recommendedMaxPnl: maxPnl,
    topRolling24h: rollingGrid.slice(0, 10),
    topPeriodRatio: ratioGrid.slice(0, 10),
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\nVolume filter backtest: ${analysisDays[0]} → ${analysisDays.at(-1)} (${analysisDays.length} days)`);
  console.log('\n=== BASELINE (high continuation, no rv_ratio) ===');
  console.log(JSON.stringify(baseline, null, 2));
  console.log('\n=== ORACLE (daily >= 825M — post-hoc, not deployable) ===');
  console.table([{
    rule: oracle.rule,
    coverage: `${(oracle.coverage * 100).toFixed(1)}%`,
    winRate: `${(oracle.winRate * 100).toFixed(2)}%`,
    halts: oracle.halts,
    pnl: oracle.pnl.toFixed(1),
    roi: `${(oracle.roi * 100).toFixed(2)}%`,
  }]);
  console.log('\n=== BEST rolling24h ===');
  console.table([{
    threshold: bestRolling.thresholdLabel,
    coverage: `${(bestRolling.coverage * 100).toFixed(1)}%`,
    roi: `${(bestRolling.roi * 100).toFixed(2)}%`,
    pnl: bestRolling.pnl.toFixed(1),
    passes: bestRolling.passesAcceptance || bestRolling.passesOracleRatio,
  }]);
  console.log('\n=== BEST period_ratio ===');
  console.table([{
    threshold: bestRatio.thresholdLabel,
    coverage: `${(bestRatio.coverage * 100).toFixed(1)}%`,
    roi: `${(bestRatio.roi * 100).toFixed(2)}%`,
    pnl: bestRatio.pnl.toFixed(1),
    passes: bestRatio.passesAcceptance || bestRatio.passesOracleRatio,
  }]);
  console.log('\n=== RECOMMENDED (high ROI, cov 15-35%) ===');
  if (highRoi) {
    console.table([{
      mode: highRoi.mode,
      threshold: highRoi.thresholdLabel,
      coverage: `${(highRoi.coverage * 100).toFixed(1)}%`,
      roi: `${(highRoi.roi * 100).toFixed(2)}%`,
      pnl: highRoi.pnl.toFixed(1),
    }]);
  }
  console.log(`\nDeploy ready: ${deployReady}`);
  if (recommended) {
    console.log('Recommended config:', output.meta.recommendedConfig);
  }
  console.log(`\nFull output: ${OUT_FILE}`);
}

main();
