import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dirname, '..', 'logs', 'backtest-mult-compare-x1.json'), 'utf8'),
);

function usd(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${n >= 0 ? '+' : '-'}$${s}`;
}
function usd2(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n >= 0 ? '+' : '-'}$${s}`;
}
function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

const tm = data.params.targetMult;
const symbolRows = data.bySymbol.map((r) => [
  r.symbol,
  usd2(r.base.pnlUsd),
  usd2(r.target.pnlUsd),
  usd2(r.deltaPnl),
  usd2(r.base.maxDrawdownUsd),
  usd2(r.target.maxDrawdownUsd),
  `$${r.base.maxStakeUsd}`,
  `$${r.target.maxStakeUsd}`,
]);

const instanceRows = data.instances.map((i) => [
  `${i.symbol} ${i.tf}`,
  String(i.trades),
  pct(i.winRate),
  usd2(i.base.pnlUsd),
  usd2(i.target.pnlUsd),
  usd2(i.deltaPnl),
  usd2(i.base.maxDrawdownUsd),
  usd2(i.target.maxDrawdownUsd),
]);

const cats = data.bySymbol.map((r) => r.symbol);
const pnl3 = data.bySymbol.map((r) => Math.round(r.base.pnlUsd));
const pnlT = data.bySymbol.map((r) => Math.round(r.target.pnlUsd));
const dd3 = data.bySymbol.map((r) => Math.round(Math.abs(r.base.maxDrawdownUsd)));
const ddT = data.bySymbol.map((r) => Math.round(Math.abs(r.target.maxDrawdownUsd)));
const g = data.grand;
const ratio = g.base.pnlUsd !== 0 ? ((g.target.pnlUsd / g.base.pnlUsd) * 100).toFixed(1) : '-';

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

export default function MartingaleMult1Compare() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>马丁倍数 x3 vs x1 回测对比</H1>
        <Text tone="secondary">
          规则不变：$3 首注 · 连亏 5 重置 · 入场 0.50 · 含手续费 · OKX Vegas。x1 = 全程固定 $3（无加仓）。胜负序列来自既有成交 CSV 重放。
        </Text>
        <Row gap={8}>
          <Pill tone="neutral">base $3</Pill>
          <Pill tone="info">x3 原回测</Pill>
          <Pill tone="success">x1 固定注</Pill>
          <Pill tone="neutral">maxLosses 5</Pill>
        </Row>
      </Stack>

      <Grid columns={4} gap={16}>
        <Stat label="七标的合计 x3" value="${usd(g.base.pnlUsd)}" tone="success" />
        <Stat label="七标的合计 x1" value="${usd(g.target.pnlUsd)}" tone="info" />
        <Stat label="PnL 差额 (x1-x3)" value="${usd(g.deltaPnl)}" tone="danger" />
        <Stat
          label="最差单标的回撤"
          value="x3 ${usd(g.base.maxDrawdownUsd)} → x1 ${usd(g.target.maxDrawdownUsd)}"
        />
      </Grid>

      <Callout tone="info" title="结论">
        改成 x1（固定 $3）后总利润约剩原 x3 的 ${ratio}%（${usd2(g.base.pnlUsd)} → ${usd2(g.target.pnlUsd)}）。
        回撤大幅收敛（最高注 $243 → $3）。马丁是利润主来源；去掉加仓后多数标的仍正期望但绝对值很小，SOL 合计接近打平，HYPE 仍亏但亏得少。
      </Callout>

      <Stack gap={8}>
        <H2>各标的三周期合计 PnL (USD)</H2>
        <BarChart
          categories={${JSON.stringify(cats)}}
          series={[
            { name: 'x3 PnL', data: ${JSON.stringify(pnl3)} },
            { name: 'x1 PnL', data: ${JSON.stringify(pnlT)} },
          ]}
          height={260}
        />
        <Text tone="secondary" size="small">
          Source: logs/backtest-*-trades.csv replay · $3 flat vs $3 x3 · fee on
        </Text>
      </Stack>

      <Stack gap={8}>
        <H2>各标的最差周期 |回撤| (USD)</H2>
        <BarChart
          categories={${JSON.stringify(cats)}}
          series={[
            { name: 'x3 |DD|', data: ${JSON.stringify(dd3)} },
            { name: 'x1 |DD|', data: ${JSON.stringify(ddT)} },
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
            'x1 PnL',
            'Δ PnL',
            'x3 最差DD',
            'x1 最差DD',
            'x3 最高注',
            'x1 最高注',
          ]}
          rows={${JSON.stringify(symbolRows)}}
        />
      </Stack>

      <Stack gap={8}>
        <H2>分实例明细（21 路）</H2>
        <Table
          headers={['实例', '笔数', '胜率', 'x3 PnL', 'x1 PnL', 'Δ PnL', 'x3 DD', 'x1 DD']}
          rows={${JSON.stringify(instanceRows)}}
        />
      </Stack>

      <Callout tone="neutral" title="注码路径">
        x3：$3 → $9 → $27 → $81 → $243（第 5 亏 halt）。
        x1：全程固定 $3（连亏仍计次并在 5 次后 halt，但不加仓）。
        胜率与笔数不变；连亏 halt 次数也不变。
      </Callout>
    </Stack>
  );
}
`;

const out =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/martingale-mult1-compare.canvas.tsx';
writeFileSync(out, content, 'utf8');
console.log('Wrote', out);
