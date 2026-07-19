import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS = join(__dirname, '..', 'logs');
const data = JSON.parse(readFileSync(join(LOGS, 'backtest-btc-eth-1y-streak-stats.json'), 'utf8'));

const rows = data.rows.map((r) => ({
  label: `${r.symbol} ${r.tf}`,
  symbol: r.symbol,
  tf: r.tf,
  trades: r.trades,
  wr: r.wr,
  pnl: r.pnl,
  maxLossStreak: r.maxLossStreak,
  maxOcc: r.maxStreakOccurrences,
  windows: r.maxStreakWindows.map((w) => ({
    start: w.start.slice(0, 16).replace('T', ' '),
    end: w.end.slice(0, 16).replace('T', ' '),
  })),
  dist: r.distribution,
  haltEnds: r.haltEnds,
}));

const by = data.bySymbol;
const bySymbol = {
  BTC: {
    trades: by.BTC.trades,
    wr: by.BTC.wr,
    max: by.BTC.maxLossStreak,
    occ: by.BTC.maxStreakOccurrences,
    dist: by.BTC.distribution,
  },
  ETH: {
    trades: by.ETH.trades,
    wr: by.ETH.wr,
    max: by.ETH.maxLossStreak,
    occ: by.ETH.maxStreakOccurrences,
    dist: by.ETH.distribution,
  },
};

const content = `import {
  BarChart, Callout, Card, CardBody, CardHeader, Grid, H1, H2, Stack, Stat, Table, Text, Pill, Row,
} from 'cursor/canvas';

const ROWS = ${JSON.stringify(rows)} as const;
const BY_SYMBOL = ${JSON.stringify(bySymbol)} as const;
const META = {
  from: '2025-07-17',
  to: '2026-07-17',
  days: 365,
  params: '$10 x1 · maxLosses=5 · classic Vegas · fee=true',
} as const;

function usd(n: number) {
  const s = Math.abs(n).toFixed(2);
  return n >= 0 ? '+$' + s : '-$' + s;
}

export default function BtcEth1yStreaks() {
  const tableRows = ROWS.map((r) => [
    r.label,
    String(r.trades),
    r.wr.toFixed(2) + '%',
    usd(r.pnl),
    String(r.maxLossStreak),
    String(r.maxOcc),
    String(r.haltEnds),
  ]);

  const eventRows: string[][] = [];
  for (const r of ROWS) {
    for (const w of r.windows) {
      eventRows.push([r.label, String(r.maxLossStreak), w.start, w.end]);
    }
  }

  const maxLen = Math.max(...ROWS.map((r) => r.maxLossStreak));
  const streakLens = Array.from({ length: maxLen }, (_, i) => i + 1);
  const chartSeries = [
    {
      name: 'BTC 5m',
      data: streakLens.map((L) => ROWS[0].dist.find((d) => d.length === L)?.count ?? 0),
    },
    {
      name: 'ETH 5m',
      data: streakLens.map((L) => ROWS[3].dist.find((d) => d.length === L)?.count ?? 0),
    },
  ];

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1100 }}>
      <Stack gap={6}>
        <H1>BTC / ETH · 近一年 · 最大连亏统计</H1>
        <Text tone="secondary">
          {META.from} → {META.to}（{META.days} 天）· {META.params}
        </Text>
        <Row gap={8}>
          <Pill tone="info">OKX Vegas</Pill>
          <Pill tone="neutral">5m / 15m / 1h</Pill>
          <Pill tone="neutral">跨链路连续亏损</Pill>
        </Row>
      </Stack>

      <Callout tone="neutral" title="口径">
        最大连亏 = 按结算时间顺序，连续亏损笔数的峰值（跨链路累计，可超过 maxLosses=5）。
        发生次数 = 完整连亏段长度恰好等于该峰值的次数。单链路内因 halt 上限，chainMax 恒为 5。
      </Callout>

      <Grid columns={4} gap={12}>
        <Stat label="BTC 峰值连亏（单周期）" value="11" tone="danger" />
        <Stat label="ETH 峰值连亏（单周期）" value="12" tone="danger" />
        <Stat
          label="BTC 三周期合并峰值"
          value={String(BY_SYMBOL.BTC.max) + ' x' + BY_SYMBOL.BTC.occ}
        />
        <Stat
          label="ETH 三周期合并峰值"
          value={String(BY_SYMBOL.ETH.max) + ' x' + BY_SYMBOL.ETH.occ}
        />
      </Grid>

      <Card>
        <CardHeader>各实例：最大连亏 & 发生次数</CardHeader>
        <CardBody>
          <Table
            headers={['实例', '笔数', '胜率', 'PnL', '最大连亏', '发生次数', 'halt次数']}
            rows={tableRows}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>最大连亏发生窗口（UTC）</CardHeader>
        <CardBody>
          <Table headers={['实例', '连亏笔数', '开始', '结束']} rows={eventRows} />
        </CardBody>
      </Card>

      <Stack gap={8}>
        <H2>5m 连亏长度分布（次数）</H2>
        <Text tone="secondary" size="small">
          X = 连亏长度（笔）· Y = 发生次数 · Source: OKX Vegas backtest · last 365 days
        </Text>
        <BarChart categories={streakLens.map(String)} series={chartSeries} height={260} />
      </Stack>

      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader>BTC 三周期合并分布（≥5）</CardHeader>
          <CardBody>
            <Table
              headers={['连亏长度', '次数']}
              rows={BY_SYMBOL.BTC.dist
                .filter((d) => d.length >= 5)
                .map((d) => [String(d.length), String(d.count)])}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>ETH 三周期合并分布（≥5）</CardHeader>
          <CardBody>
            <Table
              headers={['连亏长度', '次数']}
              rows={BY_SYMBOL.ETH.dist
                .filter((d) => d.length >= 5)
                .map((d) => [String(d.length), String(d.count)])}
            />
          </CardBody>
        </Card>
      </Grid>
    </Stack>
  );
}
`;

const out =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/btc-eth-1y-streaks.canvas.tsx';
writeFileSync(out, content, 'utf8');
console.log('Wrote', out);
