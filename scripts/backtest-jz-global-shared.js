/**
 * 神奇九转 · 全局共用账本
 *   BTC 5m/15m/1h + ETH 5m/15m/1h → 同一本 P/N/补队列
 *   每路独立 Setup / ml=2 链；同刻结算顺序：BTC→ETH，再 5m→15m→1h
 *
 *   node scripts/backtest-jz-global-shared.js --from=2020-01-01
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { MIN_SIGNAL_CANDLES as JZ_MIN } from '../src/strategy/magicNineTurns.js';
import { computeNetSettlementPnl } from '../src/trader/polymarketFees.js';
import { BankrollEngine } from './lib/bankrollEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'logs');

const SYMBOLS = [
  { symbol: 'BTC/USDT', base: 'btc' },
  { symbol: 'ETH/USDT', base: 'eth' },
];
const TIMEFRAMES = ['5m', '15m', '1h'];
const TF_ORDER = { '5m': 0, '15m': 1, '1h': 2 };
const SYM_ORDER = { btc: 0, eth: 1 };

function argStr(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
function argNum(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}
function argBool(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.split('=')[1].toLowerCase() !== 'false';
}

const FROM_MS = Date.parse(`${argStr('from', '2020-01-01')}T00:00:00.000Z`);
const TO_MS = argStr('to')
  ? Date.parse(argStr('to').includes('T') ? argStr('to') : `${argStr('to')}T23:59:59.999Z`)
  : Date.now();
const BASE_BET = argNum('base', 5);
const STEP = argNum('step', 5);
const PRINCIPAL = argNum('principal', 10_000);
const MAX_LOSSES = argNum('maxLosses', 2);
const USE_FEE = argBool('fee', true);
const ENTRY_LO = 0.4;
const ENTRY_HI = 0.6;
const SEED = Math.floor(argNum('seed', 42));

function makeRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtUsd(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toFixed(2);
  return v >= 0 ? `+$${s}` : `-$${s}`;
}
function fmtPct(x) {
  return `${(Number(x) * 100).toFixed(2)}%`;
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function settleTrade(won, stake, entryPrice) {
  if (USE_FEE) {
    const net = computeNetSettlementPnl(won, stake, entryPrice);
    return { pnlUsd: net.pnlUsd, feeUsd: net.feeUsd };
  }
  if (won) return { pnlUsd: stake * ((1 - entryPrice) / entryPrice), feeUsd: 0 };
  return { pnlUsd: -stake, feeUsd: 0 };
}

function stepMagicNineSetup(state, candles, i) {
  const c = Number(candles[i]?.close);
  const c4 = Number(candles[i - 4]?.close);
  let { buyCount, sellCount } = state;
  let completedBuy = false;
  let completedSell = false;
  if (!Number.isFinite(c) || !Number.isFinite(c4)) {
    return { buyCount: 0, sellCount: 0, completedBuy: false, completedSell: false };
  }
  if (c < c4) {
    buyCount += 1;
    sellCount = 0;
  } else if (c > c4) {
    sellCount += 1;
    buyCount = 0;
  } else {
    buyCount = 0;
    sellCount = 0;
  }
  if (buyCount === 9) {
    completedBuy = true;
    buyCount = 0;
  }
  if (sellCount === 9) {
    completedSell = true;
    sellCount = 0;
  }
  return { buyCount, sellCount, completedBuy, completedSell };
}

function loadCandles(base, tf) {
  const path = join(OUT_DIR, `ohlcv-${tf}-okx-swap-${base}-cache.json`);
  if (!existsSync(path)) throw new Error(`missing candle cache ${path}`);
  const candles = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(candles) || !candles.length) throw new Error(`empty cache ${path}`);
  console.log(
    `  ${base.toUpperCase()} ${tf}: ${candles.length} bars ` +
      `${new Date(candles[0].t).toISOString()} → ${new Date(candles.at(-1).t).toISOString()}`,
  );
  return candles;
}

function collectJzIntents(candles, { symbol, base, timeframe }, fromMs, toMs) {
  let phase = 'idle';
  let lockedSignal = null;
  let consecutiveLosses = 0;
  let setupState = { buyCount: 0, sellCount: 0 };
  const intents = [];

  for (let w = 4; w < JZ_MIN && w < candles.length; w++) {
    setupState = stepMagicNineSetup(setupState, candles, w);
  }

  for (let i = JZ_MIN; i < candles.length - 1; i++) {
    setupState = stepMagicNineSetup(setupState, candles, i);
    const { completedBuy, completedSell } = setupState;
    const signalBar = candles[i];
    const settleBar = candles[i + 1];
    if (signalBar.t < fromMs || signalBar.t >= toMs) continue;

    const outcome = settleBar.close >= settleBar.open ? 'UP' : 'DOWN';
    let signal = null;
    let signalId = null;

    if (phase === 'in_chain' && (lockedSignal === 'UP' || lockedSignal === 'DOWN')) {
      signal = lockedSignal;
      signalId = 'MG_CONT';
    } else {
      if (completedBuy && completedSell) continue;
      if (completedBuy) {
        signal = 'UP';
        signalId = 'JZ_UP';
      } else if (completedSell) {
        signal = 'DOWN';
        signalId = 'JZ_DOWN';
      } else {
        continue;
      }
      phase = 'in_chain';
      lockedSignal = signal;
      consecutiveLosses = 0;
    }

    const lossesBefore = consecutiveLosses;
    const shot = consecutiveLosses + 1;
    const won = signal === outcome;

    if (won) {
      consecutiveLosses = 0;
      phase = 'idle';
      lockedSignal = null;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MAX_LOSSES) {
        consecutiveLosses = 0;
        phase = 'idle';
        lockedSignal = null;
      }
    }

    intents.push({
      symbol,
      base,
      timeframe,
      stream: `${base}-${timeframe}`,
      signalBarT: signalBar.t,
      settleBarT: settleBar.t,
      signal,
      signalId,
      outcome,
      won,
      lossesBefore,
      shot,
    });
  }
  return intents;
}

function emptyMonthRow() {
  return {
    n: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    fees: 0,
    equity: 0,
    peak: 0,
    maxDd: 0,
    lossStreak: 0,
    maxLossStreak: 0,
    btc: 0,
    eth: 0,
    byStream: {},
  };
}

function summarize(trades, bankroll, meta, fromMs, toMs) {
  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  let equity = 0;
  let peak = 0;
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
    const row = byMonth.get(key) ?? emptyMonthRow();
    row.n += 1;
    if (t.won) {
      row.wins += 1;
      row.lossStreak = 0;
    } else {
      row.losses += 1;
      row.lossStreak += 1;
      row.maxLossStreak = Math.max(row.maxLossStreak, row.lossStreak);
    }
    row.pnl += t.pnlUsd;
    row.fees += t.feeUsd || 0;
    row.equity += t.pnlUsd;
    row.peak = Math.max(row.peak, row.equity);
    row.maxDd = Math.min(row.maxDd, row.equity - row.peak);
    if (t.base === 'btc') row.btc += 1;
    else row.eth += 1;
    row.byStream[t.stream] = (row.byStream[t.stream] || 0) + 1;
    byMonth.set(key, row);
  }

  const byStream = {};
  for (const t of trades) {
    const k = t.stream;
    if (!byStream[k]) byStream[k] = { trades: 0, wins: 0, pnl: 0 };
    byStream[k].trades += 1;
    if (t.won) byStream[k].wins += 1;
    byStream[k].pnl += t.pnlUsd;
  }
  for (const k of Object.keys(byStream)) {
    const r = byStream[k];
    r.winRate = r.trades ? r.wins / r.trades : 0;
    r.netWL = r.wins - (r.trades - r.wins);
    r.pnlUsd = r.pnl;
    delete r.pnl;
  }

  const bySymbol = {};
  for (const { symbol, base } of SYMBOLS) {
    const list = trades.filter((t) => t.base === base);
    const w = list.filter((t) => t.won).length;
    bySymbol[base] = {
      symbol,
      trades: list.length,
      wins: w,
      winRate: list.length ? w / list.length : 0,
      netWL: w - (list.length - w),
      pnlUsd: list.reduce((s, t) => s + t.pnlUsd, 0),
    };
  }

  const yearly = new Map();
  for (const [month, r] of byMonth) {
    const y = month.slice(0, 4);
    const row = yearly.get(y) ?? { trades: 0, wins: 0, losses: 0, pnl: 0, btc: 0, eth: 0 };
    row.trades += r.n;
    row.wins += r.wins;
    row.losses += r.losses;
    row.pnl += r.pnl;
    row.btc += r.btc;
    row.eth += r.eth;
    yearly.set(y, row);
  }

  return {
    period: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      days: Math.round((toMs - fromMs) / 86_400_000),
    },
    params: {
      strategy: 'jz',
      streams: SYMBOLS.flatMap((s) => TIMEFRAMES.map((tf) => `${s.base}-${tf}`)),
      sharedBankroll: true,
      maxLosses: MAX_LOSSES,
      stepUsd: STEP,
      baseBet: BASE_BET,
      principal: PRINCIPAL,
      tCap: 0,
      stakeMax: 0,
      entryRandom: `${ENTRY_LO}-${ENTRY_HI}`,
      seed: SEED,
      fee: USE_FEE,
      order: 'by_signalBarT_then_btc_eth_then_5m_15m_1h',
    },
    totals: {
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length ? wins / trades.length : 0,
      netWL: wins - losses,
      pnlUsd: equity,
      feesUsd: trades.reduce((s, t) => s + (t.feeUsd || 0), 0),
      maxDrawdownUsd: maxDd,
      maxLossStreak,
      maxStakeUsd: meta.maxStakeSeen,
    },
    bySymbol,
    byStream,
    coincidence: {
      sameBarMultiStream: meta.sameBarMulti,
      intentsByStream: meta.intentsByStream,
    },
    bankroll: {
      final: bankroll,
      meta: {
        catchUpTrades: meta.catchUpTrades,
        maxStakeSeen: meta.maxStakeSeen,
        maxQueueLen: meta.maxQueueLen,
      },
      expectedPnl: meta.expectedPnl,
      driftUsd: meta.driftUsd,
    },
    yearly: [...yearly.entries()].map(([year, r]) => ({
      year,
      trades: r.trades,
      winRate: r.trades ? r.wins / r.trades : 0,
      netWL: r.wins - r.losses,
      pnlUsd: r.pnl,
      btcTrades: r.btc,
      ethTrades: r.eth,
    })),
    monthly: [...byMonth.entries()].map(([month, r]) => ({
      month,
      trades: r.n,
      wins: r.wins,
      losses: r.losses,
      winRate: r.n ? r.wins / r.n : 0,
      netWL: r.wins - r.losses,
      pnlUsd: r.pnl,
      feesUsd: r.fees,
      maxDrawdownUsd: r.maxDd,
      maxLossStreak: r.maxLossStreak,
      btcTrades: r.btc,
      ethTrades: r.eth,
      tradesBtc5m: r.byStream['btc-5m'] || 0,
      tradesBtc15m: r.byStream['btc-15m'] || 0,
      tradesBtc1h: r.byStream['btc-1h'] || 0,
      tradesEth5m: r.byStream['eth-5m'] || 0,
      tradesEth15m: r.byStream['eth-15m'] || 0,
      tradesEth1h: r.byStream['eth-1h'] || 0,
    })),
  };
}

async function main() {
  console.log('=== 神奇九转 · 全局共用账本 (BTC+ETH × 5m/15m/1h) · ml=2 无上限 ===');
  console.log(
    `Period ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}` +
      ` · step=$${STEP} · entry ${ENTRY_LO}-${ENTRY_HI} seed=${SEED}`,
  );

  const allIntents = [];
  const intentsByStream = {};
  for (const { symbol, base } of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      const candles = loadCandles(base, tf);
      const intents = collectJzIntents(candles, { symbol, base, timeframe: tf }, FROM_MS, TO_MS);
      const key = `${base}-${tf}`;
      intentsByStream[key] = intents.length;
      console.log(`  ${key} intents: ${intents.length}`);
      allIntents.push(...intents);
    }
  }

  allIntents.sort((a, b) => {
    if (a.signalBarT !== b.signalBarT) return a.signalBarT - b.signalBarT;
    if (a.base !== b.base) return SYM_ORDER[a.base] - SYM_ORDER[b.base];
    return TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe];
  });

  let sameBarMulti = 0;
  for (let i = 0; i < allIntents.length; ) {
    let j = i + 1;
    while (j < allIntents.length && allIntents[j].signalBarT === allIntents[i].signalBarT) j += 1;
    if (j - i >= 2) sameBarMulti += 1;
    i = j;
  }

  const rng = makeRng(SEED);
  const nextEntry = () => ENTRY_LO + rng() * (ENTRY_HI - ENTRY_LO);
  const br = new BankrollEngine({
    principal: PRINCIPAL,
    stepUsd: STEP,
    defaultBetUsd: BASE_BET,
    catchUpProfitCapUsd: 0,
    stakeMaxUsd: 0,
    maxBetUsd: 0,
  });

  const trades = [];
  let maxStake = 0;
  let catchUpTrades = 0;
  let maxQueueLen = 0;

  for (const intent of allIntents) {
    const entryPrice = nextEntry();
    const sizing = br.computeStake({
      balance: br.equity(),
      entryPrice,
      spendCap: Infinity,
    });
    const stake = sizing.stakeUsd;
    if (!(stake > 0)) continue;
    if (sizing.mode === 'catch_up') catchUpTrades += 1;
    maxQueueLen = Math.max(maxQueueLen, (sizing.catchUpQueue || []).length);
    maxStake = Math.max(maxStake, stake);

    const { pnlUsd, feeUsd } = settleTrade(intent.won, stake, entryPrice);
    const after = br.onSettled(intent.won, pnlUsd);
    trades.push({
      ...intent,
      stake,
      entryPrice,
      pnlUsd,
      feeUsd,
      sizingMode: sizing.mode,
      netCountAfter: after.netCount,
    });
  }

  const meta = {
    maxStakeSeen: maxStake,
    catchUpTrades,
    maxQueueLen,
    sameBarMulti,
    intentsByStream,
    expectedPnl: br.netCount * STEP,
    driftUsd: round2(br.realizedPnlUsd - br.netCount * STEP),
  };

  const summary = summarize(trades, br.getState(), meta, FROM_MS, TO_MS);
  const t = summary.totals;
  console.log('\n======== GLOBAL SHARED ========');
  console.log(
    `开单 ${t.trades} · 胜率 ${fmtPct(t.winRate)} · N ${t.netWL >= 0 ? '+' : ''}${t.netWL}` +
      ` · 盈亏 ${fmtUsd(t.pnlUsd)} · N×5 ${fmtUsd(meta.expectedPnl)} · 偏离 ${fmtUsd(meta.driftUsd)}`,
  );
  console.log(
    `maxDD ${fmtUsd(t.maxDrawdownUsd)} · 最大注 $${maxStake.toFixed(2)}` +
      ` · 最大连亏 ${t.maxLossStreak} · 补单 ${catchUpTrades} · 同刻多流 ${sameBarMulti}`,
  );
  console.log('\n按标的:');
  for (const base of ['btc', 'eth']) {
    const r = summary.bySymbol[base];
    console.log(
      `  ${r.symbol}: ${r.trades}笔 wr ${fmtPct(r.winRate)} N ${r.netWL >= 0 ? '+' : ''}${r.netWL} 盈亏 ${fmtUsd(r.pnlUsd)}`,
    );
  }
  console.log('\n按流:');
  for (const key of Object.keys(summary.byStream).sort()) {
    const r = summary.byStream[key];
    console.log(
      `  ${key.padEnd(8)}: ${String(r.trades).padStart(5)}笔 wr ${fmtPct(r.winRate)}` +
        ` N ${r.netWL >= 0 ? '+' : ''}${r.netWL} 盈亏 ${fmtUsd(r.pnlUsd)}`,
    );
  }
  console.log('\n年份      开单    胜率   净胜负         盈亏    BTC    ETH');
  for (const y of summary.yearly) {
    console.log(
      `${y.year}  ${String(y.trades).padStart(6)}  ${fmtPct(y.winRate).padStart(7)}  ` +
        `${String(y.netWL >= 0 ? '+' + y.netWL : y.netWL).padStart(6)}  ` +
        `${fmtUsd(y.pnlUsd).padStart(11)}  ${String(y.btcTrades).padStart(5)}  ${String(y.ethTrades).padStart(5)}`,
    );
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const tag = 'btc-eth-5m15m1h-from2020-ml2';
  const outJson = join(OUT_DIR, `backtest-jz-global-shared-${tag}.json`);
  writeFileSync(outJson, JSON.stringify({ summary, tradeCount: trades.length }, null, 2));
  writeFileSync(
    join(OUT_DIR, `backtest-jz-global-shared-${tag}-monthly.json`),
    JSON.stringify(summary.monthly, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `backtest-jz-global-shared-${tag}-trades.csv`),
    [
      'symbol,timeframe,stream,signalBarT,settleBarT,signal,signalId,outcome,won,stake,entryPrice,pnlUsd,feeUsd,sizingMode,netCountAfter,shot',
      ...trades.map((tr) =>
        [
          tr.symbol,
          tr.timeframe,
          tr.stream,
          new Date(tr.signalBarT).toISOString(),
          new Date(tr.settleBarT).toISOString(),
          tr.signal,
          tr.signalId,
          tr.outcome,
          tr.won,
          tr.stake,
          Number(tr.entryPrice).toFixed(4),
          tr.pnlUsd.toFixed(4),
          (tr.feeUsd || 0).toFixed(4),
          tr.sizingMode,
          tr.netCountAfter,
          tr.shot,
        ].join(','),
      ),
    ].join('\n'),
  );
  console.log(`\nWrote ${outJson}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
