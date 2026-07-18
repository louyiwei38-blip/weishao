/**
 * Shared bankroll (P / N) across all symbol × timeframe instances of the same wallet.
 *
 * P = principal, locked from Portfolio when missing; re-locked from live Portfolio on max-loss halt
 * N = net wins-losses, start 0; +1 win / -1 loss on confirmed settlement only; reset to 0 on max-loss halt
 *
 * Sizing (every shot, including MG_CONT):
 *   Bal >= P + N*step  -> stake = defaultBet (TRADE_BUDGET_USD)
 *   else gap = target − Bal; multi-step catch-up:
 *     gap ≤ 5   -> T = gap       (一次补齐)
 *     gap ≤ 15  -> T = gap / 2   (补一半)
 *     gap > 15  -> T = gap / 3   (补 1/3；含 >30 继续分批)
 *     then T = min(T, catchUpCap)
 *     stake = defaultBet + T * p / (1-p)   // 默认首注 + 追赶仓，不得只下追赶差额
 *   then stake = min(stake, stakeMax, availableBalance)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = join(LOGS_DIR, 'bankroll-state.json');
const LOCK_FILE = `${STATE_FILE}.lock`;

/** @type {{ principal: number|null, netCount: number, updatedAt: string|null }} */
let cache = {
  principal: null,
  netCount: 0,
  updatedAt: null,
};

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function withLock(fn) {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  for (let i = 0; i < 80; i += 1) {
    let fd;
    try {
      fd = openSync(LOCK_FILE, 'wx');
    } catch {
      sleepSync(25);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(LOCK_FILE);
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error('bankroll lock timeout');
}

function readDisk() {
  if (!existsSync(STATE_FILE)) {
    return { principal: null, netCount: 0, updatedAt: null };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      principal: Number.isFinite(Number(raw.principal)) ? Number(raw.principal) : null,
      netCount: Number.isFinite(Number(raw.netCount)) ? Math.trunc(Number(raw.netCount)) : 0,
      updatedAt: raw.updatedAt ?? null,
    };
  } catch {
    logger.warn('[bankroll] state parse failed, reset');
    return { principal: null, netCount: 0, updatedAt: null };
  }
}

function writeDisk(state) {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const payload = {
    principal: state.principal,
    netCount: state.netCount,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  cache = { ...payload };
}

function reload() {
  cache = readDisk();
  return cache;
}

export function init() {
  withLock(() => {
    reload();
    logger.info('[bankroll] loaded', { ...cache, file: STATE_FILE });
  });
}

/**
 * Ensure principal P is recorded. First writer wins; later calls keep existing P.
 * @param {number} balance
 */
export function ensurePrincipal(balance) {
  const bal = Number(balance);
  if (!Number.isFinite(bal) || bal < 0) return getState();

  return withLock(() => {
    reload();
    if (cache.principal == null) {
      cache.principal = Math.round(bal * 1e6) / 1e6;
      writeDisk(cache);
      logger.info('[bankroll] principal locked', {
        principal: cache.principal,
        fromBalance: bal,
      });
    }
    return getState();
  });
}

export function getState() {
  if (cache.principal == null && existsSync(STATE_FILE)) reload();
  const step = config.bankroll.stepUsd;
  const P = cache.principal;
  const N = cache.netCount;
  return {
    principal: P,
    netCount: N,
    stepUsd: step,
    targetBalance: P == null ? null : P + N * step,
    nextTargetBalance: P == null ? null : P + (N + 1) * step,
    defaultBetUsd: config.tradeBudgetUsd,
    catchUpProfitCapUsd: config.bankroll.catchUpProfitCapUsd,
    stakeMaxUsd: config.bankroll.stakeMaxUsd,
    catchUpGapFullUsd: config.bankroll.catchUpGapFullUsd,
    catchUpGapHalfUsd: config.bankroll.catchUpGapHalfUsd,
    catchUpGapThirdUsd: config.bankroll.catchUpGapThirdUsd,
    updatedAt: cache.updatedAt,
  };
}

/**
 * Map gap = target − Portfolio → catch-up fraction of that gap.
 * Defaults: ≤5 → 1; ≤15 → 1/2; else → 1/3.
 * @param {number} gapUsd
 * @returns {{ fraction: number, label: string, tier: 'full'|'half'|'third' }}
 */
export function resolveCatchUpFraction(gapUsd) {
  const gap = Number(gapUsd);
  const fullAt = Number(config.bankroll.catchUpGapFullUsd) || 5;
  const halfAt = Number(config.bankroll.catchUpGapHalfUsd) || 15;
  // gap ≤ thirdUsd and gap > thirdUsd both use 1/3 (分批回补)

  if (!(gap > 0) || gap <= fullAt) {
    return { fraction: 1, label: '一次补齐', tier: 'full' };
  }
  if (gap <= halfAt) {
    return { fraction: 0.5, label: '补一半', tier: 'half' };
  }
  return { fraction: 1 / 3, label: '补1/3', tier: 'third' };
}

/**
 * @param {{ balance: number, entryPrice: number|null|undefined }} args
 */
export function computeStake({ balance, entryPrice }) {
  const step = config.bankroll.stepUsd;
  const defaultBet = config.tradeBudgetUsd;
  const tCap = config.bankroll.catchUpProfitCapUsd;
  const stakeMax = Math.min(config.bankroll.stakeMaxUsd, config.maxBetUsd);
  const bal = Number(balance);
  const p = Number(entryPrice);

  const st = getState();
  const P = st.principal;

  const clampStake = (raw) => {
    let s = Math.max(0, Number(raw) || 0);
    s = Math.min(s, stakeMax);
    if (Number.isFinite(bal) && bal >= 0) s = Math.min(s, bal);
    return Math.round(s * 100) / 100;
  };

  const sharesOf = (stake, price) => {
    if (!(price > 0 && price < 1) || !(stake > 0)) return null;
    return Math.round((stake / price) * 1e6) / 1e6;
  };

  if (P == null || !Number.isFinite(bal)) {
    const stakeUsd = clampStake(defaultBet);
    return {
      stakeUsd,
      shares: sharesOf(stakeUsd, p),
      mode: 'fallback_default',
      targetProfitUsd: null,
      targetBalance: null,
      gapUsd: null,
      catchUpFraction: null,
      catchUpTier: null,
      entryPrice: Number.isFinite(p) ? p : null,
    };
  }

  const N = st.netCount;
  const targetBalance = P + N * step;
  const gapUsd = targetBalance - bal;

  if (bal >= targetBalance) {
    const stakeUsd = clampStake(defaultBet);
    return {
      stakeUsd,
      shares: sharesOf(stakeUsd, p),
      mode: 'default',
      targetProfitUsd: null,
      targetBalance,
      gapUsd: Math.round((bal - targetBalance) * 100) / 100,
      catchUpFraction: null,
      catchUpTier: null,
      entryPrice: Number.isFinite(p) ? p : null,
    };
  }

  // Multi-step: recover a fraction of current gap (not full jump to next target)
  const gap = Math.round(gapUsd * 100) / 100;
  if (!(gap > 0)) {
    const stakeUsd = clampStake(defaultBet);
    return {
      stakeUsd,
      shares: sharesOf(stakeUsd, p),
      mode: 'fallback_default',
      targetProfitUsd: null,
      targetBalance,
      gapUsd: gap,
      catchUpFraction: null,
      catchUpTier: null,
      entryPrice: Number.isFinite(p) ? p : null,
    };
  }

  const plan = resolveCatchUpFraction(gap);
  let T = gap * plan.fraction;
  T = Math.min(T, tCap);
  T = Math.round(T * 100) / 100;

  if (!(T > 0)) {
    const stakeUsd = clampStake(defaultBet);
    return {
      stakeUsd,
      shares: sharesOf(stakeUsd, p),
      mode: 'fallback_default',
      targetProfitUsd: null,
      targetBalance,
      gapUsd: gap,
      catchUpFraction: plan.fraction,
      catchUpTier: plan.tier,
      entryPrice: Number.isFinite(p) ? p : null,
    };
  }

  if (!(p > 0 && p < 1)) {
    const stakeUsd = clampStake(defaultBet);
    return {
      stakeUsd,
      shares: sharesOf(stakeUsd, p),
      mode: 'fallback_default',
      targetProfitUsd: T,
      targetBalance,
      gapUsd: gap,
      catchUpFraction: plan.fraction,
      catchUpTier: plan.tier,
      entryPrice: null,
    };
  }

  // Catch-up stake is ADDITIVE to the default bet (not a replacement).
  // Winning recovers ~defaultBet*(1-p)/p toward the next step PLUS T of the gap.
  const catchUpStake = T * (p / (1 - p));
  const rawStake = defaultBet + catchUpStake;
  const stakeUsd = clampStake(rawStake);
  return {
    stakeUsd,
    shares: sharesOf(stakeUsd, p),
    mode: 'catch_up',
    targetProfitUsd: T,
    targetBalance,
    gapUsd: gap,
    catchUpFraction: plan.fraction,
    catchUpTier: plan.tier,
    catchUpLabel: plan.label,
    catchUpStakeUsd: Math.round(catchUpStake * 100) / 100,
    defaultBetUsd: defaultBet,
    entryPrice: p,
  };
}

/**
 * Recompute catch-up stake at a final book price (no fee).
 * Used when sizing price was lower than the GTC submit price (case 1).
 * Matches computeStake catch_up: defaultBet + T * p / (1-p).
 * @param {{ targetProfitUsd: number, entryPrice: number, balance?: number }} args
 */
export function stakeFromTargetProfit({ targetProfitUsd, entryPrice, balance = Infinity }) {
  const T = Number(targetProfitUsd);
  const p = Number(entryPrice);
  const bal = Number(balance);
  const defaultBet = config.tradeBudgetUsd;
  const stakeMax = Math.min(config.bankroll.stakeMaxUsd, config.maxBetUsd);

  if (!(T > 0) || !(p > 0 && p < 1)) {
    return { stakeUsd: 0, shares: null, targetProfitUsd: T || null };
  }

  let stakeUsd = defaultBet + T * (p / (1 - p));
  stakeUsd = Math.min(stakeUsd, stakeMax);
  if (Number.isFinite(bal) && bal >= 0) stakeUsd = Math.min(stakeUsd, bal);
  stakeUsd = Math.round(stakeUsd * 100) / 100;
  const shares = Math.round((stakeUsd / p) * 1e6) / 1e6;
  return { stakeUsd, shares, targetProfitUsd: T };
}

/**
 * Case 1 (sizingPrice < finalPrice): need top-up = recomputedStake − originalStake.
 * Case 2 (sizingPrice >= finalPrice): no top-up.
 *
 * @returns {{
 *   needTopUp: boolean,
 *   topUpUsd: number,
 *   neededStakeUsd: number,
 *   originalStakeUsd: number,
 *   reason: string,
 *   sizingPrice?: number,
 *   finalPrice?: number,
 *   targetProfitUsd?: number,
 * }}
 */
export function computeCatchUpTopUp({
  mode,
  targetProfitUsd,
  sizingPrice,
  finalPrice,
  originalStakeUsd,
  balance = Infinity,
}) {
  const original = Math.max(0, Number(originalStakeUsd) || 0);
  const p0 = Number(sizingPrice);
  const p1 = Number(finalPrice);

  if (mode !== 'catch_up' || !(Number(targetProfitUsd) > 0)) {
    return {
      needTopUp: false,
      topUpUsd: 0,
      neededStakeUsd: original,
      originalStakeUsd: original,
      reason: 'not_catch_up',
    };
  }
  if (!(p0 > 0 && p0 < 1) || !(p1 > 0 && p1 < 1)) {
    return {
      needTopUp: false,
      topUpUsd: 0,
      neededStakeUsd: original,
      originalStakeUsd: original,
      reason: 'bad_price',
    };
  }

  // Case 2: sizing price not lower than final — leave as-is
  if (p0 >= p1) {
    return {
      needTopUp: false,
      topUpUsd: 0,
      neededStakeUsd: original,
      originalStakeUsd: original,
      reason: 'case2_no_op',
    };
  }

  // Case 1: place original first, then top up difference at final price
  const balLeft = Number.isFinite(Number(balance))
    ? Math.max(0, Number(balance) - original)
    : Infinity;
  const recomputed = stakeFromTargetProfit({
    targetProfitUsd,
    entryPrice: p1,
    balance: Number.isFinite(Number(balance)) ? Number(balance) : Infinity,
  });
  const neededStakeUsd = recomputed.stakeUsd;
  let topUpUsd = Math.round((neededStakeUsd - original) * 100) / 100;
  if (Number.isFinite(balLeft)) topUpUsd = Math.min(topUpUsd, balLeft);
  topUpUsd = Math.max(0, topUpUsd);

  return {
    needTopUp: topUpUsd >= 0.01,
    topUpUsd,
    neededStakeUsd,
    originalStakeUsd: original,
    reason: 'case1_top_up',
    sizingPrice: p0,
    finalPrice: p1,
    targetProfitUsd: Number(targetProfitUsd),
  };
}

/** @deprecated use computeCatchUpTopUp — kept for callers expecting old shape */
export function adjustStakeForFinalPrice(args) {
  const t = computeCatchUpTopUp(args);
  return {
    stakeUsd: t.needTopUp ? t.neededStakeUsd : t.originalStakeUsd,
    sharesHint: null,
    adjusted: t.needTopUp,
    reason: t.reason,
    sizingPrice: t.sizingPrice,
    finalPrice: t.finalPrice,
    targetProfitUsd: t.targetProfitUsd,
    topUpUsd: t.topUpUsd,
    neededStakeUsd: t.neededStakeUsd,
    originalStakeUsd: t.originalStakeUsd,
  };
}

/**
 * @param {boolean} won
 */
export function onSettled(won) {
  return withLock(() => {
    reload();
    cache.netCount += won ? 1 : -1;
    writeDisk(cache);
    logger.info('[bankroll] netCount updated', {
      won,
      netCount: cache.netCount,
      principal: cache.principal,
      target:
        cache.principal == null
          ? null
          : cache.principal + cache.netCount * config.bankroll.stepUsd,
    });
    return { netCount: cache.netCount, principal: cache.principal };
  });
}

/**
 * Max-loss halt: re-lock P from current Portfolio and reset N to 0.
 * Skips the usual ±1 netCount for this settlement (epoch restart).
 * @param {number|null|undefined} balance Portfolio (Cash + positions)
 * @returns {{ netCount: number, principal: number|null, reset: true, principalUpdated: boolean }}
 */
export function resetOnMaxLossHalt(balance) {
  return withLock(() => {
    reload();
    const prev = { principal: cache.principal, netCount: cache.netCount };
    const bal = Number(balance);
    let principalUpdated = false;

    if (Number.isFinite(bal) && bal >= 0) {
      cache.principal = Math.round(bal * 1e6) / 1e6;
      principalUpdated = true;
    } else {
      logger.warn('[bankroll] max-loss halt: invalid Portfolio — principal unchanged', {
        balance,
        prevPrincipal: prev.principal,
        prevNetCount: prev.netCount,
      });
    }

    cache.netCount = 0;
    writeDisk(cache);
    logger.warn('[bankroll] max-loss halt — reset principal + netCount', {
      prevPrincipal: prev.principal,
      prevNetCount: prev.netCount,
      principal: cache.principal,
      netCount: cache.netCount,
      principalUpdated,
      fromBalance: principalUpdated ? bal : null,
      target:
        cache.principal == null
          ? null
          : cache.principal + cache.netCount * config.bankroll.stepUsd,
    });
    return {
      netCount: cache.netCount,
      principal: cache.principal,
      reset: true,
      principalUpdated,
    };
  });
}

export function formatBankrollTelegramLines(sizing = null) {
  const st = getState();
  const P = st.principal;
  const N = st.netCount;
  const target = st.targetBalance;
  let line =
    `资金: 本金 $${P != null ? P.toFixed(2) : '—'} · 净胜负 ${N}` +
    (target != null ? ` · 目标 $${target.toFixed(2)}` : '') +
    `\n`;
  if (sizing?.mode === 'catch_up') {
    const frac =
      sizing.catchUpFraction != null
        ? ` · ${sizing.catchUpLabel || '回补'}${
            sizing.gapUsd != null ? ` gap$${Number(sizing.gapUsd).toFixed(2)}` : ''
          }`
        : '';
    const basePart =
      sizing.defaultBetUsd != null
        ? `默认$${Number(sizing.defaultBetUsd).toFixed(2)}`
        : `默认$${Number(config.tradeBudgetUsd).toFixed(2)}`;
    const catchPart =
      sizing.catchUpStakeUsd != null
        ? `+追赶$${Number(sizing.catchUpStakeUsd).toFixed(2)}`
        : '';
    line +=
      `动态首注: 追赶 T=$${Number(sizing.targetProfitUsd).toFixed(2)}${frac}` +
      ` → ${basePart}${catchPart}` +
      ` = $${Number(sizing.stakeUsd).toFixed(2)}` +
      (sizing.shares != null ? ` · ~${sizing.shares.toFixed(2)} shares` : '') +
      `\n`;
  } else if (sizing) {
    line += `动态首注: 默认 $${Number(sizing.stakeUsd).toFixed(2)}\n`;
  }
  return line;
}
