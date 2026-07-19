import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const monthly = JSON.parse(
  readFileSync(join(__dirname, '..', 'logs', 'backtest-vegas-hype-doge-monthly-combined.json'), 'utf8'),
);
const summary = JSON.parse(
  readFileSync(join(__dirname, '..', 'logs', 'backtest-vegas-hype-doge-summary.json'), 'utf8'),
);

const canvasPath =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/hype-doge-vegas-backtest.canvas.tsx';

const content = `import {
  BarChart,
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  LineChart,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

const MONTHLY = ${JSON.stringify(monthly)} as const;
const SUMMARY = ${JSON.stringify(summary)} as const;

function fmtUsd(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return (
    sign +
    '$' +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function pct(n: number) {
  return (n * 100).toFixed(1) + '%';
}

export default function HypeDogeVegasBacktest() {
  const categories = MONTHLY.map((m) => m.month);
  const equity = MONTHLY.map((m) => m.cum);
  const monthPnl = MONTHLY.map((m) => m.pnl);
  const dogeMonth = MONTHLY.map(
    (m) => (m.cols.DOGE_5m || 0) + (m.cols.DOGE_15m || 0) + (m.cols.DOGE_1h || 0),
  );
  const hypeSlice = MONTHLY.filter(
    (m) => m.cols.HYPE_5m != null || m.cols.HYPE_15m != null || m.cols.HYPE_1h != null,
  );
  const hypeCats = hypeSlice.map((m) => m.month);
  const hypeMonth = hypeSlice.map(
    (m) => (m.cols.HYPE_5m || 0) + (m.cols.HYPE_15m || 0) + (m.cols.HYPE_1h || 0),
  );

  const instanceRows = SUMMARY.instances.map((i) => [
    i.symbol + ' ' + i.tf,
    i.trades.toLocaleString(),
    pct(i.winRate),
    fmtUsd(i.pnlUsd),
    fmtUsd(i.maxDrawdownUsd),
    i.period.from.slice(0, 10) + ' → ' + i.period.to.slice(0, 10),
  ]);

  const monthlyRows = MONTHLY.map((m) => [
    m.month,
    m.trades.toLocaleString(),
    fmtUsd(m.cols.DOGE_5m),
    fmtUsd(m.cols.DOGE_15m),
    fmtUsd(m.cols.DOGE_1h),
    fmtUsd(m.cols.HYPE_5m),
    fmtUsd(m.cols.HYPE_15m),
    fmtUsd(m.cols.HYPE_1h),
    fmtUsd(m.pnl),
    fmtUsd(m.cum),
  ]);
  const rowTone = MONTHLY.map((m) => (m.pnl >= 0 ? ('success' as const) : ('danger' as const)));

  const posMonths = MONTHLY.filter((m) => m.pnl > 0).length;

  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <H1>HYPE / DOGE Vegas 回测（逐月）</H1>
        <Text tone="secondary">
          OKX USDT 永续 · EMA144/169 · 首注 $3 ×3 · 连亏 5 · 入场 0.50 · 含手续费 · 请求自 2020-01-01 至今
        </Text>
        <Row gap={8} wrap>
          <Pill tone="info">DOGE 有效约 2020-07 起</Pill>
          <Pill tone="info">HYPE 有效约 2025-02 起</Pill>
          <Pill>盈利月 {posMonths}/{MONTHLY.length}</Pill>
        </Row>
      </Stack>

      <Grid columns={4} gap={12}>
        <Stat
          label="六路合计盈亏"
          value={fmtUsd(SUMMARY.combined.pnlUsd)}
          tone={SUMMARY.combined.pnlUsd >= 0 ? 'success' : 'danger'}
        />
        <Stat
          label="DOGE 三周期"
          value={fmtUsd(SUMMARY.combined.bySymbol.DOGE)}
          tone="success"
        />
        <Stat
          label="HYPE 三周期"
          value={fmtUsd(SUMMARY.combined.bySymbol.HYPE)}
          tone={SUMMARY.combined.bySymbol.HYPE >= 0 ? 'success' : 'danger'}
        />
        <Stat label="总成交笔数" value={SUMMARY.combined.trades.toLocaleString()} />
      </Grid>

      <Callout tone="info" title="数据起点说明">
        OKX 永续上市前无 K 线：DOGE-USDT-SWAP 约 2020-07 起有完整数据；HYPE-USDT-SWAP listTime ≈
        2025-02-21。回测请求区间为 2020-01-01 → 今，实际从各标的有效 K 线 + OKX EMA 对齐后开始。
      </Callout>

      <H2>各实例汇总</H2>
      <Table
        headers={['实例', '笔数', '胜率', '盈亏', '最大回撤', '有效区间']}
        columnAlign={['left', 'right', 'right', 'right', 'right', 'left']}
        rows={instanceRows}
        striped
      />

      <H2>累计权益曲线（六路合计）</H2>
      <Text tone="secondary" size="small">
        Source: OKX swap OHLCV + OKX EMA144/169 · Y 轴 USD
      </Text>
      <LineChart
        categories={categories}
        series={[{ name: '累计盈亏 (USD)', data: equity, tone: 'info' }]}
        height={220}
        fill
      />

      <H2>月度盈亏柱状图（六路合计）</H2>
      <BarChart
        categories={categories}
        series={[{ name: '月盈亏 (USD)', data: monthPnl }]}
        height={200}
      />

      <H2>DOGE 月盈亏（5m+15m+1h）</H2>
      <LineChart
        categories={categories}
        series={[{ name: 'DOGE 月 PnL (USD)', data: dogeMonth, tone: 'success' }]}
        height={180}
      />

      <H2>HYPE 月盈亏（5m+15m+1h）</H2>
      <LineChart
        categories={hypeCats}
        series={[{ name: 'HYPE 月 PnL (USD)', data: hypeMonth, tone: 'warning' }]}
        height={180}
      />

      <Divider />
      <H2>逐月明细表</H2>
      <Text tone="secondary" size="small">
        单位 USD；— 表示该月尚无该标的数据。月合计 = 六路当月盈亏之和；累计为六路合计滚动。
      </Text>
      <Table
        headers={[
          '月份',
          '笔数',
          'DOGE 5m',
          'DOGE 15m',
          'DOGE 1h',
          'HYPE 5m',
          'HYPE 15m',
          'HYPE 1h',
          '月合计',
          '累计',
        ]}
        columnAlign={[
          'left',
          'right',
          'right',
          'right',
          'right',
          'right',
          'right',
          'right',
          'right',
          'right',
        ]}
        rows={monthlyRows}
        rowTone={rowTone}
        striped
        stickyHeader
        style={{ maxHeight: 520 }}
      />
    </Stack>
  );
}
`;

writeFileSync(canvasPath, content);
console.log(`Wrote ${canvasPath} (${monthly.length} months)`);
