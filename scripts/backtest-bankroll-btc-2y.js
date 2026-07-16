/**
 * Backtest current live rules on BTC (last ~2 years):
 * - Vegas win/loss sequence from existing trade CSVs
 * - Dynamic bankroll: default $10 / multi-step catch-up by gap / stake<=$30
 * - Shared P/N across 5m+15m+1h (merged by settle time)
 * - Stops when balance cannot fund min stake
 *
 * Usage:
 *   node scripts/backtest-bankroll-btc-2y.js
 *   node scripts/backtest-bankroll-btc-2y.js --from=2024-07-15 --principal=5000
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeNetSettlementPnl } from './lib/polymarketFees.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');

function argStr(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
function argNum(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

const FROM = argStr('from', '2024-07-15');
const TO = argStr('to', null);
const PRINCIPAL = argNum('principal', 5000);
const DEFAULT_BET = argNum('base', 10);
const STEP = argNum('step', 10);
const T_CAP = argNum('tCap', 20);
const STAKE_MAX = argNum('stakeMax', 30);
const GAP_FULL = argNum('gapFull', 5);
const GAP_HALF = argNum('gapHalf', 15);
const ENTRY = argNum('entry', 0.5);
const MIN_STAKE = argNum('minStake', 1);
const USE_FEE = true;

function resolveCatchUpFraction(gap) {
  if (!(gap > 0) || gap <= GAP_FULL) return 1;
  if (gap <= GAP_HALF) return 0.5;
  return 1 / 3;
}

const TFS = ['5m', '15m', '1h'];
const fromMs = Date.parse(`${FROM}T00:00:00.000Z`);
const toMs = TO
  ? Date.parse(TO.includes('T') ? TO : `${TO}T23:59:59.999Z`)
  : Date.now();

function parseCsv(path) {
  const text = readFileSync(path, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines.slice(1).filter(Boolean).map((line) => {
    const c = line.split(',');
    return {
      settleBarT: c[idx.settleBarT],
      settleMs: Date.parse(c[idx.settleBarT]),
      signalId: c[idx.signalId],
      signal: c[idx.signal],
      won: c[idx.won] === 'true',
      tf: null,
    };
  });
}

function computeStake({ balance, principal, netCount, entryPrice, flat = false }) {
  const bal = Number(balance);
  const P = Number(principal);
  const N = netCount;
  const p = Number(entryPrice);

  const clamp = (raw) => {
    let s = Math.max(0, Number(raw) || 0);
    s = Math.min(s, STAKE_MAX, Math.max(0, bal));
    return Math.round(s * 100) / 100;
  };

  if (flat) {
    return {
      stakeUsd: clamp(DEFAULT_BET),
      mode: 'flat',
      targetProfitUsd: null,
      targetBalance: P + N * STEP,
    };
  }

  const targetBalance = P + N * STEP;
  if (bal >= targetBalance) {
    return {
      stakeUsd: clamp(DEFAULT_BET),
      mode: 'default',
      targetProfitUsd: null,
      targetBalance,
    };
  }

  const gap = targetBalance - bal;
  if (!(gap > 0)) {
    return {
      stakeUsd: clamp(DEFAULT_BET),
      mode: 'fallback_default',
      targetProfitUsd: null,
      targetBalance,
    };
  }
  let T = gap * resolveCatchUpFraction(gap);
  T = Math.min(T, T_CAP);
  T = Math.round(T * 100) / 100;

  if (!(p > 0 && p < 1)) {
    return {
      stakeUsd: clamp(DEFAULT_BET),
      mode: 'fallback_default',
      targetProfitUsd: T,
      targetBalance,
    };
  }

  return {
    stakeUsd: clamp(T * (p / (1 - p))),
    mode: 'catch_up',
    targetProfitUsd: T,
    targetBalance,
    gapUsd: Math.round(gap * 100) / 100,
  };
}

function simulate(trades, label, { flat = false } = {}) {
  let balance = PRINCIPAL;
  let netCount = 0;
  let peak = PRINCIPAL;
  let maxDd = 0;
  let pnl = 0;
  let fees = 0;
  let wins = 0;
  let stakes = 0;
  let maxStake = 0;
  let catchUpN = 0;
  let defaultN = 0;
  let executed = 0;
  let ruined = false;
  let ruinedAt = null;
  const monthly = new Map();
  const monthEq = new Map();

  for (const t of trades) {
    if (balance < MIN_STAKE) {
      ruined = true;
      ruinedAt = t.settleBarT;
      break;
    }

    const sizing = computeStake({
      balance,
      principal: PRINCIPAL,
      netCount,
      entryPrice: ENTRY,
      flat,
    });
    if (sizing.mode === 'catch_up') catchUpN += 1;
    else defaultN += 1;

    const stake = sizing.stakeUsd;
    if (!(stake >= MIN_STAKE)) {
      ruined = true;
      ruinedAt = t.settleBarT;
      break;
    }

    const net = USE_FEE
      ? computeNetSettlementPnl(t.won, stake, ENTRY)
      : t.won
        ? { pnlUsd: stake * ((1 - ENTRY) / ENTRY), feeUsd: 0 }
        : { pnlUsd: -stake, feeUsd: 0 };

    balance += net.pnlUsd;
    pnl += net.pnlUsd;
    fees += net.feeUsd;
    stakes += stake;
    maxStake = Math.max(maxStake, stake);
    executed += 1;
    if (t.won) wins += 1;
    netCount += t.won ? 1 : -1;

    peak = Math.max(peak, balance);
    maxDd = Math.min(maxDd, balance - peak);

    const month = t.settleBarT.slice(0, 7);
    const row = monthly.get(month) ?? { n: 0, wins: 0, pnl: 0 };
    row.n += 1;
    if (t.won) row.wins += 1;
    row.pnl += net.pnlUsd;
    monthly.set(month, row);
    monthEq.set(month, balance);
  }

  return {
    label,
    flat,
    signalsAvailable: trades.length,
    trades: executed,
    wins,
    winRate: executed ? wins / executed : 0,
    pnlUsd: pnl,
    feesUsd: fees,
    finalBalance: balance,
    principal: PRINCIPAL,
    finalNetCount: netCount,
    maxDrawdownUsd: maxDd,
    maxStakeUsd: maxStake,
    totalStakeUsd: stakes,
    catchUpTrades: catchUpN,
    defaultTrades: defaultN,
    ruined,
    ruinedAt,
    period: {
      from: trades[0]?.settleBarT?.slice(0, 10) ?? null,
      to: ruinedAt?.slice(0, 10) ?? trades.at(-1)?.settleBarT?.slice(0, 10) ?? null,
    },
    monthly: [...monthly.entries()].map(([month, r]) => ({
      month,
      trades: r.n,
      winRate: r.n ? r.wins / r.n : 0,
      pnlUsd: r.pnl,
    })),
    equity: [...monthEq.entries()].map(([month, eq]) => ({
      month,
      equity: Math.round(eq * 100) / 100,
    })),
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

function pct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

function loadTf(tf) {
  const path = join(LOGS, `backtest-vegas-btc-${tf}-trades.csv`);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return parseCsv(path)
    .filter((t) => t.settleMs >= fromMs && t.settleMs <= toMs)
    .map((t) => ({ ...t, tf }));
}

function printRow(r) {
  console.log(
    `${r.label.padEnd(28)} n=${String(r.trades).padStart(6)}/${r.signalsAvailable}  ` +
      `wr=${pct(r.winRate).padStart(7)}  pnl=${usd(r.pnlUsd).padStart(12)}  ` +
      `DD=${usd(r.maxDrawdownUsd).padStart(12)}  bal=$${r.finalBalance.toFixed(2).padStart(10)}  ` +
      `N=${String(r.finalNetCount).padStart(5)}  catchUp=${r.catchUpTrades}` +
      (r.ruined ? `  RUIN@${r.ruinedAt?.slice(0, 10)}` : ''),
  );
}

console.log('=== BTC bankroll backtest (current project rules) ===');
console.log(
  `Period ${FROM} → ${TO || 'now'} | P=$${PRINCIPAL} | base=$${DEFAULT_BET} step=$${STEP} Tcap=$${T_CAP} max=$${STAKE_MAX} entry=${ENTRY} fee=${USE_FEE}`,
);

const perTf = {};
const perTfFlat = {};
const all = [];
for (const tf of TFS) {
  const trades = loadTf(tf);
  perTf[tf] = simulate(trades, `BTC ${tf} bankroll`);
  perTfFlat[tf] = simulate(trades, `BTC ${tf} flat$10`, { flat: true });
  all.push(...trades);
  printRow(perTf[tf]);
  printRow(perTfFlat[tf]);
}

all.sort((a, b) => a.settleMs - b.settleMs || a.tf.localeCompare(b.tf));
const shared = simulate(all, 'BTC shared bankroll');
const sharedFlat = simulate(all, 'BTC shared flat$10', { flat: true });
console.log('');
printRow(shared);
printRow(sharedFlat);

const out = {
  generatedAt: new Date().toISOString(),
  params: {
    symbol: 'BTC',
    from: FROM,
    to: TO || 'now',
    principal: PRINCIPAL,
    defaultBet: DEFAULT_BET,
    step: STEP,
    tCap: T_CAP,
    stakeMax: STAKE_MAX,
    entryPrice: ENTRY,
    fee: USE_FEE,
    note:
      'Win/loss from vegas CSV; live bankroll formula; shared merges 3 TFs by settle time; stops when broke',
  },
  perTf,
  perTfFlat,
  shared,
  sharedFlat,
};

writeFileSync(join(LOGS, 'backtest-bankroll-btc-2y.json'), JSON.stringify(out, null, 2));
console.log('\nWrote logs/backtest-bankroll-btc-2y.json');
