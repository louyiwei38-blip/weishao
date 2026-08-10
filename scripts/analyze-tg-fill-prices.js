/**
 * Parse Telegram HTML exports for live fill prices (开单成交).
 * Usage: node scripts/analyze-tg-fill-prices.js [dir1] [dir2] ...
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('Usage: node scripts/analyze-tg-fill-prices.js <exportDir>...');
  process.exit(1);
}

function listHtml(dir) {
  return readdirSync(dir)
    .filter((f) => /^messages\d*\.html$/i.test(f) || f === 'messages.html')
    .map((f) => join(dir, f))
    .sort();
}

const files = dirs.flatMap(listHtml);
const fills = [];
const seen = new Set();

for (const fp of files) {
  const html = readFileSync(fp, 'utf8');
  const exportTag = `${basename(dirname(fp))}/${basename(fp)}`;
  // Each message text block
  const blocks = html.split(/<div class="text">/).slice(1);
  for (const block of blocks) {
    const text = block.split('</div>')[0] || '';
    if (!text.includes('开单成交')) continue;
    const streamM = text.match(/\[([^\]]+)\]/);
    const priceM = text.match(/开单价格:\s*<strong>\$([0-9.]+)<\/strong>/);
    if (!priceM) continue;
    const stakeM = text.match(/投入:\s*<strong>\$([0-9.]+)<\/strong>/);
    const sharesM = text.match(/份数:\s*([0-9.]+)/);
    const timeM = text.match(/时间:\s*([0-9-]+\s+[0-9:]+)/);
    const dirM = text.match(/方向:[\s\S]*?<strong>[^<]*(UP|DOWN)/);
    const detailM = text.match(/@\$([0-9.]+)\s*\[/);
    const price = Number(priceM[1]);
    const detailPrice = detailM ? Number(detailM[1]) : null;
    const stake = stakeM ? Number(stakeM[1]) : null;
    const shares = sharesM
      ? Number(sharesM[1])
      : stake && price
        ? stake / price
        : null;
    const stream = streamM ? streamM[1] : '?';
    const time = timeM ? timeM[1] : '';
    const dir = dirM ? dirM[1] : '';
    const key = `${stream}|${time}|${price}|${stake ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fills.push({
      stream,
      time,
      price,
      detailPrice,
      stake,
      shares,
      dir,
      file: exportTag,
    });
  }
}

fills.sort((a, b) => String(a.time).localeCompare(String(b.time)));

const prices = fills.map((f) => f.price).sort((a, b) => a - b);
const n = prices.length;
if (!n) {
  console.error('No 开单成交 fills found');
  process.exit(2);
}

function pct(p) {
  const i = (n - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return prices[lo];
  return prices[lo] + (prices[hi] - prices[lo]) * (i - lo);
}

const sum = prices.reduce((a, b) => a + b, 0);
const wSum = fills.reduce((a, f) => a + (f.stake || 0) * f.price, 0);
const wDen = fills.reduce((a, f) => a + (f.stake || 0), 0);
const shareW = fills.reduce((a, f) => a + (f.shares || 0) * f.price, 0);
const shareDen = fills.reduce((a, f) => a + (f.shares || 0), 0);

const buckets = {};
for (const p of prices) {
  const k = (Math.round(p * 100) / 100).toFixed(2);
  buckets[k] = (buckets[k] || 0) + 1;
}

const ranges = [
  { label: '<0.40', test: (p) => p < 0.4 },
  { label: '0.40-0.44', test: (p) => p >= 0.4 && p < 0.45 },
  { label: '0.45-0.49', test: (p) => p >= 0.45 && p < 0.5 },
  { label: '0.50-0.54', test: (p) => p >= 0.5 && p < 0.55 },
  { label: '0.55-0.59', test: (p) => p >= 0.55 && p < 0.6 },
  { label: '0.60-0.64', test: (p) => p >= 0.6 && p < 0.65 },
  { label: '0.65-0.69', test: (p) => p >= 0.65 && p < 0.7 },
  { label: '≥0.70', test: (p) => p >= 0.7 },
];

const rangeCounts = ranges.map((r) => ({
  label: r.label,
  n: prices.filter(r.test).length,
  pct: prices.filter(r.test).length / n,
}));

const byStream = {};
for (const f of fills) {
  const parts = f.stream.split('·');
  const s = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : f.stream;
  if (!byStream[s]) byStream[s] = { n: 0, sum: 0, min: Infinity, max: -Infinity, stake: 0 };
  const o = byStream[s];
  o.n += 1;
  o.sum += f.price;
  o.min = Math.min(o.min, f.price);
  o.max = Math.max(o.max, f.price);
  o.stake += f.stake || 0;
}

const summary = {
  files,
  fills: n,
  range: { min: prices[0], max: prices[n - 1] },
  mean: sum / n,
  median: pct(0.5),
  p10: pct(0.1),
  p25: pct(0.25),
  p75: pct(0.75),
  p90: pct(0.9),
  vwapByStake: wDen ? wSum / wDen : null,
  vwapByShares: shareDen ? shareW / shareDen : null,
  totalStakeUsd: wDen,
  totalShares: shareDen,
  rangeBuckets: rangeCounts,
  tickBuckets: Object.fromEntries(
    Object.keys(buckets)
      .sort()
      .map((k) => [k, { n: buckets[k], pct: buckets[k] / n }]),
  ),
  byStream: Object.fromEntries(
    Object.entries(byStream)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [
        k,
        {
          n: v.n,
          avg: v.sum / v.n,
          min: v.min,
          max: v.max,
          stakeUsd: v.stake,
        },
      ]),
  ),
};

console.log('=== 实盘成交价统计（开单成交）===');
console.log(`来源文件: ${files.length} · 成交笔数: ${n}`);
console.log(
  `区间: $${summary.range.min.toFixed(3)} – $${summary.range.max.toFixed(3)}`,
);
console.log(
  `算术均价: $${summary.mean.toFixed(4)} · 中位数: $${summary.median.toFixed(4)}`,
);
console.log(
  `分位: P10 $${summary.p10.toFixed(3)} · P25 $${summary.p25.toFixed(3)} · P75 $${summary.p75.toFixed(3)} · P90 $${summary.p90.toFixed(3)}`,
);
console.log(
  `成交额加权均价: $${summary.vwapByStake.toFixed(4)} · 份数加权: $${summary.vwapByShares.toFixed(4)}`,
);
console.log(`总投入: $${summary.totalStakeUsd.toFixed(2)} · 总份数: ${summary.totalShares.toFixed(2)}`);

console.log('\n--- 区间分布 ---');
for (const r of rangeCounts) {
  const bar = '#'.repeat(Math.max(0, Math.round((r.pct * 100) / 2)));
  console.log(
    `${r.label.padEnd(10)} ${String(r.n).padStart(4)}  ${(r.pct * 100).toFixed(1).padStart(5)}%  ${bar}`,
  );
}

console.log('\n--- 逐 tick (0.01) ---');
for (const [k, v] of Object.entries(summary.tickBuckets)) {
  const bar = '#'.repeat(Math.max(1, Math.round((v.pct * 100) / 2)));
  console.log(
    `$${k}  ${String(v.n).padStart(4)}  ${(v.pct * 100).toFixed(1).padStart(5)}%  ${bar}`,
  );
}

console.log('\n--- 按流 ---');
for (const [k, v] of Object.entries(summary.byStream)) {
  console.log(
    `${k.padEnd(12)} ${String(v.n).padStart(4)}笔  avg $${v.avg.toFixed(3)}  [${v.min.toFixed(3)}–${v.max.toFixed(3)}]  stake $${v.stakeUsd.toFixed(0)}`,
  );
}

const outDir = join(process.cwd(), 'logs');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outJson = join(outDir, 'tg-fill-price-stats.json');
writeFileSync(outJson, JSON.stringify({ summary, fills }, null, 2));
console.log(`\nWrote ${outJson}`);
