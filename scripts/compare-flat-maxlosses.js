/**
 * Flat bet ($3, mult=1) with maxLosses = 1..4 (and 5 for reference).
 * Re-simulates from OHLCV + EMA caches (trade sequence changes with maxLosses).
 *
 * Usage: node scripts/compare-flat-maxlosses.js
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  MIN_SIGNAL_CANDLES,
  evaluateVegasEntryAt,
  bodyOutsideAt,
} from '../src/strategy/vegasChannel.js';
import { computeNetSettlementPnl } from './lib/polymarketFees.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');

const BASE_BET = 3;
const MULT = 1;
const ENTRY_PRICE = 0.5;
const USE_FEE = true;
const MAX_LOSSES_LIST = [1, 2, 3, 4, 5];

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const TFS = ['5m', '15m', '1h'];

const TF_MS = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
};

function loadCandles(symbol, tf) {
  const base = symbol.toLowerCase();
  const path = join(LOGS, `ohlcv-${tf}-okx-swap-${base}-cache.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadBands(candles, symbol, tf) {
  const base = symbol.toLowerCase();
  const path = join(LOGS, `ema-vegas-${tf}-okx-${base}-cache.json`);
  if (!existsSync(path)) return null;
  const cached = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(cached?.points)) return null;
  const byTs = new Map(cached.points.map((p) => [p.t, p]));
  return candles.map((c) => {
    const p = byTs.get(c.t);
    if (!p) return null;
    return { ema144: p.ema144, ema169: p.ema169, upper: p.upper, lower: p.lower };
  });
}

function candleOutcome(candle) {
  return candle.close >= candle.open ? 'UP' : 'DOWN';
}

function runSim(candles, bands, maxLosses) {
  let phase = 'need_outside';
  let lockedSignal = null;
  let consecutiveLosses = 0;
  let currentBet = BASE_BET;

  let trades = 0;
  let wins = 0;
  let pnl = 0;
  let fees = 0;
  let maxStake = 0;
  let chainHalts = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;

  const firstAligned = candles.findIndex((_, i) => bands[i] && bands[i - 1]);
  const fromMs =
    firstAligned >= MIN_SIGNAL_CANDLES ? candles[firstAligned].t : candles[0]?.t ?? 0;

  for (let i = MIN_SIGNAL_CANDLES; i < candles.length - 1; i += 1) {
    const signalBar = candles[i];
    if (signalBar.t < fromMs) continue;
    if (!bands[i] || !bands[i - 1]) continue;

    const settleBar = candles[i + 1];
    const outcome = candleOutcome(settleBar);

    let signal = null;
    let signalId = null;

    if (phase === 'in_chain' && lockedSignal) {
      signal = lockedSignal;
      signalId = 'MG_CONT';
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
        phase = 'in_chain';
        lockedSignal = ev.signal;
        consecutiveLosses = 0;
        currentBet = BASE_BET;
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

    trades += 1;
    if (won) wins += 1;
    pnl += pnlUsd;
    fees += feeUsd;
    maxStake = Math.max(maxStake, stake);
    equity += pnlUsd;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);

    if (won) {
      consecutiveLosses = 0;
      currentBet = BASE_BET;
      phase = 'need_outside';
      lockedSignal = null;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= maxLosses) {
        chainHalts += 1;
        consecutiveLosses = 0;
        currentBet = BASE_BET;
        phase = 'need_outside';
        lockedSignal = null;
      } else {
        currentBet *= MULT;
      }
    }
  }

  return {
    trades,
    wins,
    winRate: trades ? wins / trades : 0,
    pnlUsd: pnl,
    feesUsd: fees,
    maxStakeUsd: maxStake,
    maxDrawdownUsd: maxDd,
    chainsHalt: chainHalts,
    periodFrom: fromMs ? new Date(fromMs).toISOString().slice(0, 10) : null,
    periodTo: candles.length
      ? new Date(candles.at(-1).t).toISOString().slice(0, 10)
      : null,
  };
}

function usd(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n >= 0 ? '+' : '-'}$${s}`;
}

const instances = [];
const t0 = Date.now();

for (const symbol of SYMBOLS) {
  for (const tf of TFS) {
    const candles = loadCandles(symbol, tf);
    if (!candles?.length) {
      console.warn(`SKIP no candles ${symbol} ${tf}`);
      continue;
    }
    const bands = loadBands(candles, symbol, tf);
    if (!bands) {
      console.warn(`SKIP no bands ${symbol} ${tf}`);
      continue;
    }

    const byMax = {};
    for (const ml of MAX_LOSSES_LIST) {
      byMax[ml] = runSim(candles, bands, ml);
    }

    instances.push({ symbol, tf, byMax });

    const line = MAX_LOSSES_LIST.map((ml) => {
      const r = byMax[ml];
      return `L${ml} n=${r.trades} wr=${(r.winRate * 100).toFixed(1)}% pnl=${usd(r.pnlUsd)}`;
    }).join(' | ');
    console.log(`${symbol} ${tf}: ${line}`);
  }
}

const bySymbol = SYMBOLS.map((symbol) => {
  const rows = instances.filter((i) => i.symbol === symbol);
  if (!rows.length) return null;
  const byMax = {};
  for (const ml of MAX_LOSSES_LIST) {
    const parts = rows.map((r) => r.byMax[ml]);
    byMax[ml] = {
      trades: parts.reduce((s, p) => s + p.trades, 0),
      wins: parts.reduce((s, p) => s + p.wins, 0),
      winRate:
        parts.reduce((s, p) => s + p.trades, 0) > 0
          ? parts.reduce((s, p) => s + p.wins, 0) / parts.reduce((s, p) => s + p.trades, 0)
          : 0,
      pnlUsd: parts.reduce((s, p) => s + p.pnlUsd, 0),
      maxDrawdownUsd: Math.min(...parts.map((p) => p.maxDrawdownUsd)),
      maxStakeUsd: Math.max(...parts.map((p) => p.maxStakeUsd)),
      chainsHalt: parts.reduce((s, p) => s + p.chainsHalt, 0),
    };
  }
  return { symbol, byMax };
}).filter(Boolean);

const grand = {};
for (const ml of MAX_LOSSES_LIST) {
  grand[ml] = {
    trades: bySymbol.reduce((s, r) => s + r.byMax[ml].trades, 0),
    wins: bySymbol.reduce((s, r) => s + r.byMax[ml].wins, 0),
    pnlUsd: bySymbol.reduce((s, r) => s + r.byMax[ml].pnlUsd, 0),
    maxDrawdownUsd: Math.min(...bySymbol.map((r) => r.byMax[ml].maxDrawdownUsd)),
  };
  grand[ml].winRate = grand[ml].trades ? grand[ml].wins / grand[ml].trades : 0;
}

const out = {
  generatedAt: new Date().toISOString(),
  params: {
    baseBet: BASE_BET,
    multiplier: MULT,
    entryPrice: ENTRY_PRICE,
    fee: USE_FEE,
    maxLossesList: MAX_LOSSES_LIST,
    note: 'mult=1 flat; maxLosses varies — full re-sim from cache (sequence changes)',
  },
  elapsedMs: Date.now() - t0,
  instances,
  bySymbol,
  grand,
};

writeFileSync(join(LOGS, 'backtest-flat-maxlosses-compare.json'), JSON.stringify(out, null, 2));

console.log('\n-- Grand --');
for (const ml of MAX_LOSSES_LIST) {
  const g = grand[ml];
  console.log(
    `maxLosses=${ml}  trades=${g.trades}  wr=${(g.winRate * 100).toFixed(2)}%  pnl=${usd(g.pnlUsd)}  worstDD=${usd(g.maxDrawdownUsd)}`,
  );
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('Wrote logs/backtest-flat-maxlosses-compare.json');
