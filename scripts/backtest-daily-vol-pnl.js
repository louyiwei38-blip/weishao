/**
 * Daily backtest: volume vs PnL, no signal filters.
 * Usage:
 *   node scripts/backtest-daily-vol-pnl.js --from=2026-06-01 --to=2026-06-10
 *   node scripts/backtest-daily-vol-pnl.js --days=365
 *   node scripts/backtest-daily-vol-pnl.js --days=365 --regime=high-only
 *   node scripts/backtest-daily-vol-pnl.js --days=365 --fetch
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
  summarizeTrades,
} from './lib/backtestFactors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const CACHE_5M = join(OUT_DIR, 'ohlcv-5m-cache.json');
const CACHE_1M = join(OUT_DIR, 'ohlcv-1m-cache.json');

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const REGIME_MODE = parseArg('regime', 'dual'); // dual | high-only
const FULL_DAY_BARS = 280;
const FULL_DAYS_TARGET = Number(parseArg('full-days', '365'));
const OUT_FILE = join(
  OUT_DIR,
  REGIME_MODE === 'high-only'
    ? 'backtest-daily-vol-pnl-high-only.json'
    : 'backtest-daily-vol-pnl.json',
);

const SYMBOL = 'BTC/USDT';
const RV5_THRESH = 0.00045;
const RV15_THRESH = 0.00025;
const WARMUP_MS = 8 * 24 * 60 * 60_000;

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchAllCandles(exchange, symbol, timeframe, since, until) {
  const all = [];
  let cursor = since;
  const tfMs = timeframe === '5m' ? 5 * 60_000 : 60_000;
  let batches = 0;
  while (cursor < until) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, cursor, 300);
    batches += 1;
    if (!batch.length) break;
    for (const row of batch) {
      const [t, o, h, l, c, v] = row;
      if (t >= until) break;
      all.push({ t, open: o, high: h, low: l, close: c, volume: v });
    }
    const lastT = batch.at(-1)[0];
    if (lastT <= cursor) break;
    cursor = lastT + tfMs;
    if (batches % 50 === 0) {
      process.stdout.write(`  ${timeframe} batches=${batches}, rows=${all.length}, at=${new Date(lastT).toISOString().slice(0, 10)}\r`);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  const dedup = new Map(all.map((c) => [c.t, c]));
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

async function ensureCandles(fromMs, toMs) {
  const needSince = fromMs - WARMUP_MS;
  let c5 = existsSync(CACHE_5M) ? JSON.parse(readFileSync(CACHE_5M, 'utf8')) : [];
  let c1 = existsSync(CACHE_1M) ? JSON.parse(readFileSync(CACHE_1M, 'utf8')) : [];
  const cacheStart = c5[0]?.t ?? Infinity;
  const cacheEnd = c5.at(-1)?.t ?? 0;
  const covers = c5.length && cacheStart <= needSince && cacheEnd >= toMs - 5 * 60_000;

  if (covers && !hasFlag('fetch')) {
    console.log(`Using cache: ${new Date(cacheStart).toISOString()} → ${new Date(cacheEnd).toISOString()}`);
    return { c5, c1 };
  }

  console.log(`Fetching OKX ${SYMBOL} 5m/1m (${new Date(needSince).toISOString()} → ${new Date(toMs).toISOString()}) ...`);
  const ex = new ccxt.okx({ enableRateLimit: true, timeout: 60_000 });
  const [f5, f1] = await Promise.all([
    fetchAllCandles(ex, SYMBOL, '5m', needSince, toMs),
    fetchAllCandles(ex, SYMBOL, '1m', needSince, toMs),
  ]);
  console.log(`\nFetched 5m=${f5.length}, 1m=${f1.length}`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE_5M, JSON.stringify(f5));
  writeFileSync(CACHE_1M, JSON.stringify(f1));
  return { c5: f5, c1: f1 };
}

function classifyRegime(rv5, rv15) {
  if (rv5 != null && rv5 >= RV5_THRESH) return 'high';
  if (rv15 != null && rv15 >= RV15_THRESH) return 'high';
  if (rv5 != null && rv5 < RV5_THRESH && rv15 != null && rv15 < RV15_THRESH) return 'low';
  return 'high';
}

function buildTrades(c5, idx1m, fromMs, toMs) {
  const rvHistory = {};
  const raw = [];
  const alwaysHigh = REGIME_MODE === 'high-only';

  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + 5 * 60_000;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;

    const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;
    const regime = alwaysHigh ? 'high' : classifyRegime(vol.rv_5m, vol.rv_15m);
    const f = computeTradeFactors(c5, idx1m, i, rvHistory);
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, regime);
    if (eval_.signal === 'NONE') continue;

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
  }

  return simulateMartingale(raw);
}

function dailyMarketVolume(c5, fromMs, toMs) {
  const byDay = new Map();
  for (const c of c5) {
    if (c.t < fromMs || c.t >= toMs) continue;
    const dk = dayKey(c.t);
    if (!byDay.has(dk)) {
      byDay.set(dk, { bars: 0, totalVolumeBtc: 0, totalVolumeUsdt: 0, prices: [] });
    }
    const row = byDay.get(dk);
    const btcVol = Number(c.volume) || 0;
    const close = Number(c.close) || 0;
    row.bars += 1;
    row.totalVolumeBtc += btcVol;
    row.totalVolumeUsdt += btcVol * close;
    row.prices.push(close);
  }
  return byDay;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    num += x * y;
    dx += x * x;
    dy += y * y;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

function summarizeDay(trades) {
  let streak = 0;
  let halts = 0;
  let wins = 0;
  let pnl = 0;
  let highVol = 0;
  let lowVol = 0;
  for (const t of trades) {
    pnl += t.pnlUsd;
    if (t.won) wins += 1;
    if (t.volRegime === 'high') highVol += 1;
    else if (t.volRegime === 'low') lowVol += 1;
    if (t.won) streak = 0;
    else {
      streak += 1;
      if (streak >= 4) { halts += 1; streak = 0; }
    }
  }
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    halts,
    pnl,
    roi: pnl / (trades.length * 0.5 || 1),
    highVolTrades: highVol,
    lowVolTrades: lowVol,
  };
}

function rollupMonthly(daily) {
  const byMonth = new Map();
  for (const d of daily) {
    const mk = d.date.slice(0, 7);
    if (!byMonth.has(mk)) {
      byMonth.set(mk, {
        month: mk,
        days: 0,
        totalVolumeUsdt: 0,
        trades: 0,
        wins: 0,
        halts: 0,
        pnl: 0,
      });
    }
    const m = byMonth.get(mk);
    m.days += 1;
    m.totalVolumeUsdt += d.market.totalVolumeUsdt;
    m.trades += d.trading.trades;
    m.wins += d.trading.wins;
    m.halts += d.trading.halts;
    m.pnl += d.trading.pnl;
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
    ...m,
    totalVolumeUsdt: Number(m.totalVolumeUsdt.toFixed(0)),
    avgDailyVolumeUsdt: Number((m.totalVolumeUsdt / m.days).toFixed(0)),
    winRate: m.trades ? m.wins / m.trades : 0,
    roi: m.pnl / (m.trades * 0.5 || 1),
    pnl: Number(m.pnl.toFixed(1)),
  }));
}

function volumeTerciles(fullDays) {
  if (!fullDays.length) return [];
  const sorted = [...fullDays].sort(
    (a, b) => a.market.avgDailyVolumeUsdt - b.market.avgDailyVolumeUsdt,
  );
  const n = sorted.length;
  const q = (p) => sorted[Math.floor(p * (n - 1))].market.avgDailyVolumeUsdt;
  const p33 = q(0.33);
  const p66 = q(0.66);
  const groups = { low: [], mid: [], high: [] };
  for (const d of sorted) {
    const v = d.market.avgDailyVolumeUsdt;
    const g = v <= p33 ? 'low' : v >= p66 ? 'high' : 'mid';
    groups[g].push(d);
  }
  return ['low', 'mid', 'high'].map((key) => {
    const arr = groups[key];
    const pnl = arr.reduce((s, d) => s + d.trading.pnl, 0);
    const trades = arr.reduce((s, d) => s + d.trading.trades, 0);
    const wins = arr.reduce((s, d) => s + d.trading.wins, 0);
    const avgVol = arr.reduce((s, d) => s + d.market.avgDailyVolumeUsdt, 0) / (arr.length || 1);
    return {
      bucket: key,
      days: arr.length,
      avgDailyVolumeUsdt: Number(avgVol.toFixed(0)),
      trades,
      winRate: trades ? wins / trades : 0,
      pnl: Number(pnl.toFixed(1)),
    };
  }).concat([{ thresholds: { p33: Number(p33.toFixed(0)), p66: Number(p66.toFixed(0)) } }]);
}

function resolveRange() {
  const days = Number(parseArg('days', '0'));
  const toMs = Date.now();
  if (days > 0) {
    const fromMs = toMs - days * 24 * 60 * 60_000;
    return {
      fromStr: dayKey(fromMs),
      toStr: dayKey(toMs),
      fromMs: Date.parse(`${dayKey(fromMs)}T00:00:00.000Z`),
      toMs: Date.parse(`${dayKey(toMs)}T00:00:00.000Z`) + 24 * 60 * 60_000,
    };
  }
  const fromStr = parseArg('from', '2026-06-01');
  const toStr = parseArg('to', '2026-06-10');
  return {
    fromStr,
    toStr,
    fromMs: Date.parse(`${fromStr}T00:00:00.000Z`),
    toMs: Date.parse(`${toStr}T00:00:00.000Z`) + 24 * 60 * 60_000,
  };
}

async function main() {
  const { fromStr, toStr, fromMs, toMs } = resolveRange();
  const { c5, c1 } = await ensureCandles(fromMs, toMs);
  const idx1m = build1mIndex(c1);
  const trades = buildTrades(c5, idx1m, fromMs, toMs);
  const volByDay = dailyMarketVolume(c5, fromMs, toMs);

  const tradeByDay = new Map();
  for (const t of trades) {
    const dk = dayKey(t.t);
    if (!tradeByDay.has(dk)) tradeByDay.set(dk, []);
    tradeByDay.get(dk).push(t);
  }

  const allDays = [...new Set([...volByDay.keys(), ...tradeByDay.keys()])].sort();
  const dailyAll = allDays.map((date) => {
    const vol = volByDay.get(date) ?? {
      bars: 0, totalVolumeBtc: 0, totalVolumeUsdt: 0, prices: [],
    };
    const dayTrades = tradeByDay.get(date) ?? [];
    const stats = summarizeDay(dayTrades);
    const avgBarVolUsdt = vol.bars ? vol.totalVolumeUsdt / vol.bars : 0;
    const avgDailyVolUsdt = vol.bars ? vol.totalVolumeUsdt : 0;
    return {
      date,
      market: {
        bars5m: vol.bars,
        totalVolumeBtc: Number(vol.totalVolumeBtc.toFixed(4)),
        totalVolumeUsdt: Number(vol.totalVolumeUsdt.toFixed(0)),
        avgBarVolumeUsdt: Number(avgBarVolUsdt.toFixed(0)),
        avgDailyVolumeUsdt: Number(avgDailyVolUsdt.toFixed(0)),
        closeFirst: vol.prices[0] ?? null,
        closeLast: vol.prices.at(-1) ?? null,
      },
      trading: stats,
    };
  });

  const completeDays = dailyAll.filter((d) => d.market.bars5m >= FULL_DAY_BARS);
  const daily = completeDays.slice(-FULL_DAYS_TARGET);
  const analysisFrom = daily[0]?.date ?? fromStr;
  const analysisTo = daily.at(-1)?.date ?? toStr;

  const vols = daily.map((d) => d.market.avgDailyVolumeUsdt);
  const pnls = daily.map((d) => d.trading.pnl);
  const tradesN = daily.map((d) => d.trading.trades);
  const corrVolPnl = pearson(vols, pnls);
  const corrVolTrades = pearson(vols, tradesN);

  const analysisTrades = trades.filter((t) => {
    const dk = dayKey(t.t);
    return daily.some((d) => d.date === dk);
  });
  const baseline = summarizeTrades(analysisTrades);
  const monthly = rollupMonthly(daily);
  const terciles = volumeTerciles(daily);
  const dataEnd = new Date(c5.at(-1).t).toISOString();
  const partialDays = dailyAll.filter((d) => d.market.bars5m > 0 && d.market.bars5m < FULL_DAY_BARS).length;

  const strategyNote = REGIME_MODE === 'high-only'
    ? 'always high-vol continuation on S1/S2 (ignore RV regime), no rv_ratio filter'
    : 'dual RV regime (high continuation / low reversal), no rv_ratio filter';

  const output = {
    meta: {
      from: analysisFrom,
      to: analysisTo,
      regimeMode: REGIME_MODE,
      fullDaysTarget: FULL_DAYS_TARGET,
      fullDaysActual: daily.length,
      partialDaysExcluded: partialDays,
      filters: strategyNote,
      volumeUnit: 'USDT (base_volume * close per 5m bar)',
      dataCacheEnd: dataEnd,
      correlationNote: `Pearson on last ${FULL_DAYS_TARGET} complete days (bars5m >= ${FULL_DAY_BARS})`,
    },
    summary: baseline,
    correlation: {
      avgDailyVolumeUsdt_vs_pnl: corrVolPnl != null ? Number(corrVolPnl.toFixed(4)) : null,
      avgDailyVolumeUsdt_vs_tradeCount: corrVolTrades != null ? Number(corrVolTrades.toFixed(4)) : null,
    },
    volumeTerciles: terciles,
    monthly,
    daily,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\nBacktest ${analysisFrom} → ${analysisTo}`);
  console.log(`Mode: ${REGIME_MODE} | ${strategyNote}`);
  console.log(`Complete days: ${daily.length} (excluded ${partialDays} partial)`);
  console.log(`Cache ends: ${dataEnd}`);
  console.log('\n=== SUMMARY (365 complete days) ===');
  console.log(JSON.stringify(baseline, null, 2));
  console.log('\n=== MONTHLY ===');
  console.table(monthly.map((m) => ({
    month: m.month,
    days: m.days,
    avgDailyVolUsdt: `${(m.avgDailyVolumeUsdt / 1e6).toFixed(1)}M`,
    trades: m.trades,
    winRate: `${(m.winRate * 100).toFixed(1)}%`,
    halts: m.halts,
    pnl: m.pnl.toFixed(1),
  })));
  console.log('\n=== VOLUME TERCILES (avg daily USDT) ===');
  console.table(terciles.filter((t) => t.bucket).map((t) => ({
    bucket: t.bucket,
    days: t.days,
    avgDailyVolUsdt: `${(t.avgDailyVolumeUsdt / 1e6).toFixed(1)}M`,
    trades: t.trades,
    winRate: `${(t.winRate * 100).toFixed(1)}%`,
    pnl: t.pnl.toFixed(1),
  })));
  console.log('\n=== CORRELATION (365 complete days) ===');
  console.log(`avg daily volume USDT ↔ PnL: r=${corrVolPnl?.toFixed(4) ?? 'N/A'}`);
  console.log(`avg daily volume USDT ↔ trade count: r=${corrVolTrades?.toFixed(4) ?? 'N/A'}`);

  if (daily.length <= 31) {
    console.log('\n=== DAILY ===');
    console.table(daily.map((d) => ({
      date: d.date,
      avgVolUsdt: `${(d.market.avgDailyVolumeUsdt / 1e6).toFixed(1)}M`,
      trades: d.trading.trades,
      winRate: `${(d.trading.winRate * 100).toFixed(1)}%`,
      halts: d.trading.halts,
      pnl: d.trading.pnl.toFixed(1),
    })));
  } else {
    const best = [...daily].sort((a, b) => b.trading.pnl - a.trading.pnl).slice(0, 5);
    const worst = [...daily].sort((a, b) => a.trading.pnl - b.trading.pnl).slice(0, 5);
    console.log('\n=== TOP 5 DAYS (PnL) ===');
    console.table(best.map((d) => ({
      date: d.date,
      avgVolUsdt: `${(d.market.avgDailyVolumeUsdt / 1e6).toFixed(1)}M`,
      trades: d.trading.trades,
      winRate: `${(d.trading.winRate * 100).toFixed(1)}%`,
      pnl: d.trading.pnl.toFixed(1),
    })));
    console.log('\n=== WORST 5 DAYS (PnL) ===');
    console.table(worst.map((d) => ({
      date: d.date,
      avgVolUsdt: `${(d.market.avgDailyVolumeUsdt / 1e6).toFixed(1)}M`,
      trades: d.trading.trades,
      winRate: `${(d.trading.winRate * 100).toFixed(1)}%`,
      pnl: d.trading.pnl.toFixed(1),
    })));
  }
  console.log(`\nFull output: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
