/**
 * BTC · current bankroll rules · maxLosses = 1..5
 * Re-sim from OHLCV (sequence changes with halt depth) → check win-rate impact.
 *
 * Usage:
 *   node scripts/backtest-maxlosses-wr.js
 *   node scripts/backtest-maxlosses-wr.js --from=2024-07-15 --principal=5000
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

const ENTRY = 0.5;
const BASE = 10;
const STEP = 10;
const T_CAP = 20;
const STAKE_MAX = 30;
const MAX_LIST = [1, 2, 3, 4, 5];
const TFS = ['5m', '15m', '1h'];

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const FROM = new Date(arg('from', '2024-07-15')).getTime();
const TO = arg('to') ? new Date(arg('to')).getTime() : Date.now();
const PRINCIPAL = Number(arg('principal', '5000'));

function loadCandles(tf) {
  const path = join(LOGS, `ohlcv-${tf}-okx-swap-btc-cache.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadBands(candles, tf) {
  const path = join(LOGS, `ema-vegas-${tf}-okx-btc-cache.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const cached = JSON.parse(readFileSync(path, 'utf8'));
  const byTs = new Map(cached.points.map((p) => [p.t, p]));
  return candles.map((c) => {
    const p = byTs.get(c.t);
    return p ? { ema144: p.ema144, ema169: p.ema169, upper: p.upper, lower: p.lower } : null;
  });
}

function candleOutcome(c) {
  return c.close >= c.open ? 'UP' : 'DOWN';
}

function targetBalance(P, N) {
  return P + (N + 1) * STEP;
}

function catchUpT(P, N, Bal) {
  return Math.min(Math.max(0, targetBalance(P, N) - Bal), T_CAP);
}

function stakeFromT(T) {
  const p = ENTRY;
  return Math.min(T * (p / (1 - p)), STAKE_MAX);
}

function collectTrades(candles, bands, maxLosses) {
  let phase = 'need_outside';
  let lockedSignal = null;
  let consecutiveLosses = 0;
  const out = [];

  for (let i = MIN_SIGNAL_CANDLES; i < candles.length - 1; i += 1) {
    const signalBar = candles[i];
    if (signalBar.t < FROM || signalBar.t >= TO) continue;
    if (!bands[i] || !bands[i - 1]) continue;

    const settleBar = candles[i + 1];
    const outcome = candleOutcome(settleBar);
    let signal = null;
    let signalId = null;

    if (phase === 'in_chain' && lockedSignal) {
      signal = lockedSignal;
      signalId = 'MG_CONT';
    } else if (phase === 'need_outside') {
      if (bodyOutsideAt(candles, bands, i).outside) phase = 'armed';
      else continue;
    }

    if (phase === 'armed') {
      const ev = evaluateVegasEntryAt(candles, bands, i);
      if (ev.signal === 'UP' || ev.signal === 'DOWN') {
        signal = ev.signal;
        signalId = ev.signalId;
        phase = 'in_chain';
        lockedSignal = ev.signal;
        consecutiveLosses = 0;
      } else continue;
    }

    if (!signal) continue;

    const won = outcome === signal;
    out.push({
      settleTs: settleBar.t,
      won,
      signalId,
      consecutiveLossesBefore: consecutiveLosses,
    });

    if (won) {
      consecutiveLosses = 0;
      lockedSignal = null;
      phase = 'need_outside';
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= maxLosses) {
        consecutiveLosses = 0;
        lockedSignal = null;
        phase = 'need_outside';
      }
    }
  }
  return out;
}

function mgContShare(trades) {
  const n = trades.filter((t) => t.signalId === 'MG_CONT').length;
  return trades.length ? n / trades.length : 0;
}

function applyBankrollDetailed(tradesChrono, P0) {
  let Bal = P0;
  let N = 0;
  let peak = Bal;
  let maxDd = 0;
  let wins = 0;
  let executed = 0;
  let fees = 0;
  let stakeSum = 0;
  let ruin = false;

  for (const t of tradesChrono) {
    if (Bal <= 0) {
      ruin = true;
      break;
    }
    const T = catchUpT(P0, N, Bal);
    let stake = stakeFromT(T);
    if (stake <= 0) stake = BASE;
    stake = Math.min(stake, Bal, STAKE_MAX);
    if (stake <= 0) {
      ruin = true;
      break;
    }

    const { pnlUsd, feeUsd } = computeNetSettlementPnl(t.won, stake, ENTRY);
    Bal += pnlUsd;
    fees += feeUsd;
    stakeSum += stake;
    executed += 1;
    if (t.won) {
      wins += 1;
      N += 1;
    } else {
      N = Math.max(0, N - 1);
    }
    if (Bal > peak) peak = Bal;
    maxDd = Math.min(maxDd, Bal - peak);
  }

  const seqWins = tradesChrono.filter((t) => t.won).length;
  return {
    seqTrades: tradesChrono.length,
    seqWins,
    seqWinRate: tradesChrono.length ? seqWins / tradesChrono.length : 0,
    execTrades: executed,
    execWins: wins,
    execWinRate: executed ? wins / executed : 0,
    pnl: Bal - P0,
    endBal: Bal,
    maxDd,
    fees,
    avgStake: executed ? stakeSum / executed : 0,
    ruin,
    endN: N,
  };
}

function main() {
  console.log(`BTC · from ${new Date(FROM).toISOString().slice(0, 10)} · P=$${PRINCIPAL}`);
  console.log(`Bankroll: base=${BASE} step=${STEP} T<=${T_CAP} stake<=${STAKE_MAX} · maxLosses=${MAX_LIST.join(',')}\n`);

  const data = {};
  for (const tf of TFS) {
    data[tf] = { candles: loadCandles(tf), bands: null };
    data[tf].bands = loadBands(data[tf].candles, tf);
  }

  const byMax = {};

  for (const maxL of MAX_LIST) {
    const perTf = {};
    const all = [];

    for (const tf of TFS) {
      const trades = collectTrades(data[tf].candles, data[tf].bands, maxL);
      const bank = applyBankrollDetailed(trades, PRINCIPAL);
      perTf[tf] = { ...bank, mgContPct: mgContShare(trades) };
      for (const t of trades) all.push({ ...t, tf });
    }

    all.sort((a, b) => a.settleTs - b.settleTs || a.tf.localeCompare(b.tf));
    const shared = applyBankrollDetailed(all, PRINCIPAL);

    byMax[maxL] = { shared: { ...shared, mgContPct: mgContShare(all) }, perTf };

    const s = shared;
    console.log(
      `maxLosses=${maxL} | shared seq WR ${(s.seqWinRate * 100).toFixed(2)}% ` +
        `(${s.seqWins}/${s.seqTrades}) | MG_CONT ${(mgContShare(all) * 100).toFixed(1)}% | ` +
        `PnL $${s.pnl.toFixed(0)} DD $${s.maxDd.toFixed(0)} ruin=${s.ruin}`,
    );
    for (const tf of TFS) {
      const p = perTf[tf];
      console.log(
        `           ${tf.padEnd(3)} seq WR ${(p.seqWinRate * 100).toFixed(2)}% (${p.seqWins}/${p.seqTrades}) ` +
          `PnL $${p.pnl.toFixed(0)}`,
      );
    }
  }

  const base = byMax[5].shared.seqWinRate;
  console.log('\nDelta seq win-rate vs maxLosses=5 (shared):');
  for (const maxL of MAX_LIST) {
    const wr = byMax[maxL].shared.seqWinRate;
    const dpp = (wr - base) * 100;
    console.log(
      `  max=${maxL}: ${(wr * 100).toFixed(3)}%  d ${dpp >= 0 ? '+' : ''}${dpp.toFixed(3)} pp  trades ${byMax[maxL].shared.seqTrades}`,
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    from: new Date(FROM).toISOString(),
    to: new Date(TO).toISOString(),
    principal: PRINCIPAL,
    bankroll: { BASE, STEP, T_CAP, STAKE_MAX, ENTRY },
    byMaxLosses: byMax,
  };
  const outPath = join(LOGS, 'backtest-maxlosses-wr.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();