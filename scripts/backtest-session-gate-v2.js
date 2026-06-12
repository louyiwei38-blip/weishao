/**
 * Session gate v2 backtest: 5m bar volume shrink (≤ threshold) + low-vol reversal strategy.
 * Usage:
 *   node scripts/backtest-session-gate-v2.js --days=365
 *   node scripts/backtest-session-gate-v2.js --days=365 --sweep-volume
 *   node scripts/backtest-session-gate-v2.js --days=365 --shrink-only
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { classifyCandle, evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { simulateMartingale, summarizeTrades } from './lib/backtestFactors.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import { resolveBurstThresholdUsdt } from '../src/session/sessionGate.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-session-gate-v2.json');
const OUT_SWEEP = join(OUT_DIR, 'backtest-session-gate-v2-sweep.json');
const SHRINK_SWEEP_THRESHOLDS_M = [3, 5, 7.5, 10, 12, 15, 20, 25, 30, 40];
/** 缩量窗持续时间扫参（分钟，触发后刷新不叠加） */
const SHRINK_SWEEP_MINUTES = [5, 10, 15, 20, 25, 30, 40, 60];

function resolveMarketArg() {
  const m = (parseArg('market', config.ohlcvMarketType) || 'swap').toLowerCase();
  return resolveOhlcvMarket(m === 'spot' ? 'spot' : 'swap', parseArg('symbol', null));
}
const TF_MS = 5 * 60_000;

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

function precomputeBars(c5, fromMs, toMs) {
  const rows = [];
  for (let i = 0; i < c5.length; i += 1) {
    const bar = c5[i];
    const barT = bar.t;
    if (barT < fromMs || barT >= toMs) continue;
    rows.push({
      t: barT,
      nowMs: barT + TF_MS,
      barUsdt: computeBarUsdtNotional(bar),
    });
  }
  return rows;
}

function simulateShrinkTimeline(c5, rows, volumeBurstMinutes, { fixedThresholdUsdt = null } = {}) {
  let volumeBurstUntilMs = null;
  let shrinkTriggers = 0;
  const shrinkMs = volumeBurstMinutes * 60_000;
  const timeline = [];
  const modeBars = { volume_burst: 0, idle: 0 };
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));

  for (const row of rows) {
    const idx = idxByT.get(row.t);
    const { thresholdUsdt } = fixedThresholdUsdt != null
      ? { thresholdUsdt: fixedThresholdUsdt }
      : resolveBurstThresholdUsdt(c5, idx ?? 0);
    const barTriggered = row.barUsdt != null && row.barUsdt <= thresholdUsdt;
    if (barTriggered) {
      volumeBurstUntilMs = row.nowMs + shrinkMs;
      shrinkTriggers += 1;
    }
    const shrinkActive = volumeBurstUntilMs != null && row.nowMs < volumeBurstUntilMs;
    let gateMode = 'idle';
    let tradeAllowed = false;
    if (shrinkActive) {
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
      thresholdUsdt,
    });
  }

  return { timeline, modeBars, shrinkTriggers };
}

function runBacktest(c5, rows, fromMs, toMs, volumeBurstMinutes, { fixedThresholdUsdt = null } = {}) {
  const { timeline, modeBars, shrinkTriggers } = simulateShrinkTimeline(
    c5,
    rows,
    volumeBurstMinutes,
    { fixedThresholdUsdt },
  );
  const gatedTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const totalBars = timeline.length;
  const gateOpenBars = timeline.filter((x) => x.tradeAllowed).length;
  const gated = summarizeTrades(gatedTrades);
  const shrink = pnlByMode(gatedTrades, 'volume_burst');
  return {
    fixedThresholdUsdt,
    gateOpenPct: gateOpenBars / (totalBars || 1),
    modeBarsPct: {
      volume_burst: modeBars.volume_burst / (totalBars || 1),
    },
    shrinkTriggers,
    gated,
    shrink,
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
  const volumeBurstMinutes = Number(parseArg('burst-min', String(config.sessionGate.volumeBurstMinutes)));
  const barMinArg = parseArg('bar-min', null);
  const marketCtx = resolveMarketArg();

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });
  const rows = precomputeBars(c5, fromMs, toMs);
  const alwaysOnTrades = summarizeTrades(buildGatedTrades(
    c5,
    rows.map((r) => ({ t: r.t, tradeAllowed: true, gateMode: 'always', barUsdt: r.barUsdt })),
    fromMs,
    toMs,
  ));
  const barDist = barUsdtDistribution(rows);

  if (hasFlag('sweep-burst-min') || hasFlag('sweep-shrink-min')) {
    const barVolumeUsdtMin = barMinArg ? Number(barMinArg) : config.sessionGate.barVolumeUsdtMin;
    const durations = (parseArg('burst-durations', null) || SHRINK_SWEEP_MINUTES.join(','))
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    const sweepResults = durations.map((mins) => {
      const r = runBacktest(c5, rows, fromMs, toMs, mins, { fixedThresholdUsdt: barVolumeUsdtMin });
      r.volumeBurstMinutes = mins;
      r.pnlDelta = r.gated.pnl - alwaysOnTrades.pnl;
      return r;
    });
    sweepResults.sort((a, b) => b.gated.pnl - a.gated.pnl);

    const sweepOut = join(OUT_DIR, `backtest-session-gate-v2-shrink-min-sweep-${barVolumeUsdtMin / 1e6}M.json`);
    writeFileSync(sweepOut, JSON.stringify({
      range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
      strategy: 'low_reversal',
      gate: 'volume_shrink',
      ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
      barVolumeUsdtMin,
      shrinkDurationsMin: durations,
      alwaysOn: alwaysOnTrades,
      sweep: sweepResults.map((r) => ({
        shrinkMinutes: r.volumeBurstMinutes,
        gateOpenPct: r.gateOpenPct,
        shrinkTriggers: r.shrinkTriggers,
        trades: r.gated.trades,
        winRate: r.gated.winRate,
        halts: r.gated.halts,
        gatedPnl: r.gated.pnl,
        gatedRoi: r.gated.roi,
        pnlDelta: r.pnlDelta,
      })),
      recommended: sweepResults[0],
    }, null, 2));

    console.log(`\n=== 缩量窗时长扫参 · 阈值 ${barVolumeUsdtMin / 1e6}M · OKX ${marketCtx.label} ===`);
    console.log(`区间: ${days}d | 常开 PnL: ${alwaysOnTrades.pnl.toFixed(2)} ROI: ${(alwaysOnTrades.roi * 100).toFixed(2)}%`);
    console.log('\n时长(min) | 门控% | 触发 | 交易 | 胜率 | 止损 | 门控PnL | ROI% | Δ常开');
    for (const r of sweepResults) {
      console.log(
        `${String(r.volumeBurstMinutes).padStart(7)} | ` +
        `${(r.gateOpenPct * 100).toFixed(1).padStart(5)}% | ` +
        `${String(r.shrinkTriggers).padStart(5)} | ` +
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
    const thresholds = SHRINK_SWEEP_THRESHOLDS_M;
    const sweepResults = thresholds.map((m) => {
      const r = runBacktest(c5, rows, fromMs, toMs, volumeBurstMinutes, { fixedThresholdUsdt: m * 1_000_000 });
      r.pnlDelta = r.gated.pnl - alwaysOnTrades.pnl;
      r.score = r.gated.pnl + r.pnlDelta * 0.3 + (r.shrink.pnl > 0 ? r.shrink.pnl * 0.2 : 0);
      return r;
    });
    sweepResults.sort((a, b) => b.gated.pnl - a.gated.pnl);

    const sweepOut = OUT_SWEEP;
    const output = {
      range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
      strategy: 'low_reversal',
      gate: 'volume_shrink',
      ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
      volumeBurstMinutes,
      barVolumeUsdtMin: config.sessionGate.barVolumeUsdtMin,
      thresholdsM: thresholds,
      alwaysOn: alwaysOnTrades,
      barUsdtDistribution: barDist,
      sweep: sweepResults.map((r) => ({
        thresholdM: r.fixedThresholdUsdt / 1e6,
        gateOpenPct: r.gateOpenPct,
        shrinkCoveragePct: r.modeBarsPct.volume_burst,
        shrinkTriggers: r.shrinkTriggers,
        trades: r.gated.trades,
        winRate: r.gated.winRate,
        halts: r.gated.halts,
        gatedPnl: r.gated.pnl,
        gatedRoi: r.gated.roi,
        pnlDelta: r.pnlDelta,
        shrinkPnl: r.shrink.pnl,
        shrinkRoi: r.shrink.roi,
        shrinkTrades: r.shrink.trades,
      })),
      recommended: sweepResults[0],
    };
    writeFileSync(sweepOut, JSON.stringify(output, null, 2));

    console.log(`\n=== 缩量窗阈值扫参 · OKX ${marketCtx.label} · 低波反转 ===`);
    console.log(`区间: ${days}d | 常开 PnL: ${alwaysOnTrades.pnl.toFixed(2)} ROI: ${(alwaysOnTrades.roi * 100).toFixed(2)}% (${alwaysOnTrades.trades}笔)`);
    if (barDist) {
      console.log(`5m 成交额分位: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)} p99=${fmtM(barDist.p99)}`);
    }
    console.log('\n阈值(M) | 门控% | 触发 | 交易 | 胜率 | 止损 | 门控PnL | ROI% | Δ常开');
    for (const r of sweepResults) {
      console.log(
        `${String(r.fixedThresholdUsdt / 1e6).padStart(5)} | ` +
        `${(r.gateOpenPct * 100).toFixed(1).padStart(5)}% | ` +
        `${String(r.shrinkTriggers).padStart(5)} | ` +
        `${String(r.gated.trades).padStart(5)} | ` +
        `${(r.gated.winRate * 100).toFixed(1).padStart(4)}% | ` +
        `${String(r.gated.halts).padStart(4)} | ` +
        `${r.gated.pnl.toFixed(1).padStart(7)} | ` +
        `${(r.gated.roi * 100).toFixed(2).padStart(5)}% | ` +
        `${r.pnlDelta.toFixed(1).padStart(6)}`,
      );
    }
    const best = sweepResults[0];
    console.log(`\n最优阈值: ${best.fixedThresholdUsdt / 1e6}M (PnL ${best.gated.pnl.toFixed(1)}, ROI ${(best.gated.roi * 100).toFixed(2)}%, Δ ${best.pnlDelta.toFixed(1)})`);
    console.log(`Full JSON: ${sweepOut}`);
    return;
  }

  const sg = config.sessionGate;
  const useFixed = barMinArg != null || hasFlag('fixed-threshold') || !sg.dynamicThresholdEnabled;
  const fixedThresholdUsdt = useFixed
    ? (barMinArg ? Number(barMinArg) : sg.barVolumeUsdtMin)
    : null;
  const { timeline, modeBars, shrinkTriggers } = simulateShrinkTimeline(
    c5,
    rows,
    volumeBurstMinutes,
    { fixedThresholdUsdt },
  );
  const segments = buildSegments(timeline, fromMs, toMs);
  const gatedTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const totalBars = timeline.length;
  const gateOpenBars = timeline.filter((x) => x.tradeAllowed).length;
  const haltWindows = extractHaltWindows(gatedTrades);
  const gated = summarizeTrades(gatedTrades);

  const report = {
    mode: 'gate-v2 (volume-shrink + low-reversal)',
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    config: {
      ohlcv: { marketType: marketCtx.marketType, symbol: marketCtx.symbol, label: marketCtx.label },
      volumeBurstMinutes,
      strategy: 'low_reversal',
      ...(useFixed
        ? { barVolumeUsdtMin: fixedThresholdUsdt, gateMode: 'fixed-threshold' }
        : {
          dynamicThresholdEnabled: true,
          activityWindowBars: sg.activityWindowBars,
          activityProbeUsdtMin: sg.activityProbeUsdtMin,
          barVolumeUsdtMinDynamic: sg.barVolumeUsdtMinDynamic,
          barVolumeUsdtMaxDynamic: sg.barVolumeUsdtMaxDynamic,
          gateMode: 'dynamic-threshold',
        }),
      barUsdtDistribution: barDist,
    },
    summary: {
      totalBars,
      gateOpenBars,
      gateOpenPct: gateOpenBars / (totalBars || 1),
      modeBars,
      modeBarsPct: {
        volume_burst: modeBars.volume_burst / (totalBars || 1),
        idle: modeBars.idle / (totalBars || 1),
      },
      shrinkTriggers,
      sessionSegments: segments.length,
      gatedTrades: gatedTrades.length,
      haltEvents: haltWindows.length,
      gated,
      alwaysOn: alwaysOnTrades,
      pnlByGateMode: {
        volume_burst: pnlByMode(gatedTrades, 'volume_burst'),
      },
    },
  };

  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

  console.log(`\n=== 门控 v2 回测 · 缩量窗 · 低波反转 · OKX ${marketCtx.label} ${marketCtx.symbol} ===`);
  if (useFixed) {
    console.log(`规则: 5m 成交额 ≤ ${fmtM(fixedThresholdUsdt)} → 开 ${volumeBurstMinutes} 分钟(刷新)`);
  } else {
    console.log(`动态门控: 近${sg.activityWindowBars}根 ≥${fmtM(sg.activityProbeUsdtMin)} 频率 → 冷市 ${fmtM(sg.barVolumeUsdtMinDynamic)} / 热市 ${fmtM(sg.barVolumeUsdtMaxDynamic)}`);
    console.log(`触发: 本根 ≤ 触发线 → 开 ${volumeBurstMinutes} 分钟(刷新)`);
  }
  console.log(`区间: ${report.range.from} → ${report.range.to} (${days}d)`);
  if (barDist) {
    console.log(`5m 成交额: p50=${fmtM(barDist.p50)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)}`);
  }

  console.log(`\n--- 覆盖率 ---`);
  console.log(`门控开启: ${gateOpenBars}/${totalBars} (${(report.summary.gateOpenPct * 100).toFixed(1)}%)`);
  console.log(`  缩量窗口: ${modeBars.volume_burst} (${(report.summary.modeBarsPct.volume_burst * 100).toFixed(1)}%)`);
  console.log(`缩量触发: ${shrinkTriggers} 次`);

  const a = alwaysOnTrades;
  console.log(`\n--- PnL ---`);
  console.log(`门控: ${gated.pnl.toFixed(2)} (${gated.trades}笔 WR ${(gated.winRate * 100).toFixed(1)}% 止损${gated.halts})`);
  console.log(`常开: ${a.pnl.toFixed(2)} (${a.trades}笔 WR ${(a.winRate * 100).toFixed(1)}% 止损${a.halts})`);
  console.log(`Δ:    ${(gated.pnl - a.pnl).toFixed(2)}`);

  const ps = report.summary.pnlByGateMode;
  console.log(`\n--- 分模式 PnL ---`);
  console.log(`缩量窗口: ${ps.volume_burst.pnl.toFixed(2)} (${ps.volume_burst.trades}笔)`);
  console.log(`\nFull JSON: ${OUT_FILE}`);
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

    const eval_ = evaluateReversalContinuation(c5[i - 1], k1, 'low');
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
