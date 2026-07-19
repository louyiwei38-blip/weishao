/**
 * Shared bankroll (P / N / catch-up queue) for the wallet.
 *
 * P = principal, locked from Portfolio on first use (never re-locked on max-loss halt)
 * N = net wins−losses; +1 win / −1 loss on confirmed settlement (kept across max-loss halt)
 * target = P + N × step
 * gap = max(0, target − Portfolio)
 *
 * Catch-up queue (补1, 补2, …):
 *   - No gap & empty queue → stake = defaultBet (TRADE_BUDGET_USD)
 *   - Else play front layer L; win profit T = L + step; stake = T × p/(1−p)
 *   - Loss: keep playing same layer; append 补N = gap − Σ(uncleared)
 *   - Win on layer: clear that layer; advance to next; empty+gap→ new 补1; empty+no gap→ default
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

/** Ignore dust below one cent when comparing / registering layers */
const GAP_EPS = 0.01;

/**
 * @typedef {{ id: number, usd: number }} CatchUpLayer
 * @type {{ principal: number|null, netCount: number, catchUpQueue: CatchUpLayer[], nextLayerId: number, updatedAt: string|null }}
 */
let cache = {
  principal: null,
  netCount: 0,
  catchUpQueue: [],
  nextLayerId: 1,
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

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** @returns {CatchUpLayer[]} */
function normalizeQueue(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (x != null && typeof x === 'object') {
      const usd = round2(x.usd ?? x.amount);
      const id = Math.trunc(Number(x.id));
      if (Number.isFinite(usd) && usd >= GAP_EPS && Number.isFinite(id) && id > 0) {
        out.push({ id, usd });
      }
      continue;
    }
    // Legacy: bare numbers → assign temporary ids 1..n (upgraded on write)
    const usd = round2(x);
    if (Number.isFinite(usd) && usd >= GAP_EPS) {
      out.push({ id: out.length + 1, usd });
    }
  }
  return out;
}

function nextIdFromQueue(queue, hint) {
  const maxId = (queue || []).reduce((m, layer) => Math.max(m, Number(layer.id) || 0), 0);
  const fromHint = Number.isFinite(Number(hint)) ? Math.trunc(Number(hint)) : 1;
  return Math.max(1, maxId + 1, fromHint);
}

function readDisk() {
  if (!existsSync(STATE_FILE)) {
    return { principal: null, netCount: 0, catchUpQueue: [], nextLayerId: 1, updatedAt: null };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const catchUpQueue = normalizeQueue(raw.catchUpQueue);
    return {
      principal: Number.isFinite(Number(raw.principal)) ? Number(raw.principal) : null,
      netCount: Number.isFinite(Number(raw.netCount)) ? Math.trunc(Number(raw.netCount)) : 0,
      catchUpQueue,
      nextLayerId: nextIdFromQueue(catchUpQueue, raw.nextLayerId),
      updatedAt: raw.updatedAt ?? null,
    };
  } catch {
    logger.warn('[bankroll] state parse failed, reset');
    return { principal: null, netCount: 0, catchUpQueue: [], nextLayerId: 1, updatedAt: null };
  }
}

function writeDisk(state) {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const catchUpQueue = normalizeQueue(state.catchUpQueue);
  const payload = {
    principal: state.principal,
    netCount: state.netCount,
    catchUpQueue,
    nextLayerId: nextIdFromQueue(catchUpQueue, state.nextLayerId),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  cache = { ...payload };
}

function reload() {
  cache = readDisk();
  return cache;
}

function queueSum(queue) {
  return round2((queue || []).reduce((a, layer) => a + Number(layer?.usd || 0), 0));
}

/** @returns {{ layer: CatchUpLayer, nextLayerId: number }} */
function makeLayer(usd, nextLayerId) {
  const id = Math.max(1, Math.trunc(Number(nextLayerId) || 1));
  return { layer: { id, usd: round2(usd) }, nextLayerId: id + 1 };
}

function targetOf(P, N) {
  if (P == null) return null;
  return P + N * config.bankroll.stepUsd;
}

function gapOf(P, N, balance) {
  const target = targetOf(P, N);
  const bal = Number(balance);
  if (target == null || !Number.isFinite(bal)) return 0;
  return Math.max(0, round2(target - bal));
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
  const queue = normalizeQueue(cache.catchUpQueue);
  const front = queue[0] ?? null;
  return {
    principal: P,
    netCount: N,
    catchUpQueue: queue,
    catchUpLayerUsd: front?.usd ?? null,
    catchUpLayerIndex: front?.id ?? null,
    stepUsd: step,
    targetBalance: P == null ? null : P + N * step,
    updatedAt: cache.updatedAt,
  };
}

/**
 * Sync queue with live gap before sizing:
 * - gap≈0 → clear queue (debt already gone)
 * - gap>0 & empty queue → open 补1 = gap
 * - gap>0 & queue claims more than live gap → rebuild 补1 = gap
 *   (Portfolio may recover while a stale layer remains; never oversize vs live gap)
 * @param {number} balance
 */
function syncCatchUpQueue(balance) {
  return withLock(() => {
    reload();
    const gap = gapOf(cache.principal, cache.netCount, balance);
    let queue = normalizeQueue(cache.catchUpQueue);
    let nextLayerId = nextIdFromQueue(queue, cache.nextLayerId);
    let changed = false;
    let reason = null;

    if (gap < GAP_EPS) {
      if (queue.length) {
        queue = [];
        nextLayerId = 1;
        changed = true;
        reason = 'gap_cleared';
      }
    } else if (queue.length === 0) {
      const made = makeLayer(gap, 1);
      queue = [made.layer];
      nextLayerId = made.nextLayerId;
      changed = true;
      reason = 'open_补1';
    } else {
      const sum = queueSum(queue);
      const front = queue[0].usd;
      // Stale layers (e.g. 补1=$20 while live gap=$0.15) must not drive sizing
      if (sum - gap > GAP_EPS || front - gap > GAP_EPS) {
        const made = makeLayer(gap, 1);
        queue = [made.layer];
        nextLayerId = made.nextLayerId;
        changed = true;
        reason = 'shrink_to_live_gap';
      }
    }

    if (changed) {
      cache.catchUpQueue = queue;
      cache.nextLayerId = nextLayerId;
      writeDisk(cache);
      logger.info('[bankroll] catch-up queue synced', {
        reason,
        gapUsd: gap,
        catchUpQueue: queue,
        netCount: cache.netCount,
        principal: cache.principal,
      });
    }
    return getState();
  });
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

  // Open / clear queue against live Portfolio before sizing
  if (Number.isFinite(bal)) syncCatchUpQueue(bal);

  const st = getState();
  const P = st.principal;
  const queue = st.catchUpQueue;

  const clampStake = (raw) => {
    let s = Math.max(0, Number(raw) || 0);
    s = Math.min(s, stakeMax);
    if (Number.isFinite(bal) && bal >= 0) s = Math.min(s, bal);
    return round2(s);
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
      layerUsd: null,
      layerIndex: null,
      catchUpQueue: [],
      targetBalance: null,
      gapUsd: null,
      entryPrice: Number.isFinite(p) ? p : null,
    };
  }

  const N = st.netCount;
  const targetBalance = P + N * step;
  const gapUsd = round2(targetBalance - bal);
  const gap = Math.max(0, gapUsd);

  if (queue.length === 0 || gap < GAP_EPS) {
    const stakeUsd = clampStake(defaultBet);
    return {
      stakeUsd,
      shares: sharesOf(stakeUsd, p),
      mode: 'default',
      targetProfitUsd: null,
      layerUsd: null,
      layerIndex: null,
      catchUpQueue: [],
      targetBalance,
      gapUsd: round2(bal - targetBalance),
      entryPrice: Number.isFinite(p) ? p : null,
    };
  }

  const front = queue[0];
  const layerUsd = round2(front.usd);
  const layerIndex = front.id;
  let T = round2(layerUsd + step);
  if (Number.isFinite(tCap) && tCap > 0) T = Math.min(T, tCap);
  T = round2(T);

  if (!(T > 0) || !(p > 0 && p < 1)) {
    const stakeUsd = clampStake(defaultBet);
    return {
      stakeUsd,
      shares: sharesOf(stakeUsd, p),
      mode: 'fallback_default',
      targetProfitUsd: T > 0 ? T : null,
      layerUsd,
      layerIndex,
      catchUpQueue: queue,
      targetBalance,
      gapUsd: gap,
      catchUpLabel: `补${layerIndex}`,
      entryPrice: Number.isFinite(p) ? p : null,
    };
  }

  const rawStake = T * (p / (1 - p));
  const stakeUsd = clampStake(rawStake);
  return {
    stakeUsd,
    shares: sharesOf(stakeUsd, p),
    mode: 'catch_up',
    targetProfitUsd: T,
    layerUsd,
    layerIndex,
    catchUpQueue: queue,
    catchUpLabel: `补${layerIndex}`,
    targetBalance,
    gapUsd: gap,
    entryPrice: p,
  };
}

/**
 * Recompute stake for full target profit T at a final book price.
 * Catch-up: stake = T × p/(1−p) where T = layer + step.
 * @param {{ targetProfitUsd: number, entryPrice: number, balance?: number }} args
 */
function stakeFromTargetProfit({ targetProfitUsd, entryPrice, balance = Infinity }) {
  const T = Number(targetProfitUsd);
  const p = Number(entryPrice);
  const bal = Number(balance);
  const stakeMax = Math.min(config.bankroll.stakeMaxUsd, config.maxBetUsd);

  if (!(T > 0) || !(p > 0 && p < 1)) {
    return { stakeUsd: 0, shares: null, targetProfitUsd: T || null };
  }

  let stakeUsd = T * (p / (1 - p));
  stakeUsd = Math.min(stakeUsd, stakeMax);
  if (Number.isFinite(bal) && bal >= 0) stakeUsd = Math.min(stakeUsd, bal);
  stakeUsd = round2(stakeUsd);
  const shares = Math.round((stakeUsd / p) * 1e6) / 1e6;
  return { stakeUsd, shares, targetProfitUsd: T };
}

/**
 * Case 1 (sizingPrice < finalPrice): need top-up = recomputedStake − originalStake.
 * Case 2 (sizingPrice >= finalPrice): no top-up.
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

  if (p0 >= p1) {
    return {
      needTopUp: false,
      topUpUsd: 0,
      neededStakeUsd: original,
      originalStakeUsd: original,
      reason: 'case2_no_op',
    };
  }

  const balLeft = Number.isFinite(Number(balance))
    ? Math.max(0, Number(balance) - original)
    : Infinity;
  const recomputed = stakeFromTargetProfit({
    targetProfitUsd,
    entryPrice: p1,
    balance: Number.isFinite(Number(balance)) ? Number(balance) : Infinity,
  });
  const neededStakeUsd = recomputed.stakeUsd;
  let topUpUsd = round2(neededStakeUsd - original);
  if (Number.isFinite(balLeft)) topUpUsd = Math.min(topUpUsd, balLeft);
  topUpUsd = Math.max(0, topUpUsd);

  return {
    needTopUp: topUpUsd >= GAP_EPS,
    topUpUsd,
    neededStakeUsd,
    originalStakeUsd: original,
    reason: 'case1_top_up',
    sizingPrice: p0,
    finalPrice: p1,
    targetProfitUsd: Number(targetProfitUsd),
  };
}

/**
 * Apply settlement to N and the catch-up queue.
 * @param {boolean} won
 * @param {number|null|undefined} [equityBalance] Portfolio after settlement
 */
export function onSettled(won, equityBalance = null) {
  return withLock(() => {
    reload();
    cache.netCount += won ? 1 : -1;

    let queue = normalizeQueue(cache.catchUpQueue);
    let nextLayerId = nextIdFromQueue(queue, cache.nextLayerId);
    const balOk = Number.isFinite(Number(equityBalance));
    let gap = null;

    if (!balOk) {
      logger.warn('[bankroll] settled without Portfolio — N updated, catch-up queue unchanged', {
        won,
        netCount: cache.netCount,
        catchUpQueue: queue,
      });
    } else {
      gap = gapOf(cache.principal, cache.netCount, equityBalance);

      if (won) {
        if (queue.length > 0) queue = queue.slice(1);
        if (gap < GAP_EPS) {
          queue = [];
          nextLayerId = 1;
        } else if (queue.length === 0) {
          const made = makeLayer(gap, 1);
          queue = [made.layer];
          nextLayerId = made.nextLayerId;
        }
      } else if (queue.length === 0) {
        if (gap >= GAP_EPS) {
          const made = makeLayer(gap, 1);
          queue = [made.layer];
          nextLayerId = made.nextLayerId;
        }
      } else {
        const next = round2(gap - queueSum(queue));
        if (next >= GAP_EPS) {
          const made = makeLayer(next, nextLayerId);
          queue = [...queue, made.layer];
          nextLayerId = made.nextLayerId;
        }
      }
    }

    cache.catchUpQueue = queue;
    cache.nextLayerId = nextLayerId;
    writeDisk(cache);

    const target = targetOf(cache.principal, cache.netCount);
    logger.info('[bankroll] settled', {
      won,
      netCount: cache.netCount,
      principal: cache.principal,
      target,
      gapUsd: gap,
      equityBalance: balOk ? Number(equityBalance) : null,
      catchUpQueue: queue,
    });
    return {
      netCount: cache.netCount,
      principal: cache.principal,
      catchUpQueue: queue,
      gapUsd: gap,
      targetBalance: target,
    };
  });
}

export function formatBankrollTelegramLines(sizing = null) {
  const st = getState();
  const P = st.principal;
  const N = st.netCount;
  const target = st.targetBalance;
  const q = st.catchUpQueue || [];
  const qText = q.length
    ? ` · 补队列[${q.map((x) => `补${x.id}=$${Number(x.usd).toFixed(2)}`).join(', ')}]`
    : '';
  let line =
    `资金: 本金 $${P != null ? P.toFixed(2) : '—'} · 净胜负 ${N}` +
    (target != null ? ` · 目标 $${target.toFixed(2)}` : '') +
    qText +
    `\n`;
  if (sizing?.mode === 'catch_up') {
    const label = sizing.catchUpLabel || `补${sizing.layerIndex || 1}`;
    line +=
      `动态首注: ${label}=$${Number(sizing.layerUsd).toFixed(2)}` +
      ` → T=$${Number(sizing.targetProfitUsd).toFixed(2)}` +
      (sizing.gapUsd != null ? ` (gap$${Number(sizing.gapUsd).toFixed(2)})` : '') +
      ` → $${Number(sizing.stakeUsd).toFixed(2)}` +
      (sizing.shares != null ? ` · ~${sizing.shares.toFixed(2)} shares` : '') +
      `\n`;
  } else if (sizing) {
    line += `动态首注: 默认 $${Number(sizing.stakeUsd).toFixed(2)}\n`;
  }
  return line;
}
