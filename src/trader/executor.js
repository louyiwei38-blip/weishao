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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../config.js';
import logger from '../utils/logger.js';
import { appendJsonl } from '../utils/jsonl.js';
import { withRetry, sleep } from '../utils/retry.js';
import { resolveActualFill, formatFillNote } from './fillSync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const TRADE_LOG = join(LOGS_DIR, 'trades.jsonl');
const DAILY_LOSS_FILE = join(LOGS_DIR, 'daily-loss.json');
const RELAYER_URL = 'https://relayer-v2.polymarket.com';

let clobClient = null;
let walletMeta = null;
let initPromise = null;

function hasEnvL2Creds() {
  const { apiKey, apiSecret, passphrase } = config.poly;
  return Boolean(apiKey && apiSecret && passphrase);
}

function envL2Creds() {
  return {
    key: config.poly.apiKey,
    secret: config.poly.apiSecret,
    passphrase: config.poly.passphrase,
  };
}

function bootstrapSignatureType() {
  const explicit = process.env.POLY_SIGNATURE_TYPE;
  if (explicit !== undefined && explicit !== '') {
    return Number(explicit);
  }
  return SignatureTypeV2.POLY_1271;
}

function isUnauthorizedError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.data?.status;
  const msg = String(err?.message ?? '');
  const raw = JSON.stringify(err?.data ?? err?.response?.data ?? {});
  return status === 401 || msg.includes('401') || raw.includes('Unauthorized');
}

async function validateL2Creds(client) {
  try {
    await client.getApiKeys();
    return true;
  } catch (err) {
    if (isUnauthorizedError(err)) return false;
    throw err;
  }
}

async function deriveL2Creds(walletClient, signatureType, funderAddress) {
  const l1 = buildClobClient(walletClient, null, signatureType, funderAddress);
  logger.info('[executor] 正在通过 createOrDeriveApiKey() 派生 L2 API 凭证...');
  const creds = await l1.createOrDeriveApiKey();
  logger.info('[executor] L2 API 凭证就绪（已派生）');
  return creds;
}

async function resolveL2Creds(walletClient, funderAddress) {
  const bootstrapSig = bootstrapSignatureType();

  if (hasEnvL2Creds()) {
    const creds = envL2Creds();
    logger.info('[executor] 正在验证环境变量中的 L2 API 凭证...');
    const probe = buildClobClient(walletClient, creds, bootstrapSig, funderAddress);
    const valid = await validateL2Creds(probe);
    if (valid) {
      logger.info('[executor] 使用环境变量中的 L2 API 凭证');
      return creds;
    }
    logger.warn('[executor] 环境变量 L2 凭证无效 (401)，回退至 createOrDeriveApiKey()');
  } else {
    logger.info('[executor] 未配置 L2 凭证 — 将调用 createOrDeriveApiKey()');
  }

  return deriveL2Creds(walletClient, bootstrapSig, funderAddress);
}

const SIGNATURE_TYPES = [
  { type: SignatureTypeV2.POLY_1271, label: 'POLY_1271' },
  { type: SignatureTypeV2.POLY_PROXY, label: 'POLY_PROXY' },
  { type: SignatureTypeV2.POLY_GNOSIS_SAFE, label: 'POLY_GNOSIS_SAFE' },
  { type: SignatureTypeV2.EOA, label: 'EOA' },
];

function parseRawBalance(resp) {
  return Number(resp?.balance ?? 0) / 1_000_000;
}

function resolveExecutionMode() {
  const ot = (config.orderType || 'FOK').toUpperCase();
  if (ot === 'FOK') return { mode: 'market', orderType: OrderType.FOK, label: 'FOK' };
  if (ot === 'FAK') return { mode: 'market', orderType: OrderType.FAK, label: 'FAK' };
  if (ot === 'GTD') return { mode: 'limit', orderType: OrderType.GTD, label: 'GTD' };
  return { mode: 'limit', orderType: OrderType.GTC, label: 'GTC' };
}

function roundToTick(value, tickSize, up = false) {
  const tick = parseFloat(tickSize) || 0.01;
  const steps = value / tick;
  const n = up ? Math.ceil(steps) : Math.floor(steps);
  return parseFloat((n * tick).toFixed(4));
}

async function resolveOrderOptions(client, tokenID) {
  const negRisk = await client.getNegRisk(tokenID).catch(() => false);
  const tickSize = await client.getTickSize(tokenID).catch(() => undefined);
  return { tickSize, negRisk };
}

/** Best ask + tick offset — same price used for limit orders. */
async function resolveExpectedEntryPrice(client, tokenID) {
  const { tickSize } = await resolveOrderOptions(client, tokenID);
  let book;
  try {
    book = await withRetry(
      () => client.getOrderBook(tokenID),
      { label: 'getOrderBook', maxAttempts: 2, baseDelayMs: 500 }
    );
  } catch {
    return { entryPrice: null, error: 'book_fetch_failed' };
  }

  const asks = [...(book.asks || [])].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  if (!asks.length) {
    return { entryPrice: null, error: 'no_asks' };
  }

  const tick = parseFloat(tickSize) || 0.01;
  const offset = config.limitPriceOffsetTicks || 0;
  let price = parseFloat(asks[0].price) + offset * tick;
  price = roundToTick(price, tickSize, true);
  price = Math.min(0.99, Math.max(tick, price));
  const minOrderSize = parseFloat(book.min_order_size || '0') || 0;
  return { entryPrice: price, minOrderSize, tickSize: String(tickSize), error: null };
}

/**
 * CLOB may return { error, orderID } without throwing.
 * Limit GTC: orderID without error = posted (may be resting).
 */
function parseOrderResponse(raw, { isLimit = false } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, orderId: null, reason: 'empty CLOB response' };
  }

  const orderId = raw.orderID ?? raw.orderId ?? raw.id ?? null;
  const errText = raw.error ?? raw.errorMsg ?? '';
  if (errText) {
    return { ok: false, orderId, reason: String(errText) };
  }
  if (raw.success === false) {
    return { ok: false, orderId, reason: raw.errorMsg || 'order rejected (success=false)' };
  }

  const taking = parseFloat(raw.takingAmount || 0);
  const making = parseFloat(raw.makingAmount || 0);
  const hasFill = taking > 0 || making > 0;

  if (isLimit) {
    if (orderId) {
      return { ok: true, orderId, resting: !hasFill, takingAmount: taking, makingAmount: making };
    }
    return { ok: false, orderId: null, reason: 'limit order missing orderID' };
  }

  if (raw.success === true || hasFill) {
    return { ok: true, orderId, resting: false, takingAmount: taking, makingAmount: making };
  }

  const status = String(raw.status || '').toLowerCase();
  if (/kill|cancel|reject|fail|expir|dead/.test(status)) {
    return { ok: false, orderId, reason: `status=${raw.status}` };
  }

  if (orderId) {
    return { ok: false, orderId, reason: 'FOK unfilled (no fill record)' };
  }

  return { ok: false, orderId: null, reason: 'unknown order response' };
}

function buildOrderResult(parsed, actualFill, extras = {}) {
  const usdcSpent = Math.max(0, parseFloat(actualFill?.usdcSpent) || 0);
  return {
    orderId: parsed.orderId,
    skipped: false,
    resting: Boolean(parsed.resting && usdcSpent <= 0),
    usdcSpent,
    makingAmount: parsed.makingAmount ?? 0,
    takingAmount: parsed.takingAmount ?? 0,
    fill: actualFill,
    ...extras,
  };
}

async function resolveFunderAddress(walletClient, signerAddress) {
  if (config.poly.funderAddress) return config.poly.funderAddress;

  try {
    const relayer = new RelayClient(RELAYER_URL, config.poly.chainId, walletClient);
    const depositWallet = await relayer.deriveDepositWalletAddress();
    logger.info('[executor] 已推导 deposit 钱包', { signer: signerAddress, funder: depositWallet });
    return depositWallet;
  } catch (err) {
    logger.warn('[executor] deposit 钱包推导失败，尝试 Gamma 档案', { error: err?.message });
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
  logger.info('[executor] 从 Gamma 解析 funder 地址', { signer: signerAddress, funder: proxy });
  return proxy;
}

function buildClobClient(walletClient, creds, signatureType, funderAddress) {
  const useFunder = signatureType !== SignatureTypeV2.EOA ? funderAddress : undefined;
  const opts = {
    host: config.poly.clobHost,
    chain: config.poly.chainId,
    signer: walletClient,
    signatureType,
    funderAddress: useFunder,
  };
  if (creds) opts.creds = creds;
  return new ClobClient(opts);
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
        logger.info('[executor] 自动探测签名类型', { label, balance, funder: funderAddress });
        return { funderAddress, signatureType: type, signatureLabel: label };
      }
    } catch (err) {
      logger.debug('[executor] 签名类型探测失败', { label, error: err?.message });
    }
  }

  return { funderAddress, signatureType: SignatureTypeV2.POLY_1271, signatureLabel: 'POLY_1271' };
}

async function createClientInstance() {
  const pk = config.poly.privateKey;

  if (config.dryRun && !pk) {
    logger.info('[executor] 空跑模式：匿名只读 CLOB 客户端');
    return new ClobClient({
      host: config.poly.clobHost,
      chain: config.poly.chainId,
    });
  }

  if (!pk) {
    throw new Error('POLY_PRIVATE_KEY is not set (check encrypted key + POLY_KEY_PASSWORD)');
  }

  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  const funderAddress = await resolveFunderAddress(walletClient, account.address);
  const creds = await resolveL2Creds(walletClient, funderAddress);
  walletMeta = await resolveWalletSetup(walletClient, account.address, creds);

  const client = buildClobClient(
    walletClient,
    creds,
    walletMeta.signatureType,
    walletMeta.funderAddress
  );

  logger.info('[executor] ClobClient 已初始化', {
    host: config.poly.clobHost,
    signer: account.address,
    funder: walletMeta.funderAddress,
    signatureType: walletMeta.signatureLabel,
    l2Source: hasEnvL2Creds() ? 'env-or-derived' : 'derived',
    dryRun: config.dryRun,
  });

  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (err) {
    logger.warn('[executor] 余额缓存同步失败', { error: err?.message });
  }

  return client;
}

export async function getClobClient() {
  if (clobClient) return clobClient;

  if (!initPromise) {
    initPromise = createClientInstance()
      .then((client) => {
        clobClient = client;
        return clobClient;
      })
      .catch((err) => {
        initPromise = null;
        clobClient = null;
        throw err;
      });
  }

  return initPromise;
}

export function clobHasL2Creds(client) {
  return Boolean(client?.creds);
}

export async function getBalance() {
  if (config.dryRun) return 9999;

  const client = await getClobClient();
  const resp = await withRetry(
    () => client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    { label: 'getBalance' }
  );

  const balance = parseRawBalance(resp);
  logger.debug('[executor] 余额', {
    balance,
    raw: resp?.balance,
    funder: walletMeta?.funderAddress,
    signatureType: walletMeta?.signatureLabel,
  });
  return balance;
}

const orderedThisCycle = new Set();

export function clearOrderDedup() {
  orderedThisCycle.clear();
}

async function submitMarketOrder(client, params, exec) {
  const {
    tokenID, actualBet, signal, signalId, conditionId, cycleStartTs,
    yesPrice, baseBet, consecutiveLosses, deadlineMs, logBase, dedupKey,
  } = params;

  let parsed = null;
  let orderResp = null;

  for (let attempt = 1; attempt <= config.orderFillAttempts; attempt++) {
    if (deadlineMs && Date.now() >= deadlineMs) {
      logger.warn('[executor] 下单截止时间已到 — 停止重试', { attempt });
      break;
    }

    const orderOpts = await resolveOrderOptions(client, tokenID);

    try {
      orderResp = await client.createAndPostMarketOrder(
        { tokenID, amount: actualBet, side: Side.BUY },
        orderOpts,
        exec.orderType
      );
    } catch (err) {
      orderResp = { error: err?.message ?? String(err) };
    }

    parsed = parseOrderResponse(orderResp, { isLimit: false });
    logger.info('[executor] 市价单响应', {
      attempt, ...parsed, raw: JSON.stringify(orderResp)?.slice(0, 600), ...logBase,
    });

    if (parsed.ok) break;

    if (attempt < config.orderFillAttempts) {
      logger.warn('[executor] 市价单未成交 — 重试中', {
        attempt, reason: parsed.reason, retryInMs: config.orderRetryDelayMs,
      });
      const delay = deadlineMs
        ? Math.min(config.orderRetryDelayMs, Math.max(0, deadlineMs - Date.now()))
        : config.orderRetryDelayMs;
      if (delay <= 0) break;
      await sleep(delay);
    }
  }

  if (!parsed?.ok) {
    writeTradelog({
      ...logBase, orderId: parsed?.orderId ?? null, status: 'unfilled',
      orderKind: 'market', reason: parsed?.reason,
    });
    orderedThisCycle.add(dedupKey);
    return {
      orderId: parsed?.orderId ?? null,
      skipped: true,
      skipReason: `unfilled:${parsed?.reason ?? 'unknown'}`,
    };
  }

  const actualFill = await resolveActualFill(client, parsed, {
    orderId: parsed.orderId,
    estUsd: actualBet,
    limitPrice: null,
  });

  if (actualFill.usdcSpent <= 0) {
    writeTradelog({
      ...logBase, orderId: parsed.orderId, status: 'unfilled',
      orderKind: 'market', reason: 'no usdc spent after fill sync',
    });
    orderedThisCycle.add(dedupKey);
    return {
      orderId: parsed.orderId,
      skipped: true,
      skipReason: 'unfilled:no_usdc_spent',
    };
  }

  const result = buildOrderResult(parsed, actualFill, {
    orderKind: 'market',
    orderType: exec.label,
    limitPrice: null,
  });

  logger.info('[executor] 市价单已成交', {
    ...result, fillNote: formatFillNote(actualFill), ...logBase,
  });
  writeTradelog({ ...logBase, orderId: parsed.orderId, status: 'filled', ...result });
  orderedThisCycle.add(dedupKey);
  return result;
}

async function submitLimitOrder(client, params, exec) {
  const {
    tokenID, actualBet, logBase, dedupKey, forceLimitPrice, maxLimitPrice,
  } = params;

  const effectiveMaxPrice = maxLimitPrice
    ?? (config.orderPriceCap > 0 ? config.orderPriceCap : null);

  const orderOpts = await resolveOrderOptions(client, tokenID);
  const quote = await resolveExpectedEntryPrice(client, tokenID);
  const tickSize = quote.tickSize || orderOpts.tickSize || '0.01';
  if (quote.error === 'book_fetch_failed') {
    logger.warn('[executor] 订单簿拉取失败 — 跳过限价单');
    return { orderId: null, skipped: true, skipReason: 'book_fetch_failed' };
  }
  if (quote.entryPrice == null && forceLimitPrice == null) {
    logger.warn('[executor] 订单簿无卖单 — 跳过限价单');
    return { orderId: null, skipped: true, skipReason: 'no_asks' };
  }

  let price;
  if (forceLimitPrice != null) {
    price = roundToTick(forceLimitPrice, tickSize, false);
    logger.info('[executor] 盘口价超阈值 — 按阈值限价挂单', {
      forceLimitPrice: price,
      bookBestAsk: quote.entryPrice,
      orderPriceCap: forceLimitPrice,
    });
  } else {
    price = quote.entryPrice;
    if (effectiveMaxPrice != null && price > effectiveMaxPrice) {
      const capped = roundToTick(effectiveMaxPrice, tickSize, false);
      logger.info('[executor] 订单簿价超阈值 — 限价封顶', {
        bookBestAsk: price,
        cappedPrice: capped,
        orderPriceCap: effectiveMaxPrice,
      });
      price = capped;
    }
  }
  const minSize = quote.minOrderSize || 0;
  let size = roundToTick(actualBet / price, tickSize, false);
  let estCost = price * size;

  if (minSize > 0 && size < minSize) {
    const minCost = minSize * price;
    if (minCost > config.maxBetUsd) {
      logger.warn(
        `[executor] 下注 $${actualBet} 低于最小份额 ${minSize} ` +
        `@ $${price.toFixed(2)}（需约 $${minCost.toFixed(2)}）`
      );
      return { orderId: null, skipped: true, skipReason: 'below_min_size' };
    }
    logger.info(`[executor] 提升至最小份额 ${minSize} 份（约 $${minCost.toFixed(2)}）`);
    size = minSize;
    estCost = minCost;
  }

  logger.info(
    `[executor] 提交限价 ${exec.label} @$${price.toFixed(2)} × ${size} 份（约 $${estCost.toFixed(2)}）`
  );

  let orderResp;
  try {
    orderResp = await withRetry(
      () => client.createAndPostOrder(
        { tokenID, price, size, side: Side.BUY },
        orderOpts,
        exec.orderType
      ),
      { label: 'placeLimitOrder', maxAttempts: 2, baseDelayMs: 1000 }
    );
  } catch (err) {
    logger.error('[executor] 限价单异常', { error: err?.message });
    return { orderId: null, skipped: true, skipReason: `exception:${err?.message}` };
  }

  const parsed = parseOrderResponse(orderResp, { isLimit: true });
  logger.info('[executor] 限价单响应', {
    ...parsed, raw: JSON.stringify(orderResp)?.slice(0, 600), ...logBase,
  });

  if (!parsed.ok) {
    writeTradelog({
      ...logBase, orderId: parsed.orderId, status: 'failed',
      orderKind: 'limit', reason: parsed.reason, limitPrice: price, size,
    });
    orderedThisCycle.add(dedupKey);
    return {
      orderId: parsed.orderId,
      skipped: true,
      skipReason: parsed.reason ?? 'limit_rejected',
    };
  }

  const actualFill = await resolveActualFill(client, parsed, {
    orderId: parsed.orderId,
    estUsd: estCost,
    limitPrice: price,
  });

  const result = buildOrderResult(parsed, actualFill, {
    orderKind: 'limit',
    orderType: exec.label,
    limitPrice: price,
    size,
    estCost,
  });

  const fillTag = result.resting ? '挂单中（等待成交）' : '已成交';
  logger.info(`[executor] 限价单${fillTag}`, {
    ...result, fillNote: formatFillNote(actualFill), ...logBase,
  });

  writeTradelog({
    ...logBase,
    orderId: parsed.orderId,
    status: result.resting ? 'resting' : 'filled',
    ...result,
  });
  orderedThisCycle.add(dedupKey);
  return result;
}

export async function placeOrder(params) {
  const {
    signal, signalId,
    yesTokenId, noTokenId,
    conditionId, cycleStartTs,
    actualBet, baseBet, consecutiveLosses,
    yesPrice, noPrice,
    maxLimitPrice, priceCapped, originalYesPrice,
    deadlineMs,
    volatility,
  } = params;

  const dedupKey = `${conditionId}:${cycleStartTs}`;
  if (orderedThisCycle.has(dedupKey)) {
    logger.warn('[executor] 重复下单已阻止', { dedupKey });
    return { orderId: null, skipped: true, skipReason: 'duplicate' };
  }

  const tokenID = signal === 'UP' ? yesTokenId : noTokenId;
  const exec = resolveExecutionMode();
  // FOK/FAK: market when price <= cap; limit at cap when price exceeds ORDER_PRICE_CAP
  const useLimitOrder = exec.mode === 'limit' || priceCapped;
  const effectiveExec = priceCapped && exec.mode === 'market'
    ? { mode: 'limit', orderType: OrderType.GTC, label: 'GTC' }
    : exec;

  const logBase = {
    ts: new Date().toISOString(),
    conditionId, cycleStartTs,
    signal, signalId, tokenID,
    actualBet, baseBet, consecutiveLosses,
    yesPrice, noPrice, dryRun: config.dryRun,
    orderKind: useLimitOrder ? 'limit' : 'market',
    orderType: effectiveExec.label,
    ...(priceCapped ? { priceCapped, originalYesPrice, maxLimitPrice } : {}),
    ...(volatility ? { volatility } : {}),
  };

  if (config.dryRun) {
    const dryId = `dry-${Date.now()}`;
    logger.info('[executor] 空跑 — 模拟下单', { ...logBase, orderId: dryId });
    writeTradelog({ ...logBase, orderId: dryId, status: 'dry_run' });
    orderedThisCycle.add(dedupKey);
    return {
      orderId: dryId,
      skipped: false,
      resting: useLimitOrder,
      usdcSpent: actualBet,
      orderKind: useLimitOrder ? 'limit' : 'market',
      orderType: effectiveExec.label,
    };
  }

  const client = await getClobClient();
  const effectiveMaxPrice = maxLimitPrice
    ?? (config.orderPriceCap > 0 ? config.orderPriceCap : null);
  const shared = {
    tokenID, actualBet, signal, signalId, conditionId, cycleStartTs,
    yesPrice, noPrice, baseBet, consecutiveLosses, deadlineMs, logBase, dedupKey,
    maxLimitPrice: effectiveMaxPrice,
    forceLimitPrice: priceCapped ? effectiveMaxPrice : null,
  };

  if (useLimitOrder) {
    return submitLimitOrder(client, shared, effectiveExec);
  }
  return submitMarketOrder(client, shared, exec);
}

let dailyLossUsd = 0;
let dailyLossDate = '';

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function loadDailyLoss() {
  if (!existsSync(DAILY_LOSS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(DAILY_LOSS_FILE, 'utf8'));
    const today = utcToday();
    if (data.date === today) {
      dailyLossDate = data.date;
      dailyLossUsd = Number(data.lossUsd) || 0;
      logger.info('[executor] 当日亏损已恢复', { dailyLossUsd, date: dailyLossDate });
    }
  } catch (err) {
    logger.warn('[executor] 读取当日亏损文件失败', { error: err?.message });
  }
}

function persistDailyLoss() {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(
      DAILY_LOSS_FILE,
      JSON.stringify({ date: dailyLossDate, lossUsd: dailyLossUsd }),
      'utf8'
    );
  } catch (err) {
    logger.warn('[executor] 持久化当日亏损失败', { error: err?.message });
  }
}

export function initDailyLoss() {
  loadDailyLoss();
}

export function getDailyLossUsd() {
  return dailyLossUsd;
}

export function recordLoss(amount) {
  const today = utcToday();
  if (dailyLossDate !== today) {
    dailyLossUsd = 0;
    dailyLossDate = today;
  }
  dailyLossUsd += amount;
  persistDailyLoss();
  logger.debug('[executor] 当日亏损追踪', { dailyLossUsd, limit: config.maxDailyLossUsd });
}

export function isDailyLossExceeded() {
  const today = utcToday();
  if (dailyLossDate !== today) return false;
  return dailyLossUsd >= config.maxDailyLossUsd;
}

function writeTradelog(entry) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendJsonl(TRADE_LOG, entry, config.jsonlMaxBytes);
  } catch (err) {
    logger.error('[executor] 写入交易日志失败', { error: err?.message });
  }
}
