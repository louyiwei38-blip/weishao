/** US equity session window in Beijing time (fixed clock range on NY trading days). */

/** NYSE full-day closures. YYYY-MM-DD in America/New_York calendar date. */
const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

function tzParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function nyDateParts(ms) {
  return tzParts(ms, 'America/New_York');
}

function bjDateParts(ms) {
  return tzParts(ms, 'Asia/Shanghai');
}

function isWeekday(weekday) {
  return !['Sat', 'Sun'].includes(weekday);
}

export function isUsMarketHoliday(dateKey) {
  return US_MARKET_HOLIDAYS.has(dateKey);
}

export function parseHm(str) {
  const [h, m] = String(str || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
}

export const DEFAULT_US_WINDOW = { startBj: '19:30', endBj: '23:59' };

/**
 * Fixed Beijing clock window on US trading days (default 19:30–23:59).
 * @param {number} nowMs
 * @param {{ startBj?: string, endBj?: string }} [window]
 */
export function isWithinUsMarketWindow(nowMs, window = DEFAULT_US_WINDOW) {
  const { startBj, endBj } = { ...DEFAULT_US_WINDOW, ...window };
  const ny = nyDateParts(nowMs);
  if (!isWeekday(ny.weekday) || isUsMarketHoliday(ny.dateKey)) {
    return { pass: false, detail: '非美股交易日' };
  }

  const bj = bjDateParts(nowMs);
  const mins = bj.hour * 60 + bj.minute;
  const start = parseHm(startBj);
  const end = parseHm(endBj);

  if (mins < start || mins > end) {
    return {
      pass: false,
      detail: `北京 ${String(bj.hour).padStart(2, '0')}:${String(bj.minute).padStart(2, '0')} 不在 ${startBj}–${endBj}`,
    };
  }

  return {
    pass: true,
    detail: `美股窗口 ${ny.dateKey} 北京 ${startBj}–${endBj}`,
  };
}

/** @deprecated use isWithinUsMarketWindow */
export function isWithinUsMarketOpenWindow(nowMs, _windowHours, window) {
  return isWithinUsMarketWindow(nowMs, window);
}

/**
 * US trading days in range with fixed BJ window label (for backtest logs).
 */
export function listUsMarketWindows(fromMs, toMs, window = DEFAULT_US_WINDOW) {
  const { startBj, endBj } = { ...DEFAULT_US_WINDOW, ...window };
  const events = [];
  const cur = new Date(fromMs);
  cur.setUTCHours(0, 0, 0, 0);

  while (cur.getTime() <= toMs + 86400000) {
    const probe = cur.getTime() + 12 * 3600_000;
    const { dateKey, weekday } = nyDateParts(probe);

    if (isWeekday(weekday) && !isUsMarketHoliday(dateKey)) {
      events.push({
        label: `美股窗口 ${dateKey} 北京${startBj}-${endBj}`,
        kind: 'us_window',
        startBj,
        endBj,
      });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return events;
}

/** @deprecated */
export function listUsMarketOpens(fromMs, toMs, window) {
  return listUsMarketWindows(fromMs, toMs, window);
}

/**
 * Macro calendar ±windowHours OR fixed US BJ window.
 */
export function evaluateCombinedEventWindow(
  nowMs,
  calendarEvents,
  windowHours,
  { usOpen = true, usWindow = DEFAULT_US_WINDOW } = {},
) {
  const windowMs = windowHours * 60 * 60 * 1000;
  const nearbyCal = calendarEvents.filter((e) => Math.abs(e.ts - nowMs) <= windowMs);

  const us = usOpen ? isWithinUsMarketWindow(nowMs, usWindow) : { pass: false };

  if (nearbyCal.length === 0 && !us.pass) {
    const { startBj, endBj } = { ...DEFAULT_US_WINDOW, ...usWindow };
    return {
      pass: false,
      enabled: true,
      detail: `±${windowHours}h 内无宏观事件且不在美股窗口 ${startBj}–${endBj} 北京`,
      usMarketOpen: us,
    };
  }

  const labels = [
    ...nearbyCal.map((e) => e.label),
    us.pass ? us.detail : null,
  ].filter(Boolean);

  return {
    pass: true,
    enabled: true,
    detail: labels.join('; '),
    events: nearbyCal.map((e) => ({ label: e.label, ts: e.ts })),
    usMarketOpen: us,
  };
}
