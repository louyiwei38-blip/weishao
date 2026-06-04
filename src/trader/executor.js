import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient } from '@polymarket/builder-relayer-client';
import {
  AssetType,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
} from '@polymarket/clob-client-v2';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../config.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const TRADE_LOG = join(LOGS_DIR, 'trades.jsonl');
const RELAYER_URL = 'https://relayer-v2.polymarket.com';

let clobClient = null;
let walletMeta = null;

const SIGNATURE_TYPES = [
  { type: SignatureTypeV2.POLY_1271, label: 'POLY_1271' },
  { type: SignatureTypeV2.POLY_PROXY, label: 'POLY_PROXY' },
  { type: SignatureTypeV2.POLY_GNOSIS_SAFE, label: 'POLY_GNOSIS_SAFE' },
  { type: SignatureTypeV2.EOA, label: 'EOA' },
];

function parseRawBalance(resp) {
  return Number(resp?.balance ?? 0) / 1_000_000;
}

async function resolveFunderAddress(walletClient, signerAddress) {
  if (config.poly.funderAddress) return config.poly.funderAddress;

  try {
    const relayer = new RelayClient(RELAYER_URL, config.poly.chainId, walletClient);
    const depositWallet = await relayer.deriveDepositWalletAddress();
    logger.info('[executor] derived deposit wallet', { signer: signerAddress, funder: depositWallet });
    return depositWallet;
  } catch (err) {
    logger.warn('[executor] deposit wallet derive failed, trying gamma profile', { error: err?.message });
  }

  const url = `${config.poly.gammaApi}/public-profile?address=${signerAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gamma public-profile ${res.status}`);

  const data = await res.json();
  const proxy = data?.proxyWallet;
  if (!proxy) {
    throw new Error(
      `No Polymarket funder wallet for ${signerAddress}. Deposit on polymarket.com first.`
    );
  }
  logger.info('[executor] resolved funder from gamma', { signer: signerAddress, funder: proxy });
  return proxy;
}

function buildClobClient(walletClient, creds, signatureType, funderAddress) {
  const useFunder = signatureType !== SignatureTypeV2.EOA ? funderAddress : undefined;
  return new ClobClient({
    host: config.poly.clobHost,
    chain: config.poly.chainId,
    signer: walletClient,
    creds,
    signatureType,
    funderAddress: useFunder,
  });
}

async function probeBalance(walletClient, creds, funderAddress, signatureType) {
  const client = buildClobClient(walletClient, creds, signatureType, funderAddress);
  const resp = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return parseRawBalance(resp);
}

async function resolveWalletSetup(walletClient, signerAddress, creds) {
  const funderAddress = await resolveFunderAddress(walletClient, signerAddress);

  const explicit = process.env.POLY_SIGNATURE_TYPE;
  if (explicit !== undefined && explicit !== '') {
    const signatureType = Number(explicit);
    const label = SIGNATURE_TYPES.find((s) => s.type === signatureType)?.label ?? String(signatureType);
    return { funderAddress, signatureType, signatureLabel: label };
  }

  for (const { type, label } of SIGNATURE_TYPES) {
    try {
      const balance = await probeBalance(walletClient, creds, funderAddress, type);
      if (balance > 0) {
        logger.info('[executor] auto-detected signature type', { label, balance, funder: funderAddress });
        return { funderAddress, signatureType: type, signatureLabel: label };
      }
    } catch (err) {
      logger.debug('[executor] signature probe failed', { label, error: err?.message });
    }
  }

  // New polymarket.com accounts use deposit wallets (POLY_1271).
  return { funderAddress, signatureType: SignatureTypeV2.POLY_1271, signatureLabel: 'POLY_1271' };
}

export async function getClobClient() {
  if (clobClient) return clobClient;

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

  const creds = {
    key: config.poly.apiKey,
    secret: config.poly.apiSecret,
    passphrase: config.poly.passphrase,
  };

  walletMeta = await resolveWalletSetup(walletClient, account.address, creds);
  clobClient = buildClobClient(
    walletClient,
    creds,
    walletMeta.signatureType,
    walletMeta.funderAddress
  );

  logger.info('[executor] ClobClient initialised', {
    host: config.poly.clobHost,
    signer: account.address,
    funder: walletMeta.funderAddress,
    signatureType: walletMeta.signatureLabel,
  });

  try {
    await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (err) {
    logger.warn('[executor] balance cache sync failed', { error: err?.message });
  }

  return clobClient;
}

export async function getBalance() {
  if (config.dryRun) return 9999;

  const client = await getClobClient();
  const resp = await withRetry(
    () => client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    { label: 'getBalance' }
  );

  const balance = parseRawBalance(resp);
  logger.debug('[executor] balance', {
    balance,
    raw: resp?.balance,
    funder: walletMeta?.funderAddress,
    signatureType: walletMeta?.signatureLabel,
  });
  return balance;
}

const orderedThisCycle = new Set();

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

  if (config.dryRun) {
    const dryId = `dry-${Date.now()}`;
    logger.info('[executor] DRY RUN — order simulated', { ...logBase, orderId: dryId });
    writeTradelog({ ...logBase, orderId: dryId, status: 'dry_run' });
    orderedThisCycle.add(dedupKey);
    return { orderId: dryId, skipped: false };
  }

  const client = await getClobClient();
  const negRisk = await client.getNegRisk(tokenID);
  const tickSize = await client.getTickSize(tokenID);
  const orderOpts = { tickSize, negRisk };

  let orderResp;

  if (config.orderType === 'GTC') {
    const price = signal === 'UP'
      ? (yesPrice ?? 0.5)
      : (yesPrice != null ? +(1 - yesPrice).toFixed(4) : 0.5);

    const size = +(actualBet / price).toFixed(2);

    orderResp = await withRetry(
      () => client.createAndPostOrder(
        { tokenID, price, size, side: Side.BUY },
        orderOpts,
        OrderType.GTC
      ),
      { label: 'createOrder (GTC)' }
    );
  } else {
    orderResp = await withRetry(
      () => client.createAndPostMarketOrder(
        { tokenID, amount: actualBet, side: Side.BUY },
        orderOpts,
        OrderType.FOK
      ),
      { label: 'createMarketOrder (FOK)' }
    );
  }

  const orderId = orderResp?.orderID ?? orderResp?.id ?? null;
  const status = orderResp?.status ?? 'unknown';
  const success = orderResp?.success === true;
  const makingAmount = Number(orderResp?.makingAmount ?? 0); // USDC spent
  const takingAmount = Number(orderResp?.takingAmount ?? 0); // shares received
  // On HTTP error the client returns { error, status }; the real reason is in `error`.
  const rawError = orderResp?.error ?? orderResp?.errorMsg ?? '';
  const errorMsg = typeof rawError === 'string' ? rawError : JSON.stringify(rawError);

  logger.info('[executor] order response', {
    orderId, success, status, errorMsg,
    makingAmount, takingAmount,
    raw: JSON.stringify(orderResp)?.slice(0, 600),
    ...logBase,
  });

  // A FOK market order is killed if it cannot fill immediately; the API still
  // returns an orderID. Treat "no fill" / failure as a skip so we neither claim
  // a position nor track a phantom win/loss in the martingale.
  const filled = success && (status === 'matched' || takingAmount > 0);
  if (!filled) {
    logger.warn('[executor] order NOT filled — treating as skipped', {
      orderId, success, status, errorMsg, makingAmount, takingAmount,
    });
    writeTradelog({
      ...logBase, orderId, status: 'unfilled',
      apiStatus: status, success, errorMsg, makingAmount, takingAmount,
    });
    orderedThisCycle.add(dedupKey);
    return { orderId, skipped: true, skipReason: `unfilled:${status}${errorMsg ? ` (${errorMsg})` : ''}` };
  }

  logger.info('[executor] order filled', { orderId, status, makingAmount, takingAmount, ...logBase });
  writeTradelog({
    ...logBase, orderId, status: 'filled',
    apiStatus: status, makingAmount, takingAmount,
  });
  orderedThisCycle.add(dedupKey);

  return { orderId, skipped: false, makingAmount, takingAmount };
}

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

function writeTradelog(entry) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(TRADE_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    logger.error('[executor] failed to write trade log', { error: err?.message });
  }
}
