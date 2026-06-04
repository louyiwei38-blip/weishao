import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../config.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR  = join(__dirname, '..', '..', 'logs');
const TRADE_LOG = join(LOGS_DIR, 'trades.jsonl');

let clobClient = null;

// ─────────────────────────────────────────
// CLOB client initialisation
// ─────────────────────────────────────────

async function getClobClient() {
  if (clobClient) return clobClient;

  const { ClobClient, SignatureType } = await import('@polymarket/clob-client');

  const pk = config.poly.privateKey;
  if (!pk) throw new Error('POLY_PRIVATE_KEY is not set (check encrypted key + POLY_KEY_PASSWORD)');

  const { apiKey: key, apiSecret, passphrase } = config.poly;
  const missing = [];
  if (!key) missing.push('POLY_API_KEY');
  if (!apiSecret) missing.push('POLY_API_SECRET');
  if (!passphrase) missing.push('POLY_PASSPHRASE');
  if (missing.length) {
    throw new Error(
      `Polymarket API missing: ${missing.join(', ')}. Run: node scripts/create-api-key.js`
    );
  }

  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  // constructor(host, chainId, signer, creds, signatureType, ...)
  clobClient = new ClobClient(
    config.poly.clobHost,
    config.poly.chainId,
    walletClient,
    {
      key: config.poly.apiKey,
      secret: config.poly.apiSecret,
      passphrase: config.poly.passphrase,
    },
    SignatureType.EOA
  );

  logger.info('[executor] ClobClient initialised', {
    host: config.poly.clobHost,
    address: account.address,
  });
  return clobClient;
}

// ─────────────────────────────────────────
// Balance
// ─────────────────────────────────────────

/**
 * Return the pUSD / USDC balance.
 * @returns {Promise<number>}
 */
export async function getBalance() {
  if (config.dryRun) return 9999;

  const client = await getClobClient();
  const resp = await withRetry(
    () => client.getBalanceAllowance({ asset_type: 'COLLATERAL' }),
    { label: 'getBalance' }
  );

  // resp shape: { balance: string, allowance: string }
  const balance = Number(resp?.balance ?? 0);
  logger.debug('[executor] balance', { balance });
  return balance;
}

// ─────────────────────────────────────────
// Order placement
// ─────────────────────────────────────────

/** Dedup guard: set of "conditionId:cycleTs" strings already ordered this run */
const orderedThisCycle = new Set();

/**
 * Place a market (FOK) or limit (GTC) order on Polymarket.
 *
 * @param {{
 *   signal: 'UP' | 'DOWN',
 *   signalId: string,
 *   yesTokenId: string,
 *   noTokenId: string,
 *   conditionId: string,
 *   cycleStartTs: number,
 *   actualBet: number,
 *   baseBet: number,
 *   consecutiveLosses: number,
 *   yesPrice: number | null,
 * }} params
 * @returns {Promise<{ orderId: string | null, skipped: boolean, skipReason?: string }>}
 */
export async function placeOrder(params) {
  const {
    signal, signalId,
    yesTokenId, noTokenId,
    conditionId, cycleStartTs,
    actualBet, baseBet, consecutiveLosses,
    yesPrice,
  } = params;

  const dedupKey = `${conditionId}:${cycleStartTs}`;
  if (orderedThisCycle.has(dedupKey)) {
    logger.warn('[executor] duplicate order prevented', { dedupKey });
    return { orderId: null, skipped: true, skipReason: 'duplicate' };
  }

  const tokenID = signal === 'UP' ? yesTokenId : noTokenId;

  const logBase = {
    ts: new Date().toISOString(),
    conditionId, cycleStartTs,
    signal, signalId, tokenID,
    actualBet, baseBet, consecutiveLosses,
    yesPrice, dryRun: config.dryRun,
  };

  // ── DRY RUN ──
  if (config.dryRun) {
    const dryId = `dry-${Date.now()}`;
    logger.info('[executor] DRY RUN — order simulated', { ...logBase, orderId: dryId });
    writeTradelog({ ...logBase, orderId: dryId, status: 'dry_run' });
    orderedThisCycle.add(dedupKey);
    return { orderId: dryId, skipped: false };
  }

  // ── Real order ──
  const client = await getClobClient();
  const balance = await getBalance();

  let orderResp;

  if (config.orderType === 'GTC') {
    // Limit order
    const price = signal === 'UP'
      ? (yesPrice ?? 0.5)
      : (yesPrice != null ? +(1 - yesPrice).toFixed(4) : 0.5);

    const size = +(actualBet / price).toFixed(2);

    orderResp = await withRetry(
      () => client.createAndPostOrder(
        client.createOrder({ tokenID, price, size, side: 'BUY' })
      ),
      { label: 'createOrder (GTC)' }
    );
  } else {
    // FOK market order
    orderResp = await withRetry(
      () => client.createAndPostMarketOrder({
        tokenID,
        amount: actualBet,
        side: 'BUY',
        feeRateBps: undefined,  // resolved internally
      }, { tickSize: undefined, negRisk: false }),
      { label: 'createMarketOrder (FOK)' }
    );
  }

  const orderId = orderResp?.orderID ?? orderResp?.id ?? String(Date.now());
  logger.info('[executor] order placed', { orderId, ...logBase });
  writeTradelog({ ...logBase, orderId, status: 'placed' });
  orderedThisCycle.add(dedupKey);

  return { orderId, skipped: false };
}

// ─────────────────────────────────────────
// Daily loss tracking
// ─────────────────────────────────────────

let dailyLossUsd = 0;
let dailyLossDate = '';

export function recordLoss(amount) {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyLossDate !== today) {
    dailyLossUsd = 0;
    dailyLossDate = today;
  }
  dailyLossUsd += amount;
  logger.debug('[executor] daily loss tracker', { dailyLossUsd, limit: config.maxDailyLossUsd });
}

export function isDailyLossExceeded() {
  return dailyLossUsd >= config.maxDailyLossUsd;
}

// ─────────────────────────────────────────
// Internal
// ─────────────────────────────────────────

function writeTradelog(entry) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(TRADE_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    logger.error('[executor] failed to write trade log', { error: err?.message });
  }
}
