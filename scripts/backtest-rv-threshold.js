/**
 * Grid-search RV_5M / RV_15M thresholds with Scheme A (rv_ratio<1.05 on high-vol continuation)
 * plus low-vol reversal mode.
 *
 * Usage: node scripts/backtest-rv-threshold.js [--target=10000]
 */
import ccxt from 'ccxt';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeSignalVolatility } from '../src/utils/volatility.js';
import {
  build1mIndex,
  computeTradeFactors,
  simulateMartingale,
  summarizeTrades,
  MARTINGALE_MAX,
} from './lib/backtestFactors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const CACHE_5M = join(OUT_DIR, 'ohlcv-5m-cache.json');
const CACHE_1M = join(OUT_DIR, 'ohlcv-1m-cache.json');
const OUT_FILE = join(OUT_DIR, 'rv-threshold-grid.json');

const SYMBOL = 'BTC/USDT';
const TARGET = Number(process.argv.find((a) => a.startsWith('--target='))?.split('=')[1] ?? 10000);
const RV_RATIO_MAX = 1.05;
const SCHEME_A = (t) => t.rv_ratio == null || t.rv_ratio < RV_RATIO_MAX;

const THRESH_GRID = [
  0.00020, 0.00025, 0.00030, 0.00035, 0.00040,
  0.00045, 0.00050, 0.00055, 0.00060, 0.00065,
];

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
    console.log('Loading cached OHLCV...');
    return {
      c5: JSON.parse(readFileSync(CACHE_5M, 'utf8')),
      c1: JSON.parse(readFileSync(CACHE_1M, 'utf8')),
    };
  }

  const ex = new ccxt.okx({ enableRateLimit: true, timeout: 30_000 });
  const until = Date.now();
  const since = until - 120 * 24 * 60 * 60_000;
  console.log(`Fetching OKX ${SYMBOL} from ${new Date(since).toISOString()} ...`);
  const [c5, c1] = await Promise.all([
    fetchAllCandles(ex, SYMBOL, '5m', since, until),
    fetchAllCandles(ex, SYMBOL, '1m', since, until),
  ]);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE_5M, JSON.stringify(c5));
  writeFileSync(CACHE_1M, JSON.stringify(c1));
  console.log(`Cached 5m=${c5.length}, 1m=${c1.length}`);
  return { c5, c1 };
}

function classifyRegime(rv5, rv15, thresh5, thresh15) {
  const highBy5 = rv5 != null && rv5 >= thresh5;
  const highBy15 = rv15 != null && rv15 >= thresh15;
  if (highBy5 || highBy15) return 'high';

  const lowBy5 = rv5 != null && rv5 < thresh5;
  const lowBy15 = rv15 != null && rv15 < thresh15;
  if (lowBy5 && lowBy15) return 'low';

  return 'high'; // partial sample → default continuation
}

function buildTradesInRange(c5, idx1m, thresh5, thresh15, startI, endI) {
  const rvHistory = {};
  const raw = [];

  for (let i = startI; i <= endI && i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;

    const regime = classifyRegime(vol.rv_5m, vol.rv_15m, thresh5, thresh15);
    const f = computeTradeFactors(c5, idx1m, i, rvHistory);
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, regime);

    if (eval_.signal === 'NONE') continue;
    if (regime === 'high' && !SCHEME_A(f)) continue;

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

function findEndIndex(c5, idx1m, targetTrades) {
  const rvHistory = {};
  let count = 0;
  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const slice1m = idx1m.slice(k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;
    const regime = classifyRegime(vol.rv_5m, vol.rv_15m, 0, 0);
    const f = computeTradeFactors(c5, idx1m, i, rvHistory);
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, regime);
    if (eval_.signal === 'NONE') continue;
    if (regime === 'high' && !SCHEME_A(f)) continue;
    count += 1;
    if (count >= targetTrades) return i;
  }
  return c5.length - 2;
}

function simStats(trades) {
  const base = summarizeTrades(trades);
  const high = trades.filter((t) => t.volRegime === 'high');
  const low = trades.filter((t) => t.volRegime === 'low');
  const highS = summarizeTrades(high);
  const lowS = summarizeTrades(low);
  return {
    ...base,
    highTrades: high.length,
    lowTrades: low.length,
    highWinRate: highS.winRate,
    lowWinRate: lowS.winRate,
    highHalts: highS.halts,
    lowHalts: lowS.halts,
    highPnl: highS.pnl,
    lowPnl: lowS.pnl,
    coverage: trades.length,
    score: (base.pnl / 50) + (1 - base.halts / 400) * 2 + base.winRate,
  };
}

function pct(v, d = 2) {
  return `${(v * 100).toFixed(d)}%`;
}

async function main() {
  const { c5, c1 } = await loadCandles();
  const idx1m = build1mIndex(c1);
  const endI = findEndIndex(c5, idx1m, TARGET);
  const startI = 50;
  console.log(`Fixed window: bar ${startI}..${endI} (${endI - startI + 1} cycles), baseline target=${TARGET} trades\n`);

  const results = [];
  let best = null;

  console.log(`Grid search: ${THRESH_GRID.length}x${THRESH_GRID.length} pairs, Scheme A rv_ratio<${RV_RATIO_MAX}\n`);

  for (const t5 of THRESH_GRID) {
    for (const t15 of THRESH_GRID) {
      const trades = buildTradesInRange(c5, idx1m, t5, t15, startI, endI);
      if (trades.length < 1000) continue;

      const s = simStats(trades);
      const row = {
        rv5mThreshold: t5,
        rv15mThreshold: t15,
        trades: s.trades,
        coverage: s.coverage,
        winRate: s.winRate,
        halts: s.halts,
        pnl: s.pnl,
        roi: s.roi,
        highTrades: s.highTrades,
        lowTrades: s.lowTrades,
        highWinRate: s.highWinRate,
        lowWinRate: s.lowWinRate,
        highHalts: s.highHalts,
        lowHalts: s.lowHalts,
        highPnl: s.highPnl,
        lowPnl: s.lowPnl,
        score: s.score,
      };
      results.push(row);
      if (!best || row.score > best.score) best = row;
    }
  }

  results.sort((a, b) => b.score - a.score);

  // Also find best with constraint: low trades >= 15% of total
  const balanced = results
    .filter((r) => r.lowTrades >= 800 && r.pnl > 0)
    .sort((a, b) => b.score - a.score);

  const bestPnl = [...results].sort((a, b) => b.pnl - a.pnl)[0];
  const bestHalts = results.filter((r) => r.pnl > 0).sort((a, b) => a.halts - b.halts)[0];

  const output = {
    meta: {
      symbol: SYMBOL,
      targetTrades: TARGET,
      schemeA: `rv_ratio < ${RV_RATIO_MAX} on high-vol continuation only`,
      grid: THRESH_GRID,
      pairsTested: results.length,
    },
    bestOverall: best,
    bestBalanced: balanced[0] ?? null,
    bestPnl,
    bestHalts,
    top20: results.slice(0, 20),
    // reference: continuation-only RV=0 + scheme A (from prior backtest)
    reference: {
      rv5mThreshold: 0,
      rv15mThreshold: 0,
      note: 'continuation-only, scheme A',
      winRate: 0.5158,
      halts: 180,
      pnl: 103.5,
      highTrades: 6553,
      lowTrades: 0,
    },
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log('=== 基准对照 ===');
  console.log(`RV=0 仅延续+方案A: 胜率 51.58% | 止损 180 | PnL +103.5 | 低波动笔数 0\n`);

  console.log('=== TOP 15 阈值组合（方案A + 低波动反转）===');
  console.table(results.slice(0, 15).map((r) => ({
    rv5m: r.rv5mThreshold,
    rv15m: r.rv15mThreshold,
    trades: r.trades,
    winRate: pct(r.winRate),
    halts: r.halts,
    pnl: r.pnl.toFixed(1),
    high: r.highTrades,
    low: r.lowTrades,
    lowWR: pct(r.lowWinRate),
    lowPnL: r.lowPnl.toFixed(1),
  })));

  console.log('\n=== 推荐 ===');
  if (best) {
    console.log(`综合最优: RV_5M=${best.rv5mThreshold}  RV_15M=${best.rv15mThreshold}`);
    console.log(`  胜率 ${pct(best.winRate)} | 止损 ${best.halts} | PnL ${best.pnl.toFixed(1)} | 高波 ${best.highTrades} / 低波 ${best.lowTrades}`);
  }
  if (balanced[0]) {
    console.log(`均衡最优(低波≥10%): RV_5M=${balanced[0].rv5mThreshold}  RV_15M=${balanced[0].rv15mThreshold}`);
    console.log(`  胜率 ${pct(balanced[0].winRate)} | 止损 ${balanced[0].halts} | PnL ${balanced[0].pnl.toFixed(1)} | 低波胜率 ${pct(balanced[0].lowWinRate)}`);
  }
  console.log(`\nFull JSON: logs/rv-threshold-grid.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
