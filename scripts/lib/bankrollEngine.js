/**
 * In-memory bankroll (P / N / catch-up queue) — mirrors src/martingale/bankroll.js
 * for backtests (no disk / lock). Keep behavior in sync with production.
 */

const GAP_EPS = 0.01;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

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
    }
  }
  return out;
}

function nextIdFromQueue(queue, hint) {
  const maxId = (queue || []).reduce((m, layer) => Math.max(m, Number(layer.id) || 0), 0);
  const fromHint = Number.isFinite(Number(hint)) ? Math.trunc(Number(hint)) : 1;
  return Math.max(1, maxId + 1, fromHint);
}

function queueSum(queue) {
  return round2((queue || []).reduce((a, layer) => a + Number(layer?.usd || 0), 0));
}

function makeLayer(usd, nextLayerId) {
  const id = Math.max(1, Math.trunc(Number(nextLayerId) || 1));
  return { layer: { id, usd: round2(usd) }, nextLayerId: id + 1 };
}

function evenSplitAcrossLayers(queue, totalUsd) {
  const q = normalizeQueue(queue);
  const total = round2(Math.max(0, Number(totalUsd) || 0));
  if (!q.length || total < GAP_EPS) return [];
  if (q.length === 1) return [{ ...q[0], usd: total }];

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

export class BankrollEngine {
  /**
   * @param {{
   *   principal: number,
   *   stepUsd?: number,
   *   defaultBetUsd?: number,
   *   catchUpProfitCapUsd?: number,
   *   stakeMaxUsd?: number,
   *   maxBetUsd?: number,
   * }} opts
   */
  constructor(opts) {
    this.principal = Number(opts.principal);
    this.stepUsd = Number(opts.stepUsd ?? 5);
    this.defaultBetUsd = Number(opts.defaultBetUsd ?? 5);
    /** ≤0 → unlimited */
    this.catchUpProfitCapUsd = Number(opts.catchUpProfitCapUsd ?? 0);
    this.stakeMaxUsd = Number(opts.stakeMaxUsd ?? 0);
    this.maxBetUsd = Number(opts.maxBetUsd ?? 0);
    this.netCount = 0;
    this.realizedPnlUsd = 0;
    this.catchUpQueue = [];
    this.nextLayerId = 1;
  }

  /** @returns {number} finite cap or Infinity */
  _cap(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return Infinity;
    return n;
  }

  targetOf(N = this.netCount) {
    return this.principal + N * this.stepUsd;
  }

  equity() {
    return round2(this.principal + this.realizedPnlUsd);
  }

  gapOf(balance = this.equity()) {
    const target = this.targetOf();
    const bal = Number(balance);
    if (!Number.isFinite(bal)) return 0;
    return Math.max(0, round2(target - bal));
  }

  getState() {
    const queue = normalizeQueue(this.catchUpQueue);
    const front = queue[0] ?? null;
    return {
      principal: this.principal,
      netCount: this.netCount,
      realizedPnlUsd: round2(this.realizedPnlUsd),
      catchUpQueue: queue,
      catchUpLayerUsd: front?.usd ?? null,
      catchUpLayerIndex: front?.id ?? null,
      stepUsd: this.stepUsd,
      targetBalance: this.targetOf(),
      ledgerEquity: this.equity(),
    };
  }

  /** Align queue to live gap (same as bankroll.syncCatchUpQueue). */
  syncCatchUpQueue(balance = this.equity()) {
    const gap = this.gapOf(balance);
    let queue = normalizeQueue(this.catchUpQueue);
    let nextLayerId = nextIdFromQueue(queue, this.nextLayerId);

    if (gap < GAP_EPS) {
      queue = [];
      nextLayerId = 1;
    } else if (queue.length === 0) {
      const made = makeLayer(gap, nextLayerId);
      queue = [made.layer];
      nextLayerId = made.nextLayerId;
    } else {
      queue = evenSplitAcrossLayers(queue, gap);
    }

    this.catchUpQueue = queue;
    this.nextLayerId = nextLayerId;
    return this.getState();
  }

  reconcileQueueToGap(queue, gap, nextLayerId) {
    let q = normalizeQueue(queue);
    let nextId = nextIdFromQueue(q, nextLayerId);
    if (gap < GAP_EPS) return { queue: [], nextLayerId: 1 };
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
   * @param {{ balance?: number, entryPrice: number, spendCap?: number }} args
   */
  computeStake({ balance, entryPrice, spendCap }) {
    const bal = Number.isFinite(Number(balance)) ? Number(balance) : this.equity();
    const p = Number(entryPrice);
    const cap = Number.isFinite(Number(spendCap)) ? Number(spendCap) : Infinity;

    this.syncCatchUpQueue(bal);

    const stakeMax = Math.min(this._cap(this.stakeMaxUsd), this._cap(this.maxBetUsd));
    const clampStake = (raw) => {
      let s = Math.max(0, Number(raw) || 0);
      if (Number.isFinite(stakeMax)) s = Math.min(s, stakeMax);
      if (Number.isFinite(cap) && cap >= 0) s = Math.min(s, cap);
      return round2(s);
    };

    const sharesOf = (stake, price) => {
      if (!(price > 0 && price < 1) || !(stake > 0)) return null;
      return Math.round((stake / price) * 1e6) / 1e6;
    };

    const N = this.netCount;
    const targetBalance = this.principal + N * this.stepUsd;
    const gapUsd = round2(targetBalance - bal);
    const gap = Math.max(0, gapUsd);
    const queue = normalizeQueue(this.catchUpQueue);

    if (queue.length === 0 || gap < GAP_EPS) {
      const stakeUsd = clampStake(this.defaultBetUsd);
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
    let T = round2(layerUsd + this.stepUsd);
    const tCap = this._cap(this.catchUpProfitCapUsd);
    if (Number.isFinite(tCap)) T = Math.min(T, tCap);
    T = round2(T);

    if (!(T > 0) || !(p > 0 && p < 1)) {
      const stakeUsd = clampStake(this.defaultBetUsd);
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
   * @param {boolean} won
   * @param {number} pnlUsd
   */
  onSettled(won, pnlUsd) {
    if (Number.isFinite(Number(pnlUsd))) {
      this.realizedPnlUsd = round2(this.realizedPnlUsd + Number(pnlUsd));
    }
    this.netCount += won ? 1 : -1;

    let queue = normalizeQueue(this.catchUpQueue);
    let nextLayerId = nextIdFromQueue(queue, this.nextLayerId);
    const equity = this.equity();
    const gap = this.gapOf(equity);

    if (won) {
      if (queue.length > 0) queue = queue.slice(1);
      const reconciled = this.reconcileQueueToGap(queue, gap, nextLayerId);
      queue = reconciled.queue;
      nextLayerId = reconciled.nextLayerId;
    } else if (queue.length === 0) {
      if (gap >= GAP_EPS) {
        const made = makeLayer(gap, nextLayerId);
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
      if (gap >= GAP_EPS) {
        queue = evenSplitAcrossLayers(queue, gap);
      } else {
        queue = [];
        nextLayerId = 1;
      }
    }

    this.catchUpQueue = queue;
    this.nextLayerId = nextLayerId;
    return this.getState();
  }
}
