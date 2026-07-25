(function () {
  var BR = window.ManualBankroll;
  if (!BR) { document.body.innerHTML = '<p style="padding:24px;color:#ef4444;font-family:sans-serif">璇峰厛杩愯 npm run manual:tracker锛屽啀鎵撳紑 http://localhost:8787</p>'; return; }
  var defaultState = BR.defaultState, normalizeState = BR.normalizeState, recordTrade = BR.recordTrade;
  var getSummary = BR.getSummary, resetBankroll = BR.resetBankroll, setBalance = BR.setBalance;
  var patchSettings = BR.patchSettings, undoLastTrade = BR.undoLastTrade;
const STORAGE_KEY = 'manual-tracker-state-v1';
function q(id){ return document.getElementById(id); }

let state = defaultState();
let apiBase = localStorage.getItem('manual-tracker-api') || '';
if (!apiBase && location.protocol.startsWith('http')) {
  apiBase = location.origin;
}

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (Number.isInteger(v)) return `$${v}`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function loadRemote() {
  if (!apiBase) return false;
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/state`);
  if (!res.ok) throw new Error(`sync ${res.status}`);
  state = normalizeState(await res.json());
  saveLocal();
  return true;
}

async function saveRemote() {
  if (!apiBase) return;
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`sync ${res.status}`);
}

async function persist() {
  saveLocal();
  if (!apiBase) return;
  try {
    await saveRemote();
  } catch (e) {
    console.warn('remote sync failed', e);
  }
}

async function initLoad() {
  const localRaw = localStorage.getItem(STORAGE_KEY);
  const localState = localRaw ? normalizeState(JSON.parse(localRaw)) : null;
  try {
    if (apiBase) {
      await loadRemote();
      if (localState?.updatedAt && (!state.updatedAt || localState.updatedAt > state.updatedAt)) {
        state = localState;
        await persist();
      }
    } else if (localState) {
      state = localState;
    }
  } catch (e) {
    console.warn(e);
    if (localState) state = localState;
  }
  render();
}

function render() {
  const s = getSummary(state);
  const stake = s.nextStake;

  q('nextStake').textContent = fmt(stake.stakeUsd);
  q('nextProfit').textContent = stake.profitUsd != null ? `赢 +${fmt(stake.profitUsd).slice(1)}` : '';
  q('stakeMode').textContent =
    stake.mode === 'catch_up'
      ? `${stake.catchUpLabel || '补层'} L=${fmt(stake.layerUsd)} → T=${fmt(stake.targetProfitUsd)}`
      : stake.targetProfitUsd != null
        ? `目标 T=${fmt(stake.targetProfitUsd)} → 注码 ${fmt(stake.stakeUsd)}`
        : '按目标计算';

  q('statWinRate').textContent = fmtPct(s.winRatePct);
  q('statWL').textContent = `${s.wins}胜 ${s.losses}负`;
  q('statNet').textContent = s.netCount >= 0 ? `+${s.netCount}` : String(s.netCount);
  q('statNet').className = 'stat-val ' + (s.netCount >= 0 ? 'pos' : 'neg');
  q('statBalance').textContent = fmt(s.balance);
  q('statPrincipal').textContent = fmt(s.principal);
  q('statTarget').textContent = fmt(s.targetBalance);
  q('statGap').textContent = s.gapUsd != null && s.gapUsd > 0 ? fmt(s.gapUsd) : '—';

  const qEl = q('queueList');
  if (!s.catchUpQueue?.length) {
    qEl.textContent = '空';
    qEl.className = 'queue-empty';
  } else {
    qEl.className = '';
    qEl.textContent = s.catchUpQueue.map((x) => `补${x.id} ${fmt(x.usd)}`).join(' · ');
  }

  const hist = q('history');
  hist.innerHTML = '';
  const trades = [...(state.trades || [])].reverse().slice(0, 30);
  if (!trades.length) {
    hist.innerHTML = '<li class="empty">暂无记录</li>';
  } else {
    for (const t of trades) {
      const li = document.createElement('li');
      li.className = t.won ? 'win' : 'loss';
      const time = new Date(t.at).toLocaleString('zh-CN', { hour12: false });
      li.innerHTML =
        `<span class="tag">${t.won ? '赢' : '输'}</span>` +
        `<span class="amt">${t.won ? '+' : ''}${t.profitUsd.toFixed(2)}</span>` +
        `<span class="meta">${time} · 注${t.stakeUsd.toFixed(2)} · N=${t.netCount}${t.catchUpLabel ? ' · ' + t.catchUpLabel : ''}</span>`;
      hist.appendChild(li);
    }
  }

  q('syncStatus').textContent = apiBase ? `云端: ${apiBase}` : '仅本机 localStorage';
  q('setDefaultBet').value = s.settings.defaultBet;
  q('setStep').value = s.settings.stepUsd;
  q('setStakeMax').value = s.settings.stakeMaxUsd;
  q('setTCap').value = s.settings.catchUpProfitCapUsd;
  q('setOdds').value = s.settings.profitRatio;
  q('setBalance').value = s.balance ?? '';
  q('setApi').value = apiBase;
}

function toast(msg, isErr = false) {
  const el = q('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 2200);
}

async function onWin() {
  ({ state } = recordTrade(state, true));
  await persist();
  render();
  toast('已记录：赢');
}

async function onLoss() {
  ({ state } = recordTrade(state, false));
  await persist();
  render();
  toast('已记录：输');
}

async function onUndo() {
  if (!state.trades?.length) return toast('没有可撤销的记录', true);
  if (!confirm('撤销上一笔？')) return;
  state = undoLastTrade(state);
  await persist();
  render();
  toast('已撤销');
}

async function onReset() {
  const v = Number(q('setBalance').value);
  if (!Number.isFinite(v) || v < 0) return toast('请输入有效余额', true);
  if (!confirm(`重置本金 P=$${v.toFixed(2)}，清空 N 与补队列？`)) return;
  state = resetBankroll(v, { settings: state.settings });
  await persist();
  render();
  toast('已重置');
}

async function onSaveSettings(e) {
  e.preventDefault();
  state = patchSettings(state, {
    defaultBet: Number(q('setDefaultBet').value),
    stepUsd: Number(q('setStep').value),
    stakeMaxUsd: Number(q('setStakeMax').value),
    catchUpProfitCapUsd: Number(q('setTCap').value),
    profitRatio: Number(q('setOdds').value),
  });
  const bal = q('setBalance').value;
  if (bal !== '' && Number.isFinite(Number(bal))) {
    state = setBalance(state, Number(bal));
  }
  apiBase = (q('setApi').value || '').trim();
  localStorage.setItem('manual-tracker-api', apiBase);
  await persist();
  render();
  toast('设置已保存');
}

function onExport() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `manual-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onImport(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      state = normalizeState(JSON.parse(reader.result));
      await persist();
      render();
      toast('导入成功');
    } catch {
      toast('导入失败', true);
    }
    ev.target.value = '';
  };
  reader.readAsText(file);
}

document.getElementById('btnWin').addEventListener('click', () => onWin().catch((e) => toast(e.message, true)));
document.getElementById('btnLoss').addEventListener('click', () => onLoss().catch((e) => toast(e.message, true)));
document.getElementById('btnUndo').addEventListener('click', () => onUndo().catch((e) => toast(e.message, true)));
document.getElementById('btnReset').addEventListener('click', () => onReset().catch((e) => toast(e.message, true)));
document.getElementById('settingsForm').addEventListener('submit', (e) => onSaveSettings(e).catch((err) => toast(err.message, true)));
document.getElementById('btnExport').addEventListener('click', onExport);
document.getElementById('importFile').addEventListener('change', (e) => onImport(e).catch((err) => toast(err.message, true)));

initLoad().catch((e) => toast(e.message, true));

})();
