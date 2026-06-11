/**
 * Session gate v2 backtest: scheduled (macro ±h ∨ US 19:30–23:59) + 5m bar volume burst.
 * Usage:
 *   node scripts/backtest-session-gate-v2.js --days=365
 *   node scripts/backtest-session-gate-v2.js --days=365 --sweep-volume
 *   node scripts/backtest-session-gate-v2.js --days=365 --burst-only
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { evaluateCombinedEventWindow, listUsMarketWindows, DEFAULT_US_WINDOW } from '../src/utils/usMarketOpen.js';
import { simulateMartingale, summarizeTrades } from './lib/backtestFactors.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-session-gate-v2.json');
const OUT_BURST = join(OUT_DIR, 'backtest-session-gate-v2-burst-only.json');
const OUT_SWEEP = join(OUT_DIR, 'backtest-session-gate-v2-sweep.json');
const SWEEP_THRESHOLDS_M = [5, 8, 10, 12, 15, 18, 20, 25, 30, 40, 50];
/** 仅放量窗 10 档扫参（OKX 永续 p50≈14M p90≈52M） */
const BURST_SWEEP_THRESHOLDS_M = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
/** 放量窗持续时间扫参（分钟，触发后刷新不叠加） */
const BURST_SWEEP_MINUTES = [5, 10, 15, 20, 25, 30, 40, 60];
const EVENT_CALENDAR = join(__dirname, '..', 'config', 'event-calendar-backtest.json');

function resolveMarketArg() {
  const m = (parseArg('market', config.ohlcvMarketType) || 'swap').toLowerCase();
  return resolveOhlcvMarket(m === 'spot' ? 'spot' : 'swap', parseArg('symbol', null));
}
const TF_MS = 5 * 60_000;

const US_WINDOW = {
  startBj: config.sessionGate.usMarketWindowStartBj || DEFAULT_US_WINDOW.startBj,
  endBj: config.sessionGate.usMarketWindowEndBj || DEFAULT_US_WINDOW.endBj,
};

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function fmtBj(ms) {
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 16);
}

function fmtM(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000).toFixed(0)}K`;
}

function loadBacktestEvents() {
  if (!existsSync(EVENT_CALENDAR)) return [];
  try {
    const raw = JSON.parse(readFileSync(EVENT_CALENDAR, 'utf8'));
    return raw
      .map((e) => ({ label: String(e.label ?? 'event'), ts: Date.parse(e.ts ?? e.time ?? '') }))
      .filter((e) => Number.isFinite(e.ts));
  } catch {
    return [];
  }
}

function precomputeBars(c5, fromMs, toMs, events, eventWindowHours, burstOnly = false) {
  const rows = [];
  for (let i = 0; i < c5.length; i += 1) {
    const bar = c5[i];
    const barT = bar.t;
    if (barT < fromMs || barT >= toMs) continue;
    const nowMs = barT + TF_MS;
    const barUsdt = computeBarUsdtNotional(bar);
    let scheduledActive = false;
    if (!burstOnly) {
      const scheduledWindow = evaluateCombinedEventWindow(nowMs, events, eventWindowHours, {
        usOpen: config.sessionGate.usMarketOpenEnabled,
        usWindow: US_WINDOW,
      });
      scheduledActive = scheduledWindow.pass;
    }
    rows.push({
      t: barT,
      nowMs,
      barUsdt,
      scheduledActive,
    });
  }
  return rows;
}

function simulateBurstTimeline(rows, barVolumeUsdtMin, volumeBurstMinutes) {
  let volumeBurstUntilMs = null;
  let burstTriggers = 0;
  const burstMs = volumeBurstMinutes * 60_000;
  const timeline = [];
  const modeBars = { scheduled: 0, volume_burst: 0, idle: 0 };

  for (const row of rows) {
    const barTriggered = row.barUsdt != null && row.barUsdt >= barVolumeUsdtMin;
    if (barTriggered) {
      volumeBurstUntilMs = row.nowMs + burstMs;
      burstTriggers += 1;
    }
    const burstActive = volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs;
    let gateMode = 'idle';
    let tradeAllowed = false;
    if (row.scheduledActive) {
      gateMode = 'scheduled';
      tradeAllowed = true;
    } else if (burstActive) {
      gateMode = 'volume_burst';
      tradeAllowed = true;
    }
    modeBars[gateMode] += 1;
    timeline.push({
      t: row.t,
      tradeAllowed,
      gateMode,
      barUsdt: row.barUsdt,
      barTriggered,
    });
  }

  return { timeline, modeBars, burstTriggers };
}

function runBacktest(c5, rows, fromMs, toMs, barVolumeUsdtMin, volumeBurstMinutes) {
  const { timeline, modeBars, burstTriggers } = simulateBurstTimeline(
    rows,
    barVolumeUsdtMin,
    volumeBurstMinutes,
  );
  const gatedTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const totalBars = timeline.length;
  const gateOpenBars = timeline.filter((x) => x.tradeAllowed).length;
  const gated = summarizeTrades(gatedTrades);
  const burst = pnlByMode(gatedTrades, 'volume_burst');
  return {
    barVolumeUsdtMin,
    gateOpenPct: gateOpenBars / (totalBars || 1),
    modeBarsPct: {
      scheduled: modeBars.scheduled / (totalBars || 1),
      volume_burst: modeBars.volume_burst / (totalBars || 1),
    },
    burstTriggers,
    gated,
    burst,
    pnlDelta: null,
  };
}

function barUsdtDistribution(rows) {
  const vals = rows.map((r) => r.barUsdt).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return null;
  const pct = (p) => vals[Math.floor(p * (vals.length - 1))];
  return {
    n: vals.length,
    p50: pct(0.5),
    p75: pct(0.75),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
    max: vals.at(-1),
  };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = parseArg('to') ? Date.parse(parseArg('to')) : Date.now();
  const fromMs = parseArg('from') ? Date.parse(parseArg('from')) : toMs - days * 24 * 60 * 60_000;
  const events = loadBacktestEvents();
  const eventWindowHours = Number(parseArg('event-hours', String(config.sessionGate.eventWindowHours)));
  const volumeBurstMinutes = Number(parseArg('burst-min', String(config.sessionGate.volumeBurstMinutes)));
  const barMinArg = parseArg('bar-min', null);
  const burstOnly = hasFlag('burst-only');
  const marketCtx = resolveMarketArg();

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });
  const rows = precomputeBars(c5, fromMs, toMs, events, eventWindowHours, burstOnly);
  const alwaysOnTrades = summarizeTrades(buildGatedTrades(
    c5,
    rows.map((r) => ({ t: r.t, tradeAllowed: true, gateMode: 'always', barUsdt: r.barUsdt })),
    fromMs,
    toMs,
  ));
  const barDist = barUsdtDistribution(rows);

  if (hasFlag('sweep-burst-min')) {
    const barVolumeUsdtMin = barMinArg ? Number(barMinArg) : config.sessionGate.barVolumeUsdtMin;
    const durations = (parseArg('burst-durations', null) || BURST_SWEEP_MINUTES.join(','))
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    const sweepResults = durations.map((mins) => {
      const r = runBacktest(c5, rows, fromMs, toMs, barVolumeUsdtMin, mins);
      r.volumeBurstMinutes = mins;
      r.pnlDelta = r.gated.pnl - alwaysOnTrades.pnl;
      return r;
    });
    sweepResults.sort((a, b) => b.gated.pnl - a.gated.pnl);

    const sweepOut = join(OUT_DIR, `backtest-session-gate-v2-burst-min-sweep-${barVolumeUsdtMin / 1e6}M.json`);
    writeFileSync(sweepOut, JSON.stringify({
      range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
      burstOnly,
      ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
      barVolumeUsdtMin,
      burstDurationsMin: durations,
      alwaysOn: alwaysOnTrades,
      sweep: sweepResults.map((r) => ({
        burstMinutes: r.volumeBurstMinutes,
        gateOpenPct: r.gateOpenPct,
        burstTriggers: r.burstTriggers,
        trades: r.gated.trades,
        winRate: r.gated.winRate,
        halts: r.gated.halts,
        gatedPnl: r.gated.pnl,
        gatedRoi: r.gated.roi,
        pnlDelta: r.pnlDelta,
      })),
      recommended: sweepResults[0],
    }, null, 2));

    console.log(`\n=== 放量窗时长扫参 · 阈值 ${barVolumeUsdtMin / 1e6}M · OKX ${marketCtx.label} ===`);
    console.log(`区间: ${days}d | 常开 PnL: ${alwaysOnTrades.pnl.toFixed(2)} ROI: ${(alwaysOnTrades.roi * 100).toFixed(2)}%`);
    console.log('\n时长(min) | 门控% | 触发 | 交易 | 胜率 | 止损 | 门控PnL | ROI% | Δ常开');
    for (const r of sweepResults) {
      console.log(
        `${String(r.volumeBurstMinutes).padStart(7)} | ` +
        `${(r.gateOpenPct * 100).toFixed(1).padStart(5)}% | ` +
        `${String(r.burstTriggers).padStart(5)} | ` +
        `${String(r.gated.trades).padStart(5)} | ` +
        `${(r.gated.winRate * 100).toFixed(1).padStart(4)}% | ` +
        `${String(r.gated.halts).padStart(4)} | ` +
        `${r.gated.pnl.toFixed(1).padStart(7)} | ` +
        `${(r.gated.roi * 100).toFixed(2).padStart(5)}% | ` +
        `${r.pnlDelta.toFixed(1).padStart(6)}`,
      );
    }
    const best = sweepResults[0];
    const current = sweepResults.find((r) => r.volumeBurstMinutes === config.sessionGate.volumeBurstMinutes);
    console.log(`\n最优时长: ${best.volumeBurstMinutes}min (PnL ${best.gated.pnl.toFixed(1)}, ROI ${(best.gated.roi * 100).toFixed(2)}%)`);
    if (current && current.volumeBurstMinutes !== best.volumeBurstMinutes) {
      console.log(`当前 ${current.volumeBurstMinutes}min: PnL ${current.gated.pnl.toFixed(1)}, ROI ${(current.gated.roi * 100).toFixed(2)}% (Δ最优 ${(current.gated.pnl - best.gated.pnl).toFixed(1)})`);
    }
    console.log(`Full JSON: ${sweepOut}`);
    return;
  }

  if (hasFlag('sweep-volume')) {
    const thresholds = burstOnly ? BURST_SWEEP_THRESHOLDS_M : SWEEP_THRESHOLDS_M;
    const sweepResults = thresholds.map((m) => {
      const r = runBacktest(c5, rows, fromMs, toMs, m * 1_000_000, volumeBurstMinutes);
      r.pnlDelta = r.gated.pnl - alwaysOnTrades.pnl;
      r.score = r.gated.pnl + r.pnlDelta * 0.3 + (r.burst.pnl > 0 ? r.burst.pnl * 0.2 : 0);
      return r;
    });
    sweepResults.sort((a, b) => b.gated.pnl - a.gated.pnl);

    const sweepOut = burstOnly ? OUT_BURST.replace('.json', '-sweep.json') : OUT_SWEEP;
    const output = {
      range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
      burstOnly,
      ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
      eventWindowHours: burstOnly ? null : eventWindowHours,
      volumeBurstMinutes,
      barVolumeUsdtMin: config.sessionGate.barVolumeUsdtMin,
      thresholdsM: thresholds,
      alwaysOn: alwaysOnTrades,
      barUsdtDistribution: barDist,
      sweep: sweepResults.map((r) => ({
        thresholdM: r.barVolumeUsdtMin / 1e6,
        gateOpenPct: r.gateOpenPct,
        burstCoveragePct: r.modeBarsPct.volume_burst,
        burstTriggers: r.burstTriggers,
        trades: r.gated.trades,
        winRate: r.gated.winRate,
        halts: r.gated.halts,
        gatedPnl: r.gated.pnl,
        gatedRoi: r.gated.roi,
        pnlDelta: r.pnlDelta,
        burstPnl: r.burst.pnl,
        burstRoi: r.burst.roi,
        burstTrades: r.burst.trades,
      })),
      recommended: sweepResults[0],
    };
    writeFileSync(sweepOut, JSON.stringify(output, null, 2));

    const title = burstOnly
      ? `仅放量窗 · OKX ${marketCtx.label} ${marketCtx.symbol} · ${thresholds.length}档阈值`
      : `放量阈值扫描 · OKX ${marketCtx.label} · 宏观±${eventWindowHours}h`;
    console.log(`\n=== ${title} ===`);
    console.log(`区间: ${days}d | 常开 PnL: ${alwaysOnTrades.pnl.toFixed(2)} ROI: ${(alwaysOnTrades.roi * 100).toFixed(2)}% (${alwaysOnTrades.trades}笔)`);
    if (barDist) {
      console.log(`5m 成交额分位: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)} p99=${fmtM(barDist.p99)}`);
    }
    console.log('\n阈值(M) | 门控% | 触发 | 交易 | 胜率 | 止损 | 门控PnL | ROI% | Δ常开');
    for (const r of sweepResults) {
      console.log(
        `${String(r.barVolumeUsdtMin / 1e6).padStart(5)} | ` +
        `${(r.gateOpenPct * 100).toFixed(1).padStart(5)}% | ` +
        `${String(r.burstTriggers).padStart(5)} | ` +
        `${String(r.gated.trades).padStart(5)} | ` +
        `${(r.gated.winRate * 100).toFixed(1).padStart(4)}% | ` +
        `${String(r.gated.halts).padStart(4)} | ` +
        `${r.gated.pnl.toFixed(1).padStart(7)} | ` +
        `${(r.gated.roi * 100).toFixed(2).padStart(5)}% | ` +
        `${r.pnlDelta.toFixed(1).padStart(6)}`,
      );
    }
    const best = sweepResults[0];
    console.log(`\n最优阈值: ${best.barVolumeUsdtMin / 1e6}M (PnL ${best.gated.pnl.toFixed(1)}, ROI ${(best.gated.roi * 100).toFixed(2)}%, Δ ${best.pnlDelta.toFixed(1)})`);
    console.log(`Full JSON: ${sweepOut}`);
    return;
  }

  const barVolumeUsdtMin = barMinArg ? Number(barMinArg) : config.sessionGate.barVolumeUsdtMin;
  const { timeline, modeBars, burstTriggers } = simulateBurstTimeline(rows, barVolumeUsdtMin, volumeBurstMinutes);
  const segments = buildSegments(timeline, fromMs, toMs);
  const gatedTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const totalBars = timeline.length;
  const gateOpenBars = timeline.filter((x) => x.tradeAllowed).length;
  const haltWindows = extractHaltWindows(gatedTrades);
  const gated = summarizeTrades(gatedTrades);

  const report = {
    mode: burstOnly ? 'burst-only (no scheduled windows)' : 'gate-v2 (scheduled + volume-burst)',
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    config: {
      burstOnly,
      ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
      barVolumeUsdtMin,
      volumeBurstMinutes,
      eventWindowHours,
      usMarketWindow: US_WINDOW,
      events: events.map((e) => ({ label: e.label, tsBj: fmtBj(e.ts) })),
      usMarketDays: listUsMarketWindows(fromMs, toMs, US_WINDOW).length,
      barUsdtDistribution: barDist,
    },
    summary: {
      totalBars,
      gateOpenBars,
      gateOpenPct: gateOpenBars / (totalBars || 1),
      modeBars,
      modeBarsPct: {
        scheduled: modeBars.scheduled / (totalBars || 1),
        volume_burst: modeBars.volume_burst / (totalBars || 1),
        idle: modeBars.idle / (totalBars || 1),
      },
      burstTriggers,
      sessionSegments: segments.length,
      gatedTrades: gatedTrades.length,
      haltEvents: haltWindows.length,
      gated,
      alwaysOn: alwaysOnTrades,
      pnlByGateMode: {
        scheduled: pnlByMode(gatedTrades, 'scheduled'),
        volume_burst: pnlByMode(gatedTrades, 'volume_burst'),
      },
    },
  };

  writeFileSync(burstOnly ? OUT_BURST : OUT_FILE, JSON.stringify(report, null, 2));

  const w = US_WINDOW;
  console.log(`\n=== 门控 v2 回测 · OKX ${marketCtx.label} ${marketCtx.symbol}${burstOnly ? ' · 仅放量窗' : ''} ===`);
  if (burstOnly) {
    console.log('定时常开: 已关闭（无宏观事件窗 / 无美股时段）');
  } else {
    console.log(`规则: 宏观±${eventWindowHours}h ∨ 美股 ${w.startBj}–${w.endBj} 常开`);
  }
  console.log(`      其它时段: 5m 成交额 ≥ ${fmtM(barVolumeUsdtMin)} → 开 ${volumeBurstMinutes} 分钟(刷新)`);
  console.log(`区间: ${report.range.from} → ${report.range.to} (${days}d)`);
  if (barDist) {
    console.log(`5m 成交额: p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)} p99=${fmtM(barDist.p99)}`);
  }

  console.log(`\n--- 覆盖率 ---`);
  console.log(`门控开启: ${gateOpenBars}/${totalBars} (${(report.summary.gateOpenPct * 100).toFixed(1)}%)`);
  console.log(`  定时常开: ${modeBars.scheduled} (${(report.summary.modeBarsPct.scheduled * 100).toFixed(1)}%)`);
  console.log(`  放量窗口: ${modeBars.volume_burst} (${(report.summary.modeBarsPct.volume_burst * 100).toFixed(1)}%)`);
  console.log(`放量触发: ${burstTriggers} 次`);

  const a = alwaysOnTrades;
  console.log(`\n--- PnL ---`);
  console.log(`门控: ${gated.pnl.toFixed(2)} (${gated.trades}笔 WR ${(gated.winRate * 100).toFixed(1)}% 止损${gated.halts})`);
  console.log(`常开: ${a.pnl.toFixed(2)} (${a.trades}笔 WR ${(a.winRate * 100).toFixed(1)}% 止损${a.halts})`);
  console.log(`Δ:    ${(gated.pnl - a.pnl).toFixed(2)}`);

  const ps = report.summary.pnlByGateMode;
  console.log(`\n--- 分模式 PnL ---`);
  console.log(`定时常开: ${ps.scheduled.pnl.toFixed(2)} (${ps.scheduled.trades}笔)`);
  console.log(`放量窗口: ${ps.volume_burst.pnl.toFixed(2)} (${ps.volume_burst.trades}笔)`);
  console.log(`\nFull JSON: ${burstOnly ? OUT_BURST : OUT_FILE}`);
}

function buildSegments(timeline, fromMs, toMs) {
  const segments = [];
  let cur = null;
  for (const row of timeline) {
    if (row.tradeAllowed && !cur) {
      cur = { start: row.t, gateMode: row.gateMode };
    } else if (!row.tradeAllowed && cur) {
      cur.end = row.t;
      segments.push(cur);
      cur = null;
    } else if (row.tradeAllowed && cur && row.gateMode !== cur.gateMode) {
      cur.end = row.t;
      segments.push(cur);
      cur = { start: row.t, gateMode: row.gateMode };
    }
  }
  if (cur) {
    cur.end = toMs;
    segments.push(cur);
  }
  return segments;
}

function buildGatedTrades(c5, timeline, fromMs, toMs) {
  const allowedByT = new Map(timeline.filter((x) => x.tradeAllowed).map((x) => [x.t, x]));
  const raw = [];

  for (let i = 50; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;

    const gateBar = allowedByT.get(k1.t);
    if (!gateBar) continue;

    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'high');
    if (eval_.signal === 'NONE') continue;

    const next = c5[i + 1];
    const outcome = classifyCandle(next);
    const won = (eval_.signal === 'UP' && outcome === 'BULL')
      || (eval_.signal === 'DOWN' && outcome === 'BEAR');

    raw.push({
      t: tradeTs,
      k1t: k1.t,
      signalId: eval_.signalId,
      signal: eval_.signal,
      won,
      pnlUsd: won ? 0.5 : -0.5,
      gateMode: gateBar.gateMode,
      barUsdt: gateBar.barUsdt,
    });
  }

  return simulateMartingale(raw);
}

function extractHaltWindows(trades) {
  const windows = [];
  let streak = [];
  for (const t of trades) {
    if (!t.won) {
      streak.push(t);
      if (streak.length >= 4) {
        windows.push({ start: streak[0].t, end: streak[3].t, trades: [...streak] });
        streak = [];
      }
    } else {
      streak = [];
    }
  }
  return windows;
}

function pnlByMode(trades, mode) {
  return summarizeTrades(trades.filter((t) => t.gateMode === mode));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
