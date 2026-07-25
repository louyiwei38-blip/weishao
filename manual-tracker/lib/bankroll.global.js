(function (g) {
/**
 * Manual bankroll: P / N + catch-up queue with fixed profit odds.
 * 1:1.85 总返 = 本金×1.85，利润倍数 profitRatio = 0.85（利润 = 本金×0.85）
 * stake = T / profitRatio，取整
 */

const DEFAULTS = {
  defaultBet: 10,
  stepUsd: 10,
  catchUpProfitCapUsd: 20,
  stakeMaxUsd: 30,
  profitRatio: 0.85,
  gapEps: 0.01,
};

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function roundInt(n) {
  return Math.max(0, Math.round(Number(n) || 0));
}

function effectivePrincipal(P, bal) {
  const p = Number(P);
  if (Number.isFinite(p) && p > 0) return round2(p);
  const b = Number(bal);
  if (Number.isFinite(b) && b > 0) return round2(b);
  return null;
}

function stakeFromTarget(T, profitRatio, clampStake) {
  const t = round2(T);
  if (!(t > 0) || !(profitRatio > 0)) return clampStake(0);
  return clampStake(t / profitRatio);
}

function defaultState(overrides = {}) {
  const settings = { ...DEFAULTS, ...(overrides.settings || {}) };
  return {
    principal: null,
    netCount: 0,
    balance: null,
    catchUpQueue: [],
    nextLayerId: 1,
    wins: 0,
    losses: 0,
    trades: [],
    updatedAt: null,
    ...overrides,
    settings,
  };
}

function cfg(state) {
  return { ...DEFAULTS, ...(state.settings || {}) };
}

function normalizeQueue(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (x != null && typeof x === 'object') {
      const usd = round2(x.usd ?? x.amount);
      const id = Math.trunc(Number(x.id));
      if (Number.isFinite(usd) && usd >= DEFAULTS.gapEps && Number.isFinite(id) && id > 0) {
        out.push({ id, usd });
      }
      continue;
    }
    const usd = round2(x);
    if (Number.isFinite(usd) && usd >= DEFAULTS.gapEps) {
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

function queueSum(queue) {
  return round2((queue || []).reduce((a, layer) => a + Number(layer?.usd || 0), 0));
}

function makeLayer(usd, nextLayerId) {
  const id = Math.max(1, Math.trunc(Number(nextLayerId) || 1));
  return { layer: { id, usd: round2(usd) }, nextLayerId: id + 1 };
}

function targetOf(P, N, step) {
  if (P == null) return null;
  return round2(P + N * step);
}

function gapOf(P, N, balance, step) {
  const target = targetOf(P, N, step);
  const bal = Number(balance);
  if (target == null || !Number.isFinite(bal)) return 0;
  return Math.max(0, round2(target - bal));
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  const catchUpQueue = normalizeQueue(raw.catchUpQueue);
  return {
    principal: Number.isFinite(Number(raw.principal)) ? round2(raw.principal) : null,
    netCount: Number.isFinite(Number(raw.netCount)) ? Math.trunc(Number(raw.netCount)) : 0,
    balance: Number.isFinite(Number(raw.balance)) ? round2(raw.balance) : null,
    catchUpQueue,
    nextLayerId: nextIdFromQueue(catchUpQueue, raw.nextLayerId),
    wins: Math.max(0, Math.trunc(Number(raw.wins) || 0)),
    losses: Math.max(0, Math.trunc(Number(raw.losses) || 0)),
    trades: Array.isArray(raw.trades) ? raw.trades.slice(-500) : [],
    settings: { ...DEFAULTS, ...(raw.settings || {}) },
    updatedAt: raw.updatedAt ?? null,
  };
}

function syncCatchUpQueue(state, { allowOpen = false } = {}) {
  const { gapEps, stepUsd: step } = cfg(state);
  const P = effectivePrincipal(state.principal, state.balance);
  const gap = gapOf(P, state.netCount, state.balance, step);
  let queue = normalizeQueue(state.catchUpQueue);
  let nextLayerId = nextIdFromQueue(queue, state.nextLayerId);
  let changed = false;

  if (gap < gapEps) {
    // 清队列只在 recordTrade 赢单且 gap≈0 时做，sync 不自动清空
  } else if (queue.length === 0 && allowOpen) {
    const made = makeLayer(gap, nextLayerId);
    queue = [made.layer];
    nextLayerId = made.nextLayerId;
    changed = true;
  } else if (queue.length > 0) {
    // 首层 > 实时 gap：只缩小首层金额，保留补N 层号（不合并成补1）
    if (gap >= gapEps && queue[0].usd - gap > gapEps) {
      queue = [{ ...queue[0], usd: round2(gap) }, ...queue.slice(1)];
      changed = true;
    }
    // 队列合计 > gap：从队尾去掉多余层，不整队合并
    while (queue.length > 1 && queueSum(queue) - gap > gapEps) {
      queue = queue.slice(0, -1);
      changed = true;
    }
  }

  if (changed) {
    state.catchUpQueue = queue;
    state.nextLayerId = nextLayerId;
  }
  return state;
}

function computeStake(state, opts = {}) {
  const settings = cfg(state);
  const { defaultBet, stepUsd: step, catchUpProfitCapUsd: tCap, stakeMaxUsd: stakeMax, profitRatio, gapEps } = settings;
  const bal = Number.isFinite(Number(opts.balance)) ? round2(Number(opts.balance)) : state.balance;

  let st = normalizeState(state);
  if (Number.isFinite(bal)) st.balance = bal;

  const queue = normalizeQueue(st.catchUpQueue);

  const clampStake = (raw) => {
    let s = roundInt(raw);
    if (s <= 0 && Number(raw) > 0) s = 1;
    s = Math.min(s, stakeMax);
    if (Number.isFinite(bal) && bal >= 0) s = Math.min(s, Math.floor(bal));
    return s;
  };

  const P = effectivePrincipal(st.principal, bal);

  if (P == null || !Number.isFinite(bal)) {
    let T = step;
    if (Number.isFinite(tCap) && tCap > 0) T = Math.min(T, tCap);
    const stakeUsd = stakeFromTarget(T, profitRatio, clampStake);
    return {
      stakeUsd,
      profitUsd: round2(stakeUsd * profitRatio),
      mode: 'fallback_default',
      targetProfitUsd: T,
      layerUsd: null,
      layerIndex: null,
      catchUpLabel: null,
      catchUpQueue: [],
      targetBalance: null,
      gapUsd: null,
      profitRatio,
    };
  }

  const N = st.netCount;
  const targetBalance = targetOf(P, N, step);
  const gapUsd = round2(targetBalance - bal);
  const gap = Math.max(0, gapUsd);

  if (queue.length > 0) {
    const front = queue[0];
    const layerUsd = round2(gap > 0 ? Math.min(front.usd, gap) : front.usd);
    const layerIndex = front.id;
    let T = round2(layerUsd + step);
    if (Number.isFinite(tCap) && tCap > 0) T = Math.min(T, tCap);
    T = round2(T);

    const stakeUsd = stakeFromTarget(T, profitRatio, clampStake);
    return {
      stakeUsd,
      profitUsd: round2(stakeUsd * profitRatio),
      mode: 'catch_up',
      targetProfitUsd: T,
      layerUsd,
      layerIndex,
      catchUpLabel: `补${layerIndex}`,
      catchUpQueue: queue,
      targetBalance,
      gapUsd: gap,
      profitRatio,
    };
  }

  if (gap < gapEps) {
    let T = step;
    if (Number.isFinite(tCap) && tCap > 0) T = Math.min(T, tCap);
    const stakeUsd = stakeFromTarget(T, profitRatio, clampStake);
    return {
      stakeUsd,
      profitUsd: round2(stakeUsd * profitRatio),
      mode: 'target_step',
      targetProfitUsd: T,
      layerUsd: null,
      layerIndex: null,
      catchUpLabel: null,
      catchUpQueue: [],
      targetBalance,
      gapUsd: round2(bal - targetBalance),
      profitRatio,
    };
  }

  // gap>0 队列未登记：仅用于 sizing 展示，不写回状态
  const layerUsd = round2(gap);
  let T = round2(layerUsd + step);
  if (Number.isFinite(tCap) && tCap > 0) T = Math.min(T, tCap);
  const stakeUsd = stakeFromTarget(T, profitRatio, clampStake);
  const nextId = nextIdFromQueue([], st.nextLayerId);
  return {
    stakeUsd,
    profitUsd: round2(stakeUsd * profitRatio),
    mode: 'catch_up',
    targetProfitUsd: T,
    layerUsd,
    layerIndex: nextId,
    catchUpLabel: `补${nextId}`,
    catchUpQueue: [{ id: nextId, usd: layerUsd }],
    targetBalance,
    gapUsd: gap,
    profitRatio,
  };
}

function recordTrade(state, won, meta = {}) {
  const settings = cfg(state);
  const { stepUsd: step, gapEps, profitRatio } = settings;

  let st = normalizeState(state);
  if (st.principal == null && st.balance != null) st.principal = st.balance;

  const sizing = computeStake(st);
  const stakeUsd = round2(meta.stakeUsd ?? sizing.stakeUsd);
  const profitUsd = round2(stakeUsd * profitRatio);

  let balance = Number.isFinite(Number(meta.balanceOverride))
    ? round2(Number(meta.balanceOverride))
    : st.balance;

  if (Number.isFinite(balance)) {
    balance = won ? round2(balance + profitUsd) : round2(balance - stakeUsd);
  }

  st.netCount += won ? 1 : -1;
  if (won) st.wins += 1;
  else st.losses += 1;

  if (Number.isFinite(balance)) {
    st.balance = balance;
    let queue = normalizeQueue(st.catchUpQueue);
    let nextLayerId = nextIdFromQueue(queue, st.nextLayerId);
    const P = effectivePrincipal(st.principal, balance);
    const gap = gapOf(P, st.netCount, balance, step);

    if (won) {
      if (queue.length > 0) queue = queue.slice(1);
      if (gap < gapEps) {
        queue = [];
        nextLayerId = 1;
      } else if (queue.length === 0) {
        const made = makeLayer(gap, 1);
        queue = [made.layer];
        nextLayerId = made.nextLayerId;
      }
    } else {
      const shortfall = round2(step - stakeUsd);
      if (queue.length === 0) {
        if (gap >= gapEps) {
          const made = makeLayer(gap, 1);
          queue = [made.layer];
          nextLayerId = made.nextLayerId;
        } else if (shortfall >= gapEps) {
          // 注码 < step 时，目标线跌幅大于实亏，仍登记补层
          const made = makeLayer(shortfall, 1);
          queue = [made.layer];
          nextLayerId = made.nextLayerId;
        }
      } else {
        const next = round2(gap - queueSum(queue));
        const extra = next >= gapEps ? next : shortfall >= gapEps ? shortfall : 0;
        if (extra >= gapEps) {
          const made = makeLayer(extra, nextLayerId);
          queue = [...queue, made.layer];
          nextLayerId = made.nextLayerId;
        }
      }
    }

    st.catchUpQueue = queue;
    st.nextLayerId = nextLayerId;
    syncCatchUpQueue(st);
  }

  const trade = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    won,
    stakeUsd,
    profitUsd: won ? profitUsd : round2(-stakeUsd),
    netCount: st.netCount,
    mode: sizing.mode,
    catchUpLabel: sizing.catchUpLabel,
    note: meta.note ? String(meta.note).slice(0, 200) : '',
  };
  st.trades = [...(st.trades || []), trade].slice(-500);
  st.updatedAt = trade.at;
  return { state: st, trade, sizing };
}

function getSummary(state) {
  const st = normalizeState(state);
  const settings = cfg(st);
  const sizing = computeStake(st);
  const total = st.wins + st.losses;
  const winRate = total > 0 ? st.wins / total : null;
  const P = effectivePrincipal(st.principal, st.balance);
  const N = st.netCount;
  const targetBalance = P != null ? targetOf(P, N, settings.stepUsd) : null;
  const gapUsd =
    P != null && Number.isFinite(st.balance) ? round2(Math.max(0, targetBalance - st.balance)) : null;

  return {
    principal: P,
    balance: st.balance,
    netCount: N,
    wins: st.wins,
    losses: st.losses,
    totalTrades: total,
    winRate,
    winRatePct: winRate != null ? round2(winRate * 100) : null,
    targetBalance,
    gapUsd,
    catchUpQueue: st.catchUpQueue,
    nextStake: sizing,
    settings,
    updatedAt: st.updatedAt,
  };
}

function resetBankroll(balance, prev = defaultState()) {
  const bal = round2(balance);
  if (!Number.isFinite(bal) || bal < 0) throw new Error('invalid balance');
  return normalizeState({
    ...prev,
    principal: bal,
    netCount: 0,
    balance: bal,
    catchUpQueue: [],
    nextLayerId: 1,
    wins: 0,
    losses: 0,
    trades: [],
    updatedAt: new Date().toISOString(),
  });
}

function setBalance(state, balance) {
  const bal = round2(balance);
  if (!Number.isFinite(bal) || bal < 0) throw new Error('invalid balance');
  const st = normalizeState(state);
  st.balance = bal;
  if (st.principal == null) st.principal = bal;
  syncCatchUpQueue(st, { allowOpen: true });
  st.updatedAt = new Date().toISOString();
  return st;
}

function patchSettings(state, settingsPatch) {
  const st = normalizeState(state);
  st.settings = { ...st.settings, ...settingsPatch };
  st.updatedAt = new Date().toISOString();
  return st;
}

function undoLastTrade(state) {
  const st = normalizeState(state);
  if (!st.trades?.length) return st;
  const remaining = st.trades.slice(0, -1);
  const seedBal = st.principal ?? st.balance ?? 0;
  const base = resetBankroll(seedBal, { ...st, trades: [] });
  base.settings = st.settings;
  let cur = base;
  for (const t of remaining) {
    ({ state: cur } = recordTrade(cur, t.won, { stakeUsd: t.stakeUsd, note: t.note }));
  }
  return cur;
}

  g.ManualBankroll = { DEFAULTS, defaultState, normalizeState, computeStake, recordTrade, getSummary, resetBankroll, setBalance, patchSettings, undoLastTrade };
})(typeof window !== 'undefined' ? window : globalThis);
