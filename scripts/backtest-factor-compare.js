/**
 * Extended factor backtest comparison on cached 10k trades.
 * Usage: node scripts/backtest-factor-compare.js [--min-coverage=0.60]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { applyFilterStats, summarizeTrades } from './lib/backtestFactors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = join(__dirname, '..', 'logs', 'backtest-10k-trades.jsonl');
const OUT_FILE = join(__dirname, '..', 'logs', 'factor-compare.json');

const MIN_COVERAGE = Number(
  process.argv.find((a) => a.startsWith('--min-coverage='))?.split('=')[1] ?? 0.60,
);

function enrich(t) {
  const er = t.ER_20 ?? 0.01;
  return {
    ...t,
    chop_index: t.pivot_cross_count_12 != null ? t.pivot_cross_count_12 / (er + 0.05) : null,
    vol_spike: t.rv_5m != null && t.rv_ratio != null ? t.rv_5m * t.rv_ratio : null,
    trend_quality: t.ER_20 != null && t.signal_body_pct != null
      ? t.ER_20 * t.signal_body_pct : null,
  };
}

function evalRule(trades, name, category, fn) {
  const r = applyFilterStats(trades, fn, MIN_COVERAGE);
  if (!r) return null;
  return {
    name,
    category,
    kept: r.kept,
    coverage: r.coverage,
    winRate: r.winRate,
    halts: r.halts,
    haltReduction: r.haltReduction,
    pnl: r.pnl,
    roi: r.roi,
    pnlDelta: r.pnlDelta,
    winRateDelta: r.winRateDelta,
    score: r.haltReduction * 1.2 + r.coverage * 0.6 + (r.pnl > 0 ? 0.3 : 0) + Math.min(r.pnlDelta, 100) / 200,
  };
}

function buildRuleSet() {
  return [
    // baseline
    { name: '无过滤 (baseline)', category: '基准', fn: () => true, force: true },

    // A. 波动率结构
    { name: 'rv_ratio < 1.05', category: '波动率', fn: (t) => t.rv_ratio == null || t.rv_ratio < 1.05 },
    { name: 'rv_ratio < 1.08', category: '波动率', fn: (t) => t.rv_ratio == null || t.rv_ratio < 1.08 },
    { name: 'rv_ratio < 1.10', category: '波动率', fn: (t) => t.rv_ratio == null || t.rv_ratio < 1.10 },
    { name: 'rv_ratio < 1.15', category: '波动率', fn: (t) => t.rv_ratio == null || t.rv_ratio < 1.15 },
    { name: 'rv_accel < 1.20', category: '波动率', fn: (t) => t.rv_accel == null || t.rv_accel < 1.20 },
    { name: 'rv_accel < 1.30', category: '波动率', fn: (t) => t.rv_accel == null || t.rv_accel < 1.30 },
    { name: 'rv_accel < 1.40', category: '波动率', fn: (t) => t.rv_accel == null || t.rv_accel < 1.40 },
    { name: 'rv_5m < 0.00040', category: '波动率', fn: (t) => t.rv_5m == null || t.rv_5m < 0.00040 },
    { name: 'rv_5m < 0.00045', category: '波动率', fn: (t) => t.rv_5m == null || t.rv_5m < 0.00045 },
    { name: 'rv_5m < 0.00050', category: '波动率', fn: (t) => t.rv_5m == null || t.rv_5m < 0.00050 },
    { name: 'rv_15m < 0.00055', category: '波动率', fn: (t) => t.rv_15m == null || t.rv_15m < 0.00055 },
    { name: 'vol_spike < 0.00042', category: '波动率', fn: (t) => t.vol_spike == null || t.vol_spike < 0.00042 },
    { name: 'atr_pct < 0.0020', category: '波动率', fn: (t) => t.atr_pct == null || t.atr_pct < 0.0020 },
    { name: 'atr_pct < 0.0025', category: '波动率', fn: (t) => t.atr_pct == null || t.atr_pct < 0.0025 },

    // B. 趋势/震荡
    { name: 'ER_20 >= 0.12', category: '趋势震荡', fn: (t) => t.ER_20 == null || t.ER_20 >= 0.12 },
    { name: 'ER_20 >= 0.15', category: '趋势震荡', fn: (t) => t.ER_20 == null || t.ER_20 >= 0.15 },
    { name: 'ER_20 >= 0.18', category: '趋势震荡', fn: (t) => t.ER_20 == null || t.ER_20 >= 0.18 },
    { name: 'pivot_cross < 1', category: '趋势震荡', fn: (t) => t.pivot_cross_count_12 == null || t.pivot_cross_count_12 < 1 },
    { name: 'pivot_cross < 2', category: '趋势震荡', fn: (t) => t.pivot_cross_count_12 == null || t.pivot_cross_count_12 < 2 },
    { name: 'pivot_cross < 3', category: '趋势震荡', fn: (t) => t.pivot_cross_count_12 == null || t.pivot_cross_count_12 < 3 },
    { name: 'chop_index < 4', category: '趋势震荡', fn: (t) => t.chop_index == null || t.chop_index < 4 },
    { name: 'chop_index < 6', category: '趋势震荡', fn: (t) => t.chop_index == null || t.chop_index < 6 },
    { name: 'SKIP ER<0.18 & cross>=2', category: '趋势震荡', fn: (t) => !(t.ER_20 != null && t.ER_20 < 0.18 && t.pivot_cross_count_12 != null && t.pivot_cross_count_12 >= 2) },
    { name: 'SKIP ER<0.20 & cross>=3', category: '趋势震荡', fn: (t) => !(t.ER_20 != null && t.ER_20 < 0.20 && t.pivot_cross_count_12 != null && t.pivot_cross_count_12 >= 3) },
    { name: 'range_comp < 3.5', category: '趋势震荡', fn: (t) => t.range_compression == null || t.range_compression < 3.5 },
    { name: 'range_comp < 4.0', category: '趋势震荡', fn: (t) => t.range_compression == null || t.range_compression < 4.0 },

    // C. 信号 K 线质量
    { name: 'wick < 0.30', category: '信号质量', fn: (t) => t.signal_wick_dominance == null || t.signal_wick_dominance < 0.30 },
    { name: 'wick < 0.35', category: '信号质量', fn: (t) => t.signal_wick_dominance == null || t.signal_wick_dominance < 0.35 },
    { name: 'wick < 0.40', category: '信号质量', fn: (t) => t.signal_wick_dominance == null || t.signal_wick_dominance < 0.40 },
    { name: 'body >= 0.40', category: '信号质量', fn: (t) => t.signal_body_pct == null || t.signal_body_pct >= 0.40 },
    { name: 'body >= 0.45', category: '信号质量', fn: (t) => t.signal_body_pct == null || t.signal_body_pct >= 0.45 },
    { name: 'body >= 0.50', category: '信号质量', fn: (t) => t.signal_body_pct == null || t.signal_body_pct >= 0.50 },
    { name: 'body_mean_6 >= 0.48', category: '信号质量', fn: (t) => t.body_ratio_mean_6 == null || t.body_ratio_mean_6 >= 0.48 },
    { name: 'trend_quality >= 0.08', category: '信号质量', fn: (t) => t.trend_quality == null || t.trend_quality >= 0.08 },
    { name: 'prev_streak >= 2', category: '信号质量', fn: (t) => t.prev_same_dir_streak == null || t.prev_same_dir_streak >= 2 },

    // D. 突破/假突破
    { name: 'SKIP 假突破 A', category: '假突破', fn: (t) => !(t.rv_5m > 0.0004 && t.breakout_dist > 0.30 && t.signal_wick_dominance > 0.25) },
    { name: 'SKIP 假突破 B', category: '假突破', fn: (t) => !(t.rv_5m > 0.00035 && t.breakout_dist > 0.25 && t.signal_wick_dominance > 0.22) },
    { name: 'SKIP 假突破 C', category: '假突破', fn: (t) => !(t.rv_5m > 0.00045 && t.breakout_dist > 0.35 && t.signal_wick_dominance > 0.28) },
    { name: 'breakout_dist < 0.50', category: '假突破', fn: (t) => t.breakout_dist == null || t.breakout_dist < 0.50 },
    { name: 'breakout_dist < 0.80', category: '假突破', fn: (t) => t.breakout_dist == null || t.breakout_dist < 0.80 },

    // E. 组合规则
    { name: 'rv_ratio<1.05 + wick<0.35', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.05) && (t.signal_wick_dominance == null || t.signal_wick_dominance < 0.35) },
    { name: 'rv_ratio<1.05 + body>=0.42', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.05) && (t.signal_body_pct == null || t.signal_body_pct >= 0.42) },
    { name: 'rv_ratio<1.05 + 假突破A', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.05) && !(t.rv_5m > 0.0004 && t.breakout_dist > 0.30 && t.signal_wick_dominance > 0.25) },
    { name: 'rv_ratio<1.08 + rv_accel<1.30', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.08) && (t.rv_accel == null || t.rv_accel < 1.30) },
    { name: 'rv_ratio<1.05 + ER>=0.14', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.05) && (t.ER_20 == null || t.ER_20 >= 0.14) },
    { name: 'rv_ratio<1.10 + wick<0.38', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.10) && (t.signal_wick_dominance == null || t.signal_wick_dominance < 0.38) },
    { name: 'rv_ratio<1.05 + chop_index<5', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.05) && (t.chop_index == null || t.chop_index < 5) },
    { name: 'wick<0.35 + body>=0.45', category: '组合', fn: (t) => (t.signal_wick_dominance == null || t.signal_wick_dominance < 0.35) && (t.signal_body_pct == null || t.signal_body_pct >= 0.45) },
    { name: 'rv_ratio<1.05 + vol_spike<0.00042', category: '组合', fn: (t) => (t.rv_ratio == null || t.rv_ratio < 1.05) && (t.vol_spike == null || t.vol_spike < 0.00042) },
  ];
}

function pct(v, d = 1) {
  return `${(v * 100).toFixed(d)}%`;
}

function main() {
  if (!existsSync(TRADES_FILE)) {
    console.error('Missing logs/backtest-10k-trades.jsonl — run: node scripts/backtest-10k.js');
    process.exit(1);
  }

  const trades = readFileSync(TRADES_FILE, 'utf8').trim().split('\n').map((l) => enrich(JSON.parse(l)));
  const baseline = summarizeTrades(trades);

  const results = [];
  for (const rule of buildRuleSet()) {
    if (rule.force) {
      results.push({
        name: rule.name,
        category: rule.category,
        kept: trades.length,
        coverage: 1,
        winRate: baseline.winRate,
        halts: baseline.halts,
        haltReduction: 0,
        pnl: baseline.pnl,
        roi: baseline.roi,
        pnlDelta: 0,
        winRateDelta: 0,
        score: 0.6,
      });
      continue;
    }
    const r = evalRule(trades, rule.name, rule.category, rule.fn);
    if (r) results.push(r);
  }

  results.sort((a, b) => b.score - a.score);

  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  const topPerCategory = Object.entries(byCategory).map(([cat, rows]) => ({
    category: cat,
    best: rows.filter((r) => r.name !== '无过滤 (baseline)').sort((a, b) => b.score - a.score)[0],
  }));

  const output = {
    meta: { trades: trades.length, minCoverage: MIN_COVERAGE, baseline },
    allResults: results,
    topPerCategory,
    top10: results.filter((r) => r.name !== '无过滤 (baseline)').slice(0, 10),
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n样本: ${trades.length} 笔 | 基准: 胜率 ${pct(baseline.winRate)} | 止损 ${baseline.halts} | PnL ${baseline.pnl.toFixed(1)}`);
  console.log(`最低覆盖率: ${pct(MIN_COVERAGE, 0)}\n`);

  const tableRows = results.map((r) => ({
    rule: r.name,
    cat: r.category,
    coverage: pct(r.coverage),
    winRate: pct(r.winRate),
    halts: r.halts,
    haltCut: pct(r.haltReduction),
    pnl: r.pnl.toFixed(1),
    pnlDelta: r.pnlDelta.toFixed(1),
    score: r.score.toFixed(3),
  }));

  console.log('=== 全因子对比表（按综合评分排序）===');
  console.table(tableRows);

  console.log('\n=== 各类别最优 ===');
  console.table(topPerCategory.map(({ category, best }) => best ? ({
    cat: category,
    rule: best.name,
    coverage: pct(best.coverage),
    haltCut: pct(best.haltReduction),
    pnl: best.pnl.toFixed(1),
  }) : { cat: category, rule: 'N/A' }));

  console.log(`\n完整 JSON: logs/factor-compare.json`);
}

main();
