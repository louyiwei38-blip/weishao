import config from '../config.js';

function round(num, digits = 8) {
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(digits));
}

function sampleStd(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const n = values.length;
  const mean = values.reduce((acc, v) => acc + v, 0) / n;
  const variance = values.reduce((acc, v) => {
    const d = v - mean;
    return acc + d * d;
  }, 0) / (n - 1);
  return Math.sqrt(variance);
}

/** @param {string} timeframe e.g. 1m, 5m, 1h */
export function parseTimeframeMinutes(timeframe) {
  const tf = String(timeframe || '').trim().toLowerCase();
  const m = /^(\d+)m$/.exec(tf);
  if (m) return Number(m[1]);
  const h = /^(\d+)h$/.exec(tf);
  if (h) return Number(h[1]) * 60;
  throw new Error(`Unsupported timeframe for volatility: ${timeframe}`);
}

/** Map 1m/5m/15m lookback windows to bar counts for the given bar size. */
export function buildWindowBars(barMinutes) {
  const minutes = Number(barMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Invalid bar minutes: ${barMinutes}`);
  }

  return {
    rv_1m: Math.max(2, Math.ceil(1 / minutes)),
    rv_5m: Math.max(2, Math.ceil(5 / minutes)),
    rv_15m: Math.max(2, Math.ceil(15 / minutes)),
  };
}

function computeRvForWindow(closePrices, barsNeeded) {
  if (!Array.isArray(closePrices) || closePrices.length < barsNeeded) return null;

  const closes = closePrices.slice(-barsNeeded);
  const returns = [];

  for (let i = 1; i < closes.length; i += 1) {
    const prev = Number(closes[i - 1]);
    const curr = Number(closes[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0 || curr <= 0) {
      return null;
    }
    returns.push(Math.log(curr / prev));
  }

  return round(sampleStd(returns), 8);
}

/** rv_5m / rv_15m — short-term vol vs 15m baseline (logging / backtests only) */
export function computeRvRatio(signalVol) {
  const rv5 = signalVol?.rv_5m;
  const rv15 = signalVol?.rv_15m;
  if (!Number.isFinite(rv5) || !Number.isFinite(rv15) || rv15 === 0) return null;
  return round(rv5 / rv15, 4);
}

/**
 * Realized volatility: sample std of log returns over 1m/5m/15m windows.
 * @param {Array<{ close: number }>} candles
 * @param {string} [barTimeframe] defaults to config.volatilityBarTimeframe
 */
export function computeSignalVolatility(candles, barTimeframe = config.volatilityBarTimeframe ?? '1m') {
  const barMinutes = parseTimeframeMinutes(barTimeframe);
  const windows = buildWindowBars(barMinutes);
  const closePrices = Array.isArray(candles)
    ? candles.map((c) => Number(c?.close)).filter(Number.isFinite)
    : [];

  return {
    barTimeframe,
    barMinutes,
    windows,
    rv_1m: computeRvForWindow(closePrices, windows.rv_1m),
    rv_5m: computeRvForWindow(closePrices, windows.rv_5m),
    rv_15m: computeRvForWindow(closePrices, windows.rv_15m),
  };
}

function formatRvValue(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  return Number(value).toFixed(6);
}

/** Structured fields for logger / heartbeat / jsonl (metrics only — no regime switch) */
export function formatLogFields(volCtx) {
  if (!volCtx) return {};
  return {
    rv_1m: volCtx.rv?.rv_1m ?? null,
    rv_5m: volCtx.rv?.rv_5m ?? null,
    rv_15m: volCtx.rv?.rv_15m ?? null,
    rv_ratio: computeRvRatio(volCtx.rv),
    volBarTimeframe: volCtx.rv?.barTimeframe ?? config.volatilityBarTimeframe ?? '1m',
  };
}

/** Compact snapshot persisted on pending bet for settlement notifications */
export function snapshotForPending(volCtx) {
  if (!volCtx) return {};
  return {
    volatility: volCtx.rv
      ? {
          barTimeframe: volCtx.rv.barTimeframe,
          rv_1m: volCtx.rv.rv_1m,
          rv_5m: volCtx.rv.rv_5m,
          rv_15m: volCtx.rv.rv_15m,
          rv_ratio: computeRvRatio(volCtx.rv),
        }
      : null,
  };
}

/** Telegram HTML block for order / settlement context */
export function formatTelegramBlock(rv) {
  if (!rv) return '\n📉 <b>波动率</b>: 暂无数据';

  return (
    `\n📉 <b>波动率</b> (${rv.barTimeframe})\n` +
    `rv_1m: <b>${formatRvValue(rv.rv_1m)}</b>\n` +
    `rv_5m: <b>${formatRvValue(rv.rv_5m)}</b>\n` +
    `rv_15m: <b>${formatRvValue(rv.rv_15m)}</b>`
  );
}
