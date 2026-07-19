import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dirname, '..', 'logs', 'backtest-mult-compare.json'), 'utf8'),
);

function usd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${n >= 0 ? '+' : '-'}$${s}`;
}
function usd2(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n >= 0 ? '+' : '-'}$${s}`;
}
function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

const symbolRows = data.bySymbol.map((r) => [
  r.symbol,
  usd2(r.mult3.pnlUsd),
  usd2(r.mult2.pnlUsd),
  usd2(r.deltaPnl),
  usd2(r.mult3.maxDrawdownUsd),
  usd2(r.mult2.maxDrawdownUsd),
  `$${r.mult3.maxStakeUsd}`,
  `$${r.mult2.maxStakeUsd}`,
]);

const instanceRows = data.instances.map((i) => [
  `${i.symbol} ${i.tf}`,
  String(i.trades),
  pct(i.winRate),
  usd2(i.mult3.pnlUsd),
  usd2(i.mult2.pnlUsd),
  usd2(i.deltaPnl),
  usd2(i.mult3.maxDrawdownUsd),
  usd2(i.mult2.maxDrawdownUsd),
]);

const cats = data.bySymbol.map((r) => r.symbol);
const pnl3 = data.bySymbol.map((r) => Math.round(r.mult3.pnlUsd));
const pnl2 = data.bySymbol.map((r) => Math.round(r.mult2.pnlUsd));
const dd3 = data.bySymbol.map((r) => Math.round(Math.abs(r.mult3.maxDrawdownUsd)));
const dd2 = data.bySymbol.map((r) => Math.round(Math.abs(r.mult2.maxDrawdownUsd)));
const g = data.grand;

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

export default function MartingaleMultCompare() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>马丁倍数 x3 vs x2 回测对比</H1>
        <Text tone="secondary">
          规则不变：$3 首注 · 连亏 5 重置 · 入场 0.50 · 含手续费 · OKX Vegas。仅改倍数；胜负序列来自既有成交 CSV 重放。
        </Text>
        <Row gap={8}>
          <Pill tone="neutral">base $3</Pill>
          <Pill tone="info">x3 原回测</Pill>
          <Pill tone="success">x2 重放</Pill>
          <Pill tone="neutral">maxLosses 5</Pill>
        </Row>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat label="七标的合计 x3" value="${usd(g.mult3.pnlUsd)}" tone="success" />
        <Stat label="七标的合计 x2" value="${usd(g.mult2.pnlUsd)}" tone="info" />
        <Stat label="PnL 差额 (x2-x3)" value="${usd(g.deltaPnl)}" tone="danger" />
        <Stat
          label="最差单标的回撤"
          value="x3 ${usd(g.mult3.maxDrawdownUsd)} → x2 ${usd(g.mult2.maxDrawdownUsd)}"
        />
      </Grid>

      <Callout tone="info" title="结论">
        改成 x2 后总利润约降到原来的 1/3（${usd2(g.mult3.pnlUsd)} → ${usd2(g.mult2.pnlUsd)}），
        但最大回撤与单笔上限同步大幅下降（最高注 $243 → $48）。盈利标的利润变薄；亏损标的（XRP 5m / BNB 5m / HYPE）亏损明显收窄。
      </Callout>

      <Stack gap={8}>
        <H2>各标的三周期合计 PnL (USD)</H2>
        <BarChart
          categories={${JSON.stringify(cats)}}
          series={[
            { name: 'x3 PnL', data: ${JSON.stringify(pnl3)} },
            { name: 'x2 PnL', data: ${JSON.stringify(pnl2)} },
          ]}
          height={260}
        />
        <Text tone="secondary" size="small">
          Source: logs/backtest-*-trades.csv replay · $3 x N · fee on
        </Text>
      </Stack>

      <Stack gap={8}>
        <H2>各标的最差周期 |回撤| (USD)</H2>
        <BarChart
          categories={${JSON.stringify(cats)}}
          series={[
            { name: 'x3 |DD|', data: ${JSON.stringify(dd3)} },
            { name: 'x2 |DD|', data: ${JSON.stringify(dd2)} },
          ]}
          height={240}
        />
        <Text tone="secondary" size="small">
          取该标的 5m/15m/1h 中最差回撤的绝对值
        </Text>
      </Stack>

      <Divider />

      <Stack gap={8}>
        <H2>标的合计对比</H2>
        <Table
          headers={[
            '标的',
            'x3 PnL',
            'x2 PnL',
            'Δ PnL',
            'x3 最差DD',
            'x2 最差DD',
            'x3 最高注',
            'x2 最高注',
          ]}
          rows={${JSON.stringify(symbolRows)}}
        />
      </Stack>

      <Stack gap={8}>
        <H2>分实例明细（21 路）</H2>
        <Table
          headers={['实例', '笔数', '胜率', 'x3 PnL', 'x2 PnL', 'Δ PnL', 'x3 DD', 'x2 DD']}
          rows={${JSON.stringify(instanceRows)}}
        />
      </Stack>

      <Callout tone="neutral" title="注码路径">
        x3：$3 → $9 → $27 → $81 → $243（第 5 亏 halt）。
        x2：$3 → $6 → $12 → $24 → $48（第 5 亏 halt）。
        胜率与笔数不变；连亏 halt 次数也不变。
      </Callout>
    </Stack>
  );
}
`;

const out =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/martingale-mult-compare.canvas.tsx';
writeFileSync(out, content, 'utf8');
console.log('Wrote', out);
