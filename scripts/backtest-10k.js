/**
 * OKX BTC 5m backtest (~10k trades) + halt-avoidance factor search.
 * Usage: node scripts/backtest-10k.js [--target 10000] [--min-coverage 0.65]
 */
import ccxt from 'ccxt';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyCandle } from '../src/strategy/reversalContinuation.js';
import { computeSignalVolatility } from '../src/utils/volatility.js';
import {
  RV_THRESH,
  build1mIndex,
  computeTradeFactors,
  simulateMartingale,
  applyFilterStats,
  summarizeTrades,
} from './lib/backtestFactors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');

const SYMBOL = 'BTC/USDT';
const TARGET_TRADES = Number(process.argv.find((a) => a.startsWith('--target='))?.split('=')[1]
  ?? process.env.TARGET_TRADES ?? 10000);
const MIN_COVERAGE = Number(process.argv.find((a) => a.startsWith('--min-coverage='))?.split('=')[1]
  ?? 0.65);

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
    await new Promise((r) => setTimeout(r, 80));
  }
  const dedup = new Map(all.map((c) => [c.t, c]));
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

function buildTrades(c5, idx1m, maxTrades) {
  const rvHistory = {};
  const raw = [];

  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;
    const highVol = (vol.rv_5m ?? 0) >= RV_THRESH || (vol.rv_15m ?? 0) >= RV_THRESH;
    if (!highVol) continue;

    const f = computeTradeFactors(c5, idx1m, i, rvHistory);
    if (f.signal === 'NONE') continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (f.signal === 'UP' && outcome === 'BULL')
      || (f.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({
      ...f,
      won,
      pnlUsd: won ? 0.5 : -0.5,
      outcome,
    });

    if (raw.length >= maxTrades) break;
  }

  return simulateMartingale(raw);
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

const FACTORS = [
  'rv_5m', 'rv_15m', 'rv_ratio', 'rv_accel', 'atr_pct', 'ER_20',
  'pivot_cross_count_12', 'range_compression', 'body_ratio_mean_6',
  'signal_body_pct', 'signal_wick_dominance', 'prev_same_dir_streak', 'breakout_dist',
];

function rankFactors(trades) {
  const haltRisk = trades.filter((t) => t.inHaltStreak || t.martingaleHalted);
  const safe = trades.filter((t) => t.won);
  const rows = [];

  for (const key of FACTORS) {
    const sv = safe.map((t) => t[key]).filter(Number.isFinite);
    const hv = haltRisk.map((t) => t[key]).filter(Number.isFinite);
    const ss = stats(sv);
    const hs = stats(hv);
    const higherIsSafe = ss.mean != null && hs.mean != null ? ss.mean > hs.mean : null;
    const aucVal = higherIsSafe ? auc(sv, hv) : auc(hv, sv);
    rows.push({
      factor: key,
      safeMedian: ss.median,
      haltMedian: hs.median,
      safeMean: ss.mean,
      haltMean: hs.mean,
      discrimination: aucVal != null ? Number(aucVal.toFixed(3)) : null,
      higherInSafe: higherIsSafe,
    });
  }
  rows.sort((a, b) => (b.discrimination ?? 0) - (a.discrimination ?? 0));
  return rows;
}

function gridSearchSingle(trades, baseline) {
  const results = [];
  const grids = {
    signal_wick_dominance: [0.25, 0.30, 0.35, 0.40, 0.45],
    signal_body_pct: [0.35, 0.40, 0.45, 0.50, 0.55],
    rv_5m: [0.0003, 0.00035, 0.0004, 0.00045, 0.0005],
    breakout_dist: [0.2, 0.25, 0.30, 0.35, 0.40],
    ER_20: [0.12, 0.15, 0.18, 0.20, 0.22],
    pivot_cross_count_12: [1, 2, 3, 4],
    rv_accel: [1.0, 1.2, 1.4, 1.6],
    rv_ratio: [0.85, 0.95, 1.05, 1.15],
    atr_pct: [0.0015, 0.0020, 0.0025],
  };

  for (const [field, thresholds] of Object.entries(grids)) {
    for (const th of thresholds) {
      const lowerBetter = ['signal_wick_dominance', 'rv_5m', 'rv_accel', 'rv_ratio', 'atr_pct',
        'pivot_cross_count_12'].includes(field);
      const upperBetter = ['signal_body_pct', 'ER_20'].includes(field);
      const skipHigh = lowerBetter
        ? (t) => t[field] == null || t[field] < th
        : upperBetter
          ? (t) => t[field] == null || t[field] >= th
          : (t) => t[field] == null || t[field] < th;

      if (field === 'breakout_dist') {
        const r = applyFilterStats(trades, (t) => !(t.rv_5m > 0.00035 && t.breakout_dist > th && t.signal_wick_dominance > 0.22), MIN_COVERAGE);
        if (r) {
          results.push({
            rule: `SKIP rv>0.00035 & breakout>${th} & wick>0.22`,
            field: 'combo_breakout',
            threshold: th,
            ...r,
            score: r.haltReduction * 2 + r.coverage + r.pnlDelta / 50,
          });
        }
        continue;
      }

      const r = applyFilterStats(trades, skipHigh, MIN_COVERAGE);
      if (!r) continue;
      const dir = lowerBetter ? `< ${th}` : field === 'breakout_dist' ? `> ${th} skip` : `>= ${th}`;
      results.push({
        rule: `${field} ${dir}`,
        field,
        threshold: th,
        ...r,
        score: r.haltReduction * 2 + r.coverage + r.pnlDelta / 50,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

function searchCombos(trades, singles) {
  const top = singles.slice(0, 8);
  const combos = [];

  const ruleFns = {
    wick035: (t) => t.signal_wick_dominance == null || t.signal_wick_dominance < 0.35,
    body045: (t) => t.signal_body_pct == null || t.signal_body_pct >= 0.45,
    falseBo: (t) => !(t.rv_5m > 0.0004 && t.breakout_dist > 0.30 && t.signal_wick_dominance > 0.25),
    rvCap: (t) => t.rv_5m == null || t.rv_5m < 0.00048,
    erMin: (t) => t.ER_20 == null || t.ER_20 >= 0.14,
    accelCap: (t) => t.rv_accel == null || t.rv_accel < 1.35,
  };

  const names = Object.keys(ruleFns);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i];
      const b = names[j];
      const fn = (t) => ruleFns[a](t) && ruleFns[b](t);
      const r = applyFilterStats(trades, fn, MIN_COVERAGE);
      if (r) {
        combos.push({ rule: `${a} + ${b}`, ...r, score: r.haltReduction * 2.5 + r.coverage + r.pnlDelta / 40 });
      }
    }
  }

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      for (let k = j + 1; k < names.length; k += 1) {
        const fn = (t) => ruleFns[names[i]](t) && ruleFns[names[j]](t) && ruleFns[names[k]](t);
        const r = applyFilterStats(trades, fn, MIN_COVERAGE);
        if (r) {
          combos.push({
            rule: `${names[i]} + ${names[j]} + ${names[k]}`,
            ...r,
            score: r.haltReduction * 3 + r.coverage + r.pnlDelta / 30,
          });
        }
      }
    }
  }

  combos.sort((a, b) => b.score - a.score);
  return combos.slice(0, 15);
}

async function main() {
  const ex = new ccxt.okx({ enableRateLimit: true, timeout: 30_000 });
  const until = Date.now();
  // ~10000 trades need ~20000 5m bars (~70d); fetch 120d buffer
  const since = until - 120 * 24 * 60 * 60_000;

  console.log(`Fetching OKX ${SYMBOL} 5m/1m from ${new Date(since).toISOString()} ...`);
  const [c5, c1] = await Promise.all([
    fetchAllCandles(ex, SYMBOL, '5m', since, until),
    fetchAllCandles(ex, SYMBOL, '1m', since, until),
  ]);
  console.log(`Loaded 5m=${c5.length}, 1m=${c1.length}`);

  const idx1m = build1mIndex(c1);
  const trades = buildTrades(c5, idx1m, TARGET_TRADES);
  const baseline = summarizeTrades(trades);
  console.log(`Trades: ${trades.length}, baseline winRate=${(baseline.winRate * 100).toFixed(2)}%, halts=${baseline.halts}, pnl=${baseline.pnl.toFixed(1)}`);

  const haltRisk = trades.filter((t) => t.inHaltStreak || t.martingaleHalted);
  const factorRanking = rankFactors(trades);
  const singleRules = gridSearchSingle(trades, baseline);
  const comboRules = searchCombos(trades, singleRules);

  const bestBalanced = [...singleRules, ...comboRules]
    .filter((r) => r.coverage >= MIN_COVERAGE && r.haltReduction > 0)
    .sort((a, b) => {
      const sa = a.haltReduction * 1.5 + a.coverage * 0.8 + Math.min(a.pnlDelta, 20) / 100;
      const sb = b.haltReduction * 1.5 + b.coverage * 0.8 + Math.min(b.pnlDelta, 20) / 100;
      return sb - sa;
    })
    .slice(0, 10);

  const output = {
    meta: {
      exchange: 'okx',
      symbol: SYMBOL,
      targetTrades: TARGET_TRADES,
      actualTrades: trades.length,
      minCoverage: MIN_COVERAGE,
      period: {
        start: new Date(c5[50]?.t ?? since).toISOString(),
        end: new Date(c5.at(-2)?.t ?? until).toISOString(),
      },
      rvThreshold: RV_THRESH,
      martingaleMaxLosses: 4,
    },
    baseline,
    haltStats: {
      haltEvents: trades.filter((t) => t.martingaleHalted).length,
      haltStreakTrades: haltRisk.length,
      haltStreakRate: haltRisk.length / trades.length,
    },
    factorRanking,
    topSingleRules: singleRules.slice(0, 15),
    topComboRules: comboRules.slice(0, 10),
    recommended: bestBalanced,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'backtest-10k.json'), JSON.stringify(output, null, 2));
  writeFileSync(join(OUT_DIR, 'backtest-10k-trades.jsonl'), trades.map((t) => JSON.stringify(t)).join('\n'));

  console.log('\n=== BASELINE ===');
  console.log(JSON.stringify(baseline, null, 2));
  console.log('\n=== TOP FACTORS (halt-risk vs safe) ===');
  console.table(factorRanking.slice(0, 8));
  console.log('\n=== RECOMMENDED RULES (halt↓ + coverage≥65%) ===');
  console.table(bestBalanced.map((r) => ({
    rule: r.rule,
    coverage: `${(r.coverage * 100).toFixed(1)}%`,
    halts: r.halts,
    haltReduction: `${(r.haltReduction * 100).toFixed(0)}%`,
    winRate: `${(r.winRate * 100).toFixed(2)}%`,
    pnl: r.pnl.toFixed(1),
  })));
  console.log(`\nFull output: logs/backtest-10k.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
