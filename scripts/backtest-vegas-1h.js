/**
 * Vegas channel strategy backtest (OKX USDT swap + OKX EMA144/169 indicators).
 *
 * Usage:
 *   node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01
 *   node scripts/backtest-vegas-1h.js --timeframe=5m --from=2020-01-01 --symbol=XRP/USDT
 *   node scripts/backtest-vegas-1h.js --timeframe=1h --from=2020-01-01 --symbol=XRP/USDT
 *   node scripts/backtest-vegas-1h.js --days=30 --symbol=BTC/USDT --emaStackFilter=true
 *     # emaStackFilter: EMA144>=EMA169 only UP; EMA144<EMA169 only DOWN
 *   node scripts/backtest-vegas-1h.js --days=30 --symbol=BTC/USDT --chainMode=parallelFixed --fixedBets=5
 *     # parallelFixed: each signal locks direction for N bets; win does not stop;
 *     # new signals spawn independent chains that run in parallel
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  MIN_SIGNAL_CANDLES,
  evaluateVegasEntryAt,
  bodyOutsideAt,
} from '../src/strategy/vegasChannel.js';
import {
  toOkxInstId,
  toOkxBar,
  fetchOkxVegasBandsHistory,
} from '../src/collector/okxIndicators.js';
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
/** Candles + EMA both from OKX (Vegas bands are OKX indicators). */
const EXCHANGE_ID = (argStr('exchange') || 'okx').toLowerCase();
if (EXCHANGE_ID !== 'okx') {
  console.error(
    `Vegas backtest requires OKX EMA; --exchange=${EXCHANGE_ID} is not supported. Use: okx`,
  );
  process.exit(1);
}
const FROM_ARG = argStr('from');
const TO_ARG = argStr('to');
const DAYS = argNum('days', 365);
const BASE_BET = argNum('base', 3);
const MULT = argNum('mult', 3);
const MAX_LOSSES = argNum('maxLosses', 5);
const ENTRY_PRICE = argNum('entry', 0.5);
const USE_FEE = argBool('fee', true);
/** EMA144>=EMA169 → only UP; EMA144<EMA169 → only DOWN (entry filter). */
const EMA_STACK_FILTER = argBool('emaStackFilter', false);
/**
 * chainMode:
 *   - classic (default): win-stop / maxLoss halt, single chain
 *   - parallelFixed: each signal opens an independent N-bet chain; chains run in parallel
 */
const CHAIN_MODE = (argStr('chainMode', 'classic') || 'classic').toLowerCase();
const FIXED_BETS = Math.max(1, Math.floor(argNum('fixedBets', 5)));
if (!['classic', 'parallelfixed'].includes(CHAIN_MODE)) {
  console.error(`Unsupported --chainMode=${CHAIN_MODE}. Use: classic | parallelFixed`);
  process.exit(1);
}
const FORCE_FETCH = process.argv.includes('--force');
const CACHE_FILE = join(
  OUT_DIR,
  `ohlcv-${TIMEFRAME}-${EXCHANGE_ID}-swap-${SYMBOL_BASE}-cache.json`,
);
const EMA_CACHE_FILE = join(
  OUT_DIR,
  `ema-vegas-${TIMEFRAME}-okx-${SYMBOL_BASE}-cache.json`,
);

const OKX_INST_ID = toOkxInstId(SYMBOL, 'swap');
const OKX_BAR = toOkxBar(TIMEFRAME);

function resolveRange() {
  const toMs = TO_ARG
    ? Date.parse(TO_ARG.includes('T') ? TO_ARG : `${TO_ARG}T23:59:59.999Z`)
    : Date.now();
  if (!Number.isFinite(toMs)) throw new Error(`Invalid --to=${TO_ARG}`);
  if (FROM_ARG) {
    const fromMs = Date.parse(FROM_ARG.includes('T') ? FROM_ARG : `${FROM_ARG}T00:00:00.000Z`);
    if (!Number.isFinite(fromMs)) throw new Error(`Invalid --from=${FROM_ARG}`);
    const toLabel = TO_ARG ? new Date(toMs).toISOString().slice(0, 10) : 'now';
    return { fromMs, toMs, label: `${new Date(fromMs).toISOString().slice(0, 10)} → ${toLabel}` };
  }
  return {
    fromMs: toMs - DAYS * 24 * 60 * 60_000,
    toMs,
    label: `last ${DAYS} days`,
  };
}

const OKX_CANDLES_URL = 'https://www.okx.com/api/v5/market/history-candles';

function mergeCandles(existing, incoming) {
  const dedup = new Map(existing.map((c) => [c.t, c]));
  for (const c of incoming) dedup.set(c.t, c);
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

/** Direct OKX REST — avoids CCXT loadMarkets (often blocked while candle API works). */
async function fetchOkxCandlesDirect(instId, bar, since, until) {
  const all = [];
  let after = since;
  let batches = 0;
  let emptySkips = 0;
  const maxEmptySkips = Math.ceil((until - since) / (BAR_MS * 300)) + 8;

  while (after < until) {
    const url = new URL(OKX_CANDLES_URL);
    url.searchParams.set('instId', instId);
    url.searchParams.set('bar', bar);
    url.searchParams.set('after', String(after));
    url.searchParams.set('limit', '300');

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`OKX candles HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== '0') throw new Error(`OKX candles ${json.code} ${json.msg || ''}`.trim());

    const batch = json.data || [];
    if (!batch.length) {
      emptySkips += 1;
      if (emptySkips > maxEmptySkips) break;
      after += BAR_MS * 300;
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    emptySkips = 0;

    let maxT = after;
    for (const row of batch) {
      const t = Number(row[0]);
      if (!Number.isFinite(t) || t <= after || t >= until) continue;
      all.push({
        t,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      });
      maxT = Math.max(maxT, t);
    }

    if (maxT <= after) break;
    after = maxT;
    batches += 1;
    if (batches % 50 === 0) {
      console.log(`  … fetched ${all.length} bars @ ${new Date(maxT).toISOString()}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  return mergeCandles([], all);
}

async function ensureCandles(fromMs, toMs) {
  // Warmup buffer for listing edge; EMA itself comes from OKX indicators API
  const needSince = fromMs - 50 * BAR_MS;
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

  const fetchSince = candles.length && cacheStart <= needSince && cacheEnd < toMs - 2 * BAR_MS
    ? cacheEnd
    : needSince;
  const fetchLabel = fetchSince > needSince
    ? `incremental ${new Date(fetchSince).toISOString()} → ${new Date(toMs).toISOString()}`
    : `${new Date(needSince).toISOString()} → ${new Date(toMs).toISOString()}`;

  console.log(`Fetching OKX ${OKX_INST_ID} ${OKX_BAR} ${fetchLabel} ...`);
  try {
    const fetched = await fetchOkxCandlesDirect(OKX_INST_ID, OKX_BAR, fetchSince, toMs);
    candles = fetchSince > needSince ? mergeCandles(candles, fetched) : fetched;
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(candles));
    console.log(`Fetched ${fetched.length} bars (total ${candles.length}) → ${CACHE_FILE}`);
    return candles;
  } catch (err) {
    if (candles.length && cacheEnd >= fromMs - 2 * BAR_MS) {
      console.warn(
        `OKX fetch failed (${err.message}); using cache through ${new Date(cacheEnd).toISOString()}`,
      );
      return candles;
    }
    throw err;
  }
}

/**
 * Load or fetch OKX EMA144/169 bands aligned to candle timestamps.
 * Cache stores { t, ema144, ema169, upper, lower }[] parallel to candles by t.
 */
function loadEmaBandsFromCache(candles, { minCoverage = 0.9 } = {}) {
  if (!existsSync(EMA_CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(readFileSync(EMA_CACHE_FILE, 'utf8'));
    if (cached?.instId !== OKX_INST_ID || cached?.bar !== OKX_BAR || !Array.isArray(cached.points)) {
      return null;
    }
    const byTs = new Map(cached.points.map((p) => [p.t, p]));
    const bands = candles.map((c) => {
      const p = byTs.get(c.t);
      if (!p) return null;
      return {
        ema144: p.ema144,
        ema169: p.ema169,
        upper: p.upper,
        lower: p.lower,
      };
    });
    const hit = bands.filter(Boolean).length;
    if (hit < candles.length * minCoverage) return null;
    console.log(
      `Using OKX EMA cache: ${hit}/${candles.length} bars aligned (${OKX_INST_ID} ${OKX_BAR})`,
    );
    return bands;
  } catch {
    return null;
  }
}

async function ensureOkxBands(candles) {
  if (!candles.length) return [];

  if (!FORCE_FETCH) {
    const cached = loadEmaBandsFromCache(candles);
    if (cached) return cached;
    console.log('OKX EMA cache missing or low coverage, refetching…');
  }

  console.log(`Fetching OKX EMA144/169 for ${OKX_INST_ID} ${OKX_BAR}…`);
  try {
    let lastLog = 0;
    const bands = await fetchOkxVegasBandsHistory(candles, {
      instId: OKX_INST_ID,
      bar: OKX_BAR,
      onProgress: (n) => {
        if (n - lastLog >= 500) {
          console.log(`  … EMA points ${n}`);
          lastLog = n;
        }
      },
    });

    const points = [];
    for (let i = 0; i < candles.length; i += 1) {
      const b = bands[i];
      if (!b) continue;
      points.push({
        t: candles[i].t,
        ema144: b.ema144,
        ema169: b.ema169,
        upper: b.upper,
        lower: b.lower,
      });
    }
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      EMA_CACHE_FILE,
      JSON.stringify({ instId: OKX_INST_ID, bar: OKX_BAR, points }),
    );
    console.log(`OKX EMA aligned ${points.length}/${candles.length} → ${EMA_CACHE_FILE}`);
    return bands;
  } catch (err) {
    const cached = loadEmaBandsFromCache(candles, { minCoverage: 0.85 });
    if (cached) {
      console.warn(`OKX EMA fetch failed (${err.message}); using cache`);
      return cached;
    }
    throw err;
  }
}

function candleOutcome(candle) {
  return candle.close >= candle.open ? 'UP' : 'DOWN';
}

function fmtUsd(n) {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function passesEmaStackFilter(band, signal) {
  if (!EMA_STACK_FILTER) return true;
  const ema144 = band?.ema144;
  const ema169 = band?.ema169;
  if (!Number.isFinite(ema144) || !Number.isFinite(ema169)) return false;
  const allowUp = ema144 >= ema169;
  if (signal === 'UP' && !allowUp) return false;
  if (signal === 'DOWN' && allowUp) return false;
  return true;
}

function settleTrade(won, stake) {
  if (USE_FEE) {
    const net = computeNetSettlementPnl(won, stake, ENTRY_PRICE);
    return { pnlUsd: net.pnlUsd, feeUsd: net.feeUsd };
  }
  if (won) return { pnlUsd: stake * ((1 - ENTRY_PRICE) / ENTRY_PRICE), feeUsd: 0 };
  return { pnlUsd: -stake, feeUsd: 0 };
}

/** Classic: single chain, stop on win or maxLoss halt. */
function runBacktestClassic(candles, bands, fromMs, toMs) {
  console.log('Running simulation (classic win-stop / maxLoss)…');

  let phase = 'need_outside';
  let lockedSignal = null;
  let consecutiveLosses = 0;
  let currentBet = BASE_BET;

  const trades = [];
  let chains = 0;
  let chainWins = 0;
  let chainHalts = 0;

  for (let i = MIN_SIGNAL_CANDLES; i < candles.length - 1; i += 1) {
    const signalBar = candles[i];
    if (signalBar.t < fromMs || signalBar.t >= toMs) continue;
    if (!bands[i] || !bands[i - 1]) continue;

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
        if (!passesEmaStackFilter(bands[i], ev.signal)) continue;
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
    const { pnlUsd, feeUsd } = settleTrade(won, stake);
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
      ema144: band?.ema144 ?? null,
      ema169: band?.ema169 ?? null,
      chainId: chains,
      shot: consecutiveLosses + 1,
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

  return { trades, chains, chainWins, chainHalts, maxConcurrent: 1, chainCompleted: chainWins + chainHalts };
}

/**
 * Parallel fixed-N: each entry signal locks direction for N bets (no win-stop).
 * Entry detection keeps running (need_outside/armed); new signals spawn new chains
 * that do not interfere with existing ones. Flat stake = BASE_BET per bet.
 */
function runBacktestParallelFixed(candles, bands, fromMs, toMs) {
  console.log(
    `Running simulation (parallelFixed · ${FIXED_BETS} bets/signal · concurrent chains)…`,
  );

  let phase = 'need_outside';
  /** @type {{ id: number, signal: 'UP'|'DOWN', left: number, shot: number, entrySignalId: string, reason: string }[]} */
  const active = [];
  let nextId = 1;

  const trades = [];
  let chains = 0;
  let chainCompleted = 0;
  let chainNetWin = 0;
  let maxConcurrent = 0;
  const chainPnl = new Map();

  for (let i = MIN_SIGNAL_CANDLES; i < candles.length - 1; i += 1) {
    const signalBar = candles[i];
    if (signalBar.t < fromMs || signalBar.t >= toMs) continue;
    if (!bands[i] || !bands[i - 1]) continue;

    const settleBar = candles[i + 1];
    const outcome = candleOutcome(settleBar);
    const band = bands[i];

    // Entry state machine — never blocked by active chains
    if (phase === 'need_outside') {
      if (bodyOutsideAt(candles, bands, i).outside) phase = 'armed';
    }
    if (phase === 'armed') {
      const ev = evaluateVegasEntryAt(candles, bands, i);
      if (
        (ev.signal === 'UP' || ev.signal === 'DOWN') &&
        passesEmaStackFilter(band, ev.signal)
      ) {
        const id = nextId;
        nextId += 1;
        active.push({
          id,
          signal: ev.signal,
          left: FIXED_BETS,
          shot: 0,
          entrySignalId: ev.signalId,
          reason: ev.reason,
        });
        chainPnl.set(id, 0);
        chains += 1;
        // Re-arm cycle so the next outside→cross can open another chain
        phase = 'need_outside';
      }
    }

    if (!active.length) continue;
    maxConcurrent = Math.max(maxConcurrent, active.length);

    const stillActive = [];
    for (const ch of active) {
      const stake = BASE_BET;
      const won = ch.signal === outcome;
      const { pnlUsd, feeUsd } = settleTrade(won, stake);
      const shot = ch.shot + 1;
      const isEntry = ch.shot === 0;
      const signalId = isEntry ? ch.entrySignalId : 'CHAIN_CONT';
      const reason = isEntry
        ? ch.reason
        : `并行链路#${ch.id} 同向第 ${shot}/${FIXED_BETS} 把 ${ch.signal}`;

      chainPnl.set(ch.id, (chainPnl.get(ch.id) || 0) + pnlUsd);
      ch.left -= 1;
      ch.shot += 1;

      const done = ch.left <= 0;
      if (done) {
        chainCompleted += 1;
        if ((chainPnl.get(ch.id) || 0) > 0) chainNetWin += 1;
      } else {
        stillActive.push(ch);
      }

      trades.push({
        signalBarT: signalBar.t,
        settleBarT: settleBar.t,
        signal: ch.signal,
        signalId,
        reason,
        outcome,
        won,
        stake,
        consecutiveLossesBefore: shot - 1,
        entryPrice: ENTRY_PRICE,
        feeUsd,
        pnlUsd,
        upper: band?.upper ?? null,
        lower: band?.lower ?? null,
        ema144: band?.ema144 ?? null,
        ema169: band?.ema169 ?? null,
        chainId: ch.id,
        shot,
        chainEnd: done ? `fixed${FIXED_BETS}` : null,
        martingaleHalted: false,
      });
    }
    active.length = 0;
    active.push(...stillActive);
  }

  return {
    trades,
    chains,
    chainWins: chainNetWin,
    chainHalts: 0,
    maxConcurrent,
    chainCompleted,
  };
}

function runBacktest(candles, bands, fromMs, toMs) {
  if (CHAIN_MODE === 'parallelfixed') {
    return runBacktestParallelFixed(candles, bands, fromMs, toMs);
  }
  return runBacktestClassic(candles, bands, fromMs, toMs);
}

function summarize(trades, chains, chainWins, chainHalts, fromMs, toMs, extra = {}) {
  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  const pnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const fees = trades.reduce((s, t) => s + (t.feeUsd || 0), 0);
  const stakes = trades.reduce((s, t) => s + t.stake, 0);
  const maxStake = trades.reduce((m, t) => Math.max(m, t.stake), 0);

  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  for (const t of trades) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
    if (t.won) lossStreak = 0;
    else {
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
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
  const conts = trades.filter((t) => t.signalId === 'MG_CONT' || t.signalId === 'CHAIN_CONT');
  const upTrades = trades.filter((t) => t.signal === 'UP');
  const downTrades = trades.filter((t) => t.signal === 'DOWN');
  const chainCompleted = extra.chainCompleted ?? chainWins + chainHalts;

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
      emaStackFilter: EMA_STACK_FILTER,
      chainMode: CHAIN_MODE,
      fixedBets: CHAIN_MODE === 'parallelfixed' ? FIXED_BETS : null,
      symbol: SYMBOL,
      exchange: EXCHANGE_ID,
      instId: OKX_INST_ID,
      timeframe: TIMEFRAME,
      emaSource: 'okx_indicators',
    },
    totals: {
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length ? wins / trades.length : 0,
      netWL: wins - losses,
      pnlUsd: pnl,
      feesUsd: fees,
      totalStakeUsd: stakes,
      maxStakeUsd: maxStake,
      maxDrawdownUsd: maxDd,
      finalEquityUsd: equity,
      maxLossStreak,
    },
    chains: {
      started: chains,
      endedWin: chainWins,
      endedHalt: chainHalts,
      completed: chainCompleted,
      maxConcurrent: extra.maxConcurrent ?? 1,
      openOrOther: Math.max(0, chains - chainCompleted),
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

  console.log('=== Vegas channel backtest (OKX EMA) ===');
  console.log(`Symbol: ${SYMBOL}  exchange: ${EXCHANGE_ID}  instId: ${OKX_INST_ID}`);
  console.log(`Timeframe: ${TIMEFRAME}  bar: ${OKX_BAR}`);
  console.log(`Period: ${label}`);
  console.log(
    `Base $${BASE_BET} ×${MULT} maxLosses=${MAX_LOSSES} entry=${ENTRY_PRICE} fee=${USE_FEE}` +
      ` emaStackFilter=${EMA_STACK_FILTER} chainMode=${CHAIN_MODE}` +
      (CHAIN_MODE === 'parallelfixed' ? ` fixedBets=${FIXED_BETS}` : ''),
  );

  const candles = await ensureCandles(fromMs, toMs);
  console.log(`Candles loaded: ${candles.length}`);
  if (candles.length) {
    console.log(
      `Candle span: ${new Date(candles[0].t).toISOString()} → ${new Date(candles.at(-1).t).toISOString()}`,
    );
  }

  const bands = await ensureOkxBands(candles);
  const firstAligned = candles.findIndex((_, i) => bands[i] && bands[i - 1]);
  const firstTradeable = firstAligned >= MIN_SIGNAL_CANDLES ? candles[firstAligned].t : fromMs;
  const effectiveFrom = Math.max(fromMs, firstTradeable);
  if (effectiveFrom > fromMs) {
    console.log(`Note: effective from ${new Date(effectiveFrom).toISOString()} (OKX EMA aligned)`);
  }

  const { trades, chains, chainWins, chainHalts, maxConcurrent, chainCompleted } = runBacktest(
    candles,
    bands,
    effectiveFrom,
    toMs,
  );
  const summary = summarize(trades, chains, chainWins, chainHalts, effectiveFrom, toMs, {
    maxConcurrent,
    chainCompleted,
  });

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const tag =
    `${SYMBOL_BASE}-${TIMEFRAME}` +
    (EMA_STACK_FILTER ? '-emastack' : '') +
    (CHAIN_MODE === 'parallelfixed' ? `-p${FIXED_BETS}` : '');
  const outJson = join(OUT_DIR, `backtest-vegas-${tag}.json`);
  const outCsv = join(OUT_DIR, `backtest-vegas-${tag}-trades.csv`);
  // Keep trades out of giant JSON for 5m — summary + monthly only; full trades in CSV
  writeFileSync(outJson, JSON.stringify({ summary, tradeCount: trades.length }, null, 2));
  writeFileSync(
    outCsv,
    [
      'signalBarT,settleBarT,signal,signalId,outcome,won,stake,pnlUsd,feeUsd,chainEnd,lossesBefore,chainId,shot',
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
          t.chainId ?? '',
          t.shot ?? '',
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
  console.log(`Trades: ${t.trades}  (entries ${b.entrySignals} + CONT ${b.martingaleContinues})`);
  console.log(
    `Win rate: ${(t.winRate * 100).toFixed(1)}%  (${t.wins}W / ${t.losses}L)  netWL=${t.netWL >= 0 ? '+' : ''}${t.netWL}`,
  );
  console.log(`PnL: ${fmtUsd(t.pnlUsd)}  fees: $${t.feesUsd.toFixed(2)}  maxDD: ${fmtUsd(t.maxDrawdownUsd)}`);
  console.log(`Stake sum: $${t.totalStakeUsd.toFixed(2)}  max single: $${t.maxStakeUsd.toFixed(2)}`);
  console.log(`Max loss streak: ${t.maxLossStreak}`);
  if (CHAIN_MODE === 'parallelfixed') {
    console.log(
      `Chains: ${c.started}  completed ${c.completed}  net+chains ${c.endedWin}  maxConcurrent ${c.maxConcurrent}`,
    );
  } else {
    console.log(`Chains: ${c.started}  win-end ${c.endedWin}  halt-end ${c.endedHalt}`);
  }
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
