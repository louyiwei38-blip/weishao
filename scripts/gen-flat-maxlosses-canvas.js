import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dirname, '..', 'logs', 'backtest-flat-maxlosses-compare.json'), 'utf8'),
);

function usd2(n) {
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

const MLS = [1, 2, 3, 4];

const grandRows = MLS.map((ml) => {
  const g = data.grand[ml];
  return [String(ml), String(g.trades), pct(g.winRate), usd2(g.pnlUsd), usd2(g.maxDrawdownUsd)];
});

const symbolRows = [];
for (const s of data.bySymbol) {
  for (const ml of MLS) {
    const r = s.byMax[ml];
    symbolRows.push([
      s.symbol,
      String(ml),
      String(r.trades),
      pct(r.winRate),
      usd2(r.pnlUsd),
      usd2(r.maxDrawdownUsd),
    ]);
  }
}

const instanceRows = [];
for (const i of data.instances) {
  for (const ml of MLS) {
    const r = i.byMax[ml];
    instanceRows.push([
      `${i.symbol} ${i.tf}`,
      String(ml),
      String(r.trades),
      pct(r.winRate),
      usd2(r.pnlUsd),
      usd2(r.maxDrawdownUsd),
    ]);
  }
}

const cats = ['L1', 'L2', 'L3', 'L4'];
const pnlSeries = MLS.map((ml) => Math.round(data.grand[ml].pnlUsd));
const wrSeries = MLS.map((ml) => Math.round(data.grand[ml].winRate * 10000) / 100);
const nSeries = MLS.map((ml) => data.grand[ml].trades);

const content = `import {
  BarChart,
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

export default function FlatMaxLossesCompare() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>马丁倍数 x1 · 连亏次数 1–4</H1>
        <Text tone="secondary">
          固定注 $3（倍数=1）· 入场 0.50 · 含手续费 · OKX Vegas。改的是连亏 halt 上限（maxLosses）；交易序列会随之变化（全量缓存重跑）。
        </Text>
        <Row gap={8}>
          <Pill tone="neutral">mult=1</Pill>
          <Pill tone="info">maxLosses 1–4</Pill>
          <Pill tone="neutral">base $3</Pill>
        </Row>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat label="L1 合计 PnL" value="${usd2(data.grand[1].pnlUsd)}" />
        <Stat label="L2 合计 PnL" value="${usd2(data.grand[2].pnlUsd)}" tone="info" />
        <Stat label="L3 合计 PnL" value="${usd2(data.grand[3].pnlUsd)}" tone="success" />
        <Stat label="L4 合计 PnL" value="${usd2(data.grand[4].pnlUsd)}" tone="success" />
      </Grid>

      <Callout tone="info" title="结论">
        倍数=1 时，允许的连亏续单次数越多，笔数与胜率越高，总利润也越高（L1 ≈打平 → L4 +$25k）。
        因为赢率略高于 50%，多续几单能多兑现正期望；回撤仍很小（全程 $3）。
      </Callout>

      <Stack gap={8}>
        <H2>七标的合计 PnL by maxLosses</H2>
        <BarChart
          categories={${JSON.stringify(cats)}}
          series={[{ name: 'PnL (USD)', data: ${JSON.stringify(pnlSeries)}, tone: 'success' }]}
          height={220}
        />
      </Stack>

      <Stack gap={8}>
        <H2>合计胜率 (%) by maxLosses</H2>
        <BarChart
          categories={${JSON.stringify(cats)}}
          series={[{ name: 'Win rate %', data: ${JSON.stringify(wrSeries)}, tone: 'info' }]}
          height={200}
          valueSuffix="%"
        />
      </Stack>

      <Stack gap={8}>
        <H2>合计笔数 by maxLosses</H2>
        <BarChart
          categories={${JSON.stringify(cats)}}
          series={[{ name: 'Trades', data: ${JSON.stringify(nSeries)} }]}
          height={200}
        />
      </Stack>

      <Divider />

      <Stack gap={8}>
        <H2>七标的合计</H2>
        <Table
          headers={['maxLosses', '笔数', '胜率', 'PnL', '最差DD']}
          rows={${JSON.stringify(grandRows)}}
        />
      </Stack>

      <Stack gap={8}>
        <H2>按标的（三周期合计）</H2>
        <Table
          headers={['标的', 'maxLosses', '笔数', '胜率', 'PnL', '最差DD']}
          rows={${JSON.stringify(symbolRows)}}
        />
      </Stack>

      <Stack gap={8}>
        <H2>分实例明细</H2>
        <Table
          headers={['实例', 'maxLosses', '笔数', '胜率', 'PnL', 'DD']}
          rows={${JSON.stringify(instanceRows)}}
        />
      </Stack>

      <Callout tone="neutral" title="说明">
        L1：首亏即 halt，几乎无 MG 续单。L4：最多连亏 4 次后 halt。全程注码固定 $3。
      </Callout>
    </Stack>
  );
}
`;

const out =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/flat-maxlosses-compare.canvas.tsx';
writeFileSync(out, content, 'utf8');
console.log('Wrote', out);
