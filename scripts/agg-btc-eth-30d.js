/**
 * Aggregate BTC/ETH 30d vegas backtest CSVs → logs/backtest-btc-eth-30d-detail.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');

const COMBOS = [
  ['btc', '1h'],
  ['eth', '1h'],
  ['btc', '15m'],
  ['eth', '15m'],
  ['btc', '5m'],
  ['eth', '5m'],
];

const out = {};

for (const [sym, tf] of COMBOS) {
  const tag = `${sym}-${tf}`;
  const summary = JSON.parse(
    readFileSync(join(LOGS, `backtest-vegas-${tag}.json`), 'utf8'),
  ).summary;
  const lines = readFileSync(join(LOGS, `backtest-vegas-${tag}-trades.csv`), 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1);

  const trades = lines.map((line) => {
    const [
      signalBarT,
      settleBarT,
      signal,
      signalId,
      outcome,
      won,
      stake,
      pnlUsd,
      feeUsd,
      chainEnd,
      lossesBefore,
    ] = line.split(',');
    return {
      signalBarT,
      settleBarT,
      signal,
      signalId,
      outcome,
      won: won === 'true',
      stake: +stake,
      pnlUsd: +pnlUsd,
      feeUsd: +feeUsd,
      chainEnd: chainEnd || null,
      lossesBefore: +lossesBefore,
    };
  });

  let eq = 0;
  const daily = new Map();
  const equityPts = [];

  for (const t of trades) {
    eq += t.pnlUsd;
    const day = t.settleBarT.slice(0, 10);
    const d = daily.get(day) || { day, n: 0, wins: 0, pnl: 0 };
    d.n += 1;
    if (t.won) d.wins += 1;
    d.pnl += t.pnlUsd;
    daily.set(day, d);
    equityPts.push({ t: t.settleBarT, eq: +eq.toFixed(2) });
  }

  const step = Math.max(1, Math.floor(equityPts.length / 60));
  const equityChart = equityPts.filter(
    (_, i) => i % step === 0 || i === equityPts.length - 1,
  );

  out[tag] = {
    summary: {
      period: summary.period,
      params: summary.params,
      totals: summary.totals,
      chains: summary.chains,
      breakdown: summary.breakdown,
    },
    daily: [...daily.values()].map((d) => ({
      day: d.day,
      trades: d.n,
      winRate: d.n ? +(d.wins / d.n).toFixed(3) : 0,
      pnlUsd: +d.pnl.toFixed(2),
    })),
    equityChart,
    trades: trades.map((t) => ({
      settle: t.settleBarT.replace('T', ' ').slice(0, 16),
      signal: t.signal,
      id: t.signalId,
      out: t.outcome,
      won: t.won,
      stake: t.stake,
      pnl: +t.pnlUsd.toFixed(2),
      fee: +t.feeUsd.toFixed(2),
      end: t.chainEnd || '',
      lb: t.lossesBefore,
    })),
  };

  const tot = summary.totals;
  console.log(
    `${tag} trades=${tot.trades} wr=${(tot.winRate * 100).toFixed(1)}% ` +
      `pnl=${tot.pnlUsd.toFixed(2)} dd=${tot.maxDrawdownUsd.toFixed(2)} ` +
      `halts=${summary.chains.endedHalt}`,
  );
}

writeFileSync(join(LOGS, 'backtest-btc-eth-30d-detail.json'), JSON.stringify(out));
console.log('Wrote logs/backtest-btc-eth-30d-detail.json');
