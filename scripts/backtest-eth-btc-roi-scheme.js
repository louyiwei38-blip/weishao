/**
 * 用 BTC ROI 最优方案回测 ETH（门控常开 · 365d）
 * 方案: probe=28.5M · 1/6/6/32 · MIN_ACTIVITY_TIER=10
 *
 * Usage:
 *   node scripts/backtest-eth-btc-roi-scheme.js --days=365
 *   node scripts/backtest-eth-btc-roi-scheme.js --days=365 --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { computeBarUsdtNotional } from '../src/utils/volumeFilter.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import {
  activityHitsToTier,
  resolveTierBaseBet,
  formatTierParamLabel,
} from '../src/martingale/dynamicBaseBet.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import {
  buildAlwaysOnTrades,
  computeActivityFreqLocal,
  ENTRY_PRICE,
  MARTINGALE_MAX,
  MULTIPLIER,
  fmtM,
  pct,
  barUsdtDistribution,
} from './lib/btcAlwaysOnSim.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-eth-btc-roi-scheme.json');

/** BTC 多方法 ROI 最优（grid_roi） */
const BTC_ROI_SCHEME = {
  probeM: 28.5,
  probeUsdt: 28_500_000,
  tierOpts: { tier1_9Usd: 1, tier10Usd: 6, tier11Usd: 6, tier12Usd: 32 },
  minActivityTier: 10,
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

function simulate(trades, c5, { fixedBase = null, tierOpts = null, probeUsdt, minTier = 1 } = {}) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let ls = 0;
  let bet = fixedBase ?? tierOpts?.tier1_9Usd ?? 1;
  let skipNext = false;
  let halts = 0;
  let stake = 0;
  let pnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let n = 0;
  let wins = 0;
  let skippedCold = 0;
  let hotTierTrades = 0;
  const byTier = Array.from({ length: 12 }, (_, i) => ({
    tier: i + 1,
    trades: 0,
    wins: 0,
    pnl: 0,
    stake: 0,
  }));

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      ls = 0;
      continue;
    }

    let entryTier = null;
    if (ls === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { hits, windowBars } = computeActivityFreqLocal(c5, idx, probeUsdt);
      entryTier = activityHitsToTier(hits, windowBars);
      if (entryTier < minTier) {
        skippedCold += 1;
        continue;
      }
      if (fixedBase != null) bet = fixedBase;
      else bet = resolveTierBaseBet(entryTier, tierOpts);
      if (entryTier >= 10) hotTierTrades += 1;
    }

    const st = bet;
    const p = t.won ? (calcWinNetProfit(st, ENTRY_PRICE) ?? st) : -st;
    pnl += p;
    stake += st;
    n += 1;
    if (t.won) wins += 1;
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);

    const tierForBucket = entryTier ?? (ls === 0 ? 1 : null);
    if (tierForBucket != null) {
      const b = byTier[tierForBucket - 1];
      b.trades += 1;
      if (t.won) b.wins += 1;
      b.pnl += p;
      b.stake += st;
    }

    if (t.won) ls = 0;
    else {
      ls += 1;
      if (ls >= MARTINGALE_MAX) {
        halts += 1;
        ls = 0;
        skipNext = true;
      } else {
        bet *= MULTIPLIER;
      }
    }
  }

  return {
    trades: n,
    skippedCold,
    wins,
    winRate: n ? wins / n : 0,
    halts,
    pnl,
    roi: stake > 0 ? pnl / stake : 0,
    avgStake: n ? stake / n : 0,
    hotTierPct: n ? hotTierTrades / n : 0,
    maxDrawdown,
    byTier: byTier.map((b) => ({
      ...b,
      roi: b.stake > 0 ? b.pnl / b.stake : 0,
      winRate: b.trades ? b.wins / b.trades : 0,
      baseBet: b.tier <= 9 ? tierOpts?.tier1_9Usd
        : b.tier === 10 ? tierOpts?.tier10Usd
          : b.tier === 11 ? tierOpts?.tier11Usd
            : tierOpts?.tier12Usd,
    })),
  };
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const symbol = parseArg('symbol', 'ETH/USDT');
  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;
  const marketCtx = resolveOhlcvMarket('swap', symbol);
  const scheme = BTC_ROI_SCHEME;

  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch: hasFlag('fetch'),
    marketType: 'swap',
    symbol: marketCtx.symbol,
  });

  const rows = c5.filter((b) => b.t >= fromMs && b.t < toMs)
    .map((b) => ({ t: b.t, barUsdt: computeBarUsdtNotional(b) }));
  const barDist = barUsdtDistribution(rows);
  const trades = buildAlwaysOnTrades(c5, fromMs, toMs);

  const baseline = simulate(trades, c5, { fixedBase: 3, probeUsdt: scheme.probeUsdt });
  const fullDynamic = simulate(trades, c5, {
    tierOpts: scheme.tierOpts,
    probeUsdt: scheme.probeUsdt,
    minTier: 1,
  });
  const hotOnly = simulate(trades, c5, {
    tierOpts: scheme.tierOpts,
    probeUsdt: scheme.probeUsdt,
    minTier: scheme.minActivityTier,
  });

  console.log(`\n=== ETH · BTC ROI 最优方案回测 · ${days}d · ${marketCtx.label} ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
  console.log(`数据: OKX ${marketCtx.symbol} | 信号 ${trades.length} 笔`);
  if (barDist) {
    console.log(`5m 成交额: p50=${fmtM(barDist.p50)} p75=${fmtM(barDist.p75)} p90=${fmtM(barDist.p90)} p95=${fmtM(barDist.p95)}`);
  }
  console.log(`方案: probe=${scheme.probeM}M · ${formatTierParamLabel(scheme.tierOpts)} · minTier=${scheme.minActivityTier}`);

  console.log('\n--- 方案对比 ---');
  console.log('模式              | 成交  | 跳过冷档 | 胜率  | 止损 | 均注  | PnL      | ROI    | 回撤');
  for (const [label, r] of [
    ['固定 $3', baseline],
    ['全档动态', fullDynamic],
    ['仅10-12档(推荐)', hotOnly],
  ]) {
    console.log(
      `${label.padEnd(17)} | ${String(r.trades).padStart(5)} | ${String(r.skippedCold ?? 0).padStart(8)} | ` +
      `${pct(r.winRate).padStart(5)} | ${String(r.halts).padStart(4)} | ` +
      `$${r.avgStake.toFixed(2).padStart(4)} | $${r.pnl.toFixed(0).padStart(7)} | ` +
      `${pct(r.roi).padStart(6)} | $${(r.maxDrawdown ?? 0).toFixed(0)}`,
    );
  }

  console.log('\n--- 仅10-12档 · 各档 PnL/ROI ---');
  console.log('档位 | 首注 | 交易  | 胜率  | PnL    | ROI');
  for (const b of hotOnly.byTier.filter((x) => x.trades > 0)) {
    console.log(
      `${String(b.tier).padStart(4)} | $${String(b.baseBet).padStart(3)} | ${String(b.trades).padStart(5)} | ` +
      `${pct(b.winRate).padStart(5)} | ${(b.pnl >= 0 ? '+' : '')}${b.pnl.toFixed(0).padStart(6)} | ${pct(b.roi)}`,
    );
  }

  const output = {
    symbol: marketCtx.symbol,
    days,
    scheme: BTC_ROI_SCHEME,
    barDist,
    rawSignals: trades.length,
    baseline,
    fullDynamic,
    hotOnly,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
