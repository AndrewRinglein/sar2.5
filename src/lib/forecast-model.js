/* ============================================================================
   SAR 2.0 — Forecast model (U12)

   Pure functions. No DOM, no network, no clock: `today` is always passed in,
   so every figure here can be reproduced by hand in a test.

   SCOPE DECISION — THE SLOT MODEL IS THE MODEL.
   The plan (SAR2-IMPLEMENTATION.md, U12) says "built from scratch — the
   existing projection logic is explicitly not a model to follow", meaning SAR
   1.0's schedule-driven projection (SPEC §8.3). The slot model used here is
   new to SAR 2.0 and already proven on the Managers screen: a session's
   takings are predicted by its SLOT — hall, weekday, session type — and a
   slot needs `MIN_SLOT_SESSIONS` before its average is used.

   THE WINDOW IS 13 WEEKS, NOT A YEAR (`FORECAST_WINDOW_DAYS`). Decided from a
   12-month backtest on live data, 1 Oct 2026, both halls: a trailing-year
   mean missed by 10.6% on average and came in LOW in all 12 months (it lags
   a business whose takings per night have been rising); 26 weeks 4.2%, bias
   −3.8%; 13 weeks 2.6%, bias −0.5%; 8 weeks 3.3%. Managers keeps its year —
   it compares people within a slot, where level drift cancels out. The driver method from the v9 mockup
   (attendance, spend per head, payout ratio) is layered ON TOP as multipliers
   on each slot's baseline — it is not a second model. Recorded in
   SAR2-REMAINING-DESIGN.md, "Forecast (U12) — scope decisions".

   SAR 1.0's GUARDRAILS THAT ARE KEPT (SPEC §8.3, §19a):
     · never invent a missed past session — a day more than one day in the
       past with no data is "missing / not yet entered", counted and listed,
       never projected. Yesterday and today stay projectable (ingestion lag).
     · a session whose slot has no usable history goes to a visible
       "unprojectable" bucket, never silently dropped
     · the averages and sample counts behind every projection are exposed

   HOLIDAYS ARE LEARNED, NOT ASSUMED. An expected session on a holiday is
   looked up against the same holiday the last time that session type at
   that hall was running that weekday, falling back to the hall as a whole
   (`holidayEvidence`): not held → "closed", not projected, listed,
   re-openable via `open`; held → projected; no evidence → projected and
   marked. The backtest applies it with only earlier data.

   OWNER-CONFIRMED CLOSURES (config `OWNER_CLOSURES`, via
   `resolveOwnerClosures`) are facts, not evidence: such a night is closed
   whatever the history says, labelled "Closed — confirmed by owner", still
   re-openable via `open`, and still overridden by a deployed/planned roster
   session. The backtest does NOT apply them — a confirmation given on 1 Oct
   2026 was not known when the months it replays were forecast.

   WHICH SESSIONS ARE STILL TO COME. A calendar walk of each slot that is
   CURRENTLY RUNNING — at least `RUNNING_MIN_SESSIONS` sessions in the trailing
   `RUNNING_WINDOW_WEEKS` weeks — plus the Operations roster where it reaches
   (deployed and planned only; drafts are excluded and reported, the same rule
   as Staff Overview). A slot that stopped running is not projected forever.

   MONEY IS INTEGER CENTS, exactly as `sessionTotals()` returns it: `revenue`
   (gross), `payout`, `net`, plus `attendance` as a head count. Nothing here
   divides by 100. Projections are means, so they are fractional cents; the
   display rounds.
   ========================================================================== */

import { metricsFor, sessionTotals } from './model.js';
import {
  slotKey, weekdayIndex, dayNumber, resolveHalls, SLOT_WINDOW_DAYS, MIN_SLOT_SESSIONS, Z_95,
} from './managers.js';
import { hallMatches } from './charts.js';
import { COUNTED_STATUSES } from './staff-model.js';

/* ---------------------------------------------------------------------------
   Constants
--------------------------------------------------------------------------- */

/** A slot is "currently running" if it ran this often in this many weeks. */
/** Baseline window for the forecast, in days. See the header: 13 weeks. */
export const FORECAST_WINDOW_DAYS = 91;

export const RUNNING_WINDOW_WEEKS = 8;
export const RUNNING_MIN_SESSIONS = 2;

/**
 * A day more than this many days in the past with no data is MISSING, not
 * projectable. 1 = yesterday and today are still projected (ingestion lag).
 */
export const MISSING_GRACE_DAYS = 1;

/**
 * Completed months the backtest replays. Twelve, so the drift estimate and
 * the in-range count include December and the holidays, not only the
 * summer.
 */
export const BACKTEST_MONTHS = 12;
/** Below this many backtested months, the range is not widened. */
export const MIN_BACKTEST_FOR_WIDENING = 3;

export const HORIZONS = Object.freeze([
  { id: 'month', label: 'Rest of this month', months: 1 },
  { id: '3m', label: 'Next 3 months', months: 3 },
  { id: 'year', label: 'Rest of year', months: null },
  { id: '12m', label: 'Next 12 months', months: 12 },
]);
export const DEFAULT_HORIZON = 'month';

/** Driver bounds. Payout is in percentage points; the others in per cent. */
export const DRIVER_LIMITS = Object.freeze({
  att: { min: -50, max: 50, step: 1 },
  spend: { min: -30, max: 30, step: 1 },
  payout: { min: -10, max: 10, step: 0.5 },
});

export const BASELINE_DRIVERS = Object.freeze({ att: 0, spend: 0, payout: 0 });

export const SCENARIO_KEY = 'sar2-forecast-scenarios';

/* ---------------------------------------------------------------------------
   Dates — 'YYYY-MM-DD' and day numbers, UTC throughout
--------------------------------------------------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

export const isoOfDay = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

/** 'YYYY-MM' plus n months. */
export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export const monthStartDay = (key) => dayNumber(`${key}-01`);
export const monthEndDay = (key) => monthStartDay(addMonths(key, 1)) - 1;

/**
 * Today's date in the tenant's timezone, from a clock reading.
 *
 * The halls close late in the evening Pacific, which is already tomorrow in
 * UTC; using UTC would move "today" a day early every night. Falls back to UTC
 * if the timezone is missing or unknown to this runtime.
 */
export function todayIso(now = new Date(), timeZone = null) {
  const t = now instanceof Date ? now : new Date(now);
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(t);
      const get = (k) => parts.find((p) => p.type === k)?.value;
      if (get('year') && get('month') && get('day')) return `${get('year')}-${get('month')}-${get('day')}`;
    } catch { /* unknown zone — UTC below */ }
  }
  return t.toISOString().slice(0, 10);
}

/**
 * The calendar months a horizon covers, starting with the current month.
 *
 *   month  this month only (the rest of it)
 *   3m     this month and the next two
 *   year   this month through December
 *   12m    this month and the next eleven
 *
 * Every horizon starts with the CURRENT month, whose done sessions are
 * actuals and whose remainder is projected.
 */
export function horizonMonths(horizon, today) {
  const first = String(today).slice(0, 7);
  const h = HORIZONS.find((x) => x.id === horizon) ?? HORIZONS[0];
  const n = h.months ?? (12 - Number(first.slice(5, 7)) + 1);
  return Array.from({ length: n }, (_, i) => addMonths(first, i));
}

/* ---------------------------------------------------------------------------
   Per-session rows
--------------------------------------------------------------------------- */

/**
 * One row per analytics event, with the four figures the forecast uses.
 *
 *   gross       sessionTotals().revenue — sum of every category's revenue_keys
 *   payout      sessionTotals().payout  — sum of every category's payout_keys (signed)
 *   net         sessionTotals().net     — gross − payout
 *   attendance  the `attendance` metric, null when not recorded
 *
 * All cents. Computed once per render; everything else works on these rows.
 */
export function sessionRows(events = [], ctx = {}) {
  return events.map((e) => {
    const t = sessionTotals(metricsFor(e.id, ctx.metrics, ctx.idx), ctx.categories ?? []);
    return {
      id: e.id,
      date: e.event_date,
      day: dayNumber(e.event_date),
      dow: weekdayIndex(e.event_date),
      locationId: e.location_id,
      type: e.event_type,
      slot: slotKey(e),
      gross: t.revenue,
      payout: t.payout,
      net: t.net,
      attendance: t.attendance,
    };
  });
}

/* ---------------------------------------------------------------------------
   Statistics
--------------------------------------------------------------------------- */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/* ---------------------------------------------------------------------------
   Slot baselines
--------------------------------------------------------------------------- */

/**
 * Mean and spread per slot over `[cutoff − windowDays, cutoff)`.
 *
 * STRICTLY BEFORE `cutoff`. For today's forecast the cutoff is tomorrow, so
 * today's sessions count; for a backtest it is the 1st of the month being
 * predicted, so nothing from that month can leak in.
 *
 * `payoutRatio` is a ratio of MEANS (mean payout ÷ mean gross), so that a
 * baseline with no drivers applied reproduces the slot's mean net exactly.
 */
export function slotBaselines(rows, {
  cutoff, windowDays = FORECAST_WINDOW_DAYS, minSessions = MIN_SLOT_SESSIONS,
} = {}) {
  const by = new Map();
  for (const r of rows) {
    if (r.day >= cutoff || r.day < cutoff - windowDays) continue;
    const cur = by.get(r.slot) ?? {
      slot: r.slot, locationId: r.locationId, weekday: r.dow, type: r.type,
      gross: [], payout: [], net: [], attendance: [], lastDate: null,
    };
    cur.gross.push(r.gross);
    cur.payout.push(r.payout);
    cur.net.push(r.net);
    if (r.attendance !== null && r.attendance !== undefined) cur.attendance.push(r.attendance);
    if (!cur.lastDate || r.date > cur.lastDate) cur.lastDate = r.date;
    by.set(r.slot, cur);
  }
  const out = new Map();
  for (const [k, s] of by) {
    const meanGross = mean(s.gross);
    const meanPayout = mean(s.payout);
    out.set(k, {
      slot: k, locationId: s.locationId, weekday: s.weekday, type: s.type,
      lastDate: s.lastDate,
      n: s.gross.length,
      nAttendance: s.attendance.length,
      meanGross, sdGross: sd(s.gross),
      meanPayout,
      meanNet: mean(s.net), sdNet: sd(s.net),
      meanAttendance: mean(s.attendance),
      payoutRatio: meanGross > 0 ? meanPayout / meanGross : 0,
      usable: s.gross.length >= minSessions,
    });
  }
  return out;
}

/**
 * Which slots are currently running, and which have stopped.
 *
 * Running: at least `minRuns` sessions in `[cutoff − weeks·7, cutoff)`.
 * Stopped: ran in the baseline window but not often enough recently — listed
 * so a closed night is visibly NOT projected, rather than quietly projected.
 */
export function runningSlots(rows, {
  cutoff, weeks = RUNNING_WINDOW_WEEKS, minRuns = RUNNING_MIN_SESSIONS,
  // Look back a full year for the "stopped" list, so a night that closed in
  // spring is still named — it is never projected either way.
  windowDays = SLOT_WINDOW_DAYS,
} = {}) {
  const seen = new Map();
  for (const r of rows) {
    if (r.day >= cutoff || r.day < cutoff - windowDays) continue;
    const s = seen.get(r.slot) ?? {
      slot: r.slot, locationId: r.locationId, weekday: r.dow, type: r.type, runs: 0, lastDate: null,
    };
    if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
    if (r.day >= cutoff - weeks * 7) s.runs += 1;
    seen.set(r.slot, s);
  }
  const running = new Map();
  const stopped = [];
  for (const [k, s] of seen) {
    if (s.runs >= minRuns) running.set(k, s);
    else stopped.push(s);
  }
  stopped.sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
  return { running, stopped };
}

/* ---------------------------------------------------------------------------
   Halls — Ops slug to analytics location, from data
--------------------------------------------------------------------------- */

/**
 * Map Operations hall ids onto analytics location ids.
 *
 * By data first: `settings.ops_hall_id` if a location carries one, else its
 * `code` lower-cased (production: SC -> 'sc', RWC -> 'rwc', which are the Ops
 * hall ids). Only when NO location yields a key does it fall back to the
 * shared `resolveHalls()` the Managers and Staff screens use.
 */
export function hallMapFromLocations(locations = []) {
  const map = new Map();
  for (const l of locations) {
    const viaSettings = l?.settings?.ops_hall_id ?? l?.settings?.ops_hall ?? null;
    if (viaSettings) map.set(String(viaSettings), l.id);
    else if (l?.code) map.set(String(l.code).toLowerCase(), l.id);
  }
  if (map.size) return { map, via: 'data' };
  return { map: resolveHalls(locations), via: 'name' };
}

/* ---------------------------------------------------------------------------
   The roster
--------------------------------------------------------------------------- */

const PART_ORDER = { AM: 0, PM: 1 };
const TYPE_ORDER = { regular: 0, late: 1 };

/**
 * Operations sessions in `[fromDay, toDay]`, resolved to analytics slots.
 *
 * Counted: `COUNTED_STATUSES` (deployed, planned). Drafts and any other status
 * are excluded and counted by status. A hall that cannot be mapped is counted.
 *
 * TYPE RESOLUTION. Ops says AM/PM; analytics says regular/late, and a weekday
 * with one session is PM in Ops but `regular` in analytics. So:
 *   · two counted sessions at a hall on one day: ordinal — AM first.
 *   · one: the type that hall runs on that weekday, if it runs only one;
 *     else the type the hall runs at all, if only one; else PM -> late.
 */
export function rosterSessions(opsSessions = [], {
  hallMap = new Map(), fromDay, toDay, rows = [], cutoff = Infinity,
} = {}) {
  const typesByDow = new Map();
  const typesByHall = new Map();
  for (const r of rows) {
    if (r.day >= cutoff) continue;
    const k = `${r.locationId}|${r.dow}`;
    (typesByDow.get(k) ?? typesByDow.set(k, new Set()).get(k)).add(r.type);
    (typesByHall.get(r.locationId) ?? typesByHall.set(r.locationId, new Set()).get(r.locationId)).add(r.type);
  }
  const sortTypes = (set) => [...set].sort((a, b) => (TYPE_ORDER[a] ?? 9) - (TYPE_ORDER[b] ?? 9));

  const excluded = {};
  let unmapped = 0;
  let lastDate = null;
  const byDay = new Map();
  for (const s of opsSessions) {
    if (!s?.session_date) continue;
    const day = dayNumber(s.session_date);
    if (day < fromDay || day > toDay) continue;
    const status = s.status ?? 'unknown';
    if (!COUNTED_STATUSES.includes(status)) {
      excluded[status] = (excluded[status] ?? 0) + 1;
      continue;
    }
    const loc = hallMap.get(s.hall_id);
    if (!loc) { unmapped += 1; continue; }
    if (!lastDate || s.session_date > lastDate) lastDate = s.session_date;
    const k = `${s.session_date}|${loc}`;
    (byDay.get(k) ?? byDay.set(k, []).get(k)).push(s);
  }

  const sessions = [];
  for (const [k, list] of byDay) {
    const [date, loc] = k.split('|');
    const dow = weekdayIndex(date);
    list.sort((a, b) => (PART_ORDER[a.part] ?? 9) - (PART_ORDER[b.part] ?? 9));
    let types;
    if (list.length > 1) {
      const known = sortTypes(typesByDow.get(`${loc}|${dow}`) ?? typesByHall.get(loc) ?? new Set());
      const order = known.length >= list.length ? known : ['regular', 'late'];
      types = list.map((_, i) => order[i] ?? `extra-${i}`);
    } else {
      const onDow = typesByDow.get(`${loc}|${dow}`);
      const atHall = typesByHall.get(loc);
      if (onDow?.size === 1) types = [[...onDow][0]];
      else if (!onDow && atHall?.size === 1) types = [[...atHall][0]];
      else types = [list[0].part === 'PM' && (onDow ?? atHall)?.has('late') ? 'late' : 'regular'];
    }
    list.forEach((s, i) => {
      sessions.push({
        date, day: dayNumber(date), dow, locationId: loc, type: types[i],
        slot: `${loc}|${dow}|${types[i]}`, source: 'roster', status: s.status, part: s.part ?? null,
      });
    });
  }
  sessions.sort((a, b) => a.day - b.day);
  return { sessions, excluded, unmapped, lastDate };
}

/* ---------------------------------------------------------------------------
   The calendar walk
--------------------------------------------------------------------------- */

/**
 * Every session expected in `[fromDay, toDay]`: the roster where it has the
 * day, the usual pattern of each running slot where it does not.
 *
 * The roster owns a (date, hall) it covers — the pattern does not add to it.
 */
export function expectedSessions({ fromDay, toDay, running = new Map(), roster = [], hall = 'all' }) {
  const out = [];
  const claimed = new Set();
  for (const r of roster) {
    if (r.day < fromDay || r.day > toDay || !hallMatches(hall, r.locationId)) continue;
    out.push(r);
    claimed.add(`${r.date}|${r.locationId}`);
  }
  const byDow = new Map();
  for (const s of running.values()) {
    if (!hallMatches(hall, s.locationId)) continue;
    (byDow.get(s.weekday) ?? byDow.set(s.weekday, []).get(s.weekday)).push(s);
  }
  for (let day = fromDay; day <= toDay; day += 1) {
    const date = isoOfDay(day);
    const dow = weekdayIndex(date);
    for (const s of byDow.get(dow) ?? []) {
      if (claimed.has(`${date}|${s.locationId}`)) continue;
      out.push({ date, day, dow, locationId: s.locationId, type: s.type, slot: s.slot, source: 'pattern' });
    }
  }
  return out.sort((a, b) => a.day - b.day || (a.slot < b.slot ? -1 : 1));
}

/* ---------------------------------------------------------------------------
   Holidays — closures learned from the data, never assumed

   A hall that closed last Thanksgiving will probably close this one; a hall
   that opened last Christmas Eve probably will again. So nothing here says
   "closed": the calendar only says WHICH days are holidays, and the evidence
   says what each hall did on the same holiday before.
--------------------------------------------------------------------------- */

/** Easter Sunday, anonymous Gregorian computus (Meeus/Jones/Butcher). */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The nth (1-based) weekday `dow` of a month; n = -1 for the last. */
function nthWeekday(year, month, dow, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return `${year}-${pad(month)}-${pad(1 + ((dow - first + 7) % 7) + (n - 1) * 7)}`;
  }
  const lastDate = new Date(Date.UTC(year, month, 0));
  const back = (lastDate.getUTCDay() - dow + 7) % 7;
  return `${year}-${pad(month)}-${pad(lastDate.getUTCDate() - back)}`;
}

/** US holidays that plausibly change whether a bingo hall opens. */
export const HOLIDAYS = Object.freeze([
  { key: 'newyear', name: "New Year's Day", on: (y) => `${y}-01-01` },
  { key: 'easter', name: 'Easter Sunday', on: (y) => easterSunday(y) },
  { key: 'mothers', name: "Mother's Day", on: (y) => nthWeekday(y, 5, 0, 2) },
  { key: 'memorial', name: 'Memorial Day', on: (y) => nthWeekday(y, 5, 1, -1) },
  { key: 'july4', name: 'Independence Day', on: (y) => `${y}-07-04` },
  { key: 'fathers', name: "Father's Day", on: (y) => nthWeekday(y, 6, 0, 3) },
  { key: 'labor', name: 'Labor Day', on: (y) => nthWeekday(y, 9, 1, 1) },
  { key: 'thanksgiving', name: 'Thanksgiving', on: (y) => nthWeekday(y, 11, 4, 4) },
  { key: 'xmaseve', name: 'Christmas Eve', on: (y) => `${y}-12-24` },
  { key: 'xmas', name: 'Christmas Day', on: (y) => `${y}-12-25` },
  { key: 'nye', name: "New Year's Eve", on: (y) => `${y}-12-31` },
]);

/** Common names accepted for a holiday in configuration, beside the keys above. */
const HOLIDAY_ALIASES = Object.freeze({
  christmas: 'xmas', 'christmas day': 'xmas', 'christmas eve': 'xmaseve',
  'new year': 'newyear', "new year's day": 'newyear', "new year's eve": 'nye',
  'independence day': 'july4', 'fourth of july': 'july4',
});

/** A HOLIDAYS key from a key, alias or name; null when it is not one of ours. */
export function holidayKeyOf(v) {
  const k = String(v ?? '').trim().toLowerCase();
  if (!k) return null;
  if (HOLIDAYS.some((h) => h.key === k)) return k;
  if (HOLIDAY_ALIASES[k]) return HOLIDAY_ALIASES[k];
  return HOLIDAYS.find((h) => h.name.toLowerCase() === k)?.key ?? null;
}

/**
 * Owner-confirmed closures (config OWNER_CLOSURES) resolved to
 * `${holidayKey}|${locationId}` -> { holiday, hall, confirmed }. Halls are
 * matched by analytics location CODE, never by name. Entries naming an
 * unknown holiday or hall are returned in `unknown`, not guessed.
 */
export function resolveOwnerClosures(closures = [], locations = []) {
  const map = new Map(); const unknown = [];
  for (const c of closures ?? []) {
    const key = holidayKeyOf(c?.holiday);
    const loc = (locations ?? []).find((l) => l?.code
      && String(l.code).toUpperCase() === String(c?.hall ?? '').toUpperCase());
    if (!key || !loc) { unknown.push(c); continue; }
    map.set(`${key}|${loc.id}`, { holiday: key, hall: String(c.hall).toUpperCase(),
      confirmed: c.confirmed ?? null });
  }
  return { map, unknown };
}

/** `[{ key, name, date }]` for one year, in date order. */
export function holidaysForYear(year) {
  return HOLIDAYS.map((h) => ({ key: h.key, name: h.name, date: h.on(year) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The holiday on a date, or null. */
export function holidayOn(date) {
  const y = Number(String(date).slice(0, 4));
  return holidaysForYear(y).find((h) => h.date === date) ?? null;
}

/**
 * What each hall did on each past holiday, from rows strictly before `before`.
 *
 * For every holiday inside the data, per hall:
 *   held      the hall has any session that day
 *   closed    a slot at that hall was RUNNING on that weekday then (by the
 *             same test as the forecast: `runningSlots` as of that date) and
 *             nothing was held
 *   no-slot   the hall would not have opened that weekday anyway — no evidence
 *
 * Returns a Map with two kinds of entry, each { key, name, locationId, type,
 * history: [{ date, outcome }] (oldest first), latest } where `latest` is the
 * most recent held/closed occurrence, or null when there is no evidence:
 *
 *   `${holidayKey}|${locationId}`          the HALL: held if it held anything
 *   `${holidayKey}|${locationId}|${type}`  each SESSION TYPE that was running
 *                                          that weekday (or was held): held
 *                                          or closed
 *
 * The forecast uses the session-type entry first — so a hall that opened on
 * Mother's Day but dropped its late session has the late session "closed"
 * and the regular one "held" — and falls back to the hall. Keyed by type,
 * not weekday, because fixed-date holidays move weekday from year to year.
 */
export function holidayEvidence(rows, { before = Infinity } = {}) {
  const usable = rows.filter((r) => r.day < before);
  const out = new Map();
  if (!usable.length) return out;
  let first = Infinity; let last = -Infinity;
  const halls = new Set();
  const heldOn = new Set();
  const heldType = new Map();
  for (const r of usable) {
    if (r.day < first) first = r.day;
    if (r.day > last) last = r.day;
    halls.add(r.locationId);
    heldOn.add(`${r.date}|${r.locationId}`);
    const k = `${r.date}|${r.locationId}`;
    (heldType.get(k) ?? heldType.set(k, new Set()).get(k)).add(r.type);
  }
  const record = (k, base, date, outcome) => {
    const e = out.get(k) ?? { ...base, history: [], latest: null };
    e.history.push({ date, outcome });
    if (outcome !== 'no-slot') e.latest = { date, outcome };
    out.set(k, e);
  };
  const y0 = Number(isoOfDay(first).slice(0, 4));
  const y1 = Number(isoOfDay(last).slice(0, 4));
  for (let y = y0; y <= y1; y += 1) {
    for (const h of holidaysForYear(y)) {
      const d = dayNumber(h.date);
      if (d < first || d > last) continue;
      const { running } = runningSlots(usable, { cutoff: d });
      const dow = weekdayIndex(h.date);
      for (const loc of halls) {
        const slotsThen = [...running.values()].filter((s) => s.locationId === loc && s.weekday === dow);
        const held = heldOn.has(`${h.date}|${loc}`);
        const outcome = held ? 'held' : slotsThen.length ? 'closed' : 'no-slot';
        record(`${h.key}|${loc}`, { key: h.key, name: h.name, locationId: loc, type: null }, h.date, outcome);
        // Per session type: each slot running that weekday, plus anything held.
        const types = new Set([...slotsThen.map((s) => s.type), ...(heldType.get(`${h.date}|${loc}`) ?? [])]);
        for (const type of types) {
          const ok = heldType.get(`${h.date}|${loc}`)?.has(type) ?? false;
          record(`${h.key}|${loc}|${type}`, { key: h.key, name: h.name, locationId: loc, type },
            h.date, ok ? 'held' : 'closed');
        }
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Drivers
--------------------------------------------------------------------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const numOr = (v, d) => {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Clean driver values: numbers, within `DRIVER_LIMITS`. */
export function normaliseDrivers(d = {}) {
  const out = {};
  for (const [k, lim] of Object.entries(DRIVER_LIMITS)) out[k] = clamp(numOr(d[k], 0), lim.min, lim.max);
  return out;
}

/** Drivers, switched-off slots, mode and horizon from route params. */
export function parseForecastParams(params = {}) {
  return {
    drivers: normaliseDrivers({ att: params.att, spend: params.spend, payout: params.payout }),
    off: new Set(String(params.off ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    open: new Set(String(params.open ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    mode: params.mode === 'expenses' ? 'expenses' : 'bingo',
    horizon: HORIZONS.some((h) => h.id === params.horizon) ? params.horizon : DEFAULT_HORIZON,
    hall: params.hall ?? 'all',
  };
}

/** The inverse, omitting anything at its default so the URL stays short. */
export function forecastParams({
  drivers = BASELINE_DRIVERS, off = new Set(), open = new Set(), mode, horizon, hall,
} = {}) {
  const d = normaliseDrivers(drivers);
  return {
    hall: hall && hall !== 'all' ? hall : undefined,
    horizon: horizon && horizon !== DEFAULT_HORIZON ? horizon : undefined,
    mode: mode === 'expenses' ? 'expenses' : undefined,
    att: d.att || undefined,
    spend: d.spend || undefined,
    payout: d.payout || undefined,
    off: off.size ? [...off].sort().join(',') : undefined,
    open: open?.size ? [...open].sort().join(',') : undefined,
  };
}

/** A holiday session re-opened by the user: `${date}|${locationId}|${type}`. */
export const openKey = (s) => `${s.date}|${s.locationId}|${s.type}`;

export const isBaseline = (d = {}, off = new Set(), open = new Set()) => {
  const n = normaliseDrivers(d);
  return !n.att && !n.spend && !n.payout && !off.size && !open?.size;
};

/**
 * One projected session of a slot, under drivers.
 *
 *   gross       = meanGross × (1 + att%) × (1 + spend%)
 *   payoutRatio = clamp(baseline ratio + payout pp, 0, 1)
 *   payout      = gross × payoutRatio
 *   net         = gross − payout
 *   attendance  = meanAttendance × (1 + att%)
 *   sdGross     = sdGross × (1 + att%) × (1 + spend%)   (spread scales with level)
 *
 * With no drivers this returns the slot's own means exactly.
 */
export function applyDrivers(b, drivers = BASELINE_DRIVERS) {
  const d = normaliseDrivers(drivers);
  const mA = 1 + d.att / 100;
  const mS = 1 + d.spend / 100;
  const gross = b.meanGross * mA * mS;
  const ratio = clamp(b.payoutRatio + d.payout / 100, 0, 1);
  const unchanged = !d.att && !d.spend && !d.payout;
  const payout = unchanged ? b.meanPayout : gross * ratio;
  return {
    gross,
    payout,
    net: gross - payout,
    attendance: b.meanAttendance === null ? null : b.meanAttendance * mA,
    sdGross: (b.sdGross ?? 0) * mA * mS,
    sdNet: (b.sdNet ?? 0) * mA * mS,
    payoutRatio: unchanged ? b.payoutRatio : ratio,
  };
}

/* ---------------------------------------------------------------------------
   Expenses — assumptions owned by Unit Economics
--------------------------------------------------------------------------- */

/**
 * Average cost of goods per linked session, from Unit Economics'
 * `costOfGoods()` map. Null when nothing is linked — then there is no COGS
 * line at all, rather than a line of zero.
 */
export function cogsPerSession(costMap = new Map()) {
  const vals = [...costMap.values()].map((v) => v?.cost).filter(Number.isFinite);
  return vals.length ? { perSession: mean(vals), n: vals.length } : null;
}

/**
 * Expense lines for a number of sessions, from the Unit Economics assumptions.
 *
 *   staff  = sessions × staffPerSession (hours) × staffCostPerHour   ASSUMED
 *   fixed  = sessions × fixedPerSession                                ASSUMED
 *   cogs   = sessions × average linked cost of goods                   ESTIMATED
 *
 * Labour is one aggregate line from a blended cost assumption. No person's
 * rate exists anywhere in this model.
 */
export function expensesFor(sessions, assumptions = {}, cogs = null) {
  const staffPer = numOr(assumptions.staffPerSession, 0) * numOr(assumptions.staffCostPerHour, 0);
  const staff = sessions * staffPer;
  const fixed = sessions * numOr(assumptions.fixedPerSession, 0);
  const goods = cogs ? sessions * cogs.perSession : null;
  return { staff, fixed, cogs: goods, total: staff + fixed + (goods ?? 0) };
}

/* ---------------------------------------------------------------------------
   The forecast
--------------------------------------------------------------------------- */

const zero = () => ({ sessions: 0, gross: 0, payout: 0, net: 0, attendance: 0 });

/**
 * Baselines and running slots as of a date. One definition, used by the live
 * forecast and by every backtest month, so the backtest tests THIS model.
 */
export function prepare(rows, { today, minSessions = MIN_SLOT_SESSIONS } = {}) {
  const t = typeof today === 'number' ? today : dayNumber(today);
  const cutoff = t + 1;
  const baselines = slotBaselines(rows, { cutoff, minSessions });
  const { running, stopped } = runningSlots(rows, { cutoff });
  const holidays = holidayEvidence(rows, { before: cutoff });
  return { today: t, cutoff, baselines, running, stopped, holidays };
}

/**
 * Actuals plus projection, per month, for a horizon.
 *
 * Input: `rows` (sessionRows), `prep` (prepare), `months` ('YYYY-MM' list),
 * `roster` (rosterSessions().sessions), `hall`, `drivers`, `off` (slot keys
 * switched off), `assumptions`, `cogs`, `drift` ({ gross, net } relative
 * level-error per month, or null).
 *
 * Each expected session is exactly one of:
 *   done           an analytics session exists for that date, hall and type
 *   missing        more than MISSING_GRACE_DAYS in the past with no data
 *   closed         a holiday on which this session type at this hall (else
 *                  the hall as a whole), last time it was expected, was not
 *                  held (`holidayEvidence`), or an owner-confirmed closure
 *                  (`ownerClosed`, from `resolveOwnerClosures`) — unless
 *                  re-opened via `open` or scheduled on the roster
 *   switched off   its slot is turned off in this scenario
 *   projected      valued at its slot baseline under the drivers
 *   unprojectable  its slot has fewer than MIN_SLOT_SESSIONS in the window
 */
export function buildForecast({
  rows = [], prep, months = [], roster = [], hall = 'all',
  drivers = BASELINE_DRIVERS, off = new Set(), open = new Set(),
  assumptions = null, cogs = null, drift = null, ownerClosed = new Map(),
}) {
  const { today, baselines, running } = prep;
  const evidence = prep.holidays ?? new Map();
  if (!months.length) return emptyForecast();
  const fromDay = monthStartDay(months[0]);
  const toDay = monthEndDay(months[months.length - 1]);

  const by = new Map(months.map((m, i) => [m, {
    key: m, index: i, actual: zero(), projected: { ...zero(), varGross: 0, varNet: 0 },
    missing: 0, unprojectable: 0, switchedOff: 0, closed: 0,
  }]));

  // Actuals: every analytics session in range, to date.
  const done = new Set();
  for (const r of rows) {
    if (r.day < fromDay || r.day > toDay || r.day > today || !hallMatches(hall, r.locationId)) continue;
    const m = by.get(r.date.slice(0, 7));
    if (!m) continue;
    m.actual.sessions += 1;
    m.actual.gross += r.gross;
    m.actual.payout += r.payout;
    m.actual.net += r.net;
    m.actual.attendance += r.attendance ?? 0;
    done.add(`${r.date}|${r.locationId}|${r.type}`);
  }

  const expected = expectedSessions({ fromDay, toDay, running, roster, hall });
  const projected = []; const missing = []; const unprojectable = []; const switchedOff = [];
  const closed = [];
  for (const raw of expected) {
    if (done.has(`${raw.date}|${raw.locationId}|${raw.type}`)) continue;
    const m = by.get(raw.date.slice(0, 7));
    if (raw.day < today - MISSING_GRACE_DAYS) { missing.push(raw); m.missing += 1; continue; }
    let s = raw;
    const hol = holidayOn(raw.date);
    if (hol) {
      const bySession = evidence.get(`${hol.key}|${raw.locationId}|${raw.type}`)?.latest ?? null;
      const byHall = evidence.get(`${hol.key}|${raw.locationId}`)?.latest ?? null;
      const ev = bySession ?? byHall;
      const reopened = open.has(openKey(raw));
      // An owner-confirmed closure outranks the evidence either way — "no
      // history" and "held last time" alike — but not a roster session.
      const owner = ownerClosed.get(`${hol.key}|${raw.locationId}`) ?? null;
      s = { ...raw, holiday: { key: hol.key, name: hol.name,
        history: ev ? ev.outcome : 'none', lastDate: ev?.date ?? null, reopened,
        level: bySession ? 'session' : byHall ? 'hall' : null,
        owner: owner ? { confirmed: owner.confirmed } : null } };
      if ((owner || ev?.outcome === 'closed') && raw.source !== 'roster' && !reopened) {
        closed.push(s); m.closed += 1; continue;
      }
    }
    if (off.has(s.slot)) { switchedOff.push(s); m.switchedOff += 1; continue; }
    const b = baselines.get(s.slot);
    if (!b || !b.usable) { unprojectable.push({ ...s, n: b?.n ?? 0 }); m.unprojectable += 1; continue; }
    const v = applyDrivers(b, drivers);
    projected.push({ ...s, ...v, baseline: b });
    const p = m.projected;
    p.sessions += 1;
    p.gross += v.gross;
    p.payout += v.payout;
    p.net += v.net;
    p.attendance += v.attendance ?? 0;
    p.varGross += v.sdGross ** 2;
    p.varNet += v.sdNet ** 2;
  }

  const rowsOut = [...by.values()].map((m) => finishMonth(m, { drift, assumptions, cogs }));
  return {
    months: rowsOut,
    totals: totalOf(rowsOut, { drift, assumptions }),
    projected, missing, unprojectable, switchedOff, closed,
    sources: {
      roster: projected.filter((s) => s.source === 'roster').length,
      pattern: projected.filter((s) => s.source === 'pattern').length,
    },
  };
}

function emptyForecast() {
  return {
    months: [], totals: totalOf([], {}), projected: [], missing: [], unprojectable: [],
    switchedOff: [], closed: [], sources: { roster: 0, pattern: 0 },
  };
}

/**
 * Range for one month.
 *
 *   noise  = Z_95 · √(Σ per-session σ²)            night-to-night, independent
 *   level  = drift · projected · √(months ahead)   level drift, from the backtest
 *   half   = √(noise² + (Z_95 · level)²)
 *
 * Applied to the PROJECTED part only; actuals are known.
 */
function halfWidth(varNoise, projected, driftRel, ahead) {
  const level = driftRel ? driftRel * Math.abs(projected) * Math.sqrt(ahead + 1) : 0;
  return { noise: Z_95 * Math.sqrt(varNoise), level: Z_95 * level,
           half: Z_95 * Math.sqrt(varNoise + level ** 2) };
}

function finishMonth(m, { drift, assumptions, cogs }) {
  const a = m.actual; const p = m.projected;
  const total = {
    sessions: a.sessions + p.sessions,
    gross: a.gross + p.gross,
    payout: a.payout + p.payout,
    net: a.net + p.net,
    attendance: a.attendance + p.attendance,
  };
  const g = halfWidth(p.varGross, p.gross, drift?.gross ?? 0, m.index);
  const n = halfWidth(p.varNet, p.net, drift?.net ?? 0, m.index);
  const out = {
    ...m, total,
    range: {
      gross: { low: total.gross - g.half, high: total.gross + g.half, noise: g.noise, level: g.level },
      net: { low: total.net - n.half, high: total.net + n.half, noise: n.noise, level: n.level },
    },
  };
  if (assumptions) {
    const e = expensesFor(total.sessions, assumptions, cogs);
    out.expenses = e;
    out.profit = total.net - e.total;
    out.margin = total.gross > 0 ? out.profit / total.gross : null;
  }
  return out;
}

/**
 * The horizon total. Noise adds in quadrature across months (independent
 * nights); level drift adds LINEARLY, because a change in level carries over
 * from one month to the next rather than cancelling.
 */
function totalOf(months, { drift, assumptions }) {
  const sum = (f) => months.reduce((s, m) => s + f(m), 0);
  const t = {
    actual: { sessions: sum((m) => m.actual.sessions), gross: sum((m) => m.actual.gross),
              net: sum((m) => m.actual.net), attendance: sum((m) => m.actual.attendance) },
    projected: { sessions: sum((m) => m.projected.sessions), gross: sum((m) => m.projected.gross),
                 net: sum((m) => m.projected.net), attendance: sum((m) => m.projected.attendance) },
    sessions: sum((m) => m.total.sessions),
    gross: sum((m) => m.total.gross),
    payout: sum((m) => m.total.payout),
    net: sum((m) => m.total.net),
    attendance: sum((m) => m.total.attendance),
    missing: sum((m) => m.missing),
    unprojectable: sum((m) => m.unprojectable),
    switchedOff: sum((m) => m.switchedOff),
    closed: sum((m) => m.closed),
  };
  const range = (key, varKey) => {
    const noiseVar = sum((m) => m.projected[varKey]);
    const level = sum((m) => (drift?.[key] ?? 0) * Math.abs(m.projected[key]) * Math.sqrt(m.index + 1));
    const half = Z_95 * Math.sqrt(noiseVar + level ** 2);
    return { low: t[key] - half, high: t[key] + half,
             noise: Z_95 * Math.sqrt(noiseVar), level: Z_95 * level };
  };
  t.range = { gross: range('gross', 'varGross'), net: range('net', 'varNet') };
  if (assumptions) {
    t.expenses = {
      staff: sum((m) => m.expenses?.staff ?? 0),
      fixed: sum((m) => m.expenses?.fixed ?? 0),
      cogs: months.some((m) => m.expenses?.cogs !== null && m.expenses?.cogs !== undefined)
        ? sum((m) => m.expenses?.cogs ?? 0) : null,
      total: sum((m) => m.expenses?.total ?? 0),
    };
    t.profit = t.net - t.expenses.total;
    t.margin = t.gross > 0 ? t.profit / t.gross : null;
  }
  return t;
}

/* ---------------------------------------------------------------------------
   Backtest — "How accurate has this been?"
--------------------------------------------------------------------------- */

/**
 * Replay the model as of the 1st of each of the last `count` completed months.
 *
 * For month M: only rows STRICTLY BEFORE M's 1st are given to the model —
 * baselines, the running-slot test, the type history and the holiday
 * evidence all come from them (December 2025 can learn only from December
 * 2024).
 * No roster (when it was published is unknown), no drivers, no actuals from M.
 * The result is compared with what M actually took.
 *
 *   error %  = (projected − actual) ÷ actual
 *   inRange  = actual within the night-to-night range stated at the time
 *
 * `drift` is the share of the error that night-to-night noise does not
 * explain: √max(0, mean(relErr²) − mean(noiseRel²)), relative to the
 * projection. Null with fewer than MIN_BACKTEST_FOR_WIDENING months.
 */
export function backtest(rows, {
  today, count = BACKTEST_MONTHS, hall = 'all', minSessions = MIN_SLOT_SESSIONS,
} = {}) {
  const current = String(today).slice(0, 7);
  const out = [];
  for (let i = count; i >= 1; i -= 1) {
    const month = addMonths(current, -i);
    const asOf = monthStartDay(month);
    const before = rows.filter((r) => r.day < asOf);
    if (!before.length) continue;
    const prep = prepare(before, { today: asOf, minSessions });
    const f = buildForecast({ rows: before, prep, months: [month], hall });
    const proj = f.months[0];
    const actual = rows.filter((r) => r.date.slice(0, 7) === month && hallMatches(hall, r.locationId));
    const act = {
      sessions: actual.length,
      gross: actual.reduce((s, r) => s + r.gross, 0),
      net: actual.reduce((s, r) => s + r.net, 0),
    };
    const err = (p, a) => (a ? (p - a) / Math.abs(a) : null);
    out.push({
      month,
      projected: { sessions: proj.projected.sessions, gross: proj.projected.gross, net: proj.projected.net,
                   unprojectable: proj.unprojectable, closed: proj.closed,
                   closedNights: f.closed.map((c) => ({ date: c.date, locationId: c.locationId, holiday: c.holiday.name })) },
      actual: act,
      errGross: err(proj.projected.gross, act.gross),
      errNet: err(proj.projected.net, act.net),
      range: proj.range,
      noiseRel: {
        gross: proj.projected.gross ? Math.sqrt(proj.projected.varGross) / proj.projected.gross : null,
        net: proj.projected.net ? Math.sqrt(proj.projected.varNet) / Math.abs(proj.projected.net) : null,
      },
      inRange: {
        gross: act.gross >= proj.range.gross.low && act.gross <= proj.range.gross.high,
        net: act.net >= proj.range.net.low && act.net <= proj.range.net.high,
      },
    });
  }
  const scored = out.filter((r) => r.actual.sessions && r.projected.sessions);
  const mae = (k) => (scored.length
    ? scored.reduce((s, r) => s + Math.abs(r[k]), 0) / scored.length : null);
  const bias = (k) => (scored.length ? scored.reduce((s, r) => s + r[k], 0) / scored.length : null);
  const driftOf = (key) => {
    if (scored.length < MIN_BACKTEST_FOR_WIDENING) return null;
    const rel = scored.map((r) => (r.projected[key] - r.actual[key]) / Math.abs(r.projected[key]))
      .filter(Number.isFinite);
    if (rel.length < MIN_BACKTEST_FOR_WIDENING) return null;
    const msErr = rel.reduce((s, x) => s + x * x, 0) / rel.length;
    const msNoise = scored.reduce((s, r) => s + (r.noiseRel[key] ?? 0) ** 2, 0) / scored.length;
    return Math.sqrt(Math.max(0, msErr - msNoise));
  };
  const drift = scored.length >= MIN_BACKTEST_FOR_WIDENING
    ? { gross: driftOf('gross'), net: driftOf('net') } : null;
  // How often the actual lands inside the WIDENED range. In-sample — the
  // widening was fitted on these same months — so it is reported as such.
  const widened = (key) => {
    if (!drift) return null;
    return scored.filter((r) => {
      const half = Z_95 * Math.sqrt(r.projected[key] === 0 ? 0
        : (r.noiseRel[key] * r.projected[key]) ** 2 + (drift[key] * r.projected[key]) ** 2);
      return Math.abs(r.actual[key] - r.projected[key]) <= half;
    }).length;
  };
  return {
    months: out,
    scored: scored.length,
    maeGross: mae('errGross'),
    maeNet: mae('errNet'),
    biasGross: bias('errGross'),
    biasNet: bias('errNet'),
    insideGross: scored.filter((r) => r.inRange.gross).length,
    insideNet: scored.filter((r) => r.inRange.net).length,
    insideWidenedGross: widened('gross'),
    insideWidenedNet: widened('net'),
    drift,
  };
}

/* ---------------------------------------------------------------------------
   Saved scenarios — localStorage, with an in-session fallback
--------------------------------------------------------------------------- */

/**
 * The in-session copy. When storage is missing or throws, scenarios still
 * work until the tab is closed — they just are not kept.
 */
const memory = { list: null };
export function resetScenarioMemory() { memory.list = null; }

/**
 * `localStorage`, or null. Merely READING the property throws a SecurityError
 * in some sandboxed frames, so even the default argument is guarded.
 */
export function browserStore() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function cleanScenario(s) {
  if (!s || typeof s !== 'object' || !s.name) return null;
  return {
    id: String(s.id ?? s.name),
    name: String(s.name).slice(0, 80),
    drivers: normaliseDrivers(s.drivers ?? {}),
    off: Array.isArray(s.off) ? s.off.map(String) : [],
    open: Array.isArray(s.open) ? s.open.map(String) : [],
    mode: s.mode === 'expenses' ? 'expenses' : 'bingo',
    horizon: HORIZONS.some((h) => h.id === s.horizon) ? s.horizon : DEFAULT_HORIZON,
    hall: s.hall ?? 'all',
    savedAt: s.savedAt ?? null,
  };
}

export function loadScenarios(store = browserStore()) {
  try {
    const raw = store?.getItem(SCENARIO_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = parsed.map(cleanScenario).filter(Boolean);
        memory.list = list;
        return list;
      }
    }
  } catch { /* private mode, blocked or corrupt — the in-session copy below */ }
  return memory.list ? [...memory.list] : [];
}

function writeScenarios(list, store) {
  memory.list = list;
  try {
    if (!store) return false;
    store.setItem(SCENARIO_KEY, JSON.stringify(list));
    return true;
  } catch { return false; }
}

/** Save (or replace, by name). Returns `{ list, persisted }`. */
export function saveScenario(scenario, store = browserStore(), { now = new Date() } = {}) {
  const s = cleanScenario({
    ...scenario,
    id: scenario.id ?? `sc-${String(scenario.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    savedAt: scenario.savedAt ?? (now instanceof Date ? now.toISOString() : String(now)),
  });
  if (!s) return { list: loadScenarios(store), persisted: false };
  const list = loadScenarios(store).filter((x) => x.name !== s.name && x.id !== s.id);
  list.push(s);
  return { list, persisted: writeScenarios(list, store) };
}

export function deleteScenario(id, store = browserStore()) {
  const list = loadScenarios(store).filter((x) => x.id !== id);
  return { list, persisted: writeScenarios(list, store) };
}
