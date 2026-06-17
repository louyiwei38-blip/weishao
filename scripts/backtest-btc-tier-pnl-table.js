/**
 * 各参数组 × 12 档动态首注 PnL/ROI 分段表
 * node scripts/backtest-btc-tier-pnl-table.js --days=365
 */
import config from '../src/config.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import { calcWinNetProfit } from '../src/trader/fillSync.js';
import {
  activityHitsToTier,
  resolveTierBaseBet,
  TIER_COUNT,
} from '../src/martingale/dynamicBaseBet.js';
import {
  buildAlwaysOnTrades,
  computeActivityFreqLocal,
  ENTRY_PRICE,
  MARTINGALE_MAX,
  MULTIPLIER,
} from './lib/btcAlwaysOnSim.js';

const CONFIGS = [
  { label: '生产默认', probeM: 25, tier1_9: 1, tier10: 6, tier11: 8, tier12: 24 },
  { label: 'ROI峰(细扫)', probeM: 28.7, tier1_9: 1, tier10: 6, tier11: 8, tier12: 24 },
  { label: 'ROI最优', probeM: 28.5, tier1_9: 1, tier10: 6, tier11: 6, tier12: 32 },
  { label: 'PnL最优', probeM: 7.7, tier1_9: 1, tier10: 10, tier11: 10, tier12: 32 },
  { label: '综合均衡', probeM: 12.1, tier1_9: 1, tier10: 10, tier11: 16, tier12: 32 },
];

function tierHitsRange(tier) {
  const ranges = [];
  for (let h = 0; h <= 12; h += 1) {
    if (activityHitsToTier(h, 12) === tier) ranges.push(h);
  }
  if (ranges.length === 1) return `${ranges[0]}根`;
  return `${ranges[0]}-${ranges.at(-1)}根`;
}

function tierOptsFrom(c) {
  return { tier1_9Usd: c.tier1_9, tier10Usd: c.tier10, tier11Usd: c.tier11, tier12Usd: c.tier12 };
}

function simulateWithTierDetails(trades, c5, probeUsdt, tierOpts) {
  const idxByT = new Map(c5.map((b, i) => [b.t, i]));
  let consecutiveLosses = 0;
  let currentBet = tierOpts.tier1_9Usd;
  let skipNext = false;
  let streakTier = null;
  const out = [];

  for (const t of trades) {
    if (skipNext) {
      skipNext = false;
      consecutiveLosses = 0;
      streakTier = null;
      continue;
    }

    let activityTier = streakTier;
    if (consecutiveLosses === 0) {
      const idx = idxByT.get(t.k1t) ?? 0;
      const { hits, windowBars } = computeActivityFreqLocal(c5, idx, probeUsdt);
      activityTier = activityHitsToTier(hits, windowBars);
      streakTier = activityTier;
      currentBet = resolveTierBaseBet(activityTier, tierOpts);
    }

    const stake = currentBet;
    const pnlUsd = t.won ? (calcWinNetProfit(stake, ENTRY_PRICE) ?? stake) : -stake;
    out.push({ won: t.won, stake, pnlUsd, activityTier });

    if (t.won) {
      consecutiveLosses = 0;
      streakTier = null;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MARTINGALE_MAX) {
        consecutiveLosses = 0;
        streakTier = null;
        skipNext = true;
      } else {
        currentBet *= MULTIPLIER;
      }
    }
  }
  return out;
}

function summarizeByTier(tradeDetails, tierOpts) {
  const tiers = Array.from({ length: TIER_COUNT }, (_, i) => ({
    tier: i + 1,
    hitsRange: tierHitsRange(i + 1),
    baseBet: resolveTierBaseBet(i + 1, tierOpts),
    trades: 0,
    wins: 0,
    pnl: 0,
    totalStake: 0,
  }));

  for (const t of tradeDetails) {
    if (t.activityTier == null) continue;
    const b = tiers[t.activityTier - 1];
    b.trades += 1;
    if (t.won) b.wins += 1;
    b.pnl += t.pnlUsd;
    b.totalStake += t.stake;
  }

  return tiers.map((b) => ({
    ...b,
    winRate: b.trades ? b.wins / b.trades : 0,
    roi: b.totalStake > 0 ? b.pnl / b.totalStake : 0,
  }));
}

async function main() {
  const days = 365;
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const marketCtx = resolveOhlcvMarket('swap', 'BTC/USDT');
  const { c5 } = await ensureOkxCandles({ fromMs, toMs, marketType: 'swap', symbol: marketCtx.symbol });
  const trades = buildAlwaysOnTrades(c5, fromMs, toMs);

  const all = [];
  for (const cfg of CONFIGS) {
    const tierOpts = tierOptsFrom(cfg);
    const details = simulateWithTierDetails(trades, c5, cfg.probeM * 1e6, tierOpts);
    const byTier = summarizeByTier(details, tierOpts);
    const total = {
      trades: details.length,
      pnl: details.reduce((s, x) => s + x.pnlUsd, 0),
      totalStake: details.reduce((s, x) => s + x.stake, 0),
    };
    total.roi = total.totalStake > 0 ? total.pnl / total.totalStake : 0;
    all.push({ ...cfg, byTier, total });
  }

  console.log(JSON.stringify(all, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
