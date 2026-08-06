/**
 * 神奇九转 · 同标的多周期共用账本
 *   BTC: 5m + 15m + 1h → one P/N/补队列
 *   ETH: 5m + 15m + 1h → one P/N/补队列
 *   Each TF keeps its own Setup / ml=2 chain; stakes share one ledger.
 *   Concurrent signals (same signalBarT): settle order 5m → 15m → 1h.
 *
 *   node scripts/backtest-jz-multitf-shared.js --all --from=2020-01-01
 *   node scripts/backtest-jz-multitf-shared.js --symbol=BTC/USDT
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

const TIMEFRAMES = ['5m', '15m', '1h'];
const TF_ORDER = { '5m': 0, '15m': 1, '1h': 2 };

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
    `  ${tf}: ${candles.length} bars ` +
      `${new Date(candles[0].t).toISOString()} → ${new Date(candles.at(-1).t).toISOString()}`,
  );
  return candles;
}

/**
 * Collect JZ intents for one TF (no sizing yet).
 * @returns {object[]}
 */
function collectJzIntents(candles, timeframe, fromMs, toMs) {
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
      timeframe,
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

function runSharedMultiTf(base, symbolLabel) {
  console.log(`\n######## ${symbolLabel} · JZ 5m+15m+1h shared book ########`);
  const byTf = {};
  for (const tf of TIMEFRAMES) {
    byTf[tf] = loadCandles(base, tf);
  }

  const allIntents = [];
  for (const tf of TIMEFRAMES) {
    const intents = collectJzIntents(byTf[tf], tf, FROM_MS, TO_MS);
    console.log(`  ${tf} intents: ${intents.length}`);
    allIntents.push(...intents);
  }

  allIntents.sort((a, b) => {
    if (a.signalBarT !== b.signalBarT) return a.signalBarT - b.signalBarT;
    return TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe];
  });

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
  const sameBarMulti = { '2': 0, '3': 0 };
  let i = 0;
  while (i < allIntents.length) {
    let j = i + 1;
    while (j < allIntents.length && allIntents[j].signalBarT === allIntents[i].signalBarT) j += 1;
    const groupSize = j - i;
    if (groupSize === 2) sameBarMulti['2'] += 1;
    if (groupSize >= 3) sameBarMulti['3'] += 1;
    i = j;
  }

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

  return {
    trades,
    bankroll: br.getState(),
    meta: {
      symbol: symbolLabel,
      maxStakeSeen: maxStake,
      catchUpTrades,
      maxQueueLen,
      sameBarDualTf: sameBarMulti['2'],
      sameBarTripleTf: sameBarMulti['3'],
      expectedPnl: br.netCount * STEP,
      driftUsd: round2(br.realizedPnlUsd - br.netCount * STEP),
      intentsByTf: Object.fromEntries(
        TIMEFRAMES.map((tf) => [tf, allIntents.filter((x) => x.timeframe === tf).length]),
      ),
    },
  };
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
    byTf: { '5m': 0, '15m': 0, '1h': 0 },
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
    row.byTf[t.timeframe] = (row.byTf[t.timeframe] || 0) + 1;
    byMonth.set(key, row);
  }

  const byTf = {};
  for (const tf of TIMEFRAMES) {
    const list = trades.filter((t) => t.timeframe === tf);
    const w = list.filter((t) => t.won).length;
    byTf[tf] = {
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
    const row = yearly.get(y) ?? {
      trades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
      byTf: { '5m': 0, '15m': 0, '1h': 0 },
    };
    row.trades += r.n;
    row.wins += r.wins;
    row.losses += r.losses;
    row.pnl += r.pnl;
    for (const tf of TIMEFRAMES) row.byTf[tf] += r.byTf[tf] || 0;
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
      timeframes: TIMEFRAMES,
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
      order: 'by_signalBarT_then_5m_15m_1h',
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
    byTimeframe: byTf,
    coincidence: {
      sameBarDualTf: meta.sameBarDualTf,
      sameBarTripleTf: meta.sameBarTripleTf,
      intentsByTf: meta.intentsByTf,
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
      trades5m: r.byTf['5m'],
      trades15m: r.byTf['15m'],
      trades1h: r.byTf['1h'],
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
      trades5m: r.byTf['5m'],
      trades15m: r.byTf['15m'],
      trades1h: r.byTf['1h'],
    })),
  };
}

function printSummary(label, summary) {
  const t = summary.totals;
  const br = summary.bankroll;
  console.log(`\n======== ${label} ========`);
  console.log(
    `开单 ${t.trades} · 胜率 ${fmtPct(t.winRate)} · N ${t.netWL >= 0 ? '+' : ''}${t.netWL}` +
      ` · 盈亏 ${fmtUsd(t.pnlUsd)} · N×5 ${fmtUsd(br.expectedPnl)} · 偏离 ${fmtUsd(br.driftUsd)}`,
  );
  console.log(
    `maxDD ${fmtUsd(t.maxDrawdownUsd)} · 最大注 $${Number(t.maxStakeUsd).toFixed(2)}` +
      ` · 最大连亏 ${t.maxLossStreak} · 补单 ${br.meta.catchUpTrades}`,
  );
  for (const tf of TIMEFRAMES) {
    const r = summary.byTimeframe[tf];
    console.log(
      `  ${tf.padEnd(3)}: ${String(r.trades).padStart(5)}笔 wr ${fmtPct(r.winRate)}` +
        ` N ${r.netWL >= 0 ? '+' : ''}${r.netWL} 盈亏 ${fmtUsd(r.pnlUsd)}`,
    );
  }
  const c = summary.coincidence;
  console.log(
    `同刻多周期: 双开 ${c.sameBarDualTf} · 三开 ${c.sameBarTripleTf}`,
  );
  console.log('年份      开单    胜率   净胜负         盈亏    5m   15m    1h');
  for (const y of summary.yearly) {
    console.log(
      `${y.year}  ${String(y.trades).padStart(6)}  ${fmtPct(y.winRate).padStart(7)}  ` +
        `${String(y.netWL >= 0 ? '+' + y.netWL : y.netWL).padStart(6)}  ` +
        `${fmtUsd(y.pnlUsd).padStart(11)}  ${String(y.trades5m).padStart(4)}  ` +
        `${String(y.trades15m).padStart(4)}  ${String(y.trades1h).padStart(4)}`,
    );
  }
}

async function runSymbol(symbol) {
  const base = symbol.split('/')[0].toLowerCase();
  const { trades, bankroll, meta } = runSharedMultiTf(base, symbol);
  const summary = summarize(trades, bankroll, meta, FROM_MS, TO_MS);
  printSummary(symbol, summary);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const tag = `${base}-5m15m1h-from2020-ml2`;
  const outJson = join(OUT_DIR, `backtest-jz-sharedtf-${tag}.json`);
  writeFileSync(outJson, JSON.stringify({ summary, tradeCount: trades.length }, null, 2));
  writeFileSync(
    join(OUT_DIR, `backtest-jz-sharedtf-${tag}-trades.csv`),
    [
      'timeframe,signalBarT,settleBarT,signal,signalId,outcome,won,stake,entryPrice,pnlUsd,feeUsd,sizingMode,netCountAfter,shot',
      ...trades.map((t) =>
        [
          t.timeframe,
          new Date(t.signalBarT).toISOString(),
          new Date(t.settleBarT).toISOString(),
          t.signal,
          t.signalId,
          t.outcome,
          t.won,
          t.stake,
          Number(t.entryPrice).toFixed(4),
          t.pnlUsd.toFixed(4),
          (t.feeUsd || 0).toFixed(4),
          t.sizingMode,
          t.netCountAfter,
          t.shot,
        ].join(','),
      ),
    ].join('\n'),
  );
  writeFileSync(
    join(OUT_DIR, `backtest-jz-sharedtf-${tag}-monthly.json`),
    JSON.stringify(summary.monthly, null, 2),
  );
  console.log(`Wrote ${outJson}`);
  return { symbol, base, summary };
}

async function main() {
  const all = process.argv.includes('--all') || !argStr('symbol');
  const symbols = all
    ? ['BTC/USDT', 'ETH/USDT']
    : [
        argStr('symbol', 'BTC/USDT').includes('/')
          ? argStr('symbol', 'BTC/USDT')
          : `${argStr('symbol')}/USDT`,
      ];

  console.log('=== 神奇九转 · 多周期共用账本 (5m+15m+1h) · ml=2 无上限 ===');
  console.log(
    `Period ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}` +
      ` · step=$${STEP} · entry ${ENTRY_LO}-${ENTRY_HI} seed=${SEED}`,
  );

  const results = [];
  for (const sym of symbols) {
    results.push(await runSymbol(sym));
  }

  const bundlePath = join(OUT_DIR, 'backtest-jz-sharedtf-btc-eth-5m15m1h-from2020-ml2.json');
  writeFileSync(
    bundlePath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'JZ ml=2; BTC/ETH each share one book across 5m+15m+1h; order by signalBarT then 5m→15m→1h',
        params: results[0]?.summary.params,
        symbols: results.map((r) => ({
          symbol: r.symbol,
          totals: r.summary.totals,
          byTimeframe: r.summary.byTimeframe,
          coincidence: r.summary.coincidence,
          bankroll: r.summary.bankroll,
          yearly: r.summary.yearly,
          monthly: r.summary.monthly,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${bundlePath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
