/**
 * Replay existing Vegas trade CSVs with a different martingale multiplier.
 * Win/loss sequence is independent of stake sizing; only stakes/PnL change.
 *
 * Usage:
 *   node scripts/compare-martingale-mult.js
 *   node scripts/compare-martingale-mult.js --mult=2
 *   node scripts/compare-martingale-mult.js --mult=1
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeNetSettlementPnl } from './lib/polymarketFees.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOGS = join(ROOT, 'logs');

const BASE_BET = 3;
const MAX_LOSSES = 5;
const ENTRY_PRICE = 0.5;
const USE_FEE = true;
const BASE_MULT = 3;

const multArg = process.argv.find((a) => a.startsWith('--mult='));
const TARGET_MULT = multArg ? Number(multArg.split('=')[1]) : 2;
if (!Number.isFinite(TARGET_MULT) || TARGET_MULT <= 0) {
  console.error('Invalid --mult');
  process.exit(1);
}

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const TFS = ['5m', '15m', '1h'];

function parseCsv(path) {
  const text = readFileSync(path, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines.slice(1).filter(Boolean).map((line) => {
    const c = line.split(',');
    return {
      settleBarT: c[idx.settleBarT],
      signalId: c[idx.signalId],
      signal: c[idx.signal],
      won: c[idx.won] === 'true',
      stake: Number(c[idx.stake]),
      pnlUsd: Number(c[idx.pnlUsd]),
      feeUsd: Number(c[idx.feeUsd]),
      chainEnd: c[idx.chainEnd] || '',
      lossesBefore: Number(c[idx.lossesBefore]),
    };
  });
}

function replay(trades, mult) {
  let consecutiveLosses = 0;
  let currentBet = BASE_BET;
  let pnl = 0;
  let fees = 0;
  let stakes = 0;
  let maxStake = 0;
  let wins = 0;
  let halts = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const byMonth = new Map();
  let maxAbsDiff = 0;

  for (const t of trades) {
    if (t.signalId === 'VG_UP' || t.signalId === 'VG_DOWN') {
      consecutiveLosses = 0;
      currentBet = BASE_BET;
    }

    const stake = currentBet;
    let pnlUsd;
    let feeUsd = 0;
    if (USE_FEE) {
      const net = computeNetSettlementPnl(t.won, stake, ENTRY_PRICE);
      pnlUsd = net.pnlUsd;
      feeUsd = net.feeUsd;
    } else if (t.won) {
      pnlUsd = stake * ((1 - ENTRY_PRICE) / ENTRY_PRICE);
    } else {
      pnlUsd = -stake;
    }

    if (mult === BASE_MULT) {
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(stake - t.stake));
    }

    if (t.won) wins += 1;
    pnl += pnlUsd;
    fees += feeUsd;
    stakes += stake;
    maxStake = Math.max(maxStake, stake);

    equity += pnlUsd;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);

    const month = t.settleBarT.slice(0, 7);
    const row = byMonth.get(month) ?? { n: 0, wins: 0, pnl: 0 };
    row.n += 1;
    if (t.won) row.wins += 1;
    row.pnl += pnlUsd;
    byMonth.set(month, row);

    if (t.won) {
      consecutiveLosses = 0;
      currentBet = BASE_BET;
    } else {
      consecutiveLosses += 1;
      if (consecutiveLosses >= MAX_LOSSES) {
        halts += 1;
        consecutiveLosses = 0;
        currentBet = BASE_BET;
      } else {
        currentBet *= mult;
      }
    }
  }

  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    pnlUsd: pnl,
    feesUsd: fees,
    totalStakeUsd: stakes,
    maxStakeUsd: maxStake,
    maxDrawdownUsd: maxDd,
    chainsHalt: halts,
    maxStakeDiffVsCsv: maxAbsDiff,
    monthly: [...byMonth.entries()].map(([month, r]) => ({
      month,
      trades: r.n,
      winRate: r.n ? r.wins / r.n : 0,
      pnlUsd: r.pnl,
    })),
  };
}

function pack(r) {
  return {
    pnlUsd: r.pnlUsd,
    feesUsd: r.feesUsd,
    maxDrawdownUsd: r.maxDrawdownUsd,
    maxStakeUsd: r.maxStakeUsd,
    totalStakeUsd: r.totalStakeUsd,
    chainsHalt: r.chainsHalt,
  };
}

function usd(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n >= 0 ? '+' : '-'}$${s}`;
}

const labelBase = `x${BASE_MULT}`;
const labelTgt = `x${TARGET_MULT}`;
const instances = [];
let verifyFail = 0;

for (const symbol of SYMBOLS) {
  for (const tf of TFS) {
    const csvPath = join(LOGS, `backtest-vegas-${symbol.toLowerCase()}-${tf}-trades.csv`);
    if (!existsSync(csvPath)) {
      console.warn(`SKIP missing ${csvPath}`);
      continue;
    }
    const trades = parseCsv(csvPath);
    const base = replay(trades, BASE_MULT);
    const tgt = replay(trades, TARGET_MULT);

    if (base.maxStakeDiffVsCsv > 0.01) {
      verifyFail += 1;
      console.warn(
        `VERIFY FAIL ${symbol} ${tf}: max stake diff vs CSV = ${base.maxStakeDiffVsCsv}`,
      );
    }

    const csvPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
    if (Math.abs(base.pnlUsd - csvPnl) > 1) {
      verifyFail += 1;
      console.warn(`PNL VERIFY FAIL ${symbol} ${tf}: replay=${base.pnlUsd} csv=${csvPnl}`);
    }

    instances.push({
      symbol,
      tf,
      trades: trades.length,
      winRate: base.winRate,
      base: pack(base),
      target: pack(tgt),
      deltaPnl: tgt.pnlUsd - base.pnlUsd,
      deltaDd: tgt.maxDrawdownUsd - base.maxDrawdownUsd,
    });

    console.log(
      `${symbol.padEnd(4)} ${tf.padEnd(3)}  ` +
        `${labelBase} ${usd(base.pnlUsd).padStart(12)} DD ${usd(base.maxDrawdownUsd).padStart(12)}  |  ` +
        `${labelTgt} ${usd(tgt.pnlUsd).padStart(12)} DD ${usd(tgt.maxDrawdownUsd).padStart(12)}  |  ` +
        `Dpnl ${usd(tgt.pnlUsd - base.pnlUsd).padStart(12)}`,
    );
  }
}

const bySymbol = SYMBOLS.map((symbol) => {
  const rows = instances.filter((i) => i.symbol === symbol);
  if (!rows.length) return null;
  const sum = (key, side) => rows.reduce((s, r) => s + r[side][key], 0);
  const worstDd = (side) => Math.min(...rows.map((r) => r[side].maxDrawdownUsd));
  return {
    symbol,
    trades: rows.reduce((s, r) => s + r.trades, 0),
    base: {
      pnlUsd: sum('pnlUsd', 'base'),
      feesUsd: sum('feesUsd', 'base'),
      maxDrawdownUsd: worstDd('base'),
      maxStakeUsd: Math.max(...rows.map((r) => r.base.maxStakeUsd)),
    },
    target: {
      pnlUsd: sum('pnlUsd', 'target'),
      feesUsd: sum('feesUsd', 'target'),
      maxDrawdownUsd: worstDd('target'),
      maxStakeUsd: Math.max(...rows.map((r) => r.target.maxStakeUsd)),
    },
    deltaPnl: sum('pnlUsd', 'target') - sum('pnlUsd', 'base'),
  };
}).filter(Boolean);

const grand = {
  base: {
    pnlUsd: bySymbol.reduce((s, r) => s + r.base.pnlUsd, 0),
    maxDrawdownUsd: Math.min(...bySymbol.map((r) => r.base.maxDrawdownUsd)),
  },
  target: {
    pnlUsd: bySymbol.reduce((s, r) => s + r.target.pnlUsd, 0),
    maxDrawdownUsd: Math.min(...bySymbol.map((r) => r.target.maxDrawdownUsd)),
  },
};
grand.deltaPnl = grand.target.pnlUsd - grand.base.pnlUsd;

const outPath = join(LOGS, `backtest-mult-compare-x${TARGET_MULT}.json`);
const out = {
  generatedAt: new Date().toISOString(),
  params: {
    baseBet: BASE_BET,
    maxLosses: MAX_LOSSES,
    entryPrice: ENTRY_PRICE,
    fee: USE_FEE,
    baseMult: BASE_MULT,
    targetMult: TARGET_MULT,
    compare: [`mult=${BASE_MULT} (original)`, `mult=${TARGET_MULT} (replay)`],
    method: 'Replay won/loss sequence from existing trade CSVs; stakes recomputed',
  },
  verifyFail,
  instances,
  bySymbol,
  grand,
};

writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`\n-- By symbol (3 TF combined) --`);
for (const r of bySymbol) {
  console.log(
    `${r.symbol.padEnd(4)}  ${labelBase} ${usd(r.base.pnlUsd).padStart(12)}  ` +
      `${labelTgt} ${usd(r.target.pnlUsd).padStart(12)}  D ${usd(r.deltaPnl).padStart(12)}  ` +
      `DD ${labelBase} ${usd(r.base.maxDrawdownUsd)} -> ${labelTgt} ${usd(r.target.maxDrawdownUsd)}`,
  );
}
console.log(
  `\nGRAND  ${labelBase} ${usd(grand.base.pnlUsd)}  ${labelTgt} ${usd(grand.target.pnlUsd)}  D ${usd(grand.deltaPnl)}`,
);
console.log(`verifyFail=${verifyFail}`);
console.log(`Wrote ${outPath}`);
