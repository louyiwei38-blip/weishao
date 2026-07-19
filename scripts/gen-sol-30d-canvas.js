import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');
const ORDER = ['sol-5m', 'sol-15m', 'sol-1h'];
const LABELS = { 'sol-5m': 'SOL 5m', 'sol-15m': 'SOL 15m', 'sol-1h': 'SOL 1h' };

function load(tag) {
  return JSON.parse(readFileSync(join(LOGS, `backtest-vegas-${tag}.json`), 'utf8')).summary;
}

const rows = ORDER.map((k) => {
  const base = load(k);
  const filt = load(`${k}-emastack`);
  const bt = base.totals;
  const ft = filt.totals;
  return {
    key: k,
    label: LABELS[k],
    base: {
      trades: bt.trades, wins: bt.wins, losses: bt.losses,
      netWL: bt.wins - bt.losses, wr: +(bt.winRate * 100).toFixed(1),
      pnl: +bt.pnlUsd.toFixed(2), dd: +bt.maxDrawdownUsd.toFixed(2), halt: base.chains.endedHalt,
    },
    filt: {
      trades: ft.trades, wins: ft.wins, losses: ft.losses,
      netWL: ft.wins - ft.losses, wr: +(ft.winRate * 100).toFixed(1),
      pnl: +ft.pnlUsd.toFixed(2), dd: +ft.maxDrawdownUsd.toFixed(2), halt: filt.chains.endedHalt,
    },
  };
});

const sum = (pick) => {
  const a = rows.reduce((acc, r) => {
    acc.trades += r[pick].trades; acc.wins += r[pick].wins; acc.losses += r[pick].losses; acc.pnl += r[pick].pnl;
    return acc;
  }, { trades: 0, wins: 0, losses: 0, pnl: 0 });
  a.netWL = a.wins - a.losses;
  a.wr = +((a.wins / a.trades) * 100).toFixed(1);
  a.pnl = +a.pnl.toFixed(2);
  return a;
};

const baseSum = sum('base');
const filtSum = sum('filt');
const period = load('sol-1h').period;

const canvasPath = 'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/sol-30d-emastack.canvas.tsx';
const content = `import {
  BarChart, Callout, Card, CardBody, CardHeader, Grid, H1, Row, Stack, Stat, Table, Text,
} from 'cursor/canvas';

const ROWS = ${JSON.stringify(rows)} as const;
const BASE_SUM = ${JSON.stringify(baseSum)} as const;
const FILT_SUM = ${JSON.stringify(filtSum)} as const;
const META = ${JSON.stringify({
  from: period.from.slice(0, 10),
  to: period.to.slice(0, 10),
  days: period.days,
})} as const;

function fmtUsd(n: number) {
  const sign = n >= 0 ? '+' : '-';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function tonePnl(n: number): 'success' | 'danger' | undefined {
  if (n > 0) return 'success';
  if (n < 0) return 'danger';
  return undefined;
}

export default function Sol30dEmaStack() {
  const labels = ROWS.map((r) => r.label);
  const compareRows = ROWS.map((r) => [
    r.label,
    String(r.base.trades), String(r.filt.trades),
    (r.base.netWL >= 0 ? '+' : '') + r.base.netWL,
    (r.filt.netWL >= 0 ? '+' : '') + r.filt.netWL,
    r.base.wr.toFixed(1) + '%', r.filt.wr.toFixed(1) + '%',
    ((r.filt.wr - r.base.wr) >= 0 ? '+' : '') + (r.filt.wr - r.base.wr).toFixed(1) + 'pp',
    fmtUsd(r.base.pnl), fmtUsd(r.filt.pnl), fmtUsd(r.filt.pnl - r.base.pnl),
    fmtUsd(r.base.dd), fmtUsd(r.filt.dd),
  ]);
  const compareTone = ROWS.map((r) => tonePnl(r.filt.pnl - r.base.pnl));
  const wrDelta = +(FILT_SUM.wr - BASE_SUM.wr).toFixed(1);

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1200 }}>
      <Stack gap={6}>
        <H1>SOL · 近一个月维加斯回测</H1>
        <Text tone="secondary">
          {META.from} → {META.to}（{META.days} 天）· 首注 $10 ×1 · 连亏 5 · 含手续费 · 对比 EMA 堆叠过滤
        </Text>
      </Stack>

      <Callout tone="info" title="过滤规则">
        EMA144≥EMA169 只做涨；EMA144&lt;EMA169 只做跌。仅过滤入场信号。
      </Callout>

      <Grid columns={4} gap={16}>
        <Stat label="无过滤合计 PnL" value={fmtUsd(BASE_SUM.pnl)} tone={tonePnl(BASE_SUM.pnl)} />
        <Stat label="过滤后合计 PnL" value={fmtUsd(FILT_SUM.pnl)} tone={tonePnl(FILT_SUM.pnl)} />
        <Stat label="无过滤胜率" value={BASE_SUM.wr.toFixed(1) + '%'} />
        <Stat label="过滤后胜率" value={FILT_SUM.wr.toFixed(1) + '%'} tone={tonePnl(wrDelta)} />
      </Grid>

      <Row gap={16} wrap>
        <Stat label="无过滤净胜负" value={(BASE_SUM.netWL >= 0 ? '+' : '') + BASE_SUM.netWL} />
        <Stat label="过滤后净胜负" value={(FILT_SUM.netWL >= 0 ? '+' : '') + FILT_SUM.netWL} />
        <Stat label="胜率变化" value={(wrDelta >= 0 ? '+' : '') + wrDelta + 'pp'} tone={tonePnl(wrDelta)} />
        <Stat label="笔数 基→滤" value={BASE_SUM.trades + ' → ' + FILT_SUM.trades} />
      </Row>

      <Card>
        <CardHeader>PnL：无过滤 vs EMA 堆叠过滤</CardHeader>
        <CardBody>
          <BarChart
            categories={labels}
            series={[
              { name: '无过滤 PnL', data: ROWS.map((r) => r.base.pnl) },
              { name: 'EMA堆叠过滤 PnL', data: ROWS.map((r) => r.filt.pnl) },
            ]}
            height={220}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>胜率对比</CardHeader>
        <CardBody>
          <BarChart
            categories={labels}
            series={[
              { name: '无过滤胜率 %', data: ROWS.map((r) => r.base.wr) },
              { name: '过滤后胜率 %', data: ROWS.map((r) => r.filt.wr) },
            ]}
            height={200}
            valueSuffix="%"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader trailing="含胜率变化">对比明细</CardHeader>
        <CardBody style={{ padding: 0 }}>
          <Table
            headers={['实例', '笔数基', '笔数滤', '净胜基', '净胜滤', '胜率基', '胜率滤', '胜率差', 'PnL基', 'PnL滤', 'PnL差', '回撤基', '回撤滤']}
            rows={compareRows}
            rowTone={compareTone}
            columnAlign={['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
            striped stickyHeader framed
          />
        </CardBody>
      </Card>

      <Text tone="tertiary" size="small">
        logs/backtest-vegas-sol-*-trades.csv · logs/backtest-vegas-sol-*-emastack-trades.csv
      </Text>
    </Stack>
  );
}
`;

writeFileSync(canvasPath, content);
writeFileSync(join(LOGS, 'backtest-sol-30d-emastack-compare.json'), JSON.stringify({ period, baseSum, filtSum, rows }, null, 2));
console.log(JSON.stringify({ baseSum, filtSum }, null, 2));
for (const r of rows) {
  console.log(r.label, 'wr', r.base.wr, '->', r.filt.wr, 'pnl', r.base.pnl, '->', r.filt.pnl, 'net', r.base.netWL, '->', r.filt.netWL);
}
console.log('Wrote', canvasPath);