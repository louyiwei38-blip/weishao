/**
 * Shared bankroll (P / N / catch-up queue) for the wallet.
 *
 * P = principal, locked from Portfolio on first use (never re-locked on max-loss halt)
 * N = net wins−losses; +1 win / −1 loss on confirmed settlement (kept across max-loss halt)
 * realizedPnlUsd = wallet-wide cumulative settle PnL (shared across instances)
 * target = P + N × step
 * gap = max(0, target − equity)
 *   equity = Portfolio (legacy) OR P + realizedPnlUsd (BANKROLL_USE_STATS_EQUITY=true)
 *
 * Catch-up queue (补1, 补2, …):
 *   - No gap & empty queue → stake = defaultBet (TRADE_BUDGET_USD)
 *   - Else play front layer L; win profit T = L + step; stake = T × p/(1−p)
 *   - Loss: keep playing same layer; if gap grew, append 补N then **even-split gap across all layers**
 *   - Win on layer: clear that layer; remaining layers **even-split** current gap; empty+gap→ new 补1
 *   - Sync: multi-layer queues redistribute total gap evenly (no uneven front/tail leftovers)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, readdirSync } from 'fs';
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
 * @type {{ principal: number|null, netCount: number, realizedPnlUsd: number, catchUpQueue: CatchUpLayer[], nextLayerId: number, updatedAt: string|null }}
 */
let cache = {
  principal: null,
  netCount: 0,
  realizedPnlUsd: 0,
  catchUpQueue: [],
  nextLayerId: 1,
  updatedAt: null,
};

function emptyState() {
  return {
    principal: null,
    netCount: 0,
    realizedPnlUsd: 0,
    catchUpQueue: [],
    nextLayerId: 1,
    updatedAt: null,
  };
}

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

/** Sum total.pnlUsd from all per-instance stats-state*.json (bootstrap shared ledger). */
function sumStatsPnlFromDisk() {
  if (!existsSync(LOGS_DIR)) return 0;
  let total = 0;
  try {
    for (const name of readdirSync(LOGS_DIR)) {
      if (!/^stats-state(-[\w.-]+)?\.json$/i.test(name)) continue;
      try {
        const raw = JSON.parse(readFileSync(join(LOGS_DIR, name), 'utf8'));
        const pnl = Number(raw?.total?.pnlUsd);
        if (Number.isFinite(pnl)) total += pnl;
      } catch {
        /* skip */
      }
    }
  } catch {
    return 0;
  }
  return round2(total);
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
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const catchUpQueue = normalizeQueue(raw.catchUpQueue);
    let realizedPnlUsd = Number(raw.realizedPnlUsd);
    if (!Number.isFinite(realizedPnlUsd)) {
      // Migrate: wallet ledger missing → sum all instance stats so multi-TF gap stays consistent
      realizedPnlUsd = sumStatsPnlFromDisk();
    }
    return {
      principal: Number.isFinite(Number(raw.principal)) ? Number(raw.principal) : null,
      netCount: Number.isFinite(Number(raw.netCount)) ? Math.trunc(Number(raw.netCount)) : 0,
      realizedPnlUsd: round2(realizedPnlUsd),
      catchUpQueue,
      nextLayerId: nextIdFromQueue(catchUpQueue, raw.nextLayerId),
      updatedAt: raw.updatedAt ?? null,
    };
  } catch {
    logger.warn('[bankroll] state parse failed, reset');
    return emptyState();
  }
}

function writeDisk(state) {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const catchUpQueue = normalizeQueue(state.catchUpQueue);
  const payload = {
    principal: state.principal,
    netCount: state.netCount,
    realizedPnlUsd: round2(Number(state.realizedPnlUsd) || 0),
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

/**
 * Keep layer ids/count; set each layer.usd so amounts sum to totalUsd (even split).
 * Last layer absorbs cent rounding remainder.
 * @param {CatchUpLayer[]} queue
 * @param {number} totalUsd
 * @returns {CatchUpLayer[]}
 */
function evenSplitAcrossLayers(queue, totalUsd) {
  const q = normalizeQueue(queue);
  const total = round2(Math.max(0, Number(totalUsd) || 0));
  if (!q.length || total < GAP_EPS) return [];
  if (q.length === 1) {
    return [{ ...q[0], usd: total }];
  }

  const n = q.length;
  const eachCents = Math.floor(Math.round(total * 100) / n);
  let allocatedCents = 0;
  return q.map((layer, i) => {
    let cents;
    if (i === n - 1) {
      cents = Math.round(total * 100) - allocatedCents;
    } else {
      cents = eachCents;
      allocatedCents += cents;
    }
    return { ...layer, usd: round2(cents / 100) };
  });
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
    // Persist migrated ledger so every instance shares the same realizedPnlUsd
    if (existsSync(STATE_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
        if (!Number.isFinite(Number(raw.realizedPnlUsd))) {
          writeDisk(cache);
          logger.info('[bankroll] migrated realizedPnlUsd from stats-state*', {
            realizedPnlUsd: cache.realizedPnlUsd,
          });
        }
      } catch {
        /* ignore */
      }
    }
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
  const realizedPnlUsd = round2(Number(cache.realizedPnlUsd) || 0);
  const queue = normalizeQueue(cache.catchUpQueue);
  const front = queue[0] ?? null;
  return {
    principal: P,
    netCount: N,
    realizedPnlUsd,
    catchUpQueue: queue,
    catchUpLayerUsd: front?.usd ?? null,
    catchUpLayerIndex: front?.id ?? null,
    stepUsd: step,
    targetBalance: P == null ? null : P + N * step,
    ledgerEquity: P == null ? null : round2(P + realizedPnlUsd),
    updatedAt: cache.updatedAt,
  };
}

/**
 * Align queue to live gap:
 * - gap≈0 → clear queue
 * - gap>0 & empty → open 补N = gap
 * - gap>0 & layers → keep layer count/ids, even-split gap across remaining layers
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
      const made = makeLayer(gap, nextLayerId);
      queue = [made.layer];
      nextLayerId = made.nextLayerId;
      changed = true;
      reason = 'open_补';
    } else {
      const before = queue.map((x) => `${x.id}:${x.usd}`).join(',');
      queue = evenSplitAcrossLayers(queue, gap);
      const after = queue.map((x) => `${x.id}:${x.usd}`).join(',');
      if (before !== after) {
        changed = true;
        reason = queue.length > 1 ? 'even_split' : 'shrink_front';
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
        realizedPnlUsd: cache.realizedPnlUsd,
      });
    }
    return getState();
  });
}

/** After settle: keep layer ids/count; even-split total gap across remaining layers. */
function reconcileQueueToGap(queue, gap, nextLayerId) {
  let q = normalizeQueue(queue);
  let nextId = nextIdFromQueue(q, nextLayerId);
  if (gap < GAP_EPS) {
    return { queue: [], nextLayerId: 1 };
  }
  if (q.length === 0) {
    const made = makeLayer(gap, nextId);
    return { queue: [made.layer], nextLayerId: made.nextLayerId };
  }
  return {
    queue: evenSplitAcrossLayers(q, gap),
    nextLayerId: nextIdFromQueue(q, nextId),
  };
}

/**
 * @param {{ balance: number, entryPrice: number|null|undefined, spendCap?: number|null }} args
 * balance — equity for gap / catch-up queue (stats-based or Portfolio)
 * spendCap — max stake clamp (Cash); defaults to balance when omitted
 */
export function computeStake({ balance, entryPrice, spendCap }) {
  const step = config.bankroll.stepUsd;
  const defaultBet = config.tradeBudgetUsd;
  const tCap = config.bankroll.catchUpProfitCapUsd;
  const stakeMax = Math.min(config.bankroll.stakeMaxUsd, config.maxBetUsd);
  const bal = Number(balance);
  const p = Number(entryPrice);
  const cap = Number.isFinite(Number(spendCap)) ? Number(spendCap) : bal;

  // Sync queue against sizing equity before stake calc
  if (Number.isFinite(bal)) syncCatchUpQueue(bal);

  const st = getState();
  const P = st.principal;
  const queue = st.catchUpQueue;

  const clampStake = (raw) => {
    let s = Math.max(0, Number(raw) || 0);
    s = Math.min(s, stakeMax);
    if (Number.isFinite(cap) && cap >= 0) s = Math.min(s, cap);
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
 * Apply settlement to N, shared ledger PnL, and the catch-up queue.
 * @param {boolean} won
 * @param {number|null|undefined} [equityBalance] Fallback equity (Portfolio / caller)
 * @param {number|null|undefined} [pnlUsd] This settle's fee-adjusted PnL — updates shared ledger
 */
export function onSettled(won, equityBalance = null, pnlUsd = null) {
  return withLock(() => {
    reload();
    if (Number.isFinite(Number(pnlUsd))) {
      cache.realizedPnlUsd = round2((Number(cache.realizedPnlUsd) || 0) + Number(pnlUsd));
    }
    cache.netCount += won ? 1 : -1;

    let queue = normalizeQueue(cache.catchUpQueue);
    let nextLayerId = nextIdFromQueue(queue, cache.nextLayerId);

    // Prefer wallet-shared ledger equity so multi-instance gap stays consistent
    let equity = Number(equityBalance);
    if (config.bankrollUseStatsEquity && cache.principal != null) {
      equity = round2(cache.principal + (Number(cache.realizedPnlUsd) || 0));
    }
    const balOk = Number.isFinite(equity);
    let gap = null;

    if (!balOk) {
      logger.warn('[bankroll] settled without equity — N/PnL updated, catch-up queue unchanged', {
        won,
        netCount: cache.netCount,
        realizedPnlUsd: cache.realizedPnlUsd,
        catchUpQueue: queue,
      });
    } else {
      gap = gapOf(cache.principal, cache.netCount, equity);

      if (won) {
        if (queue.length > 0) queue = queue.slice(1);
        const reconciled = reconcileQueueToGap(queue, gap, nextLayerId);
        queue = reconciled.queue;
        nextLayerId = reconciled.nextLayerId;
      } else if (queue.length === 0) {
        if (gap >= GAP_EPS) {
          const made = makeLayer(gap, nextLayerId);
          queue = [made.layer];
          nextLayerId = made.nextLayerId;
        }
      } else {
        // Loss while in catch-up: if gap grew, append a new layer, then even-split
        // total gap across all remaining layers (incl. the new one).
        const next = round2(gap - queueSum(queue));
        if (next >= GAP_EPS) {
          const made = makeLayer(next, nextLayerId);
          queue = [...queue, made.layer];
          nextLayerId = made.nextLayerId;
        }
        if (gap >= GAP_EPS) {
          queue = evenSplitAcrossLayers(queue, gap);
        } else {
          queue = [];
          nextLayerId = 1;
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
      realizedPnlUsd: cache.realizedPnlUsd,
      target,
      gapUsd: gap,
      equityBalance: balOk ? equity : null,
      pnlUsd: Number.isFinite(Number(pnlUsd)) ? Number(pnlUsd) : null,
      catchUpQueue: queue,
    });
    return {
      netCount: cache.netCount,
      principal: cache.principal,
      realizedPnlUsd: cache.realizedPnlUsd,
      catchUpQueue: queue,
      gapUsd: gap,
      targetBalance: target,
    };
  });
}

/**
 * Reset principal to live Portfolio and net count to 0; clear catch-up queue + ledger PnL.
 * @param {number} portfolioBalance
 */
export function resetPrincipalAndNet(portfolioBalance) {
  const bal = Number(portfolioBalance);
  if (!Number.isFinite(bal) || bal < 0) {
    throw new Error('invalid portfolio for bankroll reset');
  }
  return withLock(() => {
    reload();
    cache.principal = Math.round(bal * 1e6) / 1e6;
    cache.netCount = 0;
    cache.realizedPnlUsd = 0;
    cache.catchUpQueue = [];
    cache.nextLayerId = 1;
    writeDisk(cache);
    logger.info('[bankroll] manual reset P/N + cleared catch-up queue + ledger PnL', {
      principal: cache.principal,
      netCount: cache.netCount,
      portfolioBalance: bal,
    });
    return getState();
  });
}

export function formatBankrollTelegramLines(sizing = null, { statsEquity = null } = {}) {
  const st = getState();
  const P = st.principal;
  const N = st.netCount;
  const target = st.targetBalance;
  const q = st.catchUpQueue || [];
  const qText = q.length
    ? ` · 补队列[${q.map((x) => `补${x.id}=$${Number(x.usd).toFixed(2)}`).join(', ')}]`
    : '';
  const equityNote = statsEquity != null
    ? ` · 账本 $${Number(statsEquity).toFixed(2)}`
    : '';
  let line =
    `资金: 本金 $${P != null ? P.toFixed(2) : '—'} · 净胜负 ${N}` +
    (target != null ? ` · 目标 $${target.toFixed(2)}` : '') +
    equityNote +
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
