/**
 * Offline factor analysis: profit segments vs martingale stop-loss segments.
 * Usage: node scripts/analyze-regime-factors.js
 */
import ccxt from 'ccxt';
import { evaluateReversalContinuation, classifyCandle } from '../src/strategy/reversalContinuation.js';
import { computeSignalVolatility } from '../src/utils/volatility.js';

const SYMBOL = 'BTC/USDT';
const MARTINGALE_MAX = 4;
const RV_THRESH = 0; // profit sample used ≈0 thresholds
const ANALYSIS_START = Date.parse('2025-06-04T17:00:00Z');
const ANALYSIS_END = Date.parse('2025-06-06T01:00:00Z');
const FETCH_START = Date.parse('2025-06-03T17:00:00Z');
const FETCH_END = Date.parse('2025-06-07T01:00:00Z');

async function fetchAllCandles(exchange, symbol, timeframe, since, until) {
  const all = [];
  let cursor = since;
  const tfMs = timeframe === '5m' ? 5 * 60_000 : 60_000;
  while (cursor < until) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, cursor, 1000);
    if (!batch.length) break;
    for (const row of batch) {
      const [t, o, h, l, c, v] = row;
      if (t >= until) break;
      all.push({ t, open: o, high: h, low: l, close: c, volume: v });
    }
    const lastT = batch.at(-1)[0];
    if (lastT <= cursor) break;
    cursor = lastT + tfMs;
    await new Promise((r) => setTimeout(r, 120));
  }
  const dedup = new Map(all.map((c) => [c.t, c]));
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

function atr(candles, idx, period = 14) {
  if (idx < period) return null;
  const trs = [];
  for (let i = idx - period + 1; i <= idx; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function er20(candles, idx) {
  if (idx < 20) return null;
  const start = candles[idx - 20].close;
  const end = candles[idx].close;
  let path = 0;
  for (let i = idx - 19; i <= idx; i += 1) {
    path += Math.abs(candles[i].close - candles[i - 1].close);
  }
  if (path === 0) return 0;
  return Math.abs(end - start) / path;
}

function rollingPivot(candles, idx, lookback = 48) {
  const start = Math.max(0, idx - lookback + 1);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= idx; i += 1) {
    hi = Math.max(hi, candles[i].high);
    lo = Math.min(lo, candles[i].low);
  }
  return { pivotHigh: hi, pivotLow: lo, pivotMid: (hi + lo) / 2 };
}

function pivotCrossCount(candles, idx, pivot, lookback = 12) {
  const start = idx - lookback + 1;
  if (start < 1) return null;
  let count = 0;
  for (let i = start; i <= idx; i += 1) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    if ((prev - pivot) * (curr - pivot) < 0) count += 1;
  }
  return count;
}

function bodyRatio(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

function wickDominance(candle, direction) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBot = Math.min(candle.open, candle.close);
  const upper = candle.high - bodyTop;
  const lower = bodyBot - candle.low;
  if (direction === 'UP') return lower / range;
  if (direction === 'DOWN') return upper / range;
  return Math.max(upper, lower) / range;
}

function prevSameDirStreak(candles, idx) {
  const type = classifyCandle(candles[idx]);
  if (type === 'DOJI') return 0;
  let streak = 1;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const t = classifyCandle(candles[i]);
    if (t !== type) break;
    streak += 1;
  }
  return streak;
}

function nearestPivot(close, pivots) {
  const dists = [
    { key: 'high', val: pivots.pivotHigh, d: Math.abs(close - pivots.pivotHigh) },
    { key: 'mid', val: pivots.pivotMid, d: Math.abs(close - pivots.pivotMid) },
    { key: 'low', val: pivots.pivotLow, d: Math.abs(close - pivots.pivotLow) },
  ];
  dists.sort((a, b) => a.d - b.d);
  return dists[0];
}

function get1mSlice(candles1m, ts5m, count = 20) {
  const endIdx = candles1m.findIndex((c) => c.t > ts5m);
  const end = endIdx === -1 ? candles1m.length : endIdx;
  return candles1m.slice(Math.max(0, end - count), end);
}

function computeFactors(candles5m, candles1m, idx, rvHistory) {
  const k2 = candles5m[idx - 1];
  const k1 = candles5m[idx];
  const pivots = rollingPivot(candles5m, idx);
  const nearest = nearestPivot(k1.close, pivots);
  const atr14 = atr(candles5m, idx, 14);
  const slice1m = get1mSlice(candles1m, k1.t + 5 * 60_000, 20);
  const vol = computeSignalVolatility(slice1m, '1m');
  const rv5Now = vol.rv_5m;
  const rv5T3 = rvHistory[idx - 3] ?? null;
  const rv15 = vol.rv_15m;
  const eval_ = evaluateReversalContinuation(k2, k1, 'high');
  const signalDir = eval_.signal === 'NONE' ? null : eval_.signal;

  const breakoutRaw = signalDir === 'UP'
    ? k1.close - nearest.val
    : signalDir === 'DOWN'
      ? nearest.val - k1.close
      : 0;

  let bodyMean6 = null;
  if (idx >= 5) {
    const ratios = [];
    for (let i = idx - 5; i <= idx; i += 1) ratios.push(bodyRatio(candles5m[i]));
    bodyMean6 = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }

  let rangeComp = null;
  if (idx >= 11 && atr14) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = idx - 11; i <= idx; i += 1) {
      hi = Math.max(hi, candles5m[i].high);
      lo = Math.min(lo, candles5m[i].low);
    }
    rangeComp = (hi - lo) / atr14;
  }

  return {
    t: k1.t + 5 * 60_000,
    k1t: k1.t,
    signalId: eval_.signalId,
    signal: eval_.signal,
    rv_1m: vol.rv_1m,
    rv_5m: rv5Now,
    rv_15m: rv15,
    rv_ratio: rv5Now != null && rv15 ? rv5Now / rv15 : null,
    rv_accel: rv5Now != null && rv5T3 ? rv5Now / rv5T3 : null,
    atr_5m_14: atr14,
    atr_pct: atr14 != null ? atr14 / k1.close : null,
    ER_20: er20(candles5m, idx),
    pivot_cross_count_12: pivotCrossCount(candles5m, idx, nearest.val, 12),
    pivot_level: nearest.val,
    pivot_key: nearest.key,
    range_compression: rangeComp,
    body_ratio_mean_6: bodyMean6,
    signal_body_pct: bodyRatio(k1),
    signal_wick_dominance: signalDir ? wickDominance(k1, signalDir) : null,
    prev_same_dir_streak: prevSameDirStreak(candles5m, idx - 1),
    breakout_dist: atr14 ? breakoutRaw / atr14 : null,
  };
}

function simulateOutcomes(candles5m, signals) {
  const byT = new Map(candles5m.map((c, i) => [c.t, i]));
  const results = [];
  for (const sig of signals) {
    if (sig.signal === 'NONE') continue;
    const idx = byT.get(sig.k1t);
    if (idx == null || idx + 1 >= candles5m.length) continue;
    const next = candles5m[idx + 1];
    const outcome = classifyCandle(next);
    const won = (sig.signal === 'UP' && outcome === 'BULL')
      || (sig.signal === 'DOWN' && outcome === 'BEAR');
    results.push({ ...sig, won, pnlUsd: won ? 0.5 : -0.5, outcome });
  }
  return results;
}

function simulateMartingale(trades) {
  let streak = 0;
  let cumPnl = 0;
  const enriched = [];
  for (const t of trades) {
    cumPnl += t.pnlUsd;
    let halted = false;
    if (t.won) {
      streak = 0;
    } else {
      streak += 1;
      if (streak >= MARTINGALE_MAX) {
        halted = true;
        streak = 0;
      }
    }
    enriched.push({ ...t, cumPnl, consecutiveLosses: t.won ? 0 : streak, martingaleHalted: halted });
  }
  return enriched;
}

function stats(arr) {
  if (!arr.length) return { n: 0, mean: null, median: null, p25: null, p75: null };
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const q = (p) => s[Math.floor(p * (s.length - 1))];
  return { n: s.length, mean, median: q(0.5), p25: q(0.25), p75: q(0.75) };
}

function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let correct = 0;
  let total = 0;
  for (const p of pos) {
    for (const n of neg) {
      total += 1;
      if (p > n) correct += 1;
      else if (p === n) correct += 0.5;
    }
  }
  return correct / total;
}

function partialCorr(x, y, z) {
  const n = x.length;
  if (n < 5) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(x); const my = mean(y); const mz = mean(z);
  const cov = (a, b, ma, mb) => a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  const var_ = (a, ma) => a.reduce((s, v) => s + (v - ma) ** 2, 0);
  const cxy = cov(x, y, mx, my);
  const cxz = cov(x, z, mx, mz);
  const cyz = cov(y, z, my, mz);
  const vx = var_(x, mx);
  const vy = var_(y, my);
  const vz = var_(z, mz);
  const denom = Math.sqrt(vx * vy - (cxz ** 2) / vz) * Math.sqrt(vy - (cyz ** 2) / vz);
  if (denom === 0) return null;
  return (cxy - (cxz * cyz) / vz) / denom;
}

function findProfitSegments(trades, minWinRate = 0.55, minLen = 6) {
  const segments = [];
  let start = 0;
  while (start < trades.length) {
    let best = null;
    for (let end = start + minLen - 1; end < trades.length; end += 1) {
      const slice = trades.slice(start, end + 1);
      const wins = slice.filter((t) => t.won).length;
      const wr = wins / slice.length;
      const pnl = slice.reduce((s, t) => s + t.pnlUsd, 0);
      if (wr >= minWinRate && pnl > 0) {
        best = { start, end, wr, pnl, len: slice.length };
      }
    }
    if (best) {
      segments.push(best);
      start = best.end + 1;
    } else {
      start += 1;
    }
  }
  return segments;
}

function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function applyFilter(trades, fn) {
  const kept = trades.filter(fn);
  const skipped = trades.length - kept.length;
  let streak = 0;
  let halts = 0;
  let wins = 0;
  let pnl = 0;
  for (const t of kept) {
    pnl += t.pnlUsd;
    if (t.won) { wins += 1; streak = 0; }
    else {
      streak += 1;
      if (streak >= MARTINGALE_MAX) { halts += 1; streak = 0; }
    }
  }
  return {
    kept: kept.length,
    skipped,
    coverage: kept.length / trades.length,
    winRate: kept.length ? wins / kept.length : 0,
    halts,
    pnl,
    roi: pnl / (kept.length * 0.5 || 1),
  };
}

function mapFactorRow(r) {
  return {
    factor: r.key,
    profitTypical: r.ps.median,
    lossTypical: r.ls.median,
    profitMean: r.ps.mean,
    lossMean: r.ls.mean,
    discrimination: r.auc != null ? Number(r.auc.toFixed(3)) : null,
    partialCorrRv5: r.pcorr != null ? Number(r.pcorr.toFixed(3)) : null,
    higherInProfit: r.higherIsProfit,
  };
}

async function main() {
  const ex = new ccxt.okx({ enableRateLimit: true, timeout: 30_000 });
  console.log('Fetching OHLCV...');
  const [c5, c1] = await Promise.all([
    fetchAllCandles(ex, SYMBOL, '5m', FETCH_START, FETCH_END),
    fetchAllCandles(ex, SYMBOL, '1m', FETCH_START, FETCH_END),
  ]);
  console.log(`5m: ${c5.length}, 1m: ${c1.length}`);

  const rvHistory = {};
  const signals = [];
  for (let i = 2; i < c5.length; i += 1) {
    const k1 = c5[i];
    const cycleT = k1.t + 5 * 60_000;
    if (cycleT < ANALYSIS_START || cycleT > ANALYSIS_END) continue;
    const slice1m = get1mSlice(c1, k1.t + 5 * 60_000, 20);
    const vol = computeSignalVolatility(slice1m, '1m');
    rvHistory[i] = vol.rv_5m;
    const highVol = (vol.rv_5m ?? 0) >= RV_THRESH || (vol.rv_15m ?? 0) >= RV_THRESH;
    if (!highVol) continue;
    const f = computeFactors(c5, c1, i, rvHistory);
    if (f.signal !== 'NONE') signals.push(f);
  }

  let trades = simulateOutcomes(c5, signals);
  trades = simulateMartingale(trades);
  console.log(`Trades in window: ${trades.length}`);

  const haltTrades = trades.filter((t) => t.martingaleHalted);
  const haltLossWindows = [];
  for (const h of haltTrades) {
    const idx = trades.indexOf(h);
    const window = trades.slice(Math.max(0, idx - 3), idx + 1);
    haltLossWindows.push(...window.filter((t) => !t.won));
  }

  const profitSegs = findProfitSegments(trades);
  const profitTrades = new Set();
  for (const seg of profitSegs) {
    for (let i = seg.start; i <= seg.end; i += 1) profitTrades.add(trades[i]);
  }
  const profitSamples = [...profitTrades];
  const lossSamples = haltLossWindows.length
    ? haltLossWindows
    : trades.filter((t) => !t.won && t.consecutiveLosses >= 2);

  const FACTORS = [
    'rv_5m', 'rv_15m', 'rv_ratio', 'rv_accel', 'atr_pct', 'ER_20',
    'pivot_cross_count_12', 'range_compression', 'body_ratio_mean_6',
    'signal_body_pct', 'signal_wick_dominance', 'prev_same_dir_streak', 'breakout_dist',
  ];

  const profitSegA = trades.filter((t) => t.t >= Date.parse('2025-06-04T17:00:00Z') && t.t < Date.parse('2025-06-05T09:00:00Z'));
  const chopSegB = trades.filter((t) => t.t >= Date.parse('2025-06-05T15:00:00Z') && t.t <= Date.parse('2025-06-06T01:00:00Z'));
  const profitSamplesSeg = profitSegA.filter((t) => t.won);
  const lossSamplesSeg = [...haltLossWindows, ...chopSegB.filter((t) => !t.won)];

  function rankFactors(profitSamples, lossSamples) {
    const rows = [];
    for (const key of FACTORS) {
      const pv = profitSamples.map((t) => t[key]).filter((v) => v != null && Number.isFinite(v));
      const lv = lossSamples.map((t) => t[key]).filter((v) => v != null && Number.isFinite(v));
      const ps = stats(pv);
      const ls = stats(lv);
      const higherIsProfit = ps.mean != null && ls.mean != null ? ps.mean > ls.mean : null;
      const aucVal = higherIsProfit ? auc(pv, lv) : auc(lv, pv);
      const aligned = [...profitSamples, ...lossSamples].filter(
        (row) => row[key] != null && Number.isFinite(row[key]) && Number.isFinite(row.rv_5m),
      );
      const px = aligned.map((row) => row[key]);
      const labels = aligned.map((row) => (profitSamples.includes(row) ? 1 : 0));
      const pRv = aligned.map((row) => row.rv_5m);
      const pcorr = px.length > 4 ? partialCorr(px, labels, pRv) : null;
      rows.push({ key, ps, ls, auc: aucVal, pcorr, higherIsProfit });
    }
    rows.sort((a, b) => (b.auc ?? 0) - (a.auc ?? 0));
    return rows;
  }

  const factorRows = rankFactors(profitSamples, lossSamples);
  const segmentFactorRows = rankFactors(profitSamplesSeg, lossSamplesSeg);

  const manualSegments = [
    { name: '盈利段A', start: Date.parse('2025-06-04T17:00:00Z'), end: Date.parse('2025-06-05T09:00:00Z'), tag: '高波动单边+突破' },
    { name: '过渡段', start: Date.parse('2025-06-05T09:00:00Z'), end: Date.parse('2025-06-05T15:00:00Z'), tag: '跌破上沿pivot' },
    { name: '震荡止损段B', start: Date.parse('2025-06-05T15:00:00Z'), end: Date.parse('2025-06-06T01:00:00Z'), tag: 'pivot来回穿越' },
  ];

  const segTable = manualSegments.map((seg) => {
    const slice = trades.filter((t) => t.t >= seg.start && t.t <= seg.end);
    const wins = slice.filter((t) => t.won).length;
    const halted = slice.some((t) => t.martingaleHalted);
    return {
      ...seg,
      signals: slice.length,
      winRate: slice.length ? wins / slice.length : 0,
      halted,
    };
  });

  const baseline = {
    trades: trades.length,
    wins: trades.filter((t) => t.won).length,
    halts: haltTrades.length,
    pnl: trades.reduce((s, t) => s + t.pnlUsd, 0),
    winRate: trades.filter((t) => t.won).length / (trades.length || 1),
  };

  const rules = [
    {
      name: 'SKIP_CHOP',
      fn: (t) => !(t.ER_20 != null && t.ER_20 < 0.22 && t.pivot_cross_count_12 != null && t.pivot_cross_count_12 >= 3),
    },
    {
      name: 'MIN_BODY',
      fn: (t) => t.signal_body_pct == null || t.signal_body_pct >= 0.45,
    },
    {
      name: 'MIN_BREAKOUT',
      fn: (t) => t.breakout_dist == null || t.breakout_dist >= 0.15,
    },
    {
      name: 'MAX_WICK',
      fn: (t) => t.signal_wick_dominance == null || t.signal_wick_dominance < 0.35,
    },
    {
      name: 'SKIP_FALSE_BREAKOUT',
      fn: (t) => !(t.rv_5m != null && t.rv_5m > 0.0004
        && t.breakout_dist != null && t.breakout_dist > 0.3
        && t.signal_wick_dominance != null && t.signal_wick_dominance > 0.25),
    },
    {
      name: 'QUALITY_COMBO',
      fn: (t) => (t.signal_body_pct == null || t.signal_body_pct >= 0.45)
        && (t.signal_wick_dominance == null || t.signal_wick_dominance < 0.35),
    },
  ];

  const ruleResults = rules.map((r) => ({
    name: r.name,
    baseline,
    filtered: applyFilter(trades, r.fn),
  }));

  const combo = applyFilter(trades, (t) =>
    rules.slice(0, 3).every((r) => r.fn(t)));

  const output = {
    meta: {
      exchange: 'okx',
      analysisWindow: { start: fmtTs(ANALYSIS_START), end: fmtTs(ANALYSIS_END) },
      rvThreshold: RV_THRESH,
    profitSamples: profitSamples.length,
    lossSamples: lossSamples.length,
    profitSamplesSeg: profitSamplesSeg.length,
    lossSamplesSeg: lossSamplesSeg.length,
      haltEvents: haltTrades.length,
    },
    segmentTable: segTable,
    baseline,
    factorRanking: factorRows.map(mapFactorRow),
    segmentFactorRanking: segmentFactorRows.map(mapFactorRow),
    ruleResults,
    comboFilter: combo,
    profitSegments: profitSegs.map((s) => ({
      start: fmtTs(trades[s.start].t),
      end: fmtTs(trades[s.end].t),
      len: s.len,
      winRate: s.wr,
      pnl: s.pnl,
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
