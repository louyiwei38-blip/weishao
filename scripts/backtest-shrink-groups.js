/**
 * Multi-group shrink-gate threshold backtest (low-vol reversal).
 * Usage: node scripts/backtest-shrink-groups.js --days=90
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { simulateMartingale, summarizeTrades } from './lib/backtestFactors.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const TF_MS = 5 * 60_000;

const THRESHOLD_GROUPS = [
  { id: 'always', label: '常开(无门控)', mode: 'always' },
  { id: 'F-3M', label: '固定 3M', mode: 'fixed', fixedM: 3 },
  { id: 'F-5M', label: '固定 5M', mode: 'fixed', fixedM: 5 },
  { id: 'F-7.5M', label: '固定 7.5M', mode: 'fixed', fixedM: 7.5 },
  { id: 'F-10M', label: '固定 10M', mode: 'fixed', fixedM: 10 },
  { id: 'F-12M', label: '固定 12M', mode: 'fixed', fixedM: 12 },
  { id: 'F-15M', label: '固定 15M', mode: 'fixed', fixedM: 15 },
  { id: 'F-20M', label: '固定 20M', mode: 'fixed', fixedM: 20 },
  { id: 'F-25M', label: '固定 25M', mode: 'fixed', fixedM: 25 },
  { id: 'D-prod', label: '动态 3–7M / 探测3M', mode: 'dynamic', minM: 3, maxM: 7, probeM: 3 },
  { id: 'D-legacy', label: '动态 5–10M / 探测5M', mode: 'dynamic', minM: 5, maxM: 10, probeM: 5 },
  { id: 'D-tight', label: '动态 3–7M / 探测3M', mode: 'dynamic', minM: 3, maxM: 7, probeM: 3 },
  { id: 'D-wide', label: '动态 7–15M / 探测7M', mode: 'dynamic', minM: 7, maxM: 15, probeM: 7 },
  { id: 'D-xtight', label: '动态 3–5M / 探测3M', mode: 'dynamic', minM: 3, maxM: 5, probeM: 3 },
  { id: 'D-mid', label: '动态 5–12M / 探测5M', mode: 'dynamic', minM: 5, maxM: 12, probeM: 5 },
  { id: 'D-loose', label: '动态 8–20M / 探测8M', mode: 'dynamic', minM: 8, maxM: 20, probeM: 8 },
];

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function activityFreq(candles5m, idx, probeUsdt, windowBars = 12) {
  const window = Math.min(windowBars, idx + 1);
  const startIdx = idx - window + 1;
  let hits = 0;
  for (let i = startIdx; i <= idx; i += 1) {
    const usdt = computeBarUsdtNotional(candles5m[i]);
    if (usdt != null && usdt >= probeUsdt) hits += 1;
  }
  return window > 0 ? hits / window : 0;
}

function dynamicThreshold(freq, minM, maxM) {
  const lo = Math.min(minM, maxM) * 1_000_000;
  const hi = Math.max(minM, maxM) * 1_000_000;
  const clamped = Math.min(1, Math.max(0, freq));
  return Math.round(lo + clamped * (hi - lo));
}

function resolveThreshold(c5, idx, group, windowBars = 12) {
  if (group.mode === 'fixed') return group.fixedM * 1_000_000;
  const freq = activityFreq(c5, idx, group.probeM * 1_000_000, windowBars);
  return dynamicThreshold(freq, group.minM, group.maxM);
}

function precomputeBars(c5, fromMs, toMs) {
  const rows = [];
  for (let i = 0; i < c5.length; i += 1) {
    const barT = c5[i].t;
    if (barT < fromMs || barT >= toMs) continue;
    rows.push({ t: barT, nowMs: barT + TF_MS, barUsdt: computeBarUsdtNotional(c5[i]) });
  }
  return rows;
}

function simulateTimeline(c5, rows, group, windowMinutes) {
  if (group.mode === 'always') {
    return rows.map((r) => ({ t: r.t, tradeAllowed: true, barTriggered: false }));
  }

  let untilMs = null;
  let triggers = 0;
  const winMs = windowMinutes * 60_000;
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  const timeline = [];

  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const thresholdUsdt = resolveThreshold(c5, idx, group);
    const barTriggered = row.barUsdt != null && row.barUsdt <= thresholdUsdt;
    if (barTriggered) {
      untilMs = row.nowMs + winMs;
      triggers += 1;
    }
    const active = untilMs != null && row.nowMs < untilMs;
    timeline.push({ t: row.t, tradeAllowed: active, barTriggered, thresholdUsdt, triggers: triggers });
  }

  return { timeline, triggers, gateOpenBars: timeline.filter((x) => x.tradeAllowed).length };
}

function buildGatedTrades(c5, timeline, fromMs, toMs) {
  const allowedByT = new Map(timeline.filter((x) => x.tradeAllowed).map((x) => [x.t, x]));
  const raw = [];

  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;
    if (!allowedByT.has(k1.t)) continue;

    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'low');
    if (eval_.signal === 'NONE') continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({ t: tradeTs, signalId: eval_.signalId, signal: eval_.signal, won, pnlUsd: won ? 0.5 : -0.5 });
  }

  return simulateMartingale(raw);
}

function barUsdtDistribution(rows) {
  const vals = rows.map((r) => r.barUsdt).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return null;
  const pct = (p) => vals[Math.floor(p * (vals.length - 1))];
  return { p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p95: pct(0.95) };
}

function fmtM(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000).toFixed(0)}K`;
}

function printTable(results, alwaysOn) {
  const hdr = [
    '组别'.padEnd(22),
    '门控%'.padStart(6),
    '触发'.padStart(5),
    '交易'.padStart(5),
    '胜率%'.padStart(6),
    '止损'.padStart(4),
    'PnL'.padStart(7),
    'ROI%'.padStart(6),
    'Δ常开'.padStart(7),
  ].join(' | ');
  console.log('\n' + hdr);
  console.log('-'.repeat(hdr.length));

  for (const r of results) {
    console.log([
      r.label.padEnd(22),
      `${(r.gateOpenPct * 100).toFixed(1)}%`.padStart(6),
      String(r.triggers).padStart(5),
      String(r.trades).padStart(5),
      `${(r.winRate * 100).toFixed(1)}%`.padStart(6),
      String(r.halts).padStart(4),
      r.pnl.toFixed(1).padStart(7),
      `${(r.roi * 100).toFixed(1)}%`.padStart(6),
      (r.pnl - alwaysOn.pnl).toFixed(1).padStart(7),
    ].join(' | '));
  }
}

async function main() {
  const days = Number(parseArg('days', '90'));
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const windowMinutes = Number(parseArg('window-min', String(config.sessionGate.volumeBurstMinutes)));
  const marketCtx = resolveOhlcvMarket(config.ohlcvMarketType);

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: process.argv.includes('--fetch'),
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const rows = precomputeBars(c5, fromMs, toMs);
  const totalBars = rows.length;
  const barDist = barUsdtDistribution(rows);

  const results = [];
  let alwaysOn = null;

  for (const group of THRESHOLD_GROUPS) {
    let timeline;
    let triggers = 0;
    let gateOpenBars = totalBars;

    if (group.mode === 'always') {
      timeline = rows.map((r) => ({ t: r.t, tradeAllowed: true }));
    } else {
      const sim = simulateTimeline(c5, rows, group, windowMinutes);
      timeline = sim.timeline;
      triggers = sim.triggers;
      gateOpenBars = sim.gateOpenBars;
    }

    const trades = buildGatedTrades(c5, timeline, fromMs, toMs);
    const s = summarizeTrades(trades);
    const row = {
      id: group.id,
      label: group.label,
      mode: group.mode,
      config: group.mode === 'fixed'
        ? { fixedM: group.fixedM }
        : group.mode === 'dynamic'
          ? { minM: group.minM, maxM: group.maxM, probeM: group.probeM }
          : null,
      windowMinutes,
      gateOpenPct: gateOpenBars / (totalBars || 1),
      triggers,
      trades: s.trades,
      wins: s.wins,
      winRate: s.winRate,
      halts: s.halts,
      pnl: s.pnl,
      roi: s.roi,
    };

    if (group.mode === 'always') alwaysOn = row;
    results.push(row);
  }

  results.sort((a, b) => {
    if (a.mode === 'always') return -1;
    if (b.mode === 'always') return 1;
    return b.pnl - a.pnl;
  });

  const fromStr = new Date(fromMs).toISOString().slice(0, 10);
  const toStr = new Date(toMs).toISOString().slice(0, 10);

  console.log(`\n=== 缩量窗门控 · 低波反转 · 多组阈值回测 ===`);
  console.log(`标的: OKX ${marketCtx.label} ${marketCtx.symbol}`);
  console.log(`区间: ${fromStr} → ${toStr} (${days} 天, ${totalBars} 根 5m K 线)`);
  console.log(`窗口: ${windowMinutes} 分钟 | 策略: S1→涨 S2→跌`);
  if (barDist) {
    console.log(`5m 成交额分位: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)}`);
  }

  printTable(results, alwaysOn);

  const best = results.filter((r) => r.mode !== 'always').sort((a, b) => b.pnl - a.pnl)[0];
  const prod = results.find((r) => r.id === 'D-prod');
  console.log(`\n最优门控: ${best?.label} (PnL ${best?.pnl.toFixed(1)}, 门控 ${(best?.gateOpenPct * 100).toFixed(1)}%)`);
  if (prod && best) {
    console.log(`当前生产 D-prod: PnL ${prod.pnl.toFixed(1)} (Δ最优 ${(prod.pnl - best.pnl).toFixed(1)})`);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `backtest-shrink-groups-${days}d.json`);
  writeFileSync(outFile, JSON.stringify({
    range: { from: fromStr, to: toStr, days, totalBars },
    market: { label: marketCtx.label, symbol: marketCtx.symbol },
    strategy: 'low_reversal',
    gate: 'volume_shrink',
    windowMinutes,
    barUsdtDistribution: barDist,
    alwaysOn,
    results,
    best: best ? { id: best.id, label: best.label, pnl: best.pnl } : null,
  }, null, 2));
  console.log(`\nJSON: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
