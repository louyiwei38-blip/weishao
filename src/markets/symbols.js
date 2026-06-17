/**
 * Polymarket 5m Up/Down 支持的标的。
 * .env 中 TRADING_SYMBOL 选择其一，驱动 OHLCV 信号、Gamma slug、Chainlink 结算。
 */

/** @type {Record<string, { name: string, chainlink: string }>} */
export const POLYMARKET_5M_MARKETS = {
  'BTC/USDT': { name: 'Bitcoin', chainlink: 'btc/usd' },
  'ETH/USDT': { name: 'Ethereum', chainlink: 'eth/usd' },
  'SOL/USDT': { name: 'Solana', chainlink: 'sol/usd' },
  'XRP/USDT': { name: 'XRP', chainlink: 'xrp/usd' },
  'DOGE/USDT': { name: 'Dogecoin', chainlink: 'doge/usd' },
  'HYPE/USDT': { name: 'Hyperliquid', chainlink: 'hype/usd' },
  'BNB/USDT': { name: 'BNB', chainlink: 'bnb/usd' },
};

export const SUPPORTED_TRADING_SYMBOLS = Object.keys(POLYMARKET_5M_MARKETS);

export function getMarketMeta(symbol) {
  return POLYMARKET_5M_MARKETS[symbol] ?? null;
}

/** Polymarket slug base, e.g. ETH/USDT → eth */
export function slugBaseFromSymbol(symbol) {
  const meta = getMarketMeta(symbol);
  if (!meta) return null;
  const [base] = symbol.split('/');
  return base?.toLowerCase() ?? null;
}

export function chainlinkPairFromSymbol(symbol) {
  return getMarketMeta(symbol)?.chainlink ?? null;
}

export function assertSupportedTradingSymbol(symbol) {
  if (!getMarketMeta(symbol)) {
    throw new Error(
      `Unsupported TRADING_SYMBOL "${symbol}". ` +
        `Supported: ${SUPPORTED_TRADING_SYMBOLS.join(', ')}`
    );
  }
}

export function describeTradingSymbol(symbol) {
  const meta = getMarketMeta(symbol);
  if (!meta) return null;
  const slugBase = slugBaseFromSymbol(symbol);
  return {
    symbol,
    name: meta.name,
    chainlink: meta.chainlink,
    slugPattern: `${slugBase}-updown-{timeframe}-{windowStartUnixSec}`,
  };
}
