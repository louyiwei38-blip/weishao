/**
 * Vegas channel strategy backtest (OKX / Binance USDT swap).
 *
 * Usage:
 *   node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01
 *   node scripts/backtest-vegas-1h.js --timeframe=5m --from=2020-01-01 --symbol=XRP/USDT
 *   node scripts/backtest-vegas-1h.js --timeframe=1h --from=2020-01-01 --symbol=XRP/USDT --exchange=binance
 */
import ccxt from 'ccxt';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  EMA_SLOW,
  vegasBands,
  evaluateVegasEntryAt,
  bodyOutsideAt,
} from '../src/strategy/vegasChannel.js';
import { computeNetSettlementPnl } from './lib/polymarketFees.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');

const TF_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

function argNum(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

function argStr(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

function argBool(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.split('=')[1].toLowerCase() !== 'false';
}

/** spot-style XRP/USDT → swap XRP/USDT:USDT */
function resolveSwapSymbol(raw) {
  if (!raw) return 'XRP/USDT:USDT';
  if (raw.includes(':')) return raw;
  const [base, quote = 'USDT'] = raw.split('/');
  return `${base}/${quote}:USDT`;
}

const TIMEFRAME = argStr('timeframe', '1h');
const BAR_MS = TF_MS[TIMEFRAME];
if (!BAR_MS) {
  console.error(`Unsupported --timeframe=${TIMEFRAME}. Use: ${Object.keys(TF_MS).join(', ')}`);
  process.exit(1);
}

const SYMBOL = resolveSwapSymbol(argStr('symbol', 'XRP/USDT'));
const SYMBOL_BASE = SYMBOL.split('/')[0].toLowerCase();
/** OKX late listings may lack 2020 history; prefer Binance for altcoins */
const EXCHANGE_ID = (
  argStr('exchange') || (['bnb', 'sol', 'xrp'].includes(SYMBOL_BASE) ? 'binance' : 'okx')
).toLowerCase();
if (!['okx', 'binance'].includes(EXCHANGE_ID)) {
  console.error(`Unsupported --exchange=${EXCHANGE_ID}. Use: okx, binance`);
  process.exit(1);
}
const FROM_ARG = argStr('from');
const DAYS = argNum('days', 365);
const BASE_BET = argNum('base', 3);
const MULT = argNum('mult', 3);
const MAX_LOSSES = argNum('maxLosses', 5);
const ENTRY_PRICE = argNum('entry', 0.5);
const USE_FEE = argBool('fee', true);
const FORCE_FETCH = process.argv.includes('--force');
const CACHE_FILE = join(
  OUT_DIR,
  `ohlcv-${TIMEFRAME}-${EXCHANGE_ID}-swap-${SYMBOL_BASE}-cache.json`,
);

function resolveRange() {
  const toMs = Date.now();
  if (FROM_ARG) {
    const fromMs = Date.parse(FROM_ARG.includes('T') ? FROM_ARG : `${FROM_ARG}T00:00:00.000Z`);
    if (!Number.isFinite(fromMs)) throw new Error(`Invalid --from=${FROM_ARG}`);
    return { fromMs, toMs, label: `${new Date(fromMs).toISOString().slice(0, 10)} → now` };
  }
  return {
    fromMs: toMs - DAYS * 24 * 60 * 60_000,
    toMs,
    label: `last ${DAYS} days`,
  };
}

function createExchange() {
  if (EXCHANGE_ID === 'binance') {
    return new ccxt.binance({
      enableRateLimit: true,
      timeout: 60_000,
      options: { defaultType: 'future' },
    });
  }
  return new ccxt.okx({
    enableRateLimit: true,
    timeout: 60_000,
    options: { defaultType: 'swap' },
  });
}

/** Binance USDT-M often uses BNB/USDT; OKX uses BNB/USDT:USDT */
function fetchSymbolForExchange() {
  if (EXCHANGE_ID === 'binance') {
    const [base, rest] = SYMBOL.split('/');
    const quote = (rest || 'USDT').split(':')[0];
    return `${base}/${quote}`;
  }
  return SYMBOL;
}

async function fetchAllCandles(exchange, symbol, timeframe, since, until) {
  const all = [];
  let cursor = since;
  let batches = 0;
  let emptySkips = 0;
  while (cursor < until) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, cursor, 300);
    if (!batch.length) {
      // Listing may start later than --from (e.g. OKX BNB); skip forward
      emptySkips += 1;
      if (emptySkips > 64) break;
      cursor += BAR_MS * 300;
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    emptySkips = 0;
    for (const row of batch) {
      const [t, o, h, l, c, v] = row;
      if (t >= until) break;
      all.push({ t, open: o, high: h, low: l, close: c, volume: v });
    }
    const lastT = batch.at(-1)[0];
    if (lastT <= cursor) break;
    cursor = lastT + BAR_MS;
    batches += 1;
    if (batches % 50 === 0) {
      console.log(`  … fetched ${all.length} bars @ ${new Date(lastT).toISOString()}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  const dedup = new Map(all.map((c) => [c.t, c]));
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

async function ensureCandles(fromMs, toMs) {
  const needSince = fromMs - (EMA_SLOW + 50) * BAR_MS;
  let candles = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : [];
  const cacheStart = candles[0]?.t ?? Infinity;
  const cacheEnd = candles.at(-1)?.t ?? 0;
  const covers = candles.length && cacheStart <= needSince && cacheEnd >= toMs - 2 * BAR_MS;

  if (covers && !FORCE_FETCH) {
    console.log(
      `Using cache: ${new Date(cacheStart).toISOString()} → ${new Date(cacheEnd).toISOString()} (${candles.length} bars)`,
    );
    return candles;
  }

  const fetchSymbol = fetchSymbolForExchange();
  console.log(
    `Fetching ${EXCHANGE_ID} ${fetchSymbol} ${TIMEFRAME} ${new Date(needSince).toISOString()} → ${new Date(toMs).toISOString()} ...`,
  );
  const ex = createExchange();
  candles = await fetchAllCandles(ex, fetchSymbol, TIMEFRAME, needSince, toMs);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(candles));
  console.log(`Fetched ${candles.length} bars → ${CACHE_FILE}`);
  return candles;
}

function candleOutcome(candle) {
  return candle.close >= candle.open ? 'UP' : 'DOWN';
}

function fmtUsd(n) {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function runBacktest(candles, fromMs, toMs) {
  console.log('Precomputing Vegas bands…');
  const bands = vegasBands(candles);
  console.log('Running simulation…');

  let phase = 'need_outside';
  let lockedSignal = null;
  let consecutiveLosses = 0;
  let currentBet = BASE_BET;

  const trades = [];
  let chains = 0;
  let chainWins = 0;
  let chainHalts = 0;

  for (let i = EMA_SLOW; i < candles.length - 1; i += 1) {
    const signalBar = candles[i];
    if (signalBar.t < fromMs || signalBar.t >= toMs) continue;

    const settleBar = candles[i + 1];
    const outcome = candleOutcome(settleBar);

    let signal = null;
    let signalId = null;
    let reason = '';

    if (phase === 'in_chain' && lockedSignal) {
      signal = lockedSignal;
      signalId = 'MG_CONT';
      reason = `马丁同向续单 ${lockedSignal}`;
    } else if (phase === 'need_outside') {
      const check = bodyOutsideAt(candles, bands, i);
      if (check.outside) {
        phase = 'armed';
      } else {
        continue;
      }
    }

    if (phase === 'armed') {
      const ev = evaluateVegasEntryAt(candles, bands, i);
      if (ev.signal === 'UP' || ev.signal === 'DOWN') {
        signal = ev.signal;
        signalId = ev.signalId;
        reason = ev.reason;
        phase = 'in_chain';
        lockedSignal = ev.signal;
        consecutiveLosses = 0;
        currentBet = BASE_BET;
        chains += 1;
      } else {
        continue;
      }
    }

    if (!signal) continue;

    const stake = currentBet;
    const won = signal === outcome;
    let pnlUsd;
    let feeUsd = 0;
    if (USE_FEE) {
      const net = computeNetSettlementPnl(won, stake, ENTRY_PRICE);
      pnlUsd = net.pnlUsd;
      feeUsd = net.feeUsd;
    } else if (won) {
      pnlUsd = stake * ((1 - ENTRY_PRICE) / ENTRY_PRICE);
    } else {
      pnlUsd = -stake;
    }

    const band = bands[i];
    const trade = {
      signalBarT: signalBar.t,
      settleBarT: settleBar.t,
      signal,
      signalId,
      reason,
      outcome,
      won,
      stake,
      consecutiveLossesBefore: consecutiveLosses,
      entryPrice: ENTRY_PRICE,
      feeUsd,
      pnlUsd,
      upper: band?.upper ?? null,
      lower: band?.lower ?? null,
    };

    let halted = false;
    if (won) {
      consecutiveLosses = 0;
      currentBet = BASE_BET;
      phase = 'need_outside';
      lockedSignal = null;
      chainWins += 1;
      trade.chainEnd = 'win';
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MAX_LOSSES) {
        halted = true;
        consecutiveLosses = 0;
        currentBet = BASE_BET;
        phase = 'need_outside';
        lockedSignal = null;
        chainHalts += 1;
        trade.chainEnd = 'halt';
      } else {
        currentBet *= MULT;
        trade.chainEnd = null;
      }
    }
    trade.martingaleHalted = halted;
    trades.push(trade);
  }

  return { trades, chains, chainWins, chainHalts };
}

function summarize(trades, chains, chainWins, chainHalts, fromMs, toMs) {
  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  const pnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const fees = trades.reduce((s, t) => s + (t.feeUsd || 0), 0);
  const stakes = trades.reduce((s, t) => s + t.stake, 0);
  const maxStake = trades.reduce((m, t) => Math.max(m, t.stake), 0);

  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }

  const byMonth = new Map();
  for (const t of trades) {
    const key = new Date(t.settleBarT).toISOString().slice(0, 7);
    const row = byMonth.get(key) ?? { n: 0, wins: 0, pnl: 0 };
    row.n += 1;
    if (t.won) row.wins += 1;
    row.pnl += t.pnlUsd;
    byMonth.set(key, row);
  }

  const entries = trades.filter((t) => t.signalId === 'VG_UP' || t.signalId === 'VG_DOWN');
  const conts = trades.filter((t) => t.signalId === 'MG_CONT');
  const upTrades = trades.filter((t) => t.signal === 'UP');
  const downTrades = trades.filter((t) => t.signal === 'DOWN');

  return {
    period: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      days: Math.round((toMs - fromMs) / (24 * 60 * 60_000)),
    },
    params: {
      baseBet: BASE_BET,
      multiplier: MULT,
      maxLosses: MAX_LOSSES,
      entryPrice: ENTRY_PRICE,
      fee: USE_FEE,
      symbol: SYMBOL,
      exchange: EXCHANGE_ID,
      timeframe: TIMEFRAME,
    },
    totals: {
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length ? wins / trades.length : 0,
      pnlUsd: pnl,
      feesUsd: fees,
      totalStakeUsd: stakes,
      maxStakeUsd: maxStake,
      maxDrawdownUsd: maxDd,
      finalEquityUsd: equity,
    },
    chains: {
      started: chains,
      endedWin: chainWins,
      endedHalt: chainHalts,
      openOrOther: Math.max(0, chains - chainWins - chainHalts),
    },
    breakdown: {
      entrySignals: entries.length,
      martingaleContinues: conts.length,
      up: {
        n: upTrades.length,
        wins: upTrades.filter((t) => t.won).length,
        winRate: upTrades.length ? upTrades.filter((t) => t.won).length / upTrades.length : 0,
        pnl: upTrades.reduce((s, t) => s + t.pnlUsd, 0),
      },
      down: {
        n: downTrades.length,
        wins: downTrades.filter((t) => t.won).length,
        winRate: downTrades.length ? downTrades.filter((t) => t.won).length / downTrades.length : 0,
        pnl: downTrades.reduce((s, t) => s + t.pnlUsd, 0),
      },
    },
    monthly: [...byMonth.entries()].map(([month, r]) => ({
      month,
      trades: r.n,
      winRate: r.n ? r.wins / r.n : 0,
      pnlUsd: r.pnl,
    })),
  };
}

function printMonthly(summary) {
  let cum = 0;
  console.log('\n── Monthly ──');
  for (const m of summary.monthly) {
    cum += m.pnlUsd;
    console.log(
      `${m.month}  trades=${String(m.trades).padStart(4)}  wr=${(m.winRate * 100).toFixed(1).padStart(5)}%  ` +
      `pnl=${fmtUsd(m.pnlUsd).padStart(10)}  cum=${fmtUsd(cum)}`,
    );
  }
}

async function main() {
  const { fromMs, toMs, label } = resolveRange();

  console.log('=== Vegas channel backtest ===');
  console.log(`Symbol: ${SYMBOL}  exchange: ${EXCHANGE_ID}`);
  console.log(`Timeframe: ${TIMEFRAME}`);
  console.log(`Period: ${label}`);
  console.log(`Base $${BASE_BET} ×${MULT} maxLosses=${MAX_LOSSES} entry=${ENTRY_PRICE} fee=${USE_FEE}`);

  const candles = await ensureCandles(fromMs, toMs);
  console.log(`Candles loaded: ${candles.length}`);
  if (candles.length) {
    console.log(
      `Candle span: ${new Date(candles[0].t).toISOString()} → ${new Date(candles.at(-1).t).toISOString()}`,
    );
  }

  const firstTradeable = candles.length > EMA_SLOW ? candles[EMA_SLOW].t : fromMs;
  const effectiveFrom = Math.max(fromMs, firstTradeable);
  if (effectiveFrom > fromMs) {
    console.log(`Note: effective from ${new Date(effectiveFrom).toISOString()}`);
  }

  const { trades, chains, chainWins, chainHalts } = runBacktest(candles, effectiveFrom, toMs);
  const summary = summarize(trades, chains, chainWins, chainHalts, effectiveFrom, toMs);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const tag = TIMEFRAME;
  const outJson = join(OUT_DIR, `backtest-vegas-${tag}.json`);
  const outCsv = join(OUT_DIR, `backtest-vegas-${tag}-trades.csv`);
  // Keep trades out of giant JSON for 5m — summary + monthly only; full trades in CSV
  writeFileSync(outJson, JSON.stringify({ summary, tradeCount: trades.length }, null, 2));
  writeFileSync(
    outCsv,
    [
      'signalBarT,settleBarT,signal,signalId,outcome,won,stake,pnlUsd,feeUsd,chainEnd,lossesBefore',
      ...trades.map((t) =>
        [
          new Date(t.signalBarT).toISOString(),
          new Date(t.settleBarT).toISOString(),
          t.signal,
          t.signalId,
          t.outcome,
          t.won,
          t.stake,
          t.pnlUsd.toFixed(4),
          (t.feeUsd || 0).toFixed(4),
          t.chainEnd ?? '',
          t.consecutiveLossesBefore,
        ].join(','),
      ),
    ].join('\n'),
  );

  // Also write monthly-only helper for tables
  writeFileSync(
    join(OUT_DIR, `backtest-vegas-${tag}-monthly.json`),
    JSON.stringify(summary.monthly, null, 2),
  );

  const t = summary.totals;
  const c = summary.chains;
  const b = summary.breakdown;

  console.log('\n── Results ──');
  console.log(`Trades: ${t.trades}  (entries ${b.entrySignals} + MG_CONT ${b.martingaleContinues})`);
  console.log(`Win rate: ${(t.winRate * 100).toFixed(1)}%  (${t.wins}W / ${t.losses}L)`);
  console.log(`PnL: ${fmtUsd(t.pnlUsd)}  fees: $${t.feesUsd.toFixed(2)}  maxDD: ${fmtUsd(t.maxDrawdownUsd)}`);
  console.log(`Stake sum: $${t.totalStakeUsd.toFixed(2)}  max single: $${t.maxStakeUsd.toFixed(2)}`);
  console.log(`Chains: ${c.started}  win-end ${c.endedWin}  halt-end ${c.endedHalt}`);
  console.log(
    `UP: n=${b.up.n} wr=${(b.up.winRate * 100).toFixed(1)}% pnl=${fmtUsd(b.up.pnl)} | ` +
    `DOWN: n=${b.down.n} wr=${(b.down.winRate * 100).toFixed(1)}% pnl=${fmtUsd(b.down.pnl)}`,
  );

  printMonthly(summary);

  console.log(`\nWrote ${outJson}`);
  console.log(`Wrote ${outCsv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
