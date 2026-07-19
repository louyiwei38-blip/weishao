import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');
const TFS = ['5m', '15m', '1h'];

function load(tag) {
  return JSON.parse(readFileSync(join(LOGS, `backtest-vegas-${tag}.json`), 'utf8')).summary;
}

const rows = TFS.map((tf) => {
  const classic = load(`btc-${tf}`);
  const p5 = load(`btc-${tf}-p5`);
  const ct = classic.totals;
  const pt = p5.totals;
  return {
    label: `BTC ${tf}`,
    classic: {
      trades: ct.trades, wr: +(ct.winRate * 100).toFixed(1),
      netWL: ct.netWL ?? ct.wins - ct.losses,
      wins: ct.wins, losses: ct.losses,
      pnl: +ct.pnlUsd.toFixed(2), dd: +ct.maxDrawdownUsd.toFixed(2),
      maxLossStreak: ct.maxLossStreak ?? null,
      chains: classic.chains.started,
    },
    p5: {
      trades: pt.trades, wr: +(pt.winRate * 100).toFixed(1),
      netWL: pt.netWL, wins: pt.wins, losses: pt.losses,
      pnl: +pt.pnlUsd.toFixed(2), dd: +pt.maxDrawdownUsd.toFixed(2),
      maxLossStreak: pt.maxLossStreak,
      chains: p5.chains.started,
      completed: p5.chains.completed,
      netPlusChains: p5.chains.endedWin,
      maxConcurrent: p5.chains.maxConcurrent,
    },
  };
});

const sum = (key) => {
  const a = rows.reduce((acc, r) => {
    acc.trades += r[key].trades; acc.wins += r[key].wins; acc.losses += r[key].losses; acc.pnl += r[key].pnl;
    return acc;
  }, { trades: 0, wins: 0, losses: 0, pnl: 0 });
  a.netWL = a.wins - a.losses;
  a.wr = +((a.wins / a.trades) * 100).toFixed(1);
  a.pnl = +a.pnl.toFixed(2);
  a.maxLossStreak = Math.max(...rows.map((r) => r[key].maxLossStreak || 0));
  return a;
};

const classicSum = sum('classic');
const p5Sum = sum('p5');
const period = load('btc-1h-p5').period;

const canvasPath = 'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/btc-30d-parallel5.canvas.tsx';
const content = `import {
  BarChart, Callout, Card, CardBody, CardHeader, Grid, H1, Stack, Stat, Table, Text,
} from 'cursor/canvas';

const ROWS = ${JSON.stringify(rows)} as const;
const CLASSIC = ${JSON.stringify(classicSum)} as const;
const P5 = ${JSON.stringify(p5Sum)} as const;
const META = ${JSON.stringify({
  from: period.from.slice(0, 10),
  to: period.to.slice(0, 10),
  days: period.days,
})} as const;

function fmtUsd(n: number) {
  const sign = n >= 0 ? '+' : '-';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function tone(n: number): 'success' | 'danger' | undefined {
  if (n > 0) return 'success';
  if (n < 0) return 'danger';
  return undefined;
}

export default function Btc30dParallel5() {
  const labels = ROWS.map((r) => r.label);
  const detail = ROWS.map((r) => [
    r.label,
    String(r.classic.trades), String(r.p5.trades),
    r.classic.wr.toFixed(1) + '%', r.p5.wr.toFixed(1) + '%',
    (r.classic.netWL >= 0 ? '+' : '') + r.classic.netWL,
    (r.p5.netWL >= 0 ? '+' : '') + r.p5.netWL,
    String(r.classic.maxLossStreak ?? '-'), String(r.p5.maxLossStreak),
    fmtUsd(r.classic.pnl), fmtUsd(r.p5.pnl),
    String(r.p5.chains), String(r.p5.maxConcurrent),
  ]);
  const detailTone = ROWS.map((r) => tone(r.p5.pnl));

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1200 }}>
      <Stack gap={6}>
        <H1>BTC · 并行固定5把 vs 赢停 · 近一个月</H1>
        <Text tone="secondary">
          {META.from} → {META.to}（{META.days} 天）· 首注 $10 固定 · 入场 0.50 · 含手续费 · 无 EMA 堆叠过滤
        </Text>
      </Stack>

      <Callout tone="info" title="新策略规则">
        有信号即锁方向打满 5 把（赢不提前停）。入场检测持续运行：链路中出现新信号则另开一条独立 5 把链路，新老链路互不干扰，同一结算窗可叠加多注。
      </Callout>

      <Grid columns={4} gap={16}>
        <Stat label="并行5把合计 PnL" value={fmtUsd(P5.pnl)} tone={tone(P5.pnl)} />
        <Stat label="并行5把笔胜率" value={P5.wr.toFixed(1) + '%'} />
        <Stat label="并行5把净胜负" value={(P5.netWL >= 0 ? '+' : '') + P5.netWL} tone={tone(P5.netWL)} />
        <Stat label="并行5把最大连败峰值" value={String(P5.maxLossStreak)} tone="danger" />
      </Grid>

      <Grid columns={4} gap={16}>
        <Stat label="赢停合计 PnL" value={fmtUsd(CLASSIC.pnl)} tone={tone(CLASSIC.pnl)} />
        <Stat label="赢停笔胜率" value={CLASSIC.wr.toFixed(1) + '%'} />
        <Stat label="赢停净胜负" value={(CLASSIC.netWL >= 0 ? '+' : '') + CLASSIC.netWL} />
        <Stat label="赢停最大连败峰值" value={String(CLASSIC.maxLossStreak)} />
      </Grid>

      <Card>
        <CardHeader>PnL 对比</CardHeader>
        <CardBody>
          <BarChart
            categories={labels}
            series={[
              { name: '赢停 PnL', data: ROWS.map((r) => r.classic.pnl) },
              { name: '并行5把 PnL', data: ROWS.map((r) => r.p5.pnl) },
            ]}
            height={220}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>笔胜率 / 净胜负 / 最大连败</CardHeader>
        <CardBody>
          <BarChart
            categories={labels}
            series={[
              { name: '并行5把胜率%', data: ROWS.map((r) => r.p5.wr) },
              { name: '并行5把净胜负', data: ROWS.map((r) => r.p5.netWL) },
              { name: '并行5把最大连败', data: ROWS.map((r) => r.p5.maxLossStreak) },
            ]}
            height={220}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader trailing="classic vs parallelFixed5">明细</CardHeader>
        <CardBody style={{ padding: 0 }}>
          <Table
            headers={['实例', '笔数赢停', '笔数p5', '胜率赢停', '胜率p5', '净胜赢停', '净胜p5', '连败赢停', '连败p5', 'PnL赢停', 'PnLp5', '链路数', '最大并发']}
            rows={detail}
            rowTone={detailTone}
            columnAlign={['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
            striped stickyHeader framed
          />
        </CardBody>
      </Card>

      <Text tone="tertiary" size="small">
        命令：--chainMode=parallelFixed --fixedBets=5 · 输出：logs/backtest-vegas-btc-*-p5.json
      </Text>
    </Stack>
  );
}
`;

writeFileSync(canvasPath, content);
writeFileSync(join(LOGS, 'backtest-btc-30d-p5-compare.json'), JSON.stringify({ period, classicSum, p5Sum, rows }, null, 2));
console.log(JSON.stringify({ classicSum, p5Sum }, null, 2));
for (const r of rows) {
  console.log(r.label, 'p5 wr', r.p5.wr, 'net', r.p5.netWL, 'streak', r.p5.maxLossStreak, 'pnl', r.p5.pnl, 'concurr', r.p5.maxConcurrent);
}
console.log('Wrote', canvasPath);