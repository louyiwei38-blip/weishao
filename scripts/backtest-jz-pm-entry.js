/**
 * 神奇九转 · 全局共用账本 · Polymarket 真实盘口入场价回测（近半年）
 *
 * 信号/胜负仍用 OKX K 线；入场价来自 CLOB prices-history（FOK+cap 模式模拟）：
 *   ask ≤ ORDER_PRICE_CAP → 市价成交
 *   ask > cap → 限价@cap；窗口内曾触达 cap 则成交，否则强制算赢（N+1、$0）
 *
 *   node scripts/backtest-jz-pm-entry.js
 *   node scripts/backtest-jz-pm-entry.js --from=2026-02-10 --cap=0.55 --proxy=http://127.0.0.1:7897
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { MIN_SIGNAL_CANDLES as JZ_MIN } from '../src/strategy/magicNineTurns.js';
import { computeNetSettlementPnl } from '../src/trader/polymarketFees.js';
import { BankrollEngine } from './lib/bankrollEngine.js';
import {
  setPmProxy,
  resolveIntentEntryPrice,
  resolveDefaultProxy,
} from './lib/pmPriceHistory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'logs');
const CACHE_DIR = join(OUT_DIR, 'pm-entry-cache');

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

function parseStreamKey(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  const m = s.match(/^([a-z0-9]+)-(5m|15m|1h)$/);
  if (!m) throw new Error(`bad stream key: ${raw}`);
  return { base: m[1], timeframe: m[2], key: `${m[1]}-${m[2]}` };
}

function resolveStreams() {
  const raw = argStr('streams');
  if (raw) {
    return raw
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(parseStreamKey);
  }
  // Live 12-stream default
  return (
    'btc-5m,btc-15m,btc-1h,eth-5m,eth-15m,eth-1h,bnb-15m,bnb-1h,xrp-15m,xrp-1h,sol-15m,sol-1h'
  )
    .split(',')
    .map(parseStreamKey);
}

const STREAMS = resolveStreams();
const SYMBOLS = [
  ...new Map(
    STREAMS.map((s) => [s.base, { symbol: `${s.base.toUpperCase()}/USDT`, base: s.base }]),
  ).values(),
];
const SYM_ORDER = Object.fromEntries(SYMBOLS.map((s, i) => [s.base, i]));

const TO_MS = argStr('to')
  ? Date.parse(argStr('to').includes('T') ? argStr('to') : `${argStr('to')}T23:59:59.999Z`)
  : Date.now();
const FROM_MS = argStr('from')
  ? Date.parse(`${argStr('from')}T00:00:00.000Z`)
  : TO_MS - 183 * 86_400_000; // ~6 months

const BASE_BET = argNum('base', 5);
const STEP = argNum('step', 5);
const PRINCIPAL = argNum('principal', 10_000);
const MAX_LOSSES = argNum('maxLosses', 2);
const USE_FEE = argBool('fee', true);
const CAP = argNum('cap', 0.55);
const ENTRY_DELAY = argNum('entryDelaySec', 3);
const CONCURRENCY = Math.max(1, Math.floor(argNum('concurrency', 10)));
const SKIP_MISSING = argBool('skipMissing', true);
const LIMIT = argNum('limit', 0); // debug: only first N intents

const proxyArg = argStr('proxy');
if (proxyArg) setPmProxy(proxyArg);
else setPmProxy(resolveDefaultProxy());

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
  if (!(stake > 0)) return { pnlUsd: 0, feeUsd: 0 };
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
      candleWon: won,
      lossesBefore,
      shot,
    });
  }
  return intents;
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function main() {
  console.log('=== 神奇九转 · PM 盘口入场价 · 全局共用账本 ===');
  console.log(`  streams: ${STREAMS.map((s) => s.key).join(', ')}`);
  console.log(
    `  period ${new Date(FROM_MS).toISOString().slice(0, 10)} → ${new Date(TO_MS).toISOString().slice(0, 10)}` +
      ` · cap=${CAP} · fee=${USE_FEE} · proxy=${resolveDefaultProxy()}`,
  );

  const allIntents = [];
  for (const { base, timeframe: tf, key } of STREAMS) {
    const symbol = `${base.toUpperCase()}/USDT`;
    const candles = loadCandles(base, tf);
    const intents = collectJzIntents(candles, { symbol, base, timeframe: tf }, FROM_MS, TO_MS);
    console.log(`  ${key} intents: ${intents.length}`);
    allIntents.push(...intents);
  }

  allIntents.sort((a, b) => {
    if (a.signalBarT !== b.signalBarT) return a.signalBarT - b.signalBarT;
    if (a.base !== b.base) return SYM_ORDER[a.base] - SYM_ORDER[b.base];
    return TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe];
  });

  let intents = allIntents;
  if (LIMIT > 0) intents = intents.slice(0, LIMIT);
  console.log(`\nResolving Polymarket entry for ${intents.length} intents (concurrency=${CONCURRENCY})...`);

  let done = 0;
  const t0 = Date.now();
  const resolved = await mapPool(intents, CONCURRENCY, async (intent) => {
    // curl is sync/blocking — wrap so pool still paces work
    const entry = await resolveIntentEntryPrice(intent, {
      cacheDir: CACHE_DIR,
      cap: CAP,
      entryDelaySec: ENTRY_DELAY,
    });
    done += 1;
    if (done % 50 === 0 || done === intents.length) {
      const rate = done / ((Date.now() - t0) / 1000 || 1);
      console.log(
        `  progress ${done}/${intents.length} (${rate.toFixed(1)}/s)` +
          ` last=${intent.stream} ${entry.mode || entry.reason}`,
      );
    }
    return { intent, entry };
  });

  const coverage = {
    total: resolved.length,
    filled: 0,
    forceWin: 0,
    missing: 0,
    byReason: {},
  };

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
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let maxLossStreak = 0;
  let lossStreak = 0;
  const byStream = {};
  const byMonth = new Map();

  for (const { intent, entry } of resolved) {
    if (!entry.ok) {
      coverage.missing += 1;
      coverage.byReason[entry.reason] = (coverage.byReason[entry.reason] || 0) + 1;
      if (SKIP_MISSING) continue;
    }

    let won;
    let stake = 0;
    let entryPrice = entry.entryPrice;
    let pnlUsd = 0;
    let feeUsd = 0;
    let sizingMode = 'skip';
    let forceWin = false;

    if (entry.forceWin || entry.mode === 'unfilled_force_win') {
      coverage.forceWin += 1;
      forceWin = true;
      won = true;
      stake = 0;
      entryPrice = CAP;
      // Force-win: credit exactly one bankroll step (matches N+1), not order PnL.
      pnlUsd = STEP;
      feeUsd = 0;
      sizingMode = 'unfilled_force_win';
      br.onSettled(true, STEP);
    } else if (entry.filled) {
      coverage.filled += 1;
      won = intent.candleWon;
      const sizing = br.computeStake({
        balance: br.equity(),
        entryPrice,
        spendCap: Infinity,
      });
      stake = sizing.stakeUsd;
      if (!(stake > 0)) continue;
      if (sizing.mode === 'catch_up') catchUpTrades += 1;
      sizingMode = sizing.mode;
      maxStake = Math.max(maxStake, stake);
      ({ pnlUsd, feeUsd } = settleTrade(won, stake, entryPrice));
      br.onSettled(won, pnlUsd);
    } else {
      coverage.missing += 1;
      coverage.byReason[entry.reason || 'not_filled'] =
        (coverage.byReason[entry.reason || 'not_filled'] || 0) + 1;
      continue;
    }

    equity = br.realizedPnlUsd;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
    if (won) lossStreak = 0;
    else {
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }

    const month = new Date(intent.signalBarT).toISOString().slice(0, 7);
    if (!byMonth.has(month)) {
      byMonth.set(month, { n: 0, wins: 0, losses: 0, pnl: 0, forceWins: 0 });
    }
    const mr = byMonth.get(month);
    mr.n += 1;
    if (won) mr.wins += 1;
    else mr.losses += 1;
    mr.pnl += pnlUsd;
    if (forceWin) mr.forceWins += 1;

    if (!byStream[intent.stream]) {
      byStream[intent.stream] = { trades: 0, wins: 0, losses: 0, pnl: 0, forceWins: 0 };
    }
    const sr = byStream[intent.stream];
    sr.trades += 1;
    if (won) sr.wins += 1;
    else sr.losses += 1;
    sr.pnl += pnlUsd;
    if (forceWin) sr.forceWins += 1;

    trades.push({
      ...intent,
      won,
      stake,
      entryPrice,
      askAtEntry: entry.askAtEntry ?? null,
      entryMode: entry.mode,
      forceWin,
      pnlUsd,
      feeUsd,
      sizingMode,
      slug: entry.slug,
      netCountAfter: br.netCount,
    });
  }

  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  const summary = {
    period: {
      from: new Date(FROM_MS).toISOString(),
      to: new Date(TO_MS).toISOString(),
    },
    params: {
      cap: CAP,
      fee: USE_FEE,
      stepUsd: STEP,
      baseBet: BASE_BET,
      streams: STREAMS.map((s) => s.key),
      entrySource: 'polymarket_prices_history',
      unfilledForceWin: true,
    },
    coverage,
    totals: {
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length ? wins / trades.length : 0,
      netWL: wins - losses,
      pnlUsd: equity,
      expectedPnl: br.netCount * STEP,
      driftUsd: round2(equity - br.netCount * STEP),
      maxDrawdownUsd: maxDd,
      maxStakeUsd: maxStake,
      maxLossStreak,
      catchUpTrades,
      forceWinTrades: coverage.forceWin,
    },
    byStream,
    monthly: [...byMonth.entries()].map(([month, r]) => ({
      month,
      trades: r.n,
      wins: r.wins,
      losses: r.losses,
      winRate: r.n ? r.wins / r.n : 0,
      netWL: r.wins - r.losses,
      pnlUsd: r.pnl,
      forceWins: r.forceWins,
    })),
    bankroll: br.getState(),
  };

  const t = summary.totals;
  console.log('\n======== PM ENTRY BACKTEST ========');
  console.log(
    `覆盖: intents ${coverage.total} · 成交 ${coverage.filled} · 强制赢 ${coverage.forceWin} · 缺失 ${coverage.missing}`,
  );
  if (Object.keys(coverage.byReason).length) {
    console.log('  缺失原因:', coverage.byReason);
  }
  console.log(
    `开单 ${t.trades} · 胜率 ${fmtPct(t.winRate)} · N ${t.netWL >= 0 ? '+' : ''}${t.netWL}` +
      ` · 盈亏 ${fmtUsd(t.pnlUsd)} · N×5 ${fmtUsd(t.expectedPnl)} · 偏离 ${fmtUsd(t.driftUsd)}`,
  );
  console.log(
    `maxDD ${fmtUsd(t.maxDrawdownUsd)} · 最大注 $${maxStake.toFixed(2)}` +
      ` · 最大连亏 ${t.maxLossStreak} · 补单 ${catchUpTrades} · 强制赢 ${t.forceWinTrades}`,
  );
  console.log('\n按流:');
  for (const key of Object.keys(byStream).sort()) {
    const r = byStream[key];
    const wr = r.trades ? r.wins / r.trades : 0;
    console.log(
      `  ${key.padEnd(8)}: ${String(r.trades).padStart(5)}笔 wr ${fmtPct(wr)}` +
        ` N ${r.wins - r.losses >= 0 ? '+' : ''}${r.wins - r.losses}` +
        ` 盈亏 ${fmtUsd(r.pnl)} · forceWin ${r.forceWins}`,
    );
  }
  console.log('\n月份      开单    胜率   净胜负         盈亏  强制赢');
  for (const m of summary.monthly) {
    console.log(
      `${m.month}  ${String(m.trades).padStart(6)}  ${fmtPct(m.winRate).padStart(7)}  ` +
        `${String(m.netWL >= 0 ? '+' + m.netWL : m.netWL).padStart(6)}  ` +
        `${fmtUsd(m.pnlUsd).padStart(11)}  ${String(m.forceWins).padStart(5)}`,
    );
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const tag = `pm-entry-from${new Date(FROM_MS).toISOString().slice(0, 10)}-cap${String(CAP).replace('.', 'p')}-ml2`;
  const outJson = join(OUT_DIR, `backtest-jz-global-shared-${tag}.json`);
  writeFileSync(outJson, JSON.stringify({ summary, tradeCount: trades.length }, null, 2));
  writeFileSync(
    join(OUT_DIR, `backtest-jz-global-shared-${tag}-monthly.json`),
    JSON.stringify(summary.monthly, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `backtest-jz-global-shared-${tag}-trades.csv`),
    [
      'symbol,timeframe,stream,signalBarT,settleBarT,signal,signalId,outcome,won,forceWin,entryMode,askAtEntry,entryPrice,stake,pnlUsd,feeUsd,sizingMode,slug,netCountAfter',
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
          tr.forceWin,
          tr.entryMode,
          tr.askAtEntry ?? '',
          tr.entryPrice != null ? Number(tr.entryPrice).toFixed(4) : '',
          tr.stake,
          tr.pnlUsd.toFixed(4),
          (tr.feeUsd || 0).toFixed(4),
          tr.sizingMode,
          tr.slug || '',
          tr.netCountAfter,
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
