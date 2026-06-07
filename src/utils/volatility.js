import config from '../config.js';
import { formatBeijingTime } from './datetime.js';

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

/**
 * Realized volatility: sample std of log returns over 1m/5m/15m windows.
 * @param {Array<{ close: number }>} candles
 * @param {string} [barTimeframe] defaults to config.volatilityBarTimeframe
 */
export function computeSignalVolatility(candles, barTimeframe = config.volatilityBarTimeframe) {
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

export function isVolatilityFilterEnabled() {
  return config.minRv1m > 0 || config.minRv5m > 0 || config.minRv15m > 0;
}

/**
 * Hard gate: min > 0 and (rv is null or rv < min) → blocked (need enough volatility).
 * @returns {{ blocked: boolean, field?: string, value?: number|null, min?: number, rv?: object }}
 */
export function checkVolatilityLimits(signalVol) {
  const limits = [
    { field: 'rv_1m', value: signalVol?.rv_1m, min: config.minRv1m },
    { field: 'rv_5m', value: signalVol?.rv_5m, min: config.minRv5m },
    { field: 'rv_15m', value: signalVol?.rv_15m, min: config.minRv15m },
  ];

  for (const { field, value, min } of limits) {
    if (min > 0 && (value == null || value < min)) {
      return { blocked: true, field, value, min, rv: signalVol };
    }
  }

  return { blocked: false, rv: signalVol };
}

function formatRvValue(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  return Number(value).toFixed(6);
}

function formatRvLine(field, value, min) {
  const v = formatRvValue(value);
  if (min > 0) return `${field}: <b>${v}</b> (下限 ${min})`;
  return `${field}: <b>${v}</b>`;
}

/** Telegram HTML block for order / settlement context */
export function formatTelegramBlock(rv) {
  if (!rv) return '\n📉 <b>波动率</b>: 暂无数据';

  return (
    `\n📉 <b>波动率</b> (${rv.barTimeframe})\n` +
    `${formatRvLine('rv_1m', rv.rv_1m, config.minRv1m)}\n` +
    `${formatRvLine('rv_5m', rv.rv_5m, config.minRv5m)}\n` +
    `${formatRvLine('rv_15m', rv.rv_15m, config.minRv15m)}`
  );
}

/** Telegram message when volatility gate skips a cycle */
export function formatSkipTelegramMessage({ signal, signalId, cycleStartTs, volRisk }) {
  const side = signal === 'UP' ? '📈 买涨 UP' : '📉 买跌 DOWN';
  let reasonLine;

  if (volRisk.field === 'rv_fetch') {
    reasonLine = `原因: K 线拉取失败 (${volRisk.error ?? 'unknown'})`;
  } else if (volRisk.value == null) {
    reasonLine = `触发: <b>${volRisk.field}</b> 样本不足 (下限 ${volRisk.min})`;
  } else {
    reasonLine = `触发: <b>${volRisk.field}</b> = ${formatRvValue(volRisk.value)} < 下限 ${volRisk.min}`;
  }

  return (
    `⛔ <b>波动率过低 — 跳过下单</b>\n` +
    `信号: <b>${side}</b> (${signalId})\n` +
    `${reasonLine}\n` +
    `窗口: ${formatBeijingTime(cycleStartTs)}` +
    formatTelegramBlock(volRisk.rv)
  );
}
