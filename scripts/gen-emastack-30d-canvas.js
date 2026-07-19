import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');

const ORDER = ['btc-5m', 'btc-15m', 'btc-1h', 'eth-5m', 'eth-15m', 'eth-1h'];
const LABELS = {
  'btc-5m': 'BTC 5m',
  'btc-15m': 'BTC 15m',
  'btc-1h': 'BTC 1h',
  'eth-5m': 'ETH 5m',
  'eth-15m': 'ETH 15m',
  'eth-1h': 'ETH 1h',
};

function loadSummary(tag) {
  const p = join(LOGS, `backtest-vegas-${tag}.json`);
  return JSON.parse(readFileSync(p, 'utf8')).summary;
}

const rows = ORDER.map((k) => {
  const base = loadSummary(k);
  const filt = loadSummary(`${k}-emastack`);
  const bt = base.totals;
  const ft = filt.totals;
  return {
    key: k,
    label: LABELS[k],
    base: {
      trades: bt.trades,
      wins: bt.wins,
      losses: bt.losses,
      netWL: bt.wins - bt.losses,
      wr: +(bt.winRate * 100).toFixed(1),
      pnl: +bt.pnlUsd.toFixed(2),
      dd: +bt.maxDrawdownUsd.toFixed(2),
      halt: base.chains.endedHalt,
    },
    filt: {
      trades: ft.trades,
      wins: ft.wins,
      losses: ft.losses,
      netWL: ft.wins - ft.losses,
      wr: +(ft.winRate * 100).toFixed(1),
      pnl: +ft.pnlUsd.toFixed(2),
      dd: +ft.maxDrawdownUsd.toFixed(2),
      halt: filt.chains.endedHalt,
    },
  };
});

const sum = (pick) =>
  rows.reduce(
    (a, r) => {
      a.trades += r[pick].trades;
      a.wins += r[pick].wins;
      a.losses += r[pick].losses;
      a.pnl += r[pick].pnl;
      return a;
    },
    { trades: 0, wins: 0, losses: 0, pnl: 0 },
  );

const baseSum = sum('base');
const filtSum = sum('filt');
baseSum.netWL = baseSum.wins - baseSum.losses;
filtSum.netWL = filtSum.wins - filtSum.losses;
baseSum.pnl = +baseSum.pnl.toFixed(2);
filtSum.pnl = +filtSum.pnl.toFixed(2);

const period = loadSummary('btc-1h-emastack').period;

const canvasPath =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/btc-eth-30d-emastack.canvas.tsx';

const content = `import {
  BarChart,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Grid,
  H1,
  H2,
  Row,
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

const ROWS = ${JSON.stringify(rows)} as const;
const BASE_SUM = ${JSON.stringify(baseSum)} as const;
const FILT_SUM = ${JSON.stringify(filtSum)} as const;
const META = ${JSON.stringify({
  from: period.from.slice(0, 10),
  to: period.to.slice(0, 10),
  days: period.days,
  baseBet: 10,
  mult: 1,
  maxLosses: 5,
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

export default function BtcEth30dEmaStack() {
  const labels = ROWS.map((r) => r.label);
  const pnlDelta = FILT_SUM.pnl - BASE_SUM.pnl;
  const netDelta = FILT_SUM.netWL - BASE_SUM.netWL;

  const compareRows = ROWS.map((r) => [
    r.label,
    String(r.base.trades),
    String(r.filt.trades),
    (r.base.netWL >= 0 ? '+' : '') + r.base.netWL,
    (r.filt.netWL >= 0 ? '+' : '') + r.filt.netWL,
    r.base.wr.toFixed(1) + '%',
    r.filt.wr.toFixed(1) + '%',
    fmtUsd(r.base.pnl),
    fmtUsd(r.filt.pnl),
    fmtUsd(r.filt.pnl - r.base.pnl),
    fmtUsd(r.base.dd),
    fmtUsd(r.filt.dd),
  ]);
  const compareTone = ROWS.map((r) => tonePnl(r.filt.pnl - r.base.pnl));

  const filtDetail = ROWS.map((r) => [
    r.label,
    String(r.filt.trades),
    String(r.filt.wins),
    String(r.filt.losses),
    (r.filt.netWL >= 0 ? '+' : '') + r.filt.netWL,
    r.filt.wr.toFixed(1) + '%',
    fmtUsd(r.filt.pnl),
    fmtUsd(r.filt.dd),
    String(r.filt.halt),
  ]);
  const filtTone = ROWS.map((r) => tonePnl(r.filt.pnl));

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1280 }}>
      <Stack gap={6}>
        <H1>EMA 堆叠过滤 · 近一个月回测</H1>
        <Text tone="secondary">
          {META.from} → {META.to}（{META.days} 天）· EMA144≥EMA169 只做涨 · EMA144&lt;EMA169 只做跌 · 首注 $
          {META.baseBet} ×{META.mult} · 连亏 {META.maxLosses} · 含手续费
        </Text>
      </Stack>

      <Callout tone="info" title="过滤规则">
        入场时看信号 K 的 OKX EMA：快线 ≥ 慢线只接受 VG_UP；快线 &lt; 慢线只接受 VG_DOWN。不符合同向则跳过、保持 armed。马丁续单方向已锁定，不再二次过滤。
      </Callout>

      <Grid columns={4} gap={16}>
        <Stat label="过滤后合计 PnL" value={fmtUsd(FILT_SUM.pnl)} tone={tonePnl(FILT_SUM.pnl)} />
        <Stat label="过滤后笔数净胜负" value={(FILT_SUM.netWL >= 0 ? '+' : '') + FILT_SUM.netWL} tone={tonePnl(FILT_SUM.netWL)} />
        <Stat label="vs 无过滤 PnL" value={fmtUsd(pnlDelta)} tone={tonePnl(pnlDelta)} />
        <Stat label="vs 无过滤净胜负" value={(netDelta >= 0 ? '+' : '') + netDelta} tone={tonePnl(netDelta)} />
      </Grid>

      <Row gap={16} wrap>
        <Stat label="无过滤 PnL" value={fmtUsd(BASE_SUM.pnl)} />
        <Stat label="无过滤 胜/负" value={BASE_SUM.wins + ' / ' + BASE_SUM.losses} />
        <Stat label="过滤后 胜/负" value={FILT_SUM.wins + ' / ' + FILT_SUM.losses} />
        <Stat label="过滤后笔数" value={String(FILT_SUM.trades) + ' / ' + BASE_SUM.trades} />
      </Row>

      <Card>
        <CardHeader>各实例 PnL：无过滤 vs EMA 堆叠过滤</CardHeader>
        <CardBody>
          <BarChart
            categories={labels}
            series={[
              { name: '无过滤 PnL', data: ROWS.map((r) => r.base.pnl) },
              { name: 'EMA堆叠过滤 PnL', data: ROWS.map((r) => r.filt.pnl) },
            ]}
            height={240}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>各实例笔数净胜负对比</CardHeader>
        <CardBody>
          <BarChart
            categories={labels}
            series={[
              { name: '无过滤 净胜负', data: ROWS.map((r) => r.base.netWL) },
              { name: 'EMA堆叠过滤 净胜负', data: ROWS.map((r) => r.filt.netWL) },
            ]}
            height={220}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader trailing="过滤 − 无过滤">对比明细</CardHeader>
        <CardBody style={{ padding: 0 }}>
          <Table
            headers={['实例', '笔数基', '笔数滤', '净胜基', '净胜滤', '胜率基', '胜率滤', 'PnL基', 'PnL滤', 'PnL差', '回撤基', '回撤滤']}
            rows={compareRows}
            rowTone={compareTone}
            columnAlign={['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
            striped
            stickyHeader
            framed
          />
        </CardBody>
      </Card>

      <Divider />

      <H2>过滤后明细</H2>
      <Card>
        <CardHeader>EMA 堆叠过滤 · 各实例</CardHeader>
        <CardBody style={{ padding: 0 }}>
          <Table
            headers={['实例', '笔数', '胜', '负', '净胜负', '胜率', 'PnL', '最大回撤', '止损重置']}
            rows={filtDetail}
            rowTone={filtTone}
            columnAlign={['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
            striped
            stickyHeader
            framed
          />
        </CardBody>
      </Card>

      <Text tone="tertiary" size="small">
        输出：logs/backtest-vegas-*-emastack.json / *-emastack-trades.csv · 命令：--emaStackFilter=true
      </Text>
    </Stack>
  );
}
`;

writeFileSync(canvasPath, content);
writeFileSync(
  join(LOGS, 'backtest-btc-eth-30d-emastack-compare.json'),
  JSON.stringify({ period, baseSum, filtSum, rows }, null, 2),
);
console.log('filt PnL', filtSum.pnl, 'netWL', filtSum.netWL, 'vs base', baseSum.pnl, baseSum.netWL);
console.log('Wrote', canvasPath);