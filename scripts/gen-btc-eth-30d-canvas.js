import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dirname, '..', 'logs', 'backtest-btc-eth-30d-detail.json'), 'utf8'),
);

const ORDER = ['btc-5m', 'btc-15m', 'btc-1h', 'eth-5m', 'eth-15m', 'eth-1h'];
const LABELS = {
  'btc-5m': 'BTC 5m',
  'btc-15m': 'BTC 15m',
  'btc-1h': 'BTC 1h',
  'eth-5m': 'ETH 5m',
  'eth-15m': 'ETH 15m',
  'eth-1h': 'ETH 1h',
};

const overview = ORDER.map((k) => {
  const t = data[k].summary.totals;
  const c = data[k].summary.chains;
  const b = data[k].summary.breakdown;
  return {
    key: k,
    label: LABELS[k],
    trades: t.trades,
    wr: +(t.winRate * 100).toFixed(1),
    pnl: +t.pnlUsd.toFixed(2),
    fees: +t.feesUsd.toFixed(2),
    maxDd: +t.maxDrawdownUsd.toFixed(2),
    maxStake: t.maxStakeUsd,
    entries: b.entrySignals,
    conts: b.martingaleContinues,
    chains: c.started,
    halt: c.endedHalt,
    winEnd: c.endedWin,
    upWr: +(b.up.winRate * 100).toFixed(1),
    downWr: +(b.down.winRate * 100).toFixed(1),
    upPnl: +b.up.pnl.toFixed(2),
    downPnl: +b.down.pnl.toFixed(2),
  };
});

const totalPnl = overview.reduce((s, r) => s + r.pnl, 0);
const totalTrades = overview.reduce((s, r) => s + r.trades, 0);
const totalFees = overview.reduce((s, r) => s + r.fees, 0);
const worstDd = Math.min(...overview.map((r) => r.maxDd));

const daySet = new Set();
for (const k of ORDER) for (const d of data[k].daily) daySet.add(d.day);
const days = [...daySet].sort();

const dayEquity = {};
for (const k of ORDER) {
  let eq = 0;
  const byDay = new Map(data[k].daily.map((d) => [d.day, d.pnlUsd]));
  dayEquity[k] = days.map((day) => {
    eq += byDay.get(day) ?? 0;
    return +eq.toFixed(2);
  });
}

const dailyTotal = days.map((day) => {
  let s = 0;
  for (const k of ORDER) {
    const hit = data[k].daily.find((d) => d.day === day);
    if (hit) s += hit.pnlUsd;
  }
  return +s.toFixed(2);
});

const tradesByKey = {};
const dailyDetail = {};
for (const k of ORDER) {
  dailyDetail[k] = data[k].daily;
  tradesByKey[k] = data[k].trades.map((t) => [
    t.settle,
    t.signal,
    t.id,
    t.out,
    t.won ? 1 : 0,
    t.stake,
    t.pnl,
    t.fee,
    t.end,
    t.lb,
  ]);
}

const period = data['btc-1h'].summary.period;
const params = data['btc-1h'].summary.params;
const META = {
  from: period.from.slice(0, 10),
  to: period.to.slice(0, 10),
  days: period.days,
  baseBet: params.baseBet,
  mult: params.multiplier,
  maxLosses: params.maxLosses,
  entry: params.entryPrice,
  totalPnl: +totalPnl.toFixed(2),
  totalTrades,
  totalFees: +totalFees.toFixed(2),
  worstDd,
};

const canvasPath =
  'C:/Users/Administrator/.cursor/projects/d-vgastongdao/canvases/btc-eth-30d-vegas.canvas.tsx';

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
  LineChart,
  Row,
  Select,
  Stack,
  Stat,
  Table,
  Text,
  useCanvasState,
} from 'cursor/canvas';

const OVERVIEW = ${JSON.stringify(overview)} as const;
const DAYS = ${JSON.stringify(days)} as const;
const DAILY_TOTAL = ${JSON.stringify(dailyTotal)} as const;
const DAY_EQUITY = ${JSON.stringify(dayEquity)} as const;
const DAILY_DETAIL = ${JSON.stringify(dailyDetail)} as const;
const TRADES = ${JSON.stringify(tradesByKey)} as const;
const LABELS: Record<string, string> = ${JSON.stringify(LABELS)};
const ORDER = ${JSON.stringify(ORDER)} as const;
const META = ${JSON.stringify(META)} as const;

type InstKey = (typeof ORDER)[number];

function fmtUsd(n: number) {
  const sign = n >= 0 ? '+' : '-';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number) {
  return n.toFixed(1) + '%';
}

function tonePnl(n: number): 'success' | 'danger' | undefined {
  if (n > 0) return 'success';
  if (n < 0) return 'danger';
  return undefined;
}

export default function BtcEth30dVegas() {
  const [sel, setSel] = useCanvasState('instance', 'btc-15m');
  const key: InstKey = (ORDER as readonly string[]).includes(sel) ? (sel as InstKey) : 'btc-15m';
  const ov = OVERVIEW.find((r) => r.key === key)!;
  const daily = DAILY_DETAIL[key];
  const trades = TRADES[key];

  const overviewRows = OVERVIEW.map((r) => [
    r.label,
    String(r.trades),
    fmtPct(r.wr),
    fmtUsd(r.pnl),
    fmtUsd(r.fees),
    fmtUsd(r.maxDd),
    String(r.entries),
    String(r.conts),
    String(r.halt),
    fmtPct(r.upWr) + ' / ' + fmtUsd(r.upPnl),
    fmtPct(r.downWr) + ' / ' + fmtUsd(r.downPnl),
  ]);
  const overviewTone = OVERVIEW.map((r) => tonePnl(r.pnl));

  const dailyRows = daily.map((d) => [
    d.day,
    String(d.trades),
    fmtPct(d.winRate * 100),
    fmtUsd(d.pnlUsd),
  ]);
  const dailyTone = daily.map((d) => tonePnl(d.pnlUsd));

  const tradeRows = trades.map((t) => [
    t[0],
    String(t[1]),
    String(t[2]),
    String(t[3]),
    t[4] ? 'W' : 'L',
    '$' + String(t[5]),
    fmtUsd(Number(t[6])),
    '$' + Number(t[7]).toFixed(2),
    String(t[8] || ''),
    String(t[9]),
  ]);
  const tradeTone = trades.map((t) => (t[4] ? ('success' as const) : ('danger' as const)));

  const equitySeries = ORDER.map((k) => ({
    name: LABELS[k],
    data: [...DAY_EQUITY[k]],
  }));

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1280 }}>
      <Stack gap={6}>
        <H1>BTC / ETH · 近一个月维加斯回测明细</H1>
        <Text tone="secondary">
          {META.from} → {META.to}（{META.days} 天）· OKX 永续 + OKX EMA144/169 · 首注 $
          {META.baseBet} ×{META.mult} · 连亏 {META.maxLosses} · 入场 {META.entry} · 含手续费
        </Text>
      </Stack>

      <Callout tone="info" title="参数说明">
        对齐实盘默认仓位量级（TRADE_BUDGET=$10、MARTINGALE_MULTIPLIER=1、MAX_LOSSES=5）。回测为固定首注+同向续单，未模拟动态 bankroll 追赶；结算用 OKX K 线涨跌（非 Chainlink）。
      </Callout>

      <Row gap={16} wrap>
        <Stat label="六路合计 PnL" value={fmtUsd(META.totalPnl)} tone={tonePnl(META.totalPnl)} />
        <Stat label="总成交笔数" value={String(META.totalTrades)} />
        <Stat label="总手续费" value={'$' + META.totalFees.toFixed(2)} />
        <Stat label="最差单路回撤" value={fmtUsd(META.worstDd)} tone="danger" />
      </Row>

      <Card>
        <CardHeader>各实例盈亏对比（近 30 天净 PnL）</CardHeader>
        <CardBody>
          <BarChart
            categories={OVERVIEW.map((r) => r.label)}
            series={[{ name: 'PnL (USD)', data: OVERVIEW.map((r) => r.pnl) }]}
            height={220}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>按日累计权益曲线（各实例独立）</CardHeader>
        <CardBody>
          <LineChart categories={[...DAYS]} series={equitySeries} height={280} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>六路合计 · 按日 PnL</CardHeader>
        <CardBody>
          <BarChart
            categories={[...DAYS]}
            series={[{ name: 'Daily PnL (USD)', data: [...DAILY_TOTAL] }]}
            height={200}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader trailing="胜率 / 盈亏 / 链路 / 多空">汇总表</CardHeader>
        <CardBody style={{ padding: 0 }}>
          <Table
            headers={['实例', '笔数', '胜率', 'PnL', '手续费', '最大回撤', '入场', '续单', '止损重置', 'UP wr/pnl', 'DOWN wr/pnl']}
            rows={overviewRows}
            rowTone={overviewTone}
            columnAlign={['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right']}
            striped
            stickyHeader
            framed
          />
        </CardBody>
      </Card>

      <Divider />

      <Stack gap={10}>
        <H2>单实例明细</H2>
        <Row gap={12} align="center" wrap>
          <Select
            value={key}
            onChange={setSel}
            options={ORDER.map((k) => ({ value: k, label: LABELS[k] }))}
          />
          <Text tone="secondary">
            {ov.label} · {ov.trades} 笔 · 胜率 {fmtPct(ov.wr)} · PnL {fmtUsd(ov.pnl)} · 回撤 {fmtUsd(ov.maxDd)} · 止损重置 {ov.halt}
          </Text>
        </Row>
      </Stack>

      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader>{ov.label + ' · 按日明细'}</CardHeader>
          <CardBody style={{ padding: 0 }}>
            <Table
              headers={['日期', '笔数', '胜率', 'PnL']}
              rows={dailyRows}
              rowTone={dailyTone}
              columnAlign={['left', 'right', 'right', 'right']}
              striped
              stickyHeader
              framed
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>{ov.label + ' · 关键摘要'}</CardHeader>
          <CardBody>
            <Stack gap={12}>
              <Stat label="入场信号 / 续单" value={ov.entries + ' / ' + ov.conts} />
              <Stat label="链路赢结 / 止损" value={ov.winEnd + ' / ' + ov.halt} />
              <Stat label="最大单笔" value={'$' + ov.maxStake.toFixed(0)} />
              <Stat label={'UP · ' + fmtPct(ov.upWr)} value={fmtUsd(ov.upPnl)} tone={tonePnl(ov.upPnl)} />
              <Stat label={'DOWN · ' + fmtPct(ov.downWr)} value={fmtUsd(ov.downPnl)} tone={tonePnl(ov.downPnl)} />
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Card>
        <CardHeader trailing={trades.length + ' 笔'}>{ov.label + ' · 逐笔明细'}</CardHeader>
        <CardBody style={{ padding: 0 }}>
          <Table
            headers={['结算时间(UTC)', '方向', '信号', '结果', '胜负', '注码', 'PnL', '手续费', '链路结束', '连亏前']}
            rows={tradeRows}
            rowTone={tradeTone}
            columnAlign={['left', 'center', 'left', 'center', 'center', 'right', 'right', 'right', 'center', 'right']}
            striped
            stickyHeader
            framed
          />
        </CardBody>
      </Card>

      <Text tone="tertiary" size="small">
        完整 CSV：logs/backtest-vegas-SYMBOL-TF-trades.csv（SYMBOL=btc 或 eth，TF=5m/15m/1h）· 汇总 JSON：logs/backtest-btc-eth-30d-detail.json · Source: OKX swap OHLCV + OKX EMA indicators
      </Text>
    </Stack>
  );
}
`;

writeFileSync(canvasPath, content);
console.log('Wrote', canvasPath, 'bytes', content.length);