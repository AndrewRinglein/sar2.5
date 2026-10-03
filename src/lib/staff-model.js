/* ============================================================================
   SAR 2.0 — Staff Overview model (SPEC §22.1, U15)

   Pure functions. No DOM, no network. Everything takes arrays from the
   scheduler's `sched_*` tables and returns plain objects, so the whole screen
   can be fed a live snapshot and checked by hand.

   WHERE THE SPEC IS STALE (live Operations DB, inspected 2026-10-01)

   · §22.1.1 says there is no time clock. There is: `sched_time_entries` now has
     clock_in / clock_out / meal_start. But every row's `hours_worked` is 0.00
     or null — the only clocked rows are zero-length test punches. So actual
     hours are still "not yet recorded" everywhere, and that is a STATE, never
     a zero. A zero-hour row is treated as not recorded.
   · §22.1.1 says most shifts have no end time. Now 569 of 575 assignments have
     both. The rest are still counted, openly ("N shifts had no end time").
   · `sched_hall_role_times` DOES carry an end time. It is used as a fallback
     only where the template row is not flagged `is_placeholder` — a placeholder
     time is not a fact about a shift.

   PRIVACY (§22.1.8). Nothing here takes, reads or returns a base rate, a
   regular rate or a premium in dollars. Break premiums are HOURS. `rateAdj`
   and `otAdj` are derived from commission and hours only.
   ========================================================================== */

import { dollarsToCents } from './fmt.js';

/** SPEC §22.1.4 — confirmed. The scheduler's own constant is 0 (Sunday). */
export const WORKWEEK_START_DOW = 1;

/**
 * Q26: draft / planned / deployed are undefined in the scheduler. This screen
 * counts deployed and planned as scheduled, and reports drafts separately.
 */
export const COUNTED_STATUSES = Object.freeze(['deployed', 'planned']);

export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ---------------------------------------------------------------------------
   Dates — 'YYYY-MM-DD', UTC throughout
--------------------------------------------------------------------------- */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ms = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

export const dowOf = (d) => new Date(ms(d)).getUTCDay();
export const addDays = (d, n) => iso(ms(d) + n * 86400000);

/** The Monday on or before `d` (or whatever WORKWEEK_START_DOW says). */
export function weekStart(d, startDow = WORKWEEK_START_DOW) {
  const back = (dowOf(d) - startDow + 7) % 7;
  return addDays(d, -back);
}

/** 'HH:MM' or 'HH:MM:SS' -> hours since midnight. */
export function timeToHours(t) {
  if (t === null || t === undefined || t === '') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t));
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 60 + Number(m[3] ?? 0) / 3600;
}

/* ---------------------------------------------------------------------------
   Pay periods — semi-monthly, 1st–15th and 16th–end (§22.1.7)
--------------------------------------------------------------------------- */

const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const pad = (n) => String(n).padStart(2, '0');

export function payPeriod(date) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  const first = d <= 15;
  const start = `${y}-${pad(m)}-${first ? '01' : '16'}`;
  const endDay = first ? 15 : lastDay(y, m);
  const end = `${y}-${pad(m)}-${pad(endDay)}`;
  return {
    key: start, start, end,
    label: `${first ? 1 : 16}–${endDay} ${MON[m - 1]} ${y}`,
  };
}

/** The period containing `date`, with its neighbours. */
export function payPeriods(date) {
  const current = payPeriod(date);
  return {
    current,
    prev: payPeriod(addDays(current.start, -1)),
    next: payPeriod(addDays(current.end, 1)),
  };
}

export const inPeriod = (d, p) => Boolean(d) && d >= p.start && d <= p.end;

/* ---------------------------------------------------------------------------
   Scheduled shift length
--------------------------------------------------------------------------- */

/** The non-placeholder template time for this hall, role, weekday and part. */
export function templateFor(templates = [], { hall, role, dow, part }) {
  return templates.find((t) => t.hall_id === hall && t.role_id === role
    && Number(t.dow) === dow && t.part === part && t.is_placeholder !== true) ?? null;
}

/**
 * Hours of one assignment. `start`/`end` are hours from the session date's
 * midnight; an end at or before the start is past midnight and gains 24h
 * ("00:00:00" is the usual case).
 *
 * The assignment's own times win; each missing side falls back to the hall's
 * template time (non-placeholder only). With either side still missing the
 * shift is NOT MEASURABLE and `hours` is null — never 0.
 */
export function shiftHours(assignment = {}, session = {}, templates = []) {
  const tpl = session?.session_date
    ? templateFor(templates, { hall: session.hall_id, role: assignment.role_id,
        dow: dowOf(session.session_date), part: session.part })
    : null;
  const ownStart = timeToHours(assignment.scheduled_start);
  const ownEnd = timeToHours(assignment.scheduled_end);
  const start = ownStart ?? timeToHours(tpl?.start_time);
  let end = ownEnd ?? timeToHours(tpl?.end_time);
  if (start === null || end === null) {
    return { hours: null, start, end: null, wrapped: false, source: null,
      reason: end === null ? 'no end time' : 'no start time' };
  }
  const wrapped = end <= start;
  if (wrapped) end += 24;
  const source = ownStart !== null && ownEnd !== null ? 'assignment'
    : ownStart === null && ownEnd === null ? 'template' : 'mixed';
  return { hours: end - start, start, end, wrapped, source, reason: null };
}

/** Total length of a set of [start, end] intervals with overlaps counted once. */
export function unionHours(intervals = []) {
  const s = intervals.filter((i) => i && i[1] > i[0]).sort((a, b) => a[0] - b[0]);
  let total = 0; let cs = null; let ce = null;
  for (const [a, b] of s) {
    if (cs === null || a > ce) { if (cs !== null) total += ce - cs; cs = a; ce = b; }
    else ce = Math.max(ce, b);
  }
  if (cs !== null) total += ce - cs;
  return total;
}

/* ---------------------------------------------------------------------------
   Overtime — §22.1.4, reproduced exactly
--------------------------------------------------------------------------- */

/**
 * Classify worked days. Input: [{ date, hours }]. Days with no hours are not
 * worked days. Several entries on one date are summed (a workday is a day).
 *
 * The counters reset at the MONDAY workweek boundary — both the 40-hour
 * accumulator and the consecutive-day count — and the consecutive count also
 * resets on any non-worked day. So the seventh consecutive day can only be the
 * Sunday of a week in which Monday–Saturday were all worked.
 *
 * `startDow` exists only so a test can show what a Sunday boundary would do.
 *
 * Returns one row per worked day:
 *   { date, hours, regular, ot1_5, ot2_0, byCause: {daily, weekly, seventh},
 *     cause: 'daily'|'weekly'|'seventh'|null, consecutive, weekStart }
 */
export function classifyWeek(days = [], { startDow = WORKWEEK_START_DOW } = {}) {
  const byDate = new Map();
  for (const d of days) {
    const h = num(d?.hours);
    if (!d?.date || h === null || h <= 0) continue;
    byDate.set(d.date, (byDate.get(d.date) ?? 0) + h);
  }
  const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let week = null; let cumulative = 0; let consecutive = 0; let prev = null;
  return sorted.map(([date, h]) => {
    const ws = weekStart(date, startDow);
    if (ws !== week) { week = ws; cumulative = 0; consecutive = 0; prev = null; }
    consecutive = prev && addDays(prev, 1) === date ? consecutive + 1 : 1;
    prev = date;

    let regular; let ot15; let ot20;
    const byCause = { daily: 0, weekly: 0, seventh: 0 };
    if (consecutive >= 7) {
      ot15 = Math.min(h, 8);
      ot20 = Math.max(0, h - 8);
      regular = 0;                       // no straight time at all
      byCause.seventh = ot15 + ot20;
    } else {
      regular = Math.min(h, 8);
      ot15 = Math.max(0, Math.min(h, 12) - 8);
      ot20 = Math.max(0, h - 12);
      byCause.daily = ot15 + ot20;
    }
    // Weekly: only hours NOT already paid as daily OT accumulate (no pyramiding).
    if (regular > 0) {
      const before = cumulative;
      cumulative += regular;
      if (cumulative > 40) {
        const move = Math.min(regular, cumulative - Math.max(before, 40));
        regular -= move; ot15 += move; byCause.weekly = move;
      }
    }
    const top = Object.entries(byCause).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])[0];
    return { date, hours: h, regular, ot1_5: ot15, ot2_0: ot20, byCause,
      cause: top ? top[0] : null, consecutive, weekStart: ws };
  });
}

/** Alias that reads better when the input spans several weeks. */
export const classifyDays = classifyWeek;

/* ---------------------------------------------------------------------------
   Break compliance — §22.1.5, reproduced exactly
--------------------------------------------------------------------------- */

/**
 * 10 paid minutes per 4 hours "or major fraction thereof" (more than 2 h),
 * none when the day's work is LESS than 3½ hours. So exactly 3.5 h owes one,
 * and the table keeps going past 14 h: 18 h owes 4, 18.01 h owes 5.
 */
export function restRequired(h) {
  if (!(h >= 3.5)) return 0;
  const whole = Math.floor(h / 4);
  return Math.max(1, whole + (h - whole * 4 > 2 ? 1 : 0));
}

export const mealRequired = (h) => (h > 10 ? 2 : h > 5 ? 1 : 0);

/**
 * Actual hours of a time entry, or null when it does not record any.
 * Not worked time (PTO), null hours and ZERO hours (the clock_in = clock_out
 * test punches) are all "not recorded" — never a real 0.
 */
export function actualHours(e = {}) {
  if (e.is_worked_time === false) return null;
  if (e.category && e.category !== 'worked') return null;
  const h = num(e.hours_worked);
  return h === null || h <= 0 ? null : h;
}

/**
 * Hours WORKED before the meal started, or null when unknown. A merged
 * workday carries it precomputed (see mergeWorkday); a single entry measures
 * from its own clock-in.
 */
export function mealOffset(e = {}) {
  if (e.meal_offset_hours !== undefined) return e.meal_offset_hours;
  if (!e.clock_in || !e.meal_start) return null;
  const a = Date.parse(e.clock_in); const b = Date.parse(e.meal_start);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 3600000;
}

/**
 * One time entry against the meal and rest rules.
 *
 * Violation types: not_taken · taken_late · waived_not_waivable.
 * Premium HOURS: one for any meal violation, one for any rest violation.
 *
 * Unknowns are reported, not guessed: a meal taken with no `meal_start` (or no
 * clock-in to measure from) cannot be tested for lateness — `mealTimingUnknown`.
 * There is no second-meal start column at all, so a second meal can never be
 * found late. A null `rest_breaks_taken` is not tested (`restUnknown`).
 */
export function checkDay(e = {}) {
  const h = actualHours(e);
  if (h === null) {
    return { recorded: false, hours: null, restRequired: null, restTaken: null,
      mealRequired: null, violations: [], premiumHours: 0,
      mealTimingUnknown: false, restUnknown: false };
  }
  const violations = [];
  const rr = restRequired(h);
  const rt = num(e.rest_breaks_taken);
  if (rr > 0 && rt !== null && rt < rr) violations.push({ kind: 'rest', type: 'not_taken' });

  const mr = mealRequired(h);
  let mealTimingUnknown = false;
  if (mr >= 1) {
    if (e.meal_taken === true) {
      const off = mealOffset(e);
      if (off === null) mealTimingUnknown = true;
      else if (off > 5) violations.push({ kind: 'meal', type: 'taken_late' });
    } else if (e.meal_waived === true) {
      // Waivable only when the day is 5–6 hours.
      if (h > 6) violations.push({ kind: 'meal', type: 'waived_not_waivable' });
    } else {
      violations.push({ kind: 'meal', type: 'not_taken' });
    }
  }
  if (mr >= 2) {
    if (e.second_meal_taken === true) {
      // No second-meal start time exists; lateness cannot be tested.
    } else if (e.second_meal_waived === true) {
      // 10–12 hours AND the first actually taken; a waived first does not count.
      if (h > 12 || e.meal_taken !== true) {
        violations.push({ kind: 'second_meal', type: 'waived_not_waivable' });
      }
    } else {
      violations.push({ kind: 'second_meal', type: 'not_taken' });
    }
  }
  return { recorded: true, hours: h, restRequired: rr, restTaken: rt, mealRequired: mr,
    violations, premiumHours: premiumFor(violations), mealTimingUnknown,
    restUnknown: rr > 0 && rt === null };
}

/** One hour per category with any violation; two per day at most. */
export function premiumFor(violations = []) {
  const meal = violations.some((v) => v.kind === 'meal' || v.kind === 'second_meal') ? 1 : 0;
  const rest = violations.some((v) => v.kind === 'rest') ? 1 : 0;
  return meal + rest;
}

/**
 * Several entries on one workday (two halls, or a split shift) as the ONE day
 * the break rules are written for. What is owed depends on the day's total
 * hours: two 3-hour entries are a 6-hour day that owes a meal, which checking
 * each entry alone never found.
 *
 *   hours      summed
 *   rest taken summed; unknown if any entry's count is unknown
 *   meal       taken if any entry took one; a second meal if two entries did,
 *              or any entry records a second meal
 *   meal time  hours worked before the first meal: the whole of every entry
 *              that started earlier, plus the time into the meal's own entry
 */
export function mergeWorkday(entries = []) {
  const worked = entries.filter((e) => actualHours(e) !== null)
    .sort((a, b) => String(a.clock_in ?? '').localeCompare(String(b.clock_in ?? '')));
  if (worked.length <= 1) return worked[0] ?? null;
  const hours = worked.reduce((t, e) => t + actualHours(e), 0);
  const rests = worked.map((e) => num(e.rest_breaks_taken));
  const meals = worked.filter((e) => e.meal_taken === true);
  let offset = null;
  if (meals.length) {
    const first = meals.find((e) => mealOffset(e) !== null);
    if (first && worked.every((e) => e.clock_in)) {
      offset = worked.filter((e) => e.clock_in < first.clock_in)
        .reduce((t, e) => t + actualHours(e), 0) + mealOffset(first);
    }
  }
  return {
    ...worked[0],
    id: worked[0].id ?? null,
    hours_worked: hours,
    rest_breaks_taken: rests.some((r) => r === null) ? null : rests.reduce((t, r) => t + r, 0),
    meal_taken: meals.length > 0,
    meal_waived: meals.length === 0 && worked.some((e) => e.meal_waived === true),
    meal_offset_hours: meals.length ? offset : undefined,
    second_meal_taken: meals.length >= 2 || worked.some((e) => e.second_meal_taken === true),
    second_meal_waived: worked.some((e) => e.second_meal_waived === true),
  };
}

/**
 * Group entries into person-days and judge each DAY: requirements come from
 * the day's total hours, and the premium caps at one meal and one rest hour.
 */
export function complianceDays(entries = []) {
  const by = new Map();
  for (const e of entries) {
    if (actualHours(e) === null) continue;
    const k = `${e.staff_id}|${e.work_date}`;
    const cur = by.get(k) ?? { staffId: e.staff_id, date: e.work_date, entries: [] };
    cur.entries.push(e);
    by.set(k, cur);
  }
  return [...by.values()].map((d) => {
    const day = mergeWorkday(d.entries);
    const r = checkDay(day);
    const halls = [...new Set(d.entries.map((e) => e.hall_id).filter(Boolean))];
    const hall = halls.length === 1 ? halls[0] : null;
    const violations = r.violations.map((v) => ({ ...v, hall, entryId: d.entries[0].id ?? null }));
    return {
      staffId: d.staffId, date: d.date, halls, hours: r.hours, entries: d.entries,
      violations,
      mealTimingUnknown: r.mealTimingUnknown ? 1 : 0,
      restUnknown: r.restUnknown ? 1 : 0,
      premiumHours: premiumFor(violations),
      outOfCompliance: violations.length > 0,
    };
  });
}

/* ---------------------------------------------------------------------------
   Coverage — needed vs filled per session and per slot (§22.1.6)
--------------------------------------------------------------------------- */

/**
 * `needs` are `sched_hall_role_needs` (hall, role, dow, part, needed);
 * `overrides` are `sched_session_roles` (session, role, needed) and win per
 * role when present. Filled counts distinct non-training people per role.
 *
 * Overall coverage caps each role at what it needed, so over-staffing one role
 * never hides a shortfall in another; over-staffing is reported on its own.
 */
export function coverage(sessions = [], assignments = [], needs = [], overrides = []) {
  const needOf = new Map(needs.map((n) =>
    [`${n.hall_id}|${Number(n.dow)}|${n.part}|${n.role_id}`, num(n.needed) ?? 0]));
  const overrideOf = new Map(overrides.map((o) => [`${o.session_id}|${o.role_id}`, num(o.needed) ?? 0]));
  const rolesForSlot = new Map();
  for (const n of needs) {
    const k = `${n.hall_id}|${Number(n.dow)}|${n.part}`;
    if (!rolesForSlot.has(k)) rolesForSlot.set(k, new Set());
    rolesForSlot.get(k).add(n.role_id);
  }
  const bySessionRole = new Map();
  for (const a of assignments) {
    const k = `${a.session_id}|${a.role_id}`;
    const cur = bySessionRole.get(k) ?? { staff: new Set(), training: new Set() };
    (a.is_training ? cur.training : cur.staff).add(a.staff_id);
    bySessionRole.set(k, cur);
  }

  const bySession = [];
  const slots = new Map();
  const totals = { needed: 0, filled: 0, filledCapped: 0, short: 0, over: 0, training: 0 };
  for (const s of sessions) {
    const dow = s.session_date ? dowOf(s.session_date) : null;
    const slot = `${s.hall_id}|${dow}|${s.part}`;
    const roleIds = new Set(rolesForSlot.get(slot) ?? []);
    for (const o of overrides) if (o.session_id === s.id) roleIds.add(o.role_id);
    for (const k of bySessionRole.keys()) if (k.startsWith(`${s.id}|`)) roleIds.add(k.slice(s.id.length + 1));

    const roles = [];
    for (const roleId of roleIds) {
      const ov = overrideOf.get(`${s.id}|${roleId}`);
      const needed = ov ?? needOf.get(`${slot}|${roleId}`) ?? 0;
      const got = bySessionRole.get(`${s.id}|${roleId}`);
      const filled = got ? got.staff.size : 0;
      const training = got ? got.training.size : 0;
      const r = { roleId, needed, filled, training, short: Math.max(0, needed - filled),
        over: Math.max(0, filled - needed), override: ov !== undefined };
      roles.push(r);
      totals.needed += needed; totals.filled += filled; totals.training += training;
      totals.filledCapped += Math.min(filled, needed);
      totals.short += r.short; totals.over += r.over;

      const sk = `${slot}|${roleId}`;
      const agg = slots.get(sk) ?? { hall: s.hall_id, dow, part: s.part, roleId,
        sessions: 0, needed: 0, filled: 0, short: 0, over: 0 };
      agg.sessions += 1; agg.needed += needed; agg.filled += filled;
      agg.short += r.short; agg.over += r.over;
      slots.set(sk, agg);
    }
    const needed = roles.reduce((t, r) => t + r.needed, 0);
    const capped = roles.reduce((t, r) => t + Math.min(r.filled, r.needed), 0);
    bySession.push({ sessionId: s.id, date: s.session_date, hall: s.hall_id, part: s.part, dow,
      roles, needed, filled: roles.reduce((t, r) => t + r.filled, 0),
      short: roles.reduce((t, r) => t + r.short, 0), over: roles.reduce((t, r) => t + r.over, 0),
      pct: needed ? capped / needed : null });
  }
  return { bySession, bySlot: [...slots.values()],
    totals: { ...totals, pct: totals.needed ? totals.filledCapped / totals.needed : null } };
}

/* ---------------------------------------------------------------------------
   Seventh consecutive scheduled day (Q28)
--------------------------------------------------------------------------- */

/** Map staffId -> iterable of scheduled dates. Returns weeks with all 7 days. */
export function seventhDayFlags(datesByPerson = new Map()) {
  const out = [];
  for (const [staffId, dates] of datesByPerson) {
    const weeks = new Map();
    for (const d of new Set(dates)) {
      const ws = weekStart(d);
      weeks.set(ws, (weeks.get(ws) ?? 0) + 1);
    }
    for (const [ws, n] of weeks) if (n >= 7) out.push({ staffId, weekStart: ws, weekEnd: addDays(ws, 6) });
  }
  return out.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/* ---------------------------------------------------------------------------
   The wage line — §22.1.8. Commission and hours only. Never a base rate.
--------------------------------------------------------------------------- */

/**
 * rateAdj = commission ÷ hours; otAdj = rateAdj×0.5×ot1.5 + rateAdj×1.0×ot2.0.
 * In whatever unit commission arrives in (cents on this screen).
 */
export function wageLine({ commission = null, hours = null, ot1_5 = 0, ot2_0 = 0 } = {}) {
  if (commission === null || !hours) return { rateAdj: null, otAdj: null };
  const rateAdj = commission / hours;
  return { rateAdj, otAdj: rateAdj * 0.5 * ot1_5 + rateAdj * 1.0 * ot2_0 };
}

/* ---------------------------------------------------------------------------
   The whole screen's model
--------------------------------------------------------------------------- */

const toCents = dollarsToCents;
const nameOf = (p) => p?.name ?? p?.first_name ?? 'Unknown';

/**
 * Everything Staff Overview shows, from the raw `data.schedule` object.
 *
 * opts: { period: 'YYYY-MM-DD' (any date in it; default = the latest period
 * with any assignment), hall: 'all'|'sc'|'rwc', role: 'all'|roleId,
 * activeOnly (default true), complianceOnly (default false),
 * excludedPayoutSessions: Set of session ids whose payouts are not counted }.
 *
 * OVERTIME IS CLASSIFIED ON THE WHOLE RECORD, then summed for the days inside
 * the period: pay periods do not line up with Monday workweeks, and a week
 * that straddles the 15th still owes its weekly overtime. Each day uses ACTUAL
 * hours when recorded, otherwise SCHEDULED; each row says which.
 */
export function buildStaffOverview(sched = {}, opts = {}) {
  const staff = sched.staff ?? [];
  const roles = sched.roles ?? [];
  const sessions = sched.sessions ?? [];
  const assignments = sched.assignments ?? [];
  const entries = sched.timeEntries ?? [];
  const templates = sched.hallRoleTimes ?? [];
  const needs = sched.hallRoleNeeds ?? [];
  const overrides = sched.sessionRoles ?? [];
  const payouts = sched.commissionPayouts ?? [];
  const hall = opts.hall && opts.hall !== 'all' ? opts.hall : null;
  const role = opts.role && opts.role !== 'all' ? opts.role : null;
  const activeOnly = opts.activeOnly !== false;
  const complianceOnly = opts.complianceOnly === true;
  const excluded = opts.excludedPayoutSessions ?? new Set();

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const personById = new Map(staff.map((p) => [p.id, p]));

  /* The data window: the dates the scheduler actually has assignments for. */
  const asgDates = assignments.map((a) => sessionById.get(a.session_id)?.session_date)
    .filter(Boolean).sort();
  const window = asgDates.length ? { start: asgDates[0], end: asgDates.at(-1) } : null;
  const anchor = opts.period ?? window?.end ?? null;
  const periods = anchor ? payPeriods(anchor) : null;
  const period = periods?.current ?? null;
  const counted = (s) => COUNTED_STATUSES.includes(s?.status);

  /* Shifts */
  const shifts = [];
  let orphan = 0;
  for (const a of assignments) {
    const s = sessionById.get(a.session_id);
    if (!s?.session_date) { orphan += 1; continue; }
    const sh = shiftHours(a, s, templates);
    shifts.push({ id: a.id, staffId: a.staff_id, sessionId: s.id, date: s.session_date,
      hall: s.hall_id ?? null, part: s.part ?? null, status: s.status ?? null,
      roleId: a.role_id, training: Boolean(a.is_training), counted: counted(s), ...sh });
  }
  const shiftInView = (x) => period && inPeriod(x.date, period)
    && (!hall || x.hall === hall) && (!role || x.roleId === role);

  /* Scheduled hours per person per day — ALL counted shifts, both halls, every role. */
  const schedDay = new Map();      // staff -> date -> { intervals, halls:Set }
  for (const x of shifts) {
    if (!x.counted) continue;
    const pm = schedDay.get(x.staffId) ?? new Map(); schedDay.set(x.staffId, pm);
    const d = pm.get(x.date) ?? { intervals: [], halls: new Set(), any: 0 }; pm.set(x.date, d);
    d.any += 1;
    if (x.hall) d.halls.add(x.hall);
    if (x.hours !== null) d.intervals.push([x.start, x.end]);
  }

  /* Actual hours per person per day. */
  const actDay = new Map();        // staff -> date -> { hours, halls:Set }
  for (const e of entries) {
    const h = actualHours(e);
    if (h === null || !e.work_date) continue;
    const pm = actDay.get(e.staff_id) ?? new Map(); actDay.set(e.staff_id, pm);
    const d = pm.get(e.work_date) ?? { hours: 0, halls: new Set() }; pm.set(e.work_date, d);
    d.hours += h;
    if (e.hall_id) d.halls.add(e.hall_id);
  }

  /* Day basis and overtime, per person, on the whole record. */
  const otByPerson = new Map();    // staff -> date -> classified day (+ basis)
  for (const id of new Set([...schedDay.keys(), ...actDay.keys()])) {
    const dates = new Set([...(schedDay.get(id)?.keys() ?? []), ...(actDay.get(id)?.keys() ?? [])]);
    const days = []; const basis = new Map();
    for (const date of dates) {
      const a = actDay.get(id)?.get(date);
      const s = schedDay.get(id)?.get(date);
      if (a) { days.push({ date, hours: a.hours }); basis.set(date, 'actual'); }
      else if (s && s.intervals.length) {
        days.push({ date, hours: unionHours(s.intervals) }); basis.set(date, 'scheduled');
      }
    }
    otByPerson.set(id, new Map(classifyDays(days).map((r) => [r.date, { ...r, basis: basis.get(r.date) }])));
  }

  /* Compliance, per person-day. */
  const compliance = complianceDays(entries);
  const compliancePeriod = period ? compliance.filter((d) => inPeriod(d.date, period)
    && (!hall || d.halls.includes(hall))) : [];

  /* Weeks of the data window, for the sparklines. */
  const weeks = [];
  if (window) for (let w = weekStart(window.start); w <= window.end; w = addDays(w, 7)) weeks.push(w);

  const dayAtHall = (id, date) => !hall
    || schedDay.get(id)?.get(date)?.halls.has(hall) || actDay.get(id)?.get(date)?.halls.has(hall);

  /* Commission per person in the period. */
  const commissionOf = new Map();
  if (period) {
    for (const p of payouts) {
      if (excluded.has(p.session_id)) continue;
      const s = sessionById.get(p.session_id);
      const date = p.session_date ?? s?.session_date;
      if (!inPeriod(date, period) || (hall && s?.hall_id !== hall)) continue;
      const c = toCents(p.payout_amount);
      if (c === null) continue;
      commissionOf.set(p.staff_id, (commissionOf.get(p.staff_id) ?? 0) + c);
    }
  }

  /* Rows */
  const ids = new Set([...staff.map((p) => p.id), ...shifts.map((x) => x.staffId),
    ...actDay.keys(), ...commissionOf.keys()]);
  let rows = [];
  for (const id of ids) {
    const p = personById.get(id);
    const mine = shifts.filter((x) => x.staffId === id && x.counted);
    const inView = mine.filter(shiftInView);
    const sessionsSeen = new Set(inView.map((x) => x.sessionId));
    // Scheduled hours: union per day of the in-view shifts.
    const perDay = new Map();
    for (const x of inView) {
      if (x.hours === null) continue;
      const l = perDay.get(x.date) ?? []; l.push([x.start, x.end]); perDay.set(x.date, l);
    }
    const scheduled = [...perDay.values()].reduce((t, iv) => t + unionHours(iv), 0);
    const unmeasured = inView.filter((x) => x.hours === null).length;

    let actual = null;
    for (const [date, d] of actDay.get(id) ?? []) {
      if (!period || !inPeriod(date, period) || (hall && !d.halls.has(hall))) continue;
      actual = (actual ?? 0) + d.hours;
    }

    const ot = { hours: 0, regular: 0, ot1_5: 0, ot2_0: 0, daily: 0, weekly: 0, seventh: 0,
      actualDays: 0, scheduledDays: 0 };
    const otDays = [];
    for (const [date, r] of otByPerson.get(id) ?? []) {
      if (!period || !inPeriod(date, period) || !dayAtHall(id, date)) continue;
      ot.hours += r.hours; ot.regular += r.regular; ot.ot1_5 += r.ot1_5; ot.ot2_0 += r.ot2_0;
      ot.daily += r.byCause.daily; ot.weekly += r.byCause.weekly; ot.seventh += r.byCause.seventh;
      if (r.basis === 'actual') ot.actualDays += 1; else ot.scheduledDays += 1;
      otDays.push(r);
    }
    const basis = !otDays.length ? null : !ot.scheduledDays ? 'actual'
      : !ot.actualDays ? 'scheduled' : 'mixed';

    const mineComp = compliancePeriod.filter((d) => d.staffId === id);
    const premiumHours = mineComp.reduce((t, d) => t + d.premiumHours, 0);
    const daysOut = mineComp.filter((d) => d.outOfCompliance).length;

    const commission = commissionOf.get(id) ?? null;
    const { rateAdj, otAdj } = wageLine({ commission, hours: ot.hours, ot1_5: ot.ot1_5, ot2_0: ot.ot2_0 });

    const roleCount = new Map();
    for (const x of (inView.length ? inView : mine)) roleCount.set(x.roleId, (roleCount.get(x.roleId) ?? 0) + 1);
    const hallCount = new Map();
    for (const x of mine) if (x.hall) hallCount.set(x.hall, (hallCount.get(x.hall) ?? 0) + 1);
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const weekly = weeks.map((w) => {
      let t = 0;
      for (const [date, r] of otByPerson.get(id) ?? []) if (r.weekStart === w && dayAtHall(id, date)) t += r.hours;
      return t;
    });

    const hasRole = !role || inView.length > 0;
    rows.push({
      id, name: nameOf(p), active: p ? p.active !== false : true,
      onRoster: p ? p.on_roster !== false : true, known: Boolean(p),
      primaryRole: roleName.get(top(roleCount)) ?? null,
      homeHall: top(hallCount),
      shifts: sessionsSeen.size, scheduled,
      unmeasured, actual,
      hours: ot.hours, regular: ot.regular, ot1_5: ot.ot1_5, ot2_0: ot.ot2_0,
      byCause: { daily: ot.daily, weekly: ot.weekly, seventh: ot.seventh },
      basis, basisDays: { actual: ot.actualDays, scheduled: ot.scheduledDays },
      premiumHours, daysOut, commission, rateAdj, otAdj, weekly,
      hasActivity: inView.length > 0 || actual !== null || commission !== null || mineComp.length > 0,
      hasRole,
    });
  }
  rows = rows.filter((r) => r.hasRole
    && (activeOnly ? r.hasActivity : (r.hasActivity || (r.active && r.onRoster))));
  if (complianceOnly) rows = rows.filter((r) => r.daysOut > 0);
  rows.sort((a, b) => b.scheduled - a.scheduled || a.name.localeCompare(b.name));
  const visible = new Set(rows.map((r) => r.id));

  /* Coverage over counted sessions in the period that the scheduler staffed at all. */
  const staffedSessions = new Set(assignments.map((a) => a.session_id));
  const periodSessions = period ? sessions.filter((s) => inPeriod(s.session_date, period)
    && (!hall || s.hall_id === hall)) : [];
  const covSessions = periodSessions.filter((s) => counted(s) && staffedSessions.has(s.id));
  const unstaffed = periodSessions.filter((s) => counted(s) && !staffedSessions.has(s.id)).length;
  const cov = coverage(covSessions,
    assignments.filter((a) => !role || a.role_id === role),
    needs.filter((n) => !role || n.role_id === role),
    overrides.filter((o) => !role || o.role_id === role));
  for (const s of cov.bySlot) s.role = roleName.get(s.roleId) ?? 'Unknown role';
  for (const s of cov.bySession) for (const r of s.roles) r.role = roleName.get(r.roleId) ?? 'Unknown role';

  /* Shifts not counted, by status, in the period. */
  const notCounted = {};
  for (const x of shifts) {
    if (x.counted || !shiftInView(x)) continue;
    const k = x.status ?? 'no status';
    notCounted[k] = (notCounted[k] ?? 0) + 1;
  }

  /* Compliance detail — one row per violation; premium shown once per category per day. */
  const sessionOfEntry = (e) => {
    const a = e.assignment_id ? assignments.find((x) => x.id === e.assignment_id) : null;
    return a ? sessionById.get(a.session_id) ?? null : null;
  };
  const violations = [];
  for (const d of compliancePeriod) {
    if (!visible.has(d.staffId)) continue;
    const seen = new Set();
    for (const v of d.violations) {
      const cat = v.kind === 'rest' ? 'rest' : 'meal';
      const e = d.entries.find((x) => x.id === v.entryId) ?? d.entries[0];
      const s = e ? sessionOfEntry(e) : null;
      violations.push({ staffId: d.staffId, name: nameOf(personById.get(d.staffId)),
        date: d.date, hall: v.hall, part: s?.part ?? null, kind: v.kind, type: v.type,
        premiumHours: seen.has(cat) ? 0 : 1 });
      seen.add(cat);
    }
  }
  violations.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  /* Overtime by cause, per workweek overlapping the period. */
  const causeWeeks = [];
  if (period) {
    for (let w = weekStart(period.start); w <= period.end; w = addDays(w, 7)) {
      const t = { weekStart: w, daily: 0, weekly: 0, seventh: 0 };
      for (const id of visible) {
        for (const [date, r] of otByPerson.get(id) ?? []) {
          if (r.weekStart !== w || !inPeriod(date, period) || !dayAtHall(id, date)) continue;
          t.daily += r.byCause.daily; t.weekly += r.byCause.weekly; t.seventh += r.byCause.seventh;
        }
      }
      causeWeeks.push(t);
    }
  }

  /* Seventh consecutive scheduled day, in weeks overlapping the period. */
  const datesByPerson = new Map();
  for (const x of shifts) {
    if (!x.counted || (hall && x.hall !== hall)) continue;
    const l = datesByPerson.get(x.staffId) ?? []; l.push(x.date); datesByPerson.set(x.staffId, l);
  }
  const seventh = seventhDayFlags(datesByPerson)
    .filter((f) => period && f.weekEnd >= period.start && f.weekStart <= period.end)
    .map((f) => ({ ...f, name: nameOf(personById.get(f.staffId)) }));

  const sum = (k) => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const anyActual = rows.some((r) => r.actual !== null);
  const noEnd = shifts.filter((x) => x.counted && shiftInView(x) && x.hours === null
    && visible.has(x.staffId)).length;

  return {
    window, period, periods, hall, role, orphan,
    rows, weeks,
    kpis: {
      scheduled: sum('scheduled'), noEnd,
      actual: anyActual ? rows.reduce((t, r) => t + (r.actual ?? 0), 0) : null,
      ot1_5: sum('ot1_5'), ot2_0: sum('ot2_0'), ot: sum('ot1_5') + sum('ot2_0'),
      premiumHours: sum('premiumHours'), daysOut: sum('daysOut'),
      coverage: cov.totals.pct, needed: cov.totals.needed, filledCapped: cov.totals.filledCapped,
    },
    coverage: cov, unstaffedSessions: unstaffed, notCounted,
    violations,
    mealTimingUnknown: compliancePeriod.reduce((t, d) => t + d.mealTimingUnknown, 0),
    restUnknown: compliancePeriod.reduce((t, d) => t + d.restUnknown, 0),
    entriesInPeriod: period ? entries.filter((e) => inPeriod(e.work_date, period)).length : 0,
    causeWeeks, seventh,
    dumbbell: rows.filter((r) => r.scheduled > 0 && r.actual !== null)
      .map((r) => ({ id: r.id, name: r.name, scheduled: r.scheduled, actual: r.actual,
        variance: r.actual - r.scheduled })),
  };
}
