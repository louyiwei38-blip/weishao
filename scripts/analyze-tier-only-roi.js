/**
 * Compare ROI: full hybrid vs single-tier-only trading.
 * Usage:
 *   node scripts/analyze-tier-only-roi.js --days=365
 *   node scripts/analyze-tier-only-roi.js --days=365 --tier1-9=1 --tier10=6 --tier11=8 --tier12=24
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
const OUT_FILE = join(OUT_DIR, 'analyze-tier-only-roi.json');
const TF_MS = 5 * 60_000;
const MARTINGALE_MAX = config.martingaleMaxLosses;
const MULTIPLIER = config.martingaleMultiplier;
const ENTRY_PRICE = 0.5;

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

function getActivityAt(c5, idx) {
  const { hits, windowBars, freq } = computeActivityFreq(c5, idx);
  const tier = activityHitsToTier(hits, windowBars);
  return { hits, windowBars, freq, tier };
}

function simulateBurstTimeline(c5, rows, volumeBurstMinutes) {
  let volumeBurstUntilMs = null;
  const timeline = [];
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));

  for (const row of rows) {
    const idx = idxByT.get(row.t) ?? 0;
    const { thresholdUsdt } = resolveBurstThresholdUsdt(c5, idx);
    const barTriggered = row.barUsdt != null && row.barUsdt >= thresholdUsdt;
    if (barTriggered) {
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

    raw.push({ t: tradeTs, k1t: k1.t, won });
  }
  return raw;
}

function simulate(trades, c5, { tierOpts, tierOnly = null, tierMin = null, fixedBase = null } = {}) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = fixedBase ?? tierOpts?.tier1_9Usd ?? 3;
  let skipNext = false;
  let halts = 0;
  let streakTier = null;
  let totalStake = 0;
  let maxDrawdown = 0;
  let peakPnl = 0;
  let cumPnl = 0;
  let executed = 0;

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      streakTier = null;
      continue;
    }

    if (consecutiveLosses === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { tier } = getActivityAt(c5, idx);
      if (tierOnly != null && tier !== tierOnly) continue;
      if (tierMin != null && tier < tierMin) continue;

      streakTier = tier;
      if (fixedBase != null) {
        currentBet = fixedBase;
      } else {
        currentBet = resolveTierBaseBet(tier, tierOpts);
      }
    } else if (tierOnly != null && streakTier !== tierOnly) {
      continue;
    } else if (tierMin != null && streakTier < tierMin) {
      continue;
    }

    const stake = currentBet;
    const pnlUsd = t.won
      ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake)
      : -stake;

    cumPnl += pnlUsd;
    peakPnl = Math.max(peakPnl, cumPnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - cumPnl);
    totalStake += stake;
    executed += 1;

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

  return {
    trades: executed,
    halts,
    pnl: cumPnl,
    maxDrawdown,
    avgStake: executed ? totalStake / executed : 0,
    roi: totalStake > 0 ? cumPnl / totalStake : 0,
  };
}

function tierHitsRange(tier) {
  const ranges = [];
  for (let h = 0; h <= 12; h += 1) {
    if (activityHitsToTier(h, 12) === tier) ranges.push(h);
  }
  if (!ranges.length) return '—';
  if (ranges.length === 1) return `${ranges[0]}根`;
  return `${ranges[0]}-${ranges.at(-1)}根`;
}

function fmtPct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const tierOpts = parseTierOpts();
  const marketCtx = resolveOhlcvMarket('swap');

  const { c5 } = await ensureOkxCandles({ fromMs, toMs, marketType: marketCtx.marketType, symbol: marketCtx.symbol });
  const sg = config.sessionGate;
  const rows = [];
  for (let i = 0; i < c5.length; i += 1) {
    const bar = c5[i];
    if (bar.t < fromMs || bar.t >= toMs) continue;
    rows.push({ t: bar.t, nowMs: bar.t + TF_MS, barUsdt: computeBarUsdtNotional(bar) });
  }

  const timeline = simulateBurstTimeline(c5, rows, sg.volumeBurstMinutes);
  const rawTrades = buildGatedTrades(c5, timeline, fromMs, toMs);
  const gateSignals = rawTrades.length;

  const scenarios = [
    { key: 'full_hybrid', label: '全四档混合（当前推荐）', opts: { tierOpts } },
    ...Array.from({ length: TIER_COUNT }, (_, i) => {
      const tier = i + 1;
      const baseBet = resolveTierBaseBet(tier, tierOpts);
      return {
        key: `tier_${tier}_only`,
        label: `仅${tier}档 (${tierHitsRange(tier)} · $${baseBet})`,
        opts: { tierOpts, tierOnly: tier },
        tier,
        baseBet,
      };
    }),
    { key: 'tier_ge_9', label: '仅9-12档', opts: { tierOpts, tierMin: 9 } },
    { key: 'tier_ge_11', label: '仅11-12档', opts: { tierOpts, tierMin: 11 } },
    { key: 'tier_12_fixed24', label: '仅12档 · 固定$24无马丁', opts: { fixedBase: 24, tierOnly: 12 } },
  ];

  const results = scenarios.map((s) => {
    const r = simulate(rawTrades, c5, s.opts);
    return {
      ...s,
      ...r,
      signalCoverage: gateSignals ? r.trades / gateSignals : 0,
    };
  });

  const byRoi = [...results].sort((a, b) => b.roi - a.roi);
  const byPnl = [...results].sort((a, b) => b.pnl - a.pnl);
  const full = results.find((r) => r.key === 'full_hybrid');
  const tier12Only = results.find((r) => r.key === 'tier_12_only');

  const output = {
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), days },
    tierOpts,
    gateSignals,
    results,
    bestRoi: byRoi[0],
    bestPnl: byPnl[0],
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n=== 单档 vs 全档 ROI 分析 · ${days}d · OKX ${marketCtx.label} ===`);
  console.log(`四档参数: ${formatTierParamLabel(tierOpts)}`);
  console.log(`门控信号: ${gateSignals} 笔\n`);

  console.log('策略                    | 成交  | 覆盖率 | 止损 | PnL      | ROI    | 回撤    | 均注');
  for (const r of byRoi) {
    const mark = r.key === 'full_hybrid' ? ' *' : r.key === 'tier_12_only' ? ' †' : '';
    console.log(
      `${r.label.padEnd(23)} | ` +
      `${String(r.trades).padStart(5)} | ` +
      `${fmtPct(r.signalCoverage).padStart(6)} | ` +
      `${String(r.halts).padStart(4)} | ` +
      `$${r.pnl.toFixed(0).padStart(7)} | ` +
      `${fmtPct(r.roi).padStart(6)} | ` +
      `$${r.maxDrawdown.toFixed(0).padStart(6)} | ` +
      `$${r.avgStake.toFixed(2)}${mark}`,
    );
  }

  console.log('\n--- 结论 ---');
  console.log(`ROI 最高: ${byRoi[0].label} → ${fmtPct(byRoi[0].roi)} (PnL $${byRoi[0].pnl.toFixed(0)}, ${byRoi[0].trades}笔)`);
  console.log(`PnL 最高: ${byPnl[0].label} → $${byPnl[0].pnl.toFixed(0)} (ROI ${fmtPct(byPnl[0].roi)})`);
  if (full && tier12Only) {
    console.log(
      `仅12档 vs 全档: ROI ${fmtPct(tier12Only.roi)} vs ${fmtPct(full.roi)} | ` +
      `PnL $${tier12Only.pnl.toFixed(0)} vs $${full.pnl.toFixed(0)} | ` +
      `成交 ${tier12Only.trades} vs ${full.trades} (${fmtPct(tier12Only.trades / full.trades)} 量)`,
    );
  }
  console.log(`\n* = 全档混合  † = 仅12档`);
  console.log(`Full JSON: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
