/**
 * BTC 365d：连亏止损后「跳过下一单」vs「立即继续开」A/B
 *
 * Usage:
 *   node scripts/backtest-btc-halt-skip-compare.js --days=365
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../src/config.js';
import { resolveOhlcvMarket } from '../src/collector/binance.js';
import { ensureOkxCandles } from './lib/okxOhlcv.js';
import {
  buildAlwaysOnTrades,
  simulateMartingale,
  fmtM,
  pct,
} from './lib/btcAlwaysOnSim.js';
import { formatTierParamLabel } from '../src/martingale/dynamicBaseBet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-btc-halt-skip-compare.json');

const TIER_OPTS = {
  tier1_9Usd: config.dynamicBaseBet.tier1_9Usd,
  tier10Usd: config.dynamicBaseBet.tier10Usd,
  tier11Usd: config.dynamicBaseBet.tier11Usd,
  tier12Usd: config.dynamicBaseBet.tier12Usd,
};
const PROBE = config.sessionGate.activityProbeUsdtMin;
const MIN_TIER = config.dynamicBaseBet.minActivityTier;

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

function printRow(label, m, baseline) {
  const dPnl = m.pnl - baseline.pnl;
  const dTrades = m.trades - baseline.trades;
  console.log(
    `${label.padEnd(22)} | 成交 ${String(m.trades).padStart(5)} | 胜率 ${pct(m.winRate).padStart(6)} | `
    + `PnL $${m.pnl.toFixed(0).padStart(6)} | ROI ${pct(m.roi).padStart(7)} | `
    + `回撤 $${m.maxDrawdown.toFixed(0).padStart(5)} | 止损 ${String(m.halts).padStart(3)} | `
    + `均注 $${m.avgStake.toFixed(1).padStart(5)} | Δ成交 ${dTrades >= 0 ? '+' : ''}${dTrades} | ΔPnL ${dPnl >= 0 ? '+' : ''}$${dPnl.toFixed(0)}`,
  );
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const forceFetch = hasFlag('fetch');
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;

  console.log(`\n=== BTC 止损后是否跳过 · ${days}d · OKX 永续 5m ===`);
  console.log(`区间: ${fmtTs(fromMs)} → ${fmtTs(toMs)}`);
  console.log(`探测线: ${fmtM(PROBE)} | ${formatTierParamLabel(TIER_OPTS)} | MIN_ACTIVITY_TIER=${MIN_TIER}\n`);

  const marketCtx = resolveOhlcvMarket('swap', 'BTC/USDT');
  const { c5 } = await ensureOkxCandles({
    fromMs,
    toMs,
    forceFetch,
    marketType: marketCtx.marketType,
    symbol: marketCtx.symbol,
  });

  const trades = buildAlwaysOnTrades(c5, fromMs, toMs);
  const simOpts = { tierOpts: TIER_OPTS, probeUsdt: PROBE, minActivityTier: MIN_TIER };

  const withSkip = simulateMartingale(trades, c5, { ...simOpts, skipAfterHalt: true });
  const noSkip = simulateMartingale(trades, c5, { ...simOpts, skipAfterHalt: false });

  console.log(`原始信号: ${trades.length} 条\n`);
  console.log('方案                    | 成交  | 胜率   | PnL     | ROI     | 回撤   | 止损 | 均注   | Δ成交 | ΔPnL');
  console.log('-'.repeat(115));
  printRow('现网：止损后跳过一单', withSkip, withSkip);
  printRow('方案：止损后立即继续', noSkip, withSkip);

  const extraTrades = noSkip.trades - withSkip.trades;
  console.log('\n═══ 结论 ═══');
  console.log(`不停机多成交 ${extraTrades} 笔（≈止损 ${withSkip.halts} 次各少跳 1 单）`);
  console.log(
    `PnL ${noSkip.pnl >= withSkip.pnl ? '+' : ''}$${(noSkip.pnl - withSkip.pnl).toFixed(0)} | `
    + `ROI ${noSkip.roi >= withSkip.roi ? '+' : ''}${pct(noSkip.roi - withSkip.roi)} | `
    + `回撤 ${noSkip.maxDrawdown >= withSkip.maxDrawdown ? '+' : ''}$${(noSkip.maxDrawdown - withSkip.maxDrawdown).toFixed(0)}`,
  );

  const output = {
    days,
    range: { from: fmtTs(fromMs), to: fmtTs(toMs) },
    params: { probeUsdt: PROBE, tierOpts: TIER_OPTS, minActivityTier: MIN_TIER },
    rawSignals: trades.length,
    withSkip,
    noSkip,
    delta: {
      trades: extraTrades,
      pnl: noSkip.pnl - withSkip.pnl,
      roi: noSkip.roi - withSkip.roi,
      maxDrawdown: noSkip.maxDrawdown - withSkip.maxDrawdown,
    },
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n完整结果: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
