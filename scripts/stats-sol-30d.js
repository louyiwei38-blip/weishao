import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');
const TFS = ['5m', '15m', '1h'];

const rows = [];
for (const tf of TFS) {
  const summary = JSON.parse(
    readFileSync(join(LOGS, `backtest-vegas-sol-${tf}.json`), 'utf8'),
  ).summary;
  const lines = readFileSync(join(LOGS, `backtest-vegas-sol-${tf}-trades.csv`), 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1);

  let streak = 0;
  let maxStreak = 0;
  let maxEnd = null;
  let maxStart = null;
  let curStart = null;
  // Also track max consecutive losses within a single chain (lossesBefore+1 at halt or during)
  let chainMax = 0;

  for (const line of lines) {
    const cols = line.split(',');
    const settleBarT = cols[1];
    const won = cols[5] === 'true';
    const lossesBefore = Number(cols[10] || 0);
    if (won) {
      streak = 0;
      curStart = null;
    } else {
      if (streak === 0) curStart = settleBarT;
      streak += 1;
      if (streak > maxStreak) {
        maxStreak = streak;
        maxStart = curStart;
        maxEnd = settleBarT;
      }
      const chainLen = lossesBefore + 1;
      if (chainLen > chainMax) chainMax = chainLen;
    }
  }

  const t = summary.totals;
  const net = t.wins - t.losses;
  const row = {
    label: `SOL ${tf}`,
    tf,
    trades: t.trades,
    wins: t.wins,
    losses: t.losses,
    wr: +(t.winRate * 100).toFixed(1),
    netWL: net,
    maxLossStreak: maxStreak,
    maxLossStreakStart: maxStart,
    maxLossStreakEnd: maxEnd,
    maxChainLosses: chainMax,
    pnl: +t.pnlUsd.toFixed(2),
    period: summary.period,
  };
  rows.push(row);
  console.log(
    `${row.label}  笔数=${row.trades}  胜率=${row.wr}%  (${row.wins}W/${row.losses}L)  净胜负=${row.netWL >= 0 ? '+' : ''}${row.netWL}  最大连败=${row.maxLossStreak}`,
  );
}

const tw = rows.reduce((s, r) => s + r.wins, 0);
const tl = rows.reduce((s, r) => s + r.losses, 0);
const tt = tw + tl;
const total = {
  label: 'SOL 合计',
  trades: tt,
  wins: tw,
  losses: tl,
  wr: +((tw / tt) * 100).toFixed(1),
  netWL: tw - tl,
  maxLossStreak: Math.max(...rows.map((r) => r.maxLossStreak)),
  pnl: +rows.reduce((s, r) => s + r.pnl, 0).toFixed(2),
};
console.log(
  `${total.label}  笔数=${total.trades}  胜率=${total.wr}%  (${total.wins}W/${total.losses}L)  净胜负=${total.netWL >= 0 ? '+' : ''}${total.netWL}  各周期最大连败峰值=${total.maxLossStreak}`,
);

writeFileSync(join(LOGS, 'backtest-sol-30d-wl-stats.json'), JSON.stringify({ rows, total }, null, 2));

// canvas
const period = rows[0].period;
const canvasPath =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/sol-30d-wl-stats.canvas.tsx';
const content = `import {
  BarChart, Callout, Card, CardBody, CardHeader, Grid, H1, Stack, Stat, Table, Text,
} from 'cursor/canvas';

const ROWS = ${JSON.stringify(rows)} as const;
const TOTAL = ${JSON.stringify(total)} as const;
const META = ${JSON.stringify({
  from: period.from.slice(0, 10),
  to: period.to.slice(0, 10),
  days: period.days,
})} as const;

function tonePnl(n: number): 'success' | 'danger' | undefined {
  if (n > 0) return 'success';
  if (n < 0) return 'danger';
  return undefined;
}

export default function Sol30dWlStats() {
  const tableRows = ROWS.map((r) => [
    r.label,
    String(r.trades),
    String(r.wins),
    String(r.losses),
    r.wr.toFixed(1) + '%',
    (r.netWL >= 0 ? '+' : '') + r.netWL,
    String(r.maxLossStreak),
  ]);
  const tableTone = ROWS.map((r) => tonePnl(r.netWL));
  tableRows.push([
    TOTAL.label,
    String(TOTAL.trades),
    String(TOTAL.wins),
    String(TOTAL.losses),
    TOTAL.wr.toFixed(1) + '%',
    (TOTAL.netWL >= 0 ? '+' : '') + TOTAL.netWL,
    String(TOTAL.maxLossStreak) + ' (峰值)',
  ]);
  tableTone.push(tonePnl(TOTAL.netWL));

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 960 }}>
      <Stack gap={6}>
        <H1>SOL · 近一个月 · 笔胜率 / 净胜负 / 最大连败</H1>
        <Text tone="secondary">
          {META.from} → {META.to}（{META.days} 天）· 无 EMA 过滤 · 首注 $10 ×1 · 连亏上限 5 · 含手续费
        </Text>
      </Stack>

      <Callout tone="neutral" title="统计说明">
        笔胜率 = 赢笔 / 总笔；净胜负 = 胜笔 − 负笔；最大连败 = 按结算时间顺序连续亏损的最长笔数（跨链路累计）。
      </Callout>

      <Grid columns={4} gap={16}>
        <Stat label="合计笔胜率" value={TOTAL.wr.toFixed(1) + '%'} />
        <Stat label="合计净胜负" value={(TOTAL.netWL >= 0 ? '+' : '') + TOTAL.netWL} tone={tonePnl(TOTAL.netWL)} />
        <Stat label="胜 / 负" value={TOTAL.wins + ' / ' + TOTAL.losses} />
        <Stat label="各周期最大连败峰值" value={String(TOTAL.maxLossStreak)} tone="danger" />
      </Grid>

      <Card>
        <CardHeader>笔胜率</CardHeader>
        <CardBody>
          <BarChart
            categories={ROWS.map((r) => r.label)}
            series={[{ name: '胜率 %', data: ROWS.map((r) => r.wr) }]}
            height={200}
            valueSuffix="%"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>净胜负 / 最大连败</CardHeader>
        <CardBody>
          <BarChart
            categories={ROWS.map((r) => r.label)}
            series={[
              { name: '净胜负（笔）', data: ROWS.map((r) => r.netWL) },
              { name: '最大连败（笔）', data: ROWS.map((r) => r.maxLossStreak) },
            ]}
            height={220}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>明细</CardHeader>
        <CardBody style={{ padding: 0 }}>
          <Table
            headers={['实例', '笔数', '胜', '负', '笔胜率', '净胜负', '最大连败']}
            rows={tableRows}
            rowTone={tableTone}
            columnAlign={['left', 'right', 'right', 'right', 'right', 'right', 'right']}
            striped stickyHeader framed
          />
        </CardBody>
      </Card>

      <Text tone="tertiary" size="small">
        Source: logs/backtest-vegas-sol-{'{5m|15m|1h}'}-trades.csv · 无 emaStackFilter
      </Text>
    </Stack>
  );
}
`;

// fix footer braces for JSX
const contentFixed = content.replace(
  "logs/backtest-vegas-sol-{'{5m|15m|1h}'}-trades.csv",
  'logs/backtest-vegas-sol-TF-trades.csv（TF=5m/15m/1h）',
);
writeFileSync(canvasPath, contentFixed);
console.log('Wrote', canvasPath);