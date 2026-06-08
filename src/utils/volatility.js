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

function formatRvValue(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  return Number(value).toFixed(6);
}

/**
 * Classify volatility regime for strategy direction.
 * High: rv_5m >= RV_5M_THRESHOLD OR rv_15m >= RV_15M_THRESHOLD → continuation
 * Low:  rv_5m < RV_5M_THRESHOLD AND rv_15m < RV_15M_THRESHOLD → reversal
 * Partial sample: default to high (continuation)
 * @returns {{ regime: 'high' | 'low', reason: string, partial?: boolean }}
 */
export function classifyVolatilityRegime(signalVol) {
  const thresh5 = config.rv5mThreshold;
  const thresh15 = config.rv15mThreshold;
  const rv5 = signalVol?.rv_5m;
  const rv15 = signalVol?.rv_15m;

  const highBy5 = rv5 != null && rv5 >= thresh5;
  const highBy15 = rv15 != null && rv15 >= thresh15;

  if (highBy5 || highBy15) {
    const trigger = [
      highBy5 ? `rv_5m=${formatRvValue(rv5)} 不低于 ${thresh5}` : null,
      highBy15 ? `rv_15m=${formatRvValue(rv15)} 不低于 ${thresh15}` : null,
    ].filter(Boolean).join(' 或 ');
    return {
      regime: 'high',
      reason: `${trigger} → 高波动延续`,
    };
  }

  const lowBy5 = rv5 != null && rv5 < thresh5;
  const lowBy15 = rv15 != null && rv15 < thresh15;

  if (lowBy5 && lowBy15) {
    return {
      regime: 'low',
      reason: `rv_5m=${formatRvValue(rv5)} 低于 ${thresh5} 且 rv_15m=${formatRvValue(rv15)} 低于 ${thresh15} → 低波动反转`,
    };
  }

  return {
    regime: 'high',
    reason: `rv 样本不完整 (rv_5m=${formatRvValue(rv5)}, rv_15m=${formatRvValue(rv15)})，默认高波动延续`,
    partial: true,
  };
}

const REGIME_ZH = { high: '高波动·延续', low: '低波动·反转' };

/** Structured fields for logger / heartbeat / jsonl */
export function formatLogFields(volCtx) {
  if (!volCtx) return {};
  return {
    volRegime: volCtx.regime ?? null,
    volRegimeReason: volCtx.regimeReason ?? null,
    rv_1m: volCtx.rv?.rv_1m ?? null,
    rv_5m: volCtx.rv?.rv_5m ?? null,
    rv_15m: volCtx.rv?.rv_15m ?? null,
    rv5mThreshold: config.rv5mThreshold,
    rv15mThreshold: config.rv15mThreshold,
    volBarTimeframe: volCtx.rv?.barTimeframe ?? config.volatilityBarTimeframe,
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
        }
      : null,
    volRegime: volCtx.regime ?? null,
    volRegimeReason: volCtx.regimeReason ?? null,
  };
}

function formatRvLine(field, value, threshold) {
  const v = formatRvValue(value);
  if (threshold == null) return `${field}: <b>${v}</b>`;
  return `${field}: <b>${v}</b> (阈值 ${threshold})`;
}

/** Telegram HTML block for order / settlement context */
export function formatTelegramBlock(rv, volRegime) {
  if (!rv) return '\n📉 <b>波动率</b>: 暂无数据';

  const regimeLine = volRegime
    ? `\n模式: <b>${REGIME_ZH[volRegime] ?? volRegime}</b>`
    : '';

  return (
    `\n📉 <b>波动率</b> (${rv.barTimeframe})${regimeLine}\n` +
    `${formatRvLine('rv_1m', rv.rv_1m, null)}\n` +
    `${formatRvLine('rv_5m', rv.rv_5m, config.rv5mThreshold)}\n` +
    `${formatRvLine('rv_15m', rv.rv_15m, config.rv15mThreshold)}`
  );
}
