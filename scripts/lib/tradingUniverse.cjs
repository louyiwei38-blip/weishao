/**
 * Shared trading-universe parser for PM2 ecosystem + tooling.
 * Configure via .env only:
 *   TRADING_SYMBOLS=BTC              (single-symbol default; comma-list still supported)
 *   CANDLE_TIMEFRAMES=5m             (single-timeframe default)
 *
 * Fallback: TRADING_SYMBOL (single) when TRADING_SYMBOLS is empty.
 */
'use strict';

const TF_MINUTES = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
};

function splitList(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @returns {string} e.g. BTC */
function toBase(token) {
  const t = String(token || '').trim().toUpperCase();
  if (!t) return '';
  if (t.includes('/')) return t.split('/')[0].replace(/[^A-Z0-9]/g, '');
  return t.replace(/[^A-Z0-9]/g, '');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} bases e.g. ['BTC','ETH']
 */
function parseTradingSymbolBases(env = process.env) {
  const multi = env.TRADING_SYMBOLS;
  const tokens = multi && String(multi).trim()
    ? splitList(multi)
    : splitList(env.TRADING_SYMBOL || 'BTC/USDT');
  const bases = [];
  const seen = new Set();
  for (const tok of tokens) {
    const base = toBase(tok);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    bases.push(base);
  }
  return bases.length ? bases : ['BTC'];
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<[string, number]>} e.g. [['5m',5],['15m',15],['1h',60]]
 */
function parseCandleTimeframes(env = process.env) {
  const raw = env.CANDLE_TIMEFRAMES || '5m';
  const out = [];
  const seen = new Set();
  for (const tok of splitList(raw)) {
    const tf = String(tok).trim().toLowerCase();
    const minutes = TF_MINUTES[tf];
    if (!minutes || seen.has(tf)) continue;
    seen.add(tf);
    out.push([tf, minutes]);
  }
  return out.length ? out : [['5m', 5]];
}

/**
 * Strategies to run as separate PM2 processes (same symbols × timeframes).
 * STRATEGIES=vegas,jz  (default: vegas only)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} e.g. ['vegas'] | ['vegas','jz']
 */
function parseStrategies(env = process.env) {
  const raw = env.STRATEGIES || env.STRATEGY_LIST || 'vegas';
  const out = [];
  const seen = new Set();
  for (const tok of splitList(raw)) {
    const s = String(tok).trim().toLowerCase();
    if (s !== 'vegas' && s !== 'jz') continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length ? out : ['vegas'];
}

/** @returns {{ id: string, name: string, base: string, tf: string, minutes: number, strategy: string }[]} */
function buildInstances(env = process.env) {
  const bases = parseTradingSymbolBases(env);
  const tfs = parseCandleTimeframes(env);
  const strategies = parseStrategies(env);
  const instances = [];
  for (const strategy of strategies) {
    for (const base of bases) {
      for (const [tf, minutes] of tfs) {
        const suffix = strategy === 'jz' ? '-jz' : '';
        instances.push({
          id: `${base.toLowerCase()}-${tf}${suffix}`,
          name: `${base} ${tf}${strategy === 'jz' ? ' 九转' : ''}`,
          base,
          tf,
          minutes,
          strategy,
        });
      }
    }
  }
  return instances;
}

module.exports = {
  TF_MINUTES,
  toBase,
  parseTradingSymbolBases,
  parseCandleTimeframes,
  parseStrategies,
  buildInstances,
};