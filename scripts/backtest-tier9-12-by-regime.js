/**
 * Tier 9-12 only backtest broken down by market regime segments.
 * Usage:
 *   node scripts/backtest-tier9-12-by-regime.js --days=365
 *   node scripts/backtest-tier9-12-by-regime.js --days=365 --tier1-9=1 --tier10=6 --tier11=8 --tier12=24
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import {
  computeActivityFreq,
  resolveBurstThresholdUsdt,
} from '../src/session/sessionGate.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import {
  activityHitsToTier,
  resolveTierBaseBet,
  formatTierParamLabel,
  TIER_COUNT,
} from '../src/martingale/dynamicBaseBet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-tier9-12-by-regime.json');
const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = 0.5;
const SHORT_BARS = 12;
const LONG_BARS = 96;

const CUSTOM_WINDOWS = [
  { key: 'jun_02_06', label: '2026-06-02 ~ 06-06', from: '2026-06-02', to: '2026-06-07' },
  { key: 'jun_07_10', label: '2026-06-07 ~ 06-10', from: '2026-06-07', to: '2026-06-11' },
];

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function parseTierOpts() {
  const tier1_9 = Number(parseArg('tier1-9', String(config.dynamicBaseBet.tier1_9Usd)));
  const tier10 = Number(parseArg('tier10', String(config.dynamicBaseBet.tier10Usd)));
  const tier11 = Number(parseArg('tier11', String(config.dynamicBaseBet.tier11Usd)));
  const tier12 = Number(parseArg('tier12', String(config.dynamicBaseBet.tier12Usd)));
  return {
    tier1_9Usd: tier1_9,
    tier10Usd: tier10,
    tier11Usd: tier11,
    tier12Usd: tier12,
  };
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

function quarterKey(ms) {
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

function getActivityAt(c5, idx) {
  const { hits, windowBars } = computeActivityFreq(c5, idx);
  return { hits, windowBars, tier: activityHitsToTier(hits, windowBars) };
}

function periodVolRatio(c5, i) {
  if (i < LONG_BARS) return null;
  let shortSum = 0;
  let longSum = 0;
  for (let j = i - SHORT_BARS + 1; j <= i; j += 1) shortSum += Number(c5[j]?.volume) || 0;
  for (let j = i - LONG_BARS + 1; j <= i; j += 1) longSum += Number(c5[j]?.volume) || 0;
  const longAvg = longSum / LONG_BARS;
  if (longAvg <= 0) return null;
  return (shortSum / SHORT_BARS) / longAvg;
}

function buildPeriodMap(c5) {
  const ratios = [];
  for (let i = LONG_BARS; i < c5.length; i += 1) {
    const r = periodVolRatio(c5, i);
    if (r != null) ratios.push(r);
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const p33 = q(0.33);
  const p66 = q(0.66);
  const byIndex = new Map();
  for (let i = LONG_BARS; i < c5.length; i += 1) {
    const r = periodVolRatio(c5, i);
    if (r == null) continue;
    let period = 'neutral';
    if (r <= p33) period = 'low';
    else if (r >= p66) period = 'high';
    byIndex.set(i, { period, period_vol_ratio: r });
  }
  return { byIndex, thresholds: { p33, p66 } };
}

function buildDailyVolumeMap(c5, fromMs, toMs) {
  const byDay = new Map();
  for (const bar of c5) {
    if (bar.t < fromMs || bar.t >= toMs) continue;
    const dk = dayKey(bar.t);
    const usdt = computeBarUsdtNotional(bar);
    if (!byDay.has(dk)) byDay.set(dk, { bars: 0, totalUsdt: 0 });
    const d = byDay.get(dk);
    d.bars += 1;
    d.totalUsdt += usdt;
  }
  const days = [...byDay.entries()].map(([date, v]) => ({
    date,
    avgBarUsdt: v.bars ? v.totalUsdt / v.bars : 0,
    totalUsdt: v.totalUsdt,
  }));
  const sorted = [...days].sort((a, b) => a.avgBarUsdt - b.avgBarUsdt);
  const n = sorted.length;
  const q = (p) => sorted[Math.floor(p * Math.max(n - 1, 0))]?.avgBarUsdt ?? 0;
  const p33 = q(0.33);
  const p66 = q(0.66);
  const bucketByDay = new Map();
  for (const d of days) {
    const b = d.avgBarUsdt <= p33 ? 'low' : d.avgBarUsdt >= p66 ? 'high' : 'mid';
    bucketByDay.set(d.date, { bucket: b, avgBarUsdt: d.avgBarUsdt, totalUsdt: d.totalUsdt });
  }
  return { bucketByDay, thresholds: { p33, p66 }, days: days.length };
}

function simulateBurstTimeline(c5, rows, volumeBurstMinutes) {
  let volumeBurstUntilMs = null;
  const timeline = [];
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { thresholdUsdt } = resolveBurstThresholdUsdt(c5, idx);
    if (row.barUsdt != null && row.barUsdt >= thresholdUsdt) {
      volumeBurstUntilMs = row.nowMs + volumeBurstMinutes * 60_000;
    }
    const burstActive = volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs;
    timeline.push({ t: row.t, tradeAllowed: burstActive });
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
    raw.push({ t: tradeTs, k1t: k1.t, k1Idx: i, won });
  }
  return raw;
}

function simulateTierMin(trades, c5, tierOpts, tierMin = 9) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = tierOpts.tier1_9Usd;
  let skipNext = false;
  let halts = 0;
  let streakTier = null;
  const executed = [];

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      streakTier = null;
      continue;
    }

    if (consecutiveLosses === 0) {
      const idx = idxByT.get(t.k1t) ?? t.k1Idx ?? 0;
      const { tier } = getActivityAt(c5, idx);
      if (tier < tierMin) continue;
      streakTier = tier;
      currentBet = resolveTierBaseBet(tier, tierOpts);
    } else if (streakTier < tierMin) {
      continue;
    }

    const stake = currentBet;
    const pnlUsd = t.won
      ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake)
      : -stake;

    executed.push({
      ...t,
      stake,
      pnlUsd,
      entryTier: streakTier,
      lossStreakPos: t.won ? 0 : consecutiveLosses + 1,
    });

    if (t.won) {
      consecutiveLosses = 0;
      streakTier = null;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MARTINGALE_MAX) {
        halts += 1;
        consecutiveLosses = 0;
        streakTier = null;
        skipNext = true;
      } else {
        currentBet *= MULTIPLIER;
      }
    }
  }
  return { executed, halts };
}

function summarizeTrades(trades) {
  if (!trades.length) {
    return { trades: 0, wins: 0, winRate: 0, halts: 0, pnl: 0, roi: 0, maxDrawdown: 0, avgStake: 0, totalStake: 0 };
  }
  let cumPnl = 0;
  let peak = 0;
  let maxDd = 0;
  let totalStake = 0;
  const wins = trades.filter((t) => t.won).length;
  for (const t of trades) {
    cumPnl += t.pnlUsd;
    peak = Math.max(peak, cumPnl);
    maxDd = Math.max(maxDd, peak - cumPnl);
    totalStake += t.stake;
  }
  return {
    trades: trades.length,
    wins,
    winRate: wins / trades.length,
    pnl: cumPnl,
    roi: totalStake > 0 ? cumPnl / totalStake : 0,
    maxDrawdown: maxDd,
    avgStake: totalStake / trades.length,
    totalStake,
  };
}

function summarizeByTier(trades, tierOpts) {
  return [9, 10, 11, 12].map((tier) => {
    const slice = trades.filter((t) => t.entryTier === tier);
    const s = summarizeTrades(slice);
    return {
      tier,
      baseBet: resolveTierBaseBet(tier, tierOpts),
      ...s,
    };
  });
}

function groupAndSummarize(trades, keyFn, tierOpts, labels = null) {
  const groups = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keys = [...groups.keys()].sort();
  return keys.map((key) => {
    const slice = groups.get(key);
    const s = summarizeTrades(slice);
    const halts = slice.filter((t, i, arr) => {
      if (t.lossStreakPos !== 4) return false;
      return true;
    }).length;
    return {
      key,
      label: labels?.get(key) ?? key,
      halts,
      byTier: summarizeByTier(slice, tierOpts),
      ...s,
    };
  });
}

function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtM(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

function printSegmentTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) {
    console.log('(无成交)');
    return;
  }
  console.log('区间              | 成交  | 胜率  | 止损 | PnL      | ROI   | 回撤   | 9档   | 10档  | 11档  | 12档');
  for (const r of rows) {
    const tierPnls = [9, 10, 11, 12].map((tier) => {
      const t = r.byTier?.find((x) => x.tier === tier);
      return t?.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)}` : '—';
    });
    console.log(
      `${String(r.label).padEnd(17)} | ` +
      `${String(r.trades).padStart(5)} | ` +
      `${fmtPct(r.winRate).padStart(5)} | ` +
      `${String(r.halts ?? 0).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(7)} | ` +
      `${fmtPct(r.roi).padStart(5)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(5)} | ` +
      tierPnls.map((x) => x.padStart(5)).join(' | '),
    );
  }
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const tierOpts = parseTierOpts();
  const marketCtx = resolveOhlcvMarket('swap');

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const sg = config.sessionGate;
  const rows = [];
  for (const bar of c5) {
    if (bar.t < fromMs || bar.t >= toMs) continue;
    rows.push({ t: bar.t, nowMs: bar.t + TF_MS, barUsdt: computeBarUsdtNotional(bar) });
  }

  const timeline = simulateBurstTimeline(c5, rows, sg.volumeBurstMinutes);
  const rawTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const { byIndex: periodByIndex, thresholds: periodThresholds } = buildPeriodMap(c5);
  const { bucketByDay, thresholds: dailyThresholds } = buildDailyVolumeMap(c5, fromMs, toMs);
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));

  const { executed, halts } = simulateTierMin(rawTrades, c5, tierOpts, 9);
  const overall = { ...summarizeTrades(executed), halts };

  const enrich = (t) => {
    const idx = idxByT.get(t.k1t) ?? t.k1Idx;
    const pinfo = periodByIndex.get(idx);
    const dk = dayKey(t.t);
    const dayInfo = bucketByDay.get(dk);
    return {
      ...t,
      month: monthKey(t.t),
      quarter: quarterKey(t.t),
      day: dk,
      volPeriod: pinfo?.period ?? 'unknown',
      periodVolRatio: pinfo?.period_vol_ratio ?? null,
      dailyVolBucket: dayInfo?.bucket ?? 'unknown',
      dailyAvgBarUsdt: dayInfo?.avgBarUsdt ?? null,
    };
  };
  const enriched = executed.map(enrich);

  const monthly = groupAndSummarize(enriched, (t) => t.month, tierOpts);
  const quarterly = groupAndSummarize(enriched, (t) => t.quarter, tierOpts);
  const volPeriod = groupAndSummarize(enriched, (t) => t.volPeriod, tierOpts);
  const dailyVolBucket = groupAndSummarize(enriched, (t) => t.dailyVolBucket, tierOpts);

  const customWindows = CUSTOM_WINDOWS.map((w) => {
    const from = Date.parse(`${w.from}T00:00:00.000Z`);
    const to = Date.parse(`${w.to}T00:00:00.000Z`);
    const slice = enriched.filter((t) => t.t >= from && t.t < to);
    const s = summarizeTrades(slice);
    return {
      ...w,
      ...s,
      halts: slice.filter((t) => t.lossStreakPos === 4).length,
      byTier: summarizeByTier(slice, tierOpts),
    };
  });

  const output = {
    strategy: 'tier_9_12_only',
    tierOpts,
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), days },
    thresholds: { volPeriod: periodThresholds, dailyBarUsdt: dailyThresholds },
    gateSignals: rawTrades.length,
    overall,
    byTier: summarizeByTier(enriched, tierOpts),
    monthly,
    quarterly,
    volPeriod,
    dailyVolBucket,
    customWindows,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n=== 9-12档 · 不同行情段回测 · ${days}d · OKX ${marketCtx.label} ===`);
  console.log(`参数: ${formatTierParamLabel(tierOpts)}`);
  console.log(`门控信号: ${rawTrades.length} | 9-12档成交: ${overall.trades} (${fmtPct(overall.trades / rawTrades.length)} 覆盖)`);
  console.log(`整体: PnL $${overall.pnl.toFixed(0)} | ROI ${fmtPct(overall.roi)} | WR ${fmtPct(overall.winRate)} | 止损 ${halts} | 回撤 $${overall.maxDrawdown.toFixed(0)}`);

  console.log('\n--- 各档贡献 ---');
  for (const t of output.byTier) {
    console.log(
      `${t.tier}档 ($${t.baseBet}): ${t.trades}笔 WR ${fmtPct(t.winRate)} PnL ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(0)} ROI ${fmtPct(t.roi)}`,
    );
  }

  printSegmentTable('按月', monthly);
  printSegmentTable('按季度', quarterly);
  printSegmentTable('按相对成交量段 (1h/8h ratio)', volPeriod.map((r) => ({
    ...r,
    label: { high: '高量段', neutral: '中性段', low: '低量段', unknown: '未知' }[r.key] ?? r.key,
  })));
  printSegmentTable('按日成交额分位', dailyVolBucket.map((r) => ({
    ...r,
    label: { high: '高量日', mid: '中量日', low: '低量日', unknown: '未知' }[r.key] ?? r.key,
  })));
  printSegmentTable('自定义区间', customWindows);

  const profitableMonths = monthly.filter((m) => m.pnl > 0).length;
  const losingMonths = monthly.filter((m) => m.pnl < 0).length;
  console.log(`\n--- 稳定性 ---`);
  console.log(`盈利月份: ${profitableMonths}/${monthly.length} | 亏损月份: ${losingMonths}/${monthly.length}`);
  console.log(`高量段 PnL: $${volPeriod.find((x) => x.key === 'high')?.pnl?.toFixed(0) ?? '—'} | 低量段: $${volPeriod.find((x) => x.key === 'low')?.pnl?.toFixed(0) ?? '—'}`);
  console.log(`高量日 PnL: $${dailyVolBucket.find((x) => x.key === 'high')?.pnl?.toFixed(0) ?? '—'} | 低量日: $${dailyVolBucket.find((x) => x.key === 'low')?.pnl?.toFixed(0) ?? '—'}`);
  console.log(`\nFull JSON: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
