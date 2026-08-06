/**
 * Shared trading-universe parser for PM2 ecosystem + tooling.
 *
 * Preferred (.env):
 *   TRADING_STREAMS=btc-5m,btc-15m,btc-1h,eth-5m,eth-15m,eth-1h,bnb-15m,bnb-1h,xrp-15m,xrp-1h,sol-15m,sol-1h
 *
 * Legacy fallback (full cartesian product):
 *   TRADING_SYMBOLS=BTC,ETH
 *   CANDLE_TIMEFRAMES=5m,15m,1h
 *
 * Live strategy is always 神奇九转 (jz). All instances share BANKROLL_SCOPE=jz.
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

/** Default 12-stream live universe (shared-book backtest). */
const DEFAULT_TRADING_STREAMS =
  'btc-5m,btc-15m,btc-1h,eth-5m,eth-15m,eth-1h,bnb-15m,bnb-1h,xrp-15m,xrp-1h,sol-15m,sol-1h';

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
 * @param {string} raw e.g. btc-5m
 * @returns {{ id: string, base: string, tf: string, minutes: number }}
 */
function parseStreamToken(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  const m = s.match(/^([a-z0-9]+)-(1m|5m|15m|30m|1h|4h)$/);
  if (!m) throw new Error(`Invalid TRADING_STREAMS entry: ${raw}`);
  const base = m[1].toUpperCase();
  const tf = m[2];
  const minutes = TF_MINUTES[tf];
  if (!minutes) throw new Error(`Unsupported timeframe in stream: ${raw}`);
  return { id: `${base.toLowerCase()}-${tf}`, base, tf, minutes };
}

function hasExplicitStreams(env) {
  return Boolean(env.TRADING_STREAMS && String(env.TRADING_STREAMS).trim());
}

function hasLegacyUniverse(env) {
  return Boolean(
    (env.TRADING_SYMBOLS && String(env.TRADING_SYMBOLS).trim()) ||
      (env.CANDLE_TIMEFRAMES && String(env.CANDLE_TIMEFRAMES).trim()),
  );
}

/**
 * Resolve stream list string for PM2 / tooling.
 * Priority: TRADING_STREAMS → legacy SYMBOLS×TFs (caller builds) → default 12 streams.
 */
function resolveStreamsRaw(env = process.env) {
  if (hasExplicitStreams(env)) return String(env.TRADING_STREAMS).trim();
  if (hasLegacyUniverse(env)) return null;
  return DEFAULT_TRADING_STREAMS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} bases e.g. ['BTC','ETH']
 */
function parseTradingSymbolBases(env = process.env) {
  const streamsRaw = resolveStreamsRaw(env);
  if (streamsRaw) {
    const bases = [];
    const seen = new Set();
    for (const tok of splitList(streamsRaw)) {
      const { base } = parseStreamToken(tok);
      if (seen.has(base)) continue;
      seen.add(base);
      bases.push(base);
    }
    return bases.length ? bases : ['BTC'];
  }
  const multi = env.TRADING_SYMBOLS;
  const tokens =
    multi && String(multi).trim()
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
  const streamsRaw = resolveStreamsRaw(env);
  if (streamsRaw) {
    const out = [];
    const seen = new Set();
    for (const tok of splitList(streamsRaw)) {
      const { tf, minutes } = parseStreamToken(tok);
      if (seen.has(tf)) continue;
      seen.add(tf);
      out.push([tf, minutes]);
    }
    return out.length ? out : [['5m', 5]];
  }
  const raw = env.CANDLE_TIMEFRAMES || '5m,15m,1h';
  const out = [];
  const seen = new Set();
  for (const tok of splitList(raw)) {
    const tf = String(tok).trim().toLowerCase();
    const minutes = TF_MINUTES[tf];
    if (!minutes || seen.has(tf)) continue;
    seen.add(tf);
    out.push([tf, minutes]);
  }
  return out.length ? out : [['5m', 5], ['15m', 15], ['1h', 60]];
}

/**
 * Live strategy list — always 神奇九转.
 * @returns {string[]} always ['jz']
 */
function parseStrategies(_env = process.env) {
  return ['jz'];
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ id: string, name: string, base: string, tf: string, minutes: number, strategy: string }[]}
 */
function buildInstances(env = process.env) {
  const streamsRaw = resolveStreamsRaw(env);
  if (streamsRaw) {
    const instances = [];
    const seen = new Set();
    for (const tok of splitList(streamsRaw)) {
      const { id, base, tf, minutes } = parseStreamToken(tok);
      if (seen.has(id)) continue;
      seen.add(id);
      instances.push({
        id,
        name: `${base} ${tf} 九转`,
        base,
        tf,
        minutes,
        strategy: 'jz',
      });
    }
    return instances;
  }

  const bases = parseTradingSymbolBases(env);
  const tfs = parseCandleTimeframes(env);
  const instances = [];
  for (const base of bases) {
    for (const [tf, minutes] of tfs) {
      instances.push({
        id: `${base.toLowerCase()}-${tf}`,
        name: `${base} ${tf} 九转`,
        base,
        tf,
        minutes,
        strategy: 'jz',
      });
    }
  }
  return instances;
}

module.exports = {
  TF_MINUTES,
  DEFAULT_TRADING_STREAMS,
  toBase,
  parseStreamToken,
  resolveStreamsRaw,
  parseTradingSymbolBases,
  parseCandleTimeframes,
  parseStrategies,
  buildInstances,
};
