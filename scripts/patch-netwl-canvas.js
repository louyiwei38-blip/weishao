import { readFileSync, writeFileSync } from 'fs';

const p = 'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/btc-eth-30d-vegas.canvas.tsx';
let s = readFileSync(p, 'utf8');
const d = JSON.parse(readFileSync('logs/backtest-btc-eth-30d-detail.json', 'utf8'));

const overviewMatch = s.match(/const OVERVIEW = (\[.*?\]) as const;/s);
if (!overviewMatch) throw new Error('OVERVIEW not found');
const overview = JSON.parse(overviewMatch[1]);
for (const r of overview) {
  const t = d[r.key].summary.totals;
  r.wins = t.wins;
  r.losses = t.losses;
  r.netWL = t.wins - t.losses;
}
const totalNet = overview.reduce((a, r) => a + r.netWL, 0);
const totalWins = overview.reduce((a, r) => a + r.wins, 0);
const totalLosses = overview.reduce((a, r) => a + r.losses, 0);

s = s.replace(/const OVERVIEW = \[.*?\] as const;/s, `const OVERVIEW = ${JSON.stringify(overview)} as const;`);

if (!s.includes('"totalNetWL"')) {
  s = s.replace(
    /("worstDd":-?[0-9.]+)/,
    `$1,"totalWins":${totalWins},"totalLosses":${totalLosses},"totalNetWL":${totalNet}`,
  );
}

if (!s.includes('笔数净胜负')) {
  s = s.replace(
    '<Stat label="总成交笔数" value={String(META.totalTrades)} />',
    `<Stat label="总成交笔数" value={String(META.totalTrades)} />
        <Stat label="笔数净胜负" value={(META.totalNetWL >= 0 ? '+' : '') + META.totalNetWL} tone={tonePnl(META.totalNetWL)} />
        <Stat label="胜 / 负" value={META.totalWins + ' / ' + META.totalLosses} />`,
  );
}

s = s.replace(
  /headers=\{\['实例', '笔数', '胜率', 'PnL', '手续费', '最大回撤', '入场', '续单', '止损重置', 'UP wr\/pnl', 'DOWN wr\/pnl'\]\}/,
  "headers={['实例', '笔数', '胜', '负', '净胜负', '胜率', 'PnL', '手续费', '最大回撤', '入场', '续单', '止损重置']}",
);

s = s.replace(
  /const overviewRows = OVERVIEW\.map\(\(r\) => \[[\s\S]*?\]\);/,
  `const overviewRows = OVERVIEW.map((r) => [
    r.label,
    String(r.trades),
    String(r.wins),
    String(r.losses),
    (r.netWL >= 0 ? '+' : '') + r.netWL,
    fmtPct(r.wr),
    fmtUsd(r.pnl),
    fmtUsd(r.fees),
    fmtUsd(r.maxDd),
    String(r.entries),
    String(r.conts),
    String(r.halt),
  ]);`,
);

s = s.replace(
  /columnAlign=\{\['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'\]\}/,
  "columnAlign={['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}",
);

writeFileSync(p, s);
console.log('OK totalNetWL', totalNet, 'W/L', totalWins + '/' + totalLosses);
for (const r of overview) {
  console.log(r.label, r.wins, r.losses, (r.netWL >= 0 ? '+' : '') + r.netWL);
}