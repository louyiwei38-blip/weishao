import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { beijingDateKey } from '../utils/datetime.js';
import { calcWinNetProfit } from '../trader/fillSync.js';
import logger from '../utils/logger.js';
import { scopedLogPath } from '../utils/instancePaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = scopedLogPath(LOGS_DIR, 'stats-state.json');
const SETTLE_LOG = scopedLogPath(LOGS_DIR, 'settlements.jsonl');
const SETTLE_LOG_ARCHIVES = 5;

const EMPTY_BUCKET = () => ({
  pnlUsd: 0,
  wins: 0,
  losses: 0,
  stopLosses: 0,
});

/** @type {{ beijingDate: string, today: ReturnType<typeof EMPTY_BUCKET>, total: ReturnType<typeof EMPTY_BUCKET> }} */
let state = {
  beijingDate: '',
  today: EMPTY_BUCKET(),
  total: EMPTY_BUCKET(),
};

function persist() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function rollTodayIfNeeded(now = Date.now()) {
  const todayKey = beijingDateKey(now);
  if (!todayKey) return;
  if (state.beijingDate === todayKey) return;

  state.beijingDate = todayKey;
  state.today = EMPTY_BUCKET();
  persist();
}

function settlementLogPaths() {
  const paths = [];
  for (let i = SETTLE_LOG_ARCHIVES; i >= 1; i--) {
    const archived = `${SETTLE_LOG}.${i}`;
    if (existsSync(archived)) paths.push(archived);
  }
  if (existsSync(SETTLE_LOG)) paths.push(SETTLE_LOG);
  return paths;
}

/** Dedupe by cycleStartTs; later files override earlier ones. */
function readSettlementEntries() {
  const byCycle = new Map();

  for (const path of settlementLogPaths()) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.cycleStartTs == null) continue;
        byCycle.set(entry.cycleStartTs, entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  return [...byCycle.values()].sort(
    (a, b) => Number(a.cycleStartTs) - Number(b.cycleStartTs)
  );
}

function resolveEntryPnl(entry) {
  const pnl = Number(entry.pnlUsd);
  if (Number.isFinite(pnl)) return pnl;

  const won = Boolean(entry.won);
  const stake = Number(entry.actualBet) || 0;
  const entryPrice = entry.entryPrice ?? entry.limitPrice ?? null;
  return computeSettlementPnl(won, stake, entryPrice);
}

function resolveEntryTs(entry) {
  const fromIso = entry.ts ? Date.parse(entry.ts) : NaN;
  if (Number.isFinite(fromIso)) return fromIso;

  const cycleStart = Number(entry.cycleStartTs);
  if (Number.isFinite(cycleStart)) return cycleStart;

  return Date.now();
}

function applySettlementEntry(entry, todayKey) {
  const won = Boolean(entry.won);
  const pnlUsd = resolveEntryPnl(entry);
  const dayKey = beijingDateKey(resolveEntryTs(entry));

  if (won) state.total.wins += 1;
  else state.total.losses += 1;
  state.total.pnlUsd += pnlUsd;
  if (entry.martingaleHalted) state.total.stopLosses += 1;

  if (dayKey === todayKey) {
    if (won) state.today.wins += 1;
    else state.today.losses += 1;
    state.today.pnlUsd += pnlUsd;
    if (entry.martingaleHalted) state.today.stopLosses += 1;
  }
}

function rebuildFromSettlements() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const todayKey = beijingDateKey();
  state = {
    beijingDate: todayKey,
    today: EMPTY_BUCKET(),
    total: EMPTY_BUCKET(),
  };

  const entries = readSettlementEntries();
  for (const entry of entries) {
    applySettlementEntry(entry, todayKey);
  }

  persist();

  if (entries.length > 0) {
    logger.info('[stats] 已从 settlements.jsonl 回填统计', {
      entries: entries.length,
      ...formatLogFields(),
    });
  } else {
    logger.info('[stats] 无历史结算记录，统计从零开始');
  }
}

export function init() {
  rebuildFromSettlements();
}

export function computeSettlementPnl(won, stakeUsd, entryPrice) {
  const stake = Number(stakeUsd);
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  if (!won) return -stake;

  const price = Number(entryPrice);
  const profit = calcWinNetProfit(stake, price);
  if (profit != null) return profit;

  const fallback = calcWinNetProfit(stake, 0.5);
  return fallback != null ? fallback : stake;
}

function winRatePct(wins, losses) {
  const total = wins + losses;
  if (total === 0) return 0;
  return (wins / total) * 100;
}

export function getSnapshot() {
  rollTodayIfNeeded();
  return {
    beijingDate: state.beijingDate,
    today: { ...state.today },
    total: { ...state.total },
    todayWinRate: winRatePct(state.today.wins, state.today.losses),
    totalWinRate: winRatePct(state.total.wins, state.total.losses),
  };
}

export function recordSettlement({ won, pnlUsd, ts = Date.now() } = {}) {
  rollTodayIfNeeded(ts);
  const pnl = Number(pnlUsd) || 0;

  if (won) {
    state.today.wins += 1;
    state.total.wins += 1;
  } else {
    state.today.losses += 1;
    state.total.losses += 1;
  }

  state.today.pnlUsd += pnl;
  state.total.pnlUsd += pnl;
  persist();

  logger.info('[stats] 结算已记录', {
    won,
    pnlUsd: pnl,
    ...formatLogFields(),
  });
}

export function recordStopLoss({ ts = Date.now() } = {}) {
  rollTodayIfNeeded(ts);
  state.today.stopLosses += 1;
  state.total.stopLosses += 1;
  persist();

  logger.warn('[stats] 止损已记录', formatLogFields());
}

export function formatPnlUsd(value) {
  const v = Number(value) || 0;
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export function formatLogFields() {
  const s = getSnapshot();
  return {
    stats: {
      totalPnlUsd: +s.total.pnlUsd.toFixed(4),
      todayPnlUsd: +s.today.pnlUsd.toFixed(4),
      totalWinRate: +s.totalWinRate.toFixed(2),
      todayWinRate: +s.todayWinRate.toFixed(2),
      totalWins: s.total.wins,
      totalLosses: s.total.losses,
      todayWins: s.today.wins,
      todayLosses: s.today.losses,
      stopLossToday: s.today.stopLosses,
      stopLossTotal: s.total.stopLosses,
      beijingDate: s.beijingDate,
    },
  };
}

/** Telegram HTML block appended to trade / settlement notifications */
export function formatTelegramBlock() {
  const s = getSnapshot();

  return (
    `\n──────────\n` +
    `📊 <b>统计</b> (${s.beijingDate || '—'} 北京)\n` +
    `盈亏: 累计 <b>${formatPnlUsd(s.total.pnlUsd)}</b> | 今日 <b>${formatPnlUsd(s.today.pnlUsd)}</b>\n` +
    `胜率: 累计 <b>${s.totalWinRate.toFixed(1)}%</b> (${s.total.wins}胜/${s.total.losses}输)\n` +
    `     今日 <b>${s.todayWinRate.toFixed(1)}%</b> (${s.today.wins}胜/${s.today.losses}输)\n` +
    `止损: 今日 <b>${s.today.stopLosses}</b> | 总计 <b>${s.total.stopLosses}</b>`
  );
}
