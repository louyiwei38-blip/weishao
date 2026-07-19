/**
 * From Vegas backtest trade CSVs: max consecutive loss streak + occurrence counts.
 *
 * Usage: node scripts/stats-btc-eth-1y-streaks.js
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');
const SYMBOLS = ['btc', 'eth'];
const TFS = ['5m', '15m', '1h'];

function streakStats(wonFlags) {
  const hist = new Map(); // length -> count of completed streaks of that length
  let streak = 0;
  let maxStreak = 0;
  const maxEvents = []; // { startIdx, endIdx, length }

  for (let i = 0; i < wonFlags.length; i += 1) {
    if (wonFlags[i]) {
      if (streak > 0) {
        hist.set(streak, (hist.get(streak) || 0) + 1);
        if (streak > maxStreak) {
          maxStreak = streak;
          maxEvents.length = 0;
          maxEvents.push({ startIdx: i - streak, endIdx: i - 1, length: streak });
        } else if (streak === maxStreak) {
          maxEvents.push({ startIdx: i - streak, endIdx: i - 1, length: streak });
        }
      }
      streak = 0;
    } else {
      streak += 1;
    }
  }
  if (streak > 0) {
    hist.set(streak, (hist.get(streak) || 0) + 1);
    if (streak > maxStreak) {
      maxStreak = streak;
      maxEvents.length = 0;
      maxEvents.push({
        startIdx: wonFlags.length - streak,
        endIdx: wonFlags.length - 1,
        length: streak,
      });
    } else if (streak === maxStreak) {
      maxEvents.push({
        startIdx: wonFlags.length - streak,
        endIdx: wonFlags.length - 1,
        length: streak,
      });
    }
  }

  const distribution = [...hist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([len, count]) => ({ length: len, count }));

  return {
    maxStreak,
    maxStreakOccurrences: maxEvents.length,
    maxEvents,
    distribution,
    totalLossStreaks: distribution.reduce((s, r) => s + r.count, 0),
  };
}

function loadCsv(symbol, tf) {
  const path = join(LOGS, `backtest-vegas-${symbol}-${tf}-trades.csv`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(1);
  const trades = lines.map((line) => {
    const cols = line.split(',');
    return {
      settleBarT: cols[1],
      won: cols[5] === 'true',
      lossesBefore: Number(cols[10] || 0),
    };
  });
  return trades;
}

function loadSummary(symbol, tf) {
  const path = join(LOGS, `backtest-vegas-${symbol}-${tf}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')).summary;
}

function main() {
  const rows = [];

  for (const symbol of SYMBOLS) {
    for (const tf of TFS) {
      const trades = loadCsv(symbol, tf);
      const summary = loadSummary(symbol, tf);
      if (!trades || !summary) {
        console.warn(`missing ${symbol} ${tf}`);
        continue;
      }

      const stats = streakStats(trades.map((t) => t.won));
      const maxStarts = stats.maxEvents.map((e) => ({
        start: trades[e.startIdx].settleBarT,
        end: trades[e.endIdx].settleBarT,
      }));

      // Chain-internal max (lossesBefore+1) — capped by maxLosses halt
      let chainMax = 0;
      for (const t of trades) {
        if (!t.won) chainMax = Math.max(chainMax, t.lossesBefore + 1);
      }

      const t = summary.totals;
      const row = {
        symbol: symbol.toUpperCase(),
        tf,
        period: summary.period,
        trades: t.trades,
        wins: t.wins,
        losses: t.losses,
        wr: +(t.winRate * 100).toFixed(2),
        pnl: +t.pnlUsd.toFixed(2),
        maxLossStreak: stats.maxStreak,
        maxStreakOccurrences: stats.maxStreakOccurrences,
        maxStreakWindows: maxStarts,
        chainMaxLosses: chainMax,
        distribution: stats.distribution,
        haltEnds: summary.chains?.endedHalt ?? null,
      };
      rows.push(row);

      console.log(
        `${row.symbol} ${row.tf.padEnd(3)}  笔数=${row.trades}  胜率=${row.wr}%  ` +
          `最大连亏=${row.maxLossStreak}  发生次数=${row.maxStreakOccurrences}  ` +
          `PnL=$${row.pnl}`,
      );
      for (const w of maxStarts) {
        console.log(`         └ ${w.start} → ${w.end}`);
      }
    }
  }

  // Per-symbol: merge all TF trades by settle time for shared-sequence streak
  const bySymbol = {};
  for (const symbol of SYMBOLS) {
    const all = [];
    for (const tf of TFS) {
      const trades = loadCsv(symbol, tf);
      if (!trades) continue;
      for (const t of trades) all.push({ ...t, tf });
    }
    all.sort((a, b) => a.settleBarT.localeCompare(b.settleBarT) || a.tf.localeCompare(b.tf));
    const stats = streakStats(all.map((t) => t.won));
    const maxStarts = stats.maxEvents.map((e) => ({
      start: all[e.startIdx].settleBarT,
      end: all[e.endIdx].settleBarT,
      tfHint: all[e.startIdx].tf,
    }));
    bySymbol[symbol.toUpperCase()] = {
      trades: all.length,
      wins: all.filter((t) => t.won).length,
      losses: all.filter((t) => !t.won).length,
      wr: all.length ? +((all.filter((t) => t.won).length / all.length) * 100).toFixed(2) : 0,
      maxLossStreak: stats.maxStreak,
      maxStreakOccurrences: stats.maxStreakOccurrences,
      maxStreakWindows: maxStarts,
      distribution: stats.distribution,
    };
    const s = bySymbol[symbol.toUpperCase()];
    console.log(
      `\n${symbol.toUpperCase()} 三周期合并  笔数=${s.trades}  胜率=${s.wr}%  ` +
        `最大连亏=${s.maxLossStreak}  发生次数=${s.maxStreakOccurrences}`,
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note:
      'maxLossStreak = chronological consecutive losses in trade sequence (cross-chain). ' +
      'maxStreakOccurrences = how many times a completed streak equaled that max. ' +
      'Params: base$10 ×1 maxLosses=5 fee=true classic Vegas.',
    rows,
    bySymbol,
  };
  const outPath = join(LOGS, 'backtest-btc-eth-1y-streak-stats.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
