import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from '../config.js';
import logger from '../utils/logger.js';
import { formatPnlUsd } from './manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');
const STATE_FILE = join(LOGS_DIR, 'min-open-tier-stats-state.json');
const SETTLE_LOG = join(LOGS_DIR, 'settlements.jsonl');

const DEFAULT_MIN_OPEN_TIERS = [8, 9, 10, 11, 12];

function configuredMinOpenTiers() {
  return Array.isArray(config.minOpenTiers) && config.minOpenTiers.length > 0
    ? config.minOpenTiers
    : DEFAULT_MIN_OPEN_TIERS;
}

function emptyBucket() {
  return { trades: 0, wins: 0, losses: 0, pnlUsd: 0 };
}

function emptyState() {
  const byMinOpenTier = {};
  for (const t of configuredMinOpenTiers()) byMinOpenTier[t] = emptyBucket();
  return { byMinOpenTier, updatedAt: null };
}

/** @type {{ byMinOpenTier: Record<number, ReturnType<typeof emptyBucket>>, updatedAt: string|null }} */
let state = emptyState();

function persist() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function clampMinOpenTier(tier) {
  const t = Math.round(Number(tier));
  if (!Number.isFinite(t)) return null;
  if (!configuredMinOpenTiers().includes(t)) return null;
  return t;
}

function ensureBucket(minOpenTier) {
  const t = clampMinOpenTier(minOpenTier);
  if (t == null) return null;
  if (!state.byMinOpenTier[t]) state.byMinOpenTier[t] = emptyBucket();
  return state.byMinOpenTier[t];
}

function applyEntry(minOpenTier, { won, pnlUsd }) {
  const bucket = ensureBucket(minOpenTier);
  if (!bucket) return;
  bucket.trades += 1;
  if (won) bucket.wins += 1;
  else bucket.losses += 1;
  bucket.pnlUsd += Number(pnlUsd) || 0;
}

function resolveMinOpenTier(entry) {
  if (entry.minOpenTier != null) return entry.minOpenTier;
  if (entry.entryTier != null && configuredMinOpenTiers().includes(entry.entryTier)) {
    return entry.entryTier;
  }
  return null;
}

function rebuildFromSettlements() {
  state = emptyState();
  if (!existsSync(SETTLE_LOG)) {
    persist();
    return;
  }

  let raw;
  try {
    raw = readFileSync(SETTLE_LOG, 'utf8');
  } catch {
    persist();
    return;
  }

  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.skipped) continue;
      const minOpenTier = resolveMinOpenTier(entry);
      if (minOpenTier == null) continue;
      applyEntry(minOpenTier, {
        won: entry.won,
        pnlUsd: entry.pnlUsd,
      });
      count += 1;
    } catch {
      // skip
    }
  }

  persist();
  if (count > 0) {
    logger.info('[minOpenTierStats] rebuilt from settlements', { entries: count });
  }
}

export function init() {
  if (existsSync(STATE_FILE)) {
    try {
      state = { ...emptyState(), ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
      for (const t of configuredMinOpenTiers()) {
        state.byMinOpenTier[t] = { ...emptyBucket(), ...state.byMinOpenTier[t] };
      }
      return;
    } catch {
      state = emptyState();
    }
  }
  rebuildFromSettlements();
}

export function recordMinOpenSettlement(minOpenTier, { won, pnlUsd } = {}) {
  applyEntry(minOpenTier, { won, pnlUsd });
  persist();
  logger.info('[minOpenTierStats] settlement', {
    minOpenTier: clampMinOpenTier(minOpenTier),
    won,
    pnlUsd,
  });
}

export function getSnapshot() {
  return {
    byMinOpenTier: { ...state.byMinOpenTier },
    updatedAt: state.updatedAt,
  };
}

function winRatePct(wins, losses) {
  const n = wins + losses;
  return n > 0 ? (wins / n) * 100 : 0;
}

/** Telegram block for offline min-open tier stats (not used by live bot). */
export function formatTelegramBlock() {
  const rows = [];
  for (const t of configuredMinOpenTiers()) {
    const b = state.byMinOpenTier[t];
    if (!b || b.trades === 0) continue;
    const wr = winRatePct(b.wins, b.losses);
    rows.push(
      `tier <b>${t}</b>: ${b.trades} · ${formatPnlUsd(b.pnlUsd)} ` +
      `${wr.toFixed(0)}% (${b.wins}W/${b.losses}L)`,
    );
  }
  if (rows.length === 0) {
    return '\n📊 <b>min-open tiers</b>: none';
  }
  return `\n📊 <b>min-open tiers</b>\n${rows.join('\n')}`;
}

export function formatLogFields() {
  const snap = getSnapshot();
  const active = {};
  for (const t of configuredMinOpenTiers()) {
    const b = snap.byMinOpenTier[t];
    if (b?.trades > 0) {
      active[t] = {
        trades: b.trades,
        wins: b.wins,
        losses: b.losses,
        pnlUsd: +b.pnlUsd.toFixed(4),
        winRate: +winRatePct(b.wins, b.losses).toFixed(2),
      };
    }
  }
  return { minOpenTierStats: active };
}

export function formatTracksLine(tracks, { activityTier, activityHits } = {}) {
  if (!tracks?.length) return '';
  const parts = tracks.map(
    (tr) => `>=${tr.minOpenTier} $${tr.actualBet.toFixed(2)}`,
  );
  const head = activityTier != null
    ? `tier <b>${activityTier}</b> (${activityHits ?? '—'}/12)\n`
    : '';
  return `${head}tracks: ${parts.join(' · ')}`;
}
