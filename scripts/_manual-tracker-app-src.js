import {
  defaultState,
  normalizeState,
  recordTrade,
  getSummary,
  resetBankroll,
  setBalance,
  patchSettings,
  undoLastTrade,
} from './lib/bankroll.js';

const STORAGE_KEY = 'manual-tracker-state-v1';
const $ = (sel) => document.querySelector(sel);

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

  $('#nextStake').textContent = fmt(stake.stakeUsd);
  $('#nextProfit').textContent = stake.profitUsd != null ? `赢 +${fmt(stake.profitUsd).slice(1)}` : '';
  $('#stakeMode').textContent =
    stake.mode === 'catch_up'
      ? `${stake.catchUpLabel || '补层'} L=${fmt(stake.layerUsd)} → T=${fmt(stake.targetProfitUsd)}`
      : stake.targetProfitUsd != null
        ? `目标 T=${fmt(stake.targetProfitUsd)} → 注码 ${fmt(stake.stakeUsd)}`
        : '按目标计算';

  $('#statWinRate').textContent = fmtPct(s.winRatePct);
  $('#statWL').textContent = `${s.wins}胜 ${s.losses}负`;
  $('#statNet').textContent = s.netCount >= 0 ? `+${s.netCount}` : String(s.netCount);
  $('#statNet').className = 'stat-val ' + (s.netCount >= 0 ? 'pos' : 'neg');
  $('#statBalance').textContent = fmt(s.balance);
  $('#statPrincipal').textContent = fmt(s.principal);
  $('#statTarget').textContent = fmt(s.targetBalance);
  $('#statGap').textContent = s.gapUsd != null && s.gapUsd > 0 ? fmt(s.gapUsd) : '—';

  const qEl = $('#queueList');
  if (!s.catchUpQueue?.length) {
    qEl.textContent = '空';
    qEl.className = 'queue-empty';
  } else {
    qEl.className = '';
    qEl.textContent = s.catchUpQueue.map((x) => `补${x.id} ${fmt(x.usd)}`).join(' · ');
  }

  const hist = $('#history');
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

  $('#syncStatus').textContent = apiBase ? `云端: ${apiBase}` : '仅本机 localStorage';
  $('#setDefaultBet').value = s.settings.defaultBet;
  $('#setStep').value = s.settings.stepUsd;
  $('#setStakeMax').value = s.settings.stakeMaxUsd;
  $('#setTCap').value = s.settings.catchUpProfitCapUsd;
  $('#setOdds').value = s.settings.profitRatio;
  $('#setBalance').value = s.balance ?? '';
  $('#setApi').value = apiBase;
}

function toast(msg, isErr = false) {
  const el = $('#toast');
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
  const v = Number($('#setBalance').value);
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
    defaultBet: Number($('#setDefaultBet').value),
    stepUsd: Number($('#setStep').value),
    stakeMaxUsd: Number($('#setStakeMax').value),
    catchUpProfitCapUsd: Number($('#setTCap').value),
    profitRatio: Number($('#setOdds').value),
  });
  const bal = $('#setBalance').value;
  if (bal !== '' && Number.isFinite(Number(bal))) {
    state = setBalance(state, Number(bal));
  }
  apiBase = ($('#setApi').value || '').trim();
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
