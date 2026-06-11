/**
 * Run each session-gate factor separately and print comparison table.
 * Usage: node scripts/backtest-session-gate-all-factors.js --days=365 --fetch
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  runSessionGateBacktest,
  FACTOR_LABELS,
} from './backtest-session-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'logs');
const OUT_FILE = join(OUT_DIR, 'backtest-session-gate-all-factors.json');

const FACTORS = [
  'compress',
  'volume',
  'period-vol',
  'spike',
  'momentum',
  'macro',
  'us',
  'event',
  'combo',
];

function parseArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

async function main() {
  const days = Number(parseArg('days', '365'));
  const fetch = hasFlag('fetch');
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60_000;
  const results = [];
  let alwaysOn = null;
  let sharedCandles = null;

  console.log(`\n=== 单因子会话门控回测 · ${days} 天 ===`);
  console.log(`区间: ${new Date(fromMs).toISOString().slice(0, 16)} → ${new Date(toMs).toISOString().slice(0, 16)}\n`);

  for (let i = 0; i < FACTORS.length; i += 1) {
    const factor = FACTORS[i];
    console.log(`[${i + 1}/${FACTORS.length}] ${FACTOR_LABELS[factor]} (${factor}) ...`);
    const { report, candles } = await runSessionGateBacktest({
      factor,
      fromMs,
      toMs,
      candles: sharedCandles,
      fetch: fetch && !sharedCandles,
      quiet: true,
    });
    if (!sharedCandles) sharedCandles = candles;
    report.quietSegments = true;
    if (!alwaysOn) alwaysOn = report.summary.alwaysOn;

    results.push({
      factor,
      label: FACTOR_LABELS[factor],
      evalPassPct: report.summary.evalPassPct,
      gateOpenPct: report.summary.gateOpenPct,
      segments: report.summary.sessionSegments,
      trades: report.summary.gated.trades,
      winRate: report.summary.gated.winRate,
      halts: report.summary.gated.halts,
      pnl: report.summary.gated.pnl,
      pnlDelta: report.summary.gated.pnl - report.summary.alwaysOn.pnl,
      roi: report.summary.gated.roi,
    });
  }

  results.sort((a, b) => b.pnl - a.pnl);

  const output = {
    days,
    range: results.length ? { note: 'see individual factor JSON files' } : null,
    alwaysOn,
    results,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n常开基准 (${days}d): ${alwaysOn.trades}笔 WR ${pct(alwaysOn.winRate)} PnL ${alwaysOn.pnl.toFixed(2)} 止损${alwaysOn.halts}`);
  console.log('\n=== 单因子对比（按门控 PnL 排序）===');
  console.table(results.map((r) => ({
    因子: r.label,
    评估通过: pct(r.evalPassPct),
    门控开启: pct(r.gateOpenPct),
    交易: r.trades,
    胜率: pct(r.winRate),
    止损: r.halts,
    门控PnL: r.pnl.toFixed(2),
    'Δvs常开': r.pnlDelta.toFixed(2),
  })));

  console.log(`\nFull JSON: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
