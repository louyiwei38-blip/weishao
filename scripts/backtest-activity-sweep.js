/**
 * Backtest: single-candle follow + activity gate + tier bets.
 * Includes Polymarket Crypto taker fees (feeRate=0.07).
 *
 * Usage:
 *   node scripts/backtest-activity-sweep.js --days=365
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { evaluateReversalContinuation } from '../src/strategy/reversalContinuation.js';
import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { hitsToActivityTier } from '../src/session/activityTier.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import {
  calcTakerFeeUsd,
  computeNetSettlementPnl,
  effectiveFeeRate,
  CRYPTO_TAKER_FEE_RATE,
} from './lib/polymarketFees.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-activity-sweep-net.json');

const TF_MS = 5 * 60_000;
const WINDOW = 12;

const PROBE_SWEEP_M = [8, 10, 12, 15, 18, 20, 22, 25, 28, 30, 35, 40];
const MIN_HITS_SWEEP = [6, 7, 8, 9, 10, 11];

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

function fmtM(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000).toFixed(0)}K`;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
}

function rollingHits(barUsdt, idx, probeUsdt) {
  const start = Math.max(0, idx - WINDOW + 1);
  let hits = 0;
  for (let j = start; j <= idx; j += 1) {
    const u = barUsdt[j];
    if (u != null && u >= probeUsdt) hits += 1;
  }
  return hits;
}

function okxWon(signal, bar) {
  const winning = bar.close >= bar.open ? 'UP' : 'DOWN';
  return signal === winning;
}

function buildTierProfiles(base = config.tradeBudgetUsd) {
  const linear = Array.from({ length: 12 }, (_, i) =>
    Number((base * (1 + i * 0.35)).toFixed(2)));
  const flat = Array.from({ length: 12 }, () => base);
  const highTierOnly = [1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 5, 8].map((x) =>
    Number((x * base).toFixed(2)));
  const step = [2, 2, 2, 2, 3, 3, 3, 3, 4, 5, 6, 8].map((x) =>
    Number((x * (base / 2)).toFixed(2)));
  return { linear, flat, highTierOnly, step };
}

function summarizeTradesNet(trades) {
  let wins = 0;
  let grossPnl = 0;
  let netPnl = 0;
  let totalStaked = 0;
  let totalCost = 0;
  let totalFees = 0;
  let halts = 0;
  let skippedHalt = 0;
  let executed = 0;

  for (const t of trades) {
    if (t.skipped) {
      if (t.skipReason === 'halted') skippedHalt += 1;
      continue;
    }
    executed += 1;
    grossPnl += Number(t.grossPnlUsd) || 0;
    netPnl += Number(t.pnlUsd) || 0;
    totalStaked += Number(t.actualBet) || 0;
    totalCost += Number(t.totalCost) || Number(t.actualBet) || 0;
    totalFees += Number(t.feeUsd) || 0;
    if (t.won) wins += 1;
    if (t.martingaleHalted) halts += 1;
  }

  return {
    signals: trades.length,
    trades: executed,
    skippedHalt,
    wins,
    winRate: executed ? wins / executed : 0,
    halts,
    grossPnl,
    netPnl,
    totalFees,
    totalStaked,
    totalCost,
    grossRoi: totalStaked > 0 ? grossPnl / totalStaked : 0,
    netRoi: totalCost > 0 ? netPnl / totalCost : 0,
    feeDrag: totalStaked > 0 ? totalFees / totalStaked : 0,
  };
}

function simulateTierMartingale(trades, tierBets, options = {}) {
  const multiplier = options.multiplier ?? config.martingaleMultiplier;
  const maxLosses = options.maxLosses ?? config.martingaleMaxLosses;
  const maxBetUsd = options.maxBetUsd ?? config.maxBetUsd;
  const entryPrice = options.entryPrice ?? Number(process.env.BACKTEST_ENTRY_PRICE ?? 0.5);

  let baseBet = tierBets[0];
  let currentBet = baseBet;
  let consecutiveLosses = 0;
  let isHalted = false;
  const out = [];

  for (const t of trades) {
    if (isHalted) {
      isHalted = false;
      consecutiveLosses = 0;
      out.push({
        ...t,
        skipped: true,
        skipReason: 'halted',
        actualBet: 0,
        grossPnlUsd: 0,
        pnlUsd: 0,
        feeUsd: 0,
        totalCost: 0,
        martingaleHalted: false,
      });
      continue;
    }

    const actualBet = Math.min(currentBet, maxBetUsd);
    const { pnlUsd, feeUsd, totalCost } = computeNetSettlementPnl(t.won, actualBet, entryPrice);
    const grossPnlUsd = t.won ? (actualBet / entryPrice - actualBet) : -actualBet;
    let halted = false;

    if (t.won) {
      const tier = t.settleTier ?? 1;
      baseBet = tierBets[Math.min(12, Math.max(1, tier)) - 1];
      currentBet = baseBet;
      consecutiveLosses = 0;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= maxLosses) {
        const tier = t.settleTier ?? 1;
        baseBet = tierBets[Math.min(12, Math.max(1, tier)) - 1];
        currentBet = baseBet;
        isHalted = true;
        halted = true;
        consecutiveLosses = 0;
      } else {
        currentBet *= multiplier;
      }
    }

    out.push({
      ...t,
      skipped: false,
      actualBet,
      entryPrice,
      grossPnlUsd,
      pnlUsd,
      feeUsd,
      totalCost,
      martingaleHalted: halted,
    });
  }

  return out;
}

function buildSignals(c5, fromMs, toMs) {
  const signals = [];
  for (let i = WINDOW - 1; i < c5.length - 1; i += 1) {
    const k1 = c5[i];
    const tradeTs = k1.t + TF_MS;
    if (tradeTs < fromMs || tradeTs >= toMs) continue;

    const eval_ = evaluateReversalContinuation(k1, undefined, 'high');
    if (eval_.signal === 'NONE') continue;

    const next = c5[i + 1];
    signals.push({
      t: tradeTs,
      idx: i,
      settleIdx: i + 1,
      signalId: eval_.signalId,
      signal: eval_.signal,
      won: okxWon(eval_.signal, next),
    });
  }
  return signals;
}

function filterAndSimulate(signals, barUsdt, probeUsdt, minHits, tierBets, entryPrice) {
  const raw = [];
  for (const s of signals) {
    const hits = rollingHits(barUsdt, s.idx, probeUsdt);
    if (hits < minHits) continue;
    const settleHits = rollingHits(barUsdt, s.settleIdx, probeUsdt);
    raw.push({ ...s, hits, settleTier: hitsToActivityTier(settleHits) });
  }
  return simulateTierMartingale(raw, tierBets, { entryPrice });
}

function scoreNet(summary) {
  if (summary.trades < 50 || summary.netPnl <= 0) return -Infinity;
  return summary.netPnl + summary.netRoi * 800 + summary.winRate * 50 - summary.halts * 20;
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const toMs = parseArg('to') ? Date.parse(parseArg('to')) : Date.now();
  const fromMs = parseArg('from') ? Date.parse(parseArg('from')) : toMs - days * 24 * 60 * 60_000;
  const base = Number(parseArg('base', String(config.tradeBudgetUsd)));
  const entryPrice = Number(parseArg('entry', process.env.BACKTEST_ENTRY_PRICE ?? '0.5'));
  const marketCtx = resolveOhlcvMarket(config.ohlcvMarketType);

  const effFee = effectiveFeeRate(entryPrice);
  console.log(`\n=== 扣费回测 · OKX ${marketCtx.label} · ${days}d ===`);
  console.log(`Polymarket Crypto taker: feeRate=${CRYPTO_TAKER_FEE_RATE}, entry=$${entryPrice}, 有效费率≈${(effFee * 100).toFixed(2)}%`);
  console.log(`公式: fee = C × ${CRYPTO_TAKER_FEE_RATE} × p × (1-p) — https://docs.polymarket.com/trading/fees`);

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const barUsdt = c5.map((b) => computeBarUsdtNotional(b));
  const inRangeUsdt = c5
    .filter((b) => b.t >= fromMs && b.t < toMs)
    .map((b) => computeBarUsdtNotional(b))
    .filter(Number.isFinite);

  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)} | K线 ${c5.length}`);
  console.log(`单根成交额 p50=${fmtM(pct(inRangeUsdt, 0.5))} p75=${fmtM(pct(inRangeUsdt, 0.75))} p90=${fmtM(pct(inRangeUsdt, 0.9))}`);

  const signals = buildSignals(c5, fromMs, toMs);
  const tierProfiles = buildTierProfiles(base);

  const alwaysOn = summarizeTradesNet(simulateTierMartingale(
    signals.map((s) => ({
      ...s,
      settleTier: hitsToActivityTier(rollingHits(barUsdt, s.settleIdx, 25_000_000)),
    })),
    tierProfiles.flat,
    { entryPrice },
  ));

  console.log(`\n常开 flat $${base} | 交易 ${alwaysOn.trades} | 胜率 ${(alwaysOn.winRate * 100).toFixed(1)}%`);
  console.log(`  毛 PnL $${alwaysOn.grossPnl.toFixed(0)} 毛ROI ${(alwaysOn.grossRoi * 100).toFixed(2)}%`);
  console.log(`  手续费 $${alwaysOn.totalFees.toFixed(0)} (drag ${(alwaysOn.feeDrag * 100).toFixed(2)}%)`);
  console.log(`  净 PnL $${alwaysOn.netPnl.toFixed(0)} 净ROI ${(alwaysOn.netRoi * 100).toFixed(2)}%`);

  const gateSweep = [];
  for (const probeM of PROBE_SWEEP_M) {
    const probeUsdt = probeM * 1_000_000;
    for (const minHits of MIN_HITS_SWEEP) {
      for (const [profile, bets] of Object.entries(tierProfiles)) {
        const sim = filterAndSimulate(signals, barUsdt, probeUsdt, minHits, bets, entryPrice);
        const s = summarizeTradesNet(sim);
        gateSweep.push({
          probeM,
          probeUsdt,
          minHits,
          profile,
          tierBets: bets,
          gatePct: sim.length / (signals.length || 1),
          ...s,
          score: scoreNet(s),
        });
      }
    }
  }

  const netPositive = gateSweep.filter((r) => r.netPnl > 0 && r.trades >= 50);
  netPositive.sort((a, b) => b.netPnl - a.netPnl);

  console.log('\n=== 净 ROI > 0 的组合 (按净 PnL 排序 top 12) ===');
  console.log('probe | hits | 方案 | 交易 | 胜率 | 止损 | 毛ROI | 净ROI | 净PnL');
  for (const r of netPositive.slice(0, 12)) {
    console.log(
      `${fmtM(r.probeUsdt).padStart(5)} | ${String(r.minHits).padStart(4)} | ${r.profile.padEnd(12)} | ` +
      `${String(r.trades).padStart(5)} | ${(r.winRate * 100).toFixed(1).padStart(4)}% | ${String(r.halts).padStart(4)} | ` +
      `${(r.grossRoi * 100).toFixed(2).padStart(5)}% | ${(r.netRoi * 100).toFixed(2).padStart(5)}% | $${r.netPnl.toFixed(0)}`,
    );
  }

  if (netPositive.length === 0) {
    console.log('(无净盈利组合，显示最接近打平的 8 组)');
    gateSweep.sort((a, b) => b.netPnl - a.netPnl);
    for (const r of gateSweep.slice(0, 8)) {
      console.log(
        `${fmtM(r.probeUsdt).padStart(5)} | ${String(r.minHits).padStart(4)} | ${r.profile.padEnd(12)} | ` +
        `净ROI ${(r.netRoi * 100).toFixed(2)}% 净PnL $${r.netPnl.toFixed(0)}`,
      );
    }
  }

  const byProbeHits = new Map();
  for (const r of gateSweep) {
    const key = `${r.probeM}-${r.minHits}`;
    const prev = byProbeHits.get(key);
    if (!prev || r.netPnl > prev.netPnl) byProbeHits.set(key, r);
  }
  const bestPerGate = [...byProbeHits.values()].filter((r) => r.netPnl > 0);
  bestPerGate.sort((a, b) => b.netRoi - a.netRoi);

  console.log('\n=== 各门控参数最优档位 (净盈利) ===');
  console.log('probe | hits | 最优方案 | 净ROI | 净PnL | 交易');
  for (const r of bestPerGate.slice(0, 10)) {
    console.log(
      `${fmtM(r.probeUsdt).padStart(5)} | ${String(r.minHits).padStart(4)} | ${r.profile.padEnd(12)} | ` +
      `${(r.netRoi * 100).toFixed(2).padStart(5)}% | $${r.netPnl.toFixed(0).padStart(6)} | ${r.trades}`,
    );
  }

  const recommended = netPositive[0] ?? gateSweep.sort((a, b) => b.netPnl - a.netPnl)[0];

  console.log('\n=== 推荐配置 (扣费后) ===');
  if (recommended?.netPnl > 0) {
    console.log(`ACTIVITY_PROBE_USDT_MIN=${recommended.probeUsdt}`);
    console.log(`ACTIVITY_MIN_HITS=${recommended.minHits}`);
    console.log(`ACTIVITY_TIER_BETS=${recommended.tierBets.join(',')}`);
    console.log(`方案: ${recommended.profile}`);
    console.log(`净 PnL $${recommended.netPnl.toFixed(1)} | 净 ROI ${(recommended.netRoi * 100).toFixed(2)}% | 毛 ROI ${(recommended.grossRoi * 100).toFixed(2)}%`);
    console.log(`交易 ${recommended.trades} | 胜率 ${(recommended.winRate * 100).toFixed(1)}% | 止损 ${recommended.halts}`);
    console.log(`对比常开: 净PnL ${recommended.netPnl > alwaysOn.netPnl ? '+' : ''}${(recommended.netPnl - alwaysOn.netPnl).toFixed(0)}`);
  } else {
    console.log('⚠ 一年回测内无稳定净盈利组合，建议提高 minHits 或降低首注档位');
  }

  const entrySweep = [0.45, 0.5, 0.55, 0.6];
  if (recommended?.netPnl > 0) {
    console.log(`\n=== 入场价敏感性 (${fmtM(recommended.probeUsdt)} · hits≥${recommended.minHits} · ${recommended.profile}) ===`);
    for (const p of entrySweep) {
      const sim = filterAndSimulate(
        signals, barUsdt, recommended.probeUsdt, recommended.minHits, recommended.tierBets, p,
      );
      const s = summarizeTradesNet(sim);
      console.log(
        `  p=$${p.toFixed(2)} 有效费率 ${(effectiveFeeRate(p) * 100).toFixed(2)}% | ` +
        `净ROI ${(s.netRoi * 100).toFixed(2)}% | 净PnL $${s.netPnl.toFixed(0)}`,
      );
    }
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify({
    feeModel: { feeRate: CRYPTO_TAKER_FEE_RATE, entryPrice, docs: 'https://docs.polymarket.com/trading/fees' },
    range: { from: fmtTs(fromMs), to: fmtTs(toMs), days },
    alwaysOn,
    netPositiveTop30: netPositive.slice(0, 30),
    bestPerGate: bestPerGate.slice(0, 20),
    recommended: recommended?.netPnl > 0 ? {
      ACTIVITY_PROBE_USDT_MIN: recommended.probeUsdt,
      ACTIVITY_MIN_HITS: recommended.minHits,
      ACTIVITY_TIER_BETS: recommended.tierBets.join(','),
      profile: recommended.profile,
      netPnl: recommended.netPnl,
      netRoi: recommended.netRoi,
      grossRoi: recommended.grossRoi,
    } : null,
  }, null, 2));
  console.log(`\n完整结果 → ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
