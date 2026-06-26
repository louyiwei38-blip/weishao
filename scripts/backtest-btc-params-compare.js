/**
 * 用项目默认 BTC 门控 + 动态首注参数，回测 BTC vs ETH 对比。
 *
 * Usage:
 *   node scripts/backtest-btc-params-compare.js --days=365
 *   node scripts/backtest-btc-params-compare.js --days=365 --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import { activityHitsToTier, resolveTierBaseBet } from '../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-btc-params-compare.json');

const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = 0.5;
const ACTIVITY_WINDOW = config.sessionGate.activityWindowBars;

/** 项目默认 BTC 生产参数 */
const BTC_PARAMS = {
  gate: {
    activityProbeUsdtMin: config.sessionGate.activityProbeUsdtMin,
    barVolumeUsdtMinDynamic: config.sessionGate.barVolumeUsdtMinDynamic,
    barVolumeUsdtMaxDynamic: config.sessionGate.barVolumeUsdtMaxDynamic,
    volumeBurstMinutes: config.sessionGate.volumeBurstMinutes,
  },
  tierOpts: {
    tier1_9Usd: config.dynamicBaseBet.tier1_9Usd,
    tier10Usd: config.dynamicBaseBet.tier10Usd,
    tier11Usd: config.dynamicBaseBet.tier11Usd,
    tier12Usd: config.dynamicBaseBet.tier12Usd,
  },
  fixedBase: config.tradeBudgetUsd,
};

const SYMBOLS = ['BTC/USDT', 'ETH/USDT'];

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fmtM(n) {
  if (n == null) return '—';
  return `${(n / 1e6).toFixed(1)}M`;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function computeActivityFreqLocal(c5, idx, probeUsdt) {
  const windowBars = Math.min(ACTIVITY_WINDOW, idx + 1);
  const startIdx = idx - windowBars + 1;
  let hits = 0;
  for (let i = startIdx; i <= idx; i += 1) {
    const usdt = computeBarUsdtNotional(c5[i]);
    if (usdt != null && usdt >= probeUsdt) hits += 1;
  }
  return { hits, windowBars, freq: windowBars > 0 ? hits / windowBars : 0 };
}

function resolveDynamicThreshold(freq, threshMin, threshMax) {
  const lo = Math.min(threshMin, threshMax);
  const hi = Math.max(threshMin, threshMax);
  const clamped = Math.min(1, Math.max(0, freq));
  return Math.round(hi - clamped * (hi - lo));
}

function simulateBurstTimeline(c5, rows, gate) {
  let volumeBurstUntilMs = null;
  const timeline = [];
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const burstMs = gate.volumeBurstMinutes * 60_000;

  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { freq } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
    const thresholdUsdt = resolveDynamicThreshold(
      freq,
      gate.barVolumeUsdtMinDynamic,
      gate.barVolumeUsdtMaxDynamic,
    );
    const barTriggered = row.barUsdt != null && row.barUsdt >= thresholdUsdt;
    if (barTriggered) volumeBurstUntilMs = row.nowMs + burstMs;
    const burstActive = volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs;
    timeline.push({ t: row.t, tradeAllowed: burstActive, thresholdUsdt, barUsdt: row.barUsdt });
  }
  return timeline;
}

function buildGatedTrades(c5, timeline, fromMs, toMs) {
  const allowedByT = new Map(timeline.filter((x) => x.tradeAllowed).map((x) => [x.t, x]));
  const raw = [];
  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;
    if (!allowedByT.has(k1.t)) continue;
    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;
    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');
    raw.push({ t: tradeTs, k1t: k1.t, won });
  }
  return raw;
}

function simulateMartingale(trades, c5, { fixedBase = null, tierOpts = null, gate = null } = {}) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = fixedBase ?? tierOpts?.tier1_9Usd ?? 1;
  let skipNext = false;
  let halts = 0;
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  let tradesCount = 0;
  let wins = 0;

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      continue;
    }
    if (consecutiveLosses === 0) {
      if (fixedBase != null) {
        currentBet = fixedBase;
      } else if (tierOpts) {
        const idx = idxByT.get(t.k1t) ?? 0;
        const { hits, windowBars } = computeActivityFreqLocal(
          c5, idx, gate?.activityProbeUsdtMin ?? BTC_PARAMS.gate.activityProbeUsdtMin,
        );
        currentBet = resolveTierBaseBet(activityHitsToTier(hits, windowBars), tierOpts);
      }
    }
    const stake = currentBet;
    const pnlUsd = t.won ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake) : -stake;
    cumPnl += pnlUsd;
    peakPnl = Math.max(peakPnl, cumPnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumPnl);
    totalStake += stake;
    tradesCount += 1;
    if (t.won) wins += 1;
    if (t.won) {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MARTINGALE_MAX) {
        halts += 1;
        consecutiveLosses = 0;
        skipNext = true;
      } else {
        currentBet *= MULTIPLIER;
      }
    }
  }
  return {
    trades: tradesCount,
    wins,
    winRate: tradesCount ? wins / tradesCount : 0,
    halts,
    pnl: cumPnl,
    maxDrawdown,
    roi: totalStake > 0 ? cumPnl / totalStake : 0,
    avgStake: tradesCount ? totalStake / tradesCount : 0,
  };
}

function barUsdtDistribution(rows) {
  const vals = rows.map((r) => r.barUsdt).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return null;
  const pct = (p) => vals[Math.floor(p * (vals.length - 1))];
  return { p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99) };
}

function analyzeGateReachability(c5, rows, gate, barDist) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let triggerBars = 0;
  let coldUnreachable = 0;
  let total = 0;
  const thresholds = [];

  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { freq } = computeActivityFreqLocal(c5, idx, gate.activityProbeUsdtMin);
    const thresholdUsdt = resolveDynamicThreshold(
      freq,
      gate.barVolumeUsdtMinDynamic,
      gate.barVolumeUsdtMaxDynamic,
    );
    thresholds.push(thresholdUsdt);
    total += 1;
    if (row.barUsdt >= thresholdUsdt) triggerBars += 1;
    if (freq < 0.17 && thresholdUsdt > barDist.p99) coldUnreachable += 1;
  }
  thresholds.sort((a, b) => a - b);
  const timeline = simulateBurstTimeline(c5, rows, gate);
  const gateOpenPct = timeline.filter((x) => x.tradeAllowed).length / (timeline.length || 1);
  return {
    gateOpenPct,
    triggerBarPct: total ? triggerBars / total : 0,
    coldUnreachablePct: total ? coldUnreachable / total : 0,
    threshP50: thresholds[Math.floor(thresholds.length * 0.5)],
    threshP90: thresholds[Math.floor(thresholds.length * 0.9)],
  };
}

async function runSymbol(symbol, fromMs, toMs, forceFetch) {
  const marketCtx = resolveOhlcvMarket('swap', symbol);
  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch,
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const rows = [];
  for (const bar of c5) {
    if (bar.t < fromMs || bar.t >= toMs) continue;
    rows.push({ t: bar.t, nowMs: bar.t + TF_MS, barUsdt: computeBarUsdtNotional(bar) });
  }

  const barDist = barUsdtDistribution(rows);
  const alwaysOnTrades = buildGatedTrades(
    c5,
    rows.map((r) => ({ t: r.t, tradeAllowed: true })),
    fromMs,
    toMs,
  );
  const timeline = simulateBurstTimeline(c5, rows, BTC_PARAMS.gate);
  const gatedTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const reach = analyzeGateReachability(c5, rows, BTC_PARAMS.gate, barDist);

  const alwaysOnFixed = simulateMartingale(alwaysOnTrades, c5, { fixedBase: BTC_PARAMS.fixedBase });
  const gatedFixed = simulateMartingale(gatedTrades, c5, { fixedBase: BTC_PARAMS.fixedBase });
  const gatedDynamic = simulateMartingale(gatedTrades, c5, {
    tierOpts: BTC_PARAMS.tierOpts,
    gate: BTC_PARAMS.gate,
  });

  return {
    symbol,
    marketSymbol: marketCtx.symbol,
    barDist,
    reach,
    rawSignals: gatedTrades.length,
    alwaysOn: alwaysOnFixed,
    gatedFixed,
    gatedDynamic,
  };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const forceFetch = hasFlag('fetch');

  console.log(`\n=== BTC 默认参数 · BTC vs ETH 对比 · ${days}d ===`);
  console.log('门控: probe=25M min=20M max=37M burst=21min');
  console.log('首注: 1-9=$1 | 10=$6 | 11=$8 | 12=$24 | 固定=$3\n');

  const results = [];
  for (const sym of SYMBOLS) {
    console.log(`回测 ${sym} ...`);
    results.push(await runSymbol(sym, fromMs, toMs, forceFetch));
  }

  const output = {
    days,
    params: BTC_PARAMS,
    results,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log('\n--- 成交额分布 ---');
  console.log('标的     | p50    | p90    | p95    | p99');
  for (const r of results) {
    const d = r.barDist;
    console.log(
      `${r.symbol.padEnd(8)} | ${fmtM(d.p50).padStart(6)} | ${fmtM(d.p90).padStart(6)} | ${fmtM(d.p95).padStart(6)} | ${fmtM(d.p99)}`,
    );
  }

  console.log('\n--- BTC 参数下的门控行为 ---');
  console.log('标的     | 门控开启 | 单根可触发 | 冷态阈值>p99 | 实际阈值p50');
  for (const r of results) {
    const g = r.reach;
    console.log(
      `${r.symbol.padEnd(8)} | ${pct(g.gateOpenPct).padStart(7)} | ${pct(g.triggerBarPct).padStart(9)} | ${pct(g.coldUnreachablePct).padStart(11)} | ${fmtM(g.threshP50)}`,
    );
  }

  console.log('\n--- 常开 vs 门控（固定 $3）---');
  console.log('标的     | 模式   | 交易  | 胜率  | 止损 | PnL      | ROI   | 回撤');
  for (const r of results) {
    for (const [label, m] of [['常开', r.alwaysOn], ['门控', r.gatedFixed]]) {
      console.log(
        `${r.symbol.padEnd(8)} | ${label.padEnd(6)} | ${String(m.trades).padStart(5)} | ` +
        `${pct(m.winRate).padStart(5)} | ${String(m.halts).padStart(4)} | ` +
        `$${m.pnl.toFixed(0).padStart(7)} | ${pct(m.roi).padStart(5)} | $${m.maxDrawdown.toFixed(0)}`,
      );
    }
  }

  console.log('\n--- 门控 + 动态首注（BTC 默认 1/6/8/24）---');
  console.log('标的     | 交易  | 胜率  | 止损 | PnL      | ROI   | 回撤   | Δ常开');
  for (const r of results) {
    const m = r.gatedDynamic;
    const delta = m.pnl - r.alwaysOn.pnl;
    console.log(
      `${r.symbol.padEnd(8)} | ${String(m.trades).padStart(5)} | ${pct(m.winRate).padStart(5)} | ` +
      `${String(m.halts).padStart(4)} | $${m.pnl.toFixed(0).padStart(7)} | ${pct(m.roi).padStart(5)} | ` +
      `$${m.maxDrawdown.toFixed(0).padStart(6)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}`,
    );
  }

  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
