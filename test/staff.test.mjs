/* ============================================================================
   Staff Overview (SPEC §22.1, U15) — model and screen

   Every overtime and compliance figure below is worked out by hand in the
   comment beside it. If one of these fails, the code is wrong, not the
   arithmetic: §22.1.4 and §22.1.5 say "reproduce exactly".
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  shiftHours, unionHours, classifyWeek, restRequired, mealRequired, checkDay,
  complianceDays, actualHours, payPeriod, payPeriods, coverage, seventhDayFlags,
  wageLine, buildStaffOverview, weekStart, timeToHours, WORKWEEK_START_DOW,
} from '../src/lib/staff-model.js';
import { COLUMNS, assertNoPayColumns } from '../src/lib/ops-schema.js';
import { readOperations } from '../server/database.mjs';
import { sessionRows, targetFor, poolFor } from '../src/screens/commission.js';
import { commissionPool } from '../src/lib/model.js';

/* ---------------------------------------------------------------------------
   DOM — same boot as test/screens.test.mjs
--------------------------------------------------------------------------- */
const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;

const { renderStaff } = await import('../src/screens/staff.js');
const { renderCommission } = await import('../src/screens/commission.js');

const FORBIDDEN = [
  [/\bNaN\b/, 'NaN'], [/\bundefined\b/, 'undefined'], [/\bnull\b/, 'null'],
  [/\bInfinity\b/, 'Infinity'], [/\[object \w+\]/, '[object Object]'],
  [/\d[eE][+-]\d/, 'scientific notation'], [/\$-/, '$-'],
];
function readableText(node) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue); return; }
    for (const c of n.childNodes ?? []) walk(c);
    out.push(' ');
  };
  walk(node);
  return out.join(' ').replace(/\s+/g, ' ');
}
function inspect(node, label) {
  const text = readableText(node);
  for (const [re, name] of FORBIDDEN) {
    const m = text.match(re);
    assert.ok(!m, `${label}: rendered ${name} — "${text.slice(Math.max(0, (m?.index ?? 0) - 60), (m?.index ?? 0) + 40)}"`);
  }
  const raw = text.match(/\$\d{5,}(?!,)/);
  assert.ok(!raw, `${label}: unformatted money "${raw?.[0]}"`);
  return text;
}
function render(fn, data, params = {}) {
  let inspectorHtml = '';
  const calls = [];
  const node = fn({ data, params, onNavigate: (route, p) => calls.push([route, p]),
    setInspectorContent: (x) => { inspectorHtml = x; } });
  const holder = document.createElement('div');
  holder.innerHTML = inspectorHtml;
  return { node, inspector: holder, calls };
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} expected ${b}, got ${a}`);

/* ===========================================================================
   Shift length
=========================================================================== */

test('an end at or before the start is past midnight', () => {
  const s = { session_date: '2026-08-17', hall_id: 'sc', part: 'PM' };
  const a = shiftHours({ scheduled_start: '15:15:00', scheduled_end: '00:00:00' }, s);
  close(a.hours, 8.75); assert.equal(a.wrapped, true); assert.equal(a.source, 'assignment');
  close(shiftHours({ scheduled_start: '17:00:00', scheduled_end: '01:30:00' }, s).hours, 8.5);
  const b = shiftHours({ scheduled_start: '14:00:00', scheduled_end: '23:00:00' }, s);
  close(b.hours, 9); assert.equal(b.wrapped, false);
});

test('a missing time falls back to the template, but never to a placeholder', () => {
  const s = { session_date: '2026-08-17', hall_id: 'sc', part: 'PM' };   // Monday
  const tpl = [
    { hall_id: 'sc', role_id: 'rM', dow: 1, part: 'PM', start_time: '15:00:00', end_time: '23:00:00', is_placeholder: false },
    { hall_id: 'sc', role_id: 'rC', dow: 1, part: 'PM', start_time: '14:00:00', end_time: '00:00:00', is_placeholder: true },
  ];
  const full = shiftHours({ role_id: 'rM' }, s, tpl);
  close(full.hours, 8); assert.equal(full.source, 'template');
  const mixed = shiftHours({ role_id: 'rM', scheduled_start: '16:00:00' }, s, tpl);
  close(mixed.hours, 7); assert.equal(mixed.source, 'mixed');
  const ph = shiftHours({ role_id: 'rC', scheduled_start: '14:00:00' }, s, tpl);
  assert.equal(ph.hours, null, 'a placeholder end time is not a fact');
  assert.equal(ph.reason, 'no end time');
  assert.equal(shiftHours({ role_id: 'rX' }, s, tpl).hours, null, 'no time anywhere is null, not 0');
});

test('two roles in the same shift are not two shifts of hours', () => {
  close(unionHours([[9.5, 18.75], [15.5, 24]]), 14.5);
  close(unionHours([[15, 23], [15, 23]]), 8);
  close(unionHours([[10, 12], [13, 14]]), 3);
  assert.equal(timeToHours('xx'), null);
});

/* ===========================================================================
   Overtime — §22.1.4
=========================================================================== */

// 2026-08-03 is a Monday. 2026-08-09 is the Sunday of that week.
const MON = '2026-08-03';
const day = (i) => new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10);

test('the workweek starts Monday', () => {
  assert.equal(WORKWEEK_START_DOW, 1);
  assert.equal(weekStart('2026-08-09'), MON, 'Sunday belongs to the week that began Monday');
  assert.equal(weekStart('2026-08-10'), '2026-08-10');
});

test('a 10 hour day is 8 regular and 2 at 1.5x', () => {
  const [d] = classifyWeek([{ date: MON, hours: 10 }]);
  assert.deepEqual([d.regular, d.ot1_5, d.ot2_0, d.cause], [8, 2, 0, 'daily']);
});

test('a 13 hour day is 8 / 4 / 1', () => {
  const [d] = classifyWeek([{ date: MON, hours: 13 }]);
  assert.deepEqual([d.regular, d.ot1_5, d.ot2_0], [8, 4, 1]);
  assert.equal(d.byCause.daily, 5);
});

test('five 9 hour days: daily OT only, the week stops at exactly 40 regular', () => {
  // Each day 8 reg + 1 daily. Weekly accumulates the 8s only: 8,16,24,32,40.
  // 40 is not MORE than 40, so nothing moves. 40 regular, 5 at 1.5x.
  const r = classifyWeek([0, 1, 2, 3, 4].map((i) => ({ date: day(i), hours: 9 })));
  for (const d of r) assert.deepEqual([d.regular, d.ot1_5, d.ot2_0, d.cause], [8, 1, 0, 'daily']);
  assert.equal(r.reduce((t, d) => t + d.regular, 0), 40);
  assert.equal(r.reduce((t, d) => t + d.ot1_5, 0), 5);
  assert.equal(r.reduce((t, d) => t + d.byCause.weekly, 0), 0, 'no pyramiding');
});

test('six 8 hour days and a 9 hour Sunday: weekly on Saturday, seventh day on Sunday', () => {
  // Mon–Fri 40 regular. Sat: cumulative 48 > 40, all 8 move to 1.5x (weekly).
  // Sun is the 7th consecutive day: 8 at 1.5x, 1 at 2x, no straight time.
  const r = classifyWeek([...[0, 1, 2, 3, 4, 5].map((i) => ({ date: day(i), hours: 8 })),
    { date: day(6), hours: 9 }]);
  const sat = r[5]; const sun = r[6];
  assert.deepEqual([sat.regular, sat.ot1_5, sat.ot2_0, sat.cause], [0, 8, 0, 'weekly']);
  assert.deepEqual([sun.regular, sun.ot1_5, sun.ot2_0, sun.cause], [0, 8, 1, 'seventh']);
  assert.equal(sun.consecutive, 7);
  assert.equal(r.reduce((t, d) => t + d.regular, 0), 40);
  assert.equal(r.reduce((t, d) => t + d.ot1_5, 0), 16);
  assert.equal(r.reduce((t, d) => t + d.ot2_0, 0), 1);
});

test('the Sunday/Monday boundary decides the overtime — Monday is the answer', () => {
  // Seven 7h days Mon 3 – Sun 9, then Mon 10.
  //   MONDAY week: Mon–Fri 35; Sat cumulative 42 → 2 weekly; Sun is the 7th
  //   consecutive day → 7 at 1.5x. Mon 10 starts a new week: 7 regular,
  //   consecutive back to 1.  Totals: 47 regular, 9 at 1.5x.
  //   A SUNDAY week would put Sun 9 with Mon 10 and give 54 regular, 2 OT.
  const days = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ date: day(i), hours: 7 }));
  const mon = classifyWeek(days);
  const tot = (r, k) => r.reduce((t, d) => t + d[k], 0);
  assert.equal(tot(mon, 'regular'), 47);
  assert.equal(tot(mon, 'ot1_5'), 9);
  assert.deepEqual([mon[5].regular, mon[5].ot1_5, mon[5].cause], [5, 2, 'weekly']);
  assert.equal(mon[6].cause, 'seventh');
  assert.equal(mon[7].consecutive, 1, 'the count does not roll across weeks');
  assert.equal(mon[7].regular, 7, 'and the 40-hour counter restarted');

  const sun = classifyWeek(days, { startDow: 0 });
  assert.equal(tot(sun, 'regular'), 54);
  assert.equal(tot(sun, 'ot1_5'), 2);
  assert.ok(sun.every((d) => d.cause !== 'seventh'));
});

test('a day off resets the consecutive count', () => {
  const r = classifyWeek([0, 1, 3, 4, 5, 6].map((i) => ({ date: day(i), hours: 6 })));
  assert.equal(r.at(-1).consecutive, 4);
  assert.ok(r.every((d) => d.cause === null));
});

test('null and zero hours are not worked days', () => {
  const r = classifyWeek([{ date: MON, hours: null }, { date: day(1), hours: 0 }, { date: day(2), hours: 3 }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].consecutive, 1);
});

/* ===========================================================================
   Break compliance — §22.1.5
=========================================================================== */

const entry = (o) => ({ staff_id: 'p', work_date: MON, hall_id: 'sc', is_worked_time: true,
  category: 'worked', meal_taken: false, meal_waived: false, second_meal_taken: false,
  second_meal_waived: false, rest_breaks_taken: 4, ...o });

test('rest table edges', () => {
  for (const [h, n] of [[3.5, 0], [3.51, 1], [6, 1], [6.01, 2], [10, 2], [10.01, 3], [14, 3], [14.01, 4]]) {
    assert.equal(restRequired(h), n, `${h}h`);
  }
});

test('a meal is owed past 5 hours, not at 5', () => {
  assert.equal(mealRequired(5), 0);
  assert.equal(mealRequired(5.01), 1);
  assert.deepEqual(checkDay(entry({ hours_worked: '5.00' })).violations, []);
  assert.deepEqual(checkDay(entry({ hours_worked: '5.01' })).violations,
    [{ kind: 'meal', type: 'not_taken' }]);
});

test('a meal starting at the end of the 5th hour is on time; a minute later is late', () => {
  const at = (mins) => entry({ hours_worked: '8', meal_taken: true,
    clock_in: '2026-08-03T17:00:00Z', meal_start: new Date(Date.parse('2026-08-03T17:00:00Z') + mins * 60000).toISOString() });
  assert.deepEqual(checkDay(at(300)).violations, []);
  assert.deepEqual(checkDay(at(300.6)).violations, [{ kind: 'meal', type: 'taken_late' }]);
});

test('a meal taken with no start time is counted as taken, timing unknown', () => {
  const r = checkDay(entry({ hours_worked: '8', meal_taken: true }));
  assert.deepEqual(r.violations, []);
  assert.equal(r.mealTimingUnknown, true);
});

test('the first meal is waivable at 5.5 hours, not at 6.5', () => {
  assert.deepEqual(checkDay(entry({ hours_worked: '5.5', meal_waived: true })).violations, []);
  assert.deepEqual(checkDay(entry({ hours_worked: '6.5', meal_waived: true })).violations,
    [{ kind: 'meal', type: 'waived_not_waivable' }]);
});

test('the second meal is waivable only at 10–12 hours AND after a first meal actually taken', () => {
  const ok = checkDay(entry({ hours_worked: '11', meal_taken: true, second_meal_waived: true }));
  assert.deepEqual(ok.violations, []);
  const noFirst = checkDay(entry({ hours_worked: '11', meal_waived: true, second_meal_waived: true }));
  assert.ok(noFirst.violations.some((v) => v.kind === 'second_meal' && v.type === 'waived_not_waivable'),
    'a waived first meal does not permit waiving the second');
  const long = checkDay(entry({ hours_worked: '12.5', meal_taken: true, second_meal_waived: true }));
  assert.deepEqual(long.violations, [{ kind: 'second_meal', type: 'waived_not_waivable' }]);
});

test('premium hours cap at one meal and one rest per day', () => {
  // 11h, no meals, no rest: meal + second meal + rest violations, but 2 hours.
  const r = checkDay(entry({ hours_worked: '11', rest_breaks_taken: 0 }));
  assert.equal(r.violations.length, 3);
  assert.equal(r.premiumHours, 2);
  // Two entries on one day at two halls: still capped at 2.
  const days = complianceDays([
    entry({ id: 'a', hours_worked: '6', rest_breaks_taken: 0 }),
    entry({ id: 'b', hall_id: 'rwc', hours_worked: '6', rest_breaks_taken: 0 }),
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].premiumHours, 2);
});

test('null hours are not 0 hours, and a zero-hour test punch is ignored', () => {
  assert.equal(actualHours(entry({ hours_worked: null })), null);
  assert.equal(actualHours(entry({ hours_worked: '0.00', clock_in: '2026-08-10T20:00:00Z',
    clock_out: '2026-08-10T20:00:00Z' })), null);
  assert.equal(actualHours(entry({ hours_worked: '7', category: 'pto', is_worked_time: false })), null);
  assert.equal(checkDay(entry({ hours_worked: '0.00' })).recorded, false);
  assert.deepEqual(complianceDays([entry({ hours_worked: null }), entry({ hours_worked: '0' })]), []);
});

/* ===========================================================================
   Pay periods, coverage, seventh day, wage line
=========================================================================== */

test('semi-monthly pay periods, including February', () => {
  assert.deepEqual([payPeriod('2026-08-10').start, payPeriod('2026-08-10').end], ['2026-08-01', '2026-08-15']);
  assert.deepEqual([payPeriod('2026-08-15').start, payPeriod('2026-08-16').start], ['2026-08-01', '2026-08-16']);
  assert.equal(payPeriod('2026-08-20').end, '2026-08-31');
  assert.equal(payPeriod('2026-02-20').end, '2026-02-28');
  assert.equal(payPeriod('2028-02-20').end, '2028-02-29');
  assert.equal(payPeriod('2026-09-30').end, '2026-09-30');
  const p = payPeriods('2026-03-01');
  assert.deepEqual([p.prev.start, p.prev.end], ['2026-02-16', '2026-02-28']);
  assert.deepEqual([p.next.start, p.next.end], ['2026-03-16', '2026-03-31']);
  assert.equal(payPeriods('2026-12-20').next.start, '2027-01-01');
  assert.equal(payPeriod('2026-08-20').label, '16–31 Aug 2026');
});

test('coverage: short, over, training not counted, overrides win', () => {
  const sessions = [{ id: 's1', hall_id: 'sc', session_date: '2026-08-23', part: 'PM' }]; // Sunday
  const needs = [
    { hall_id: 'sc', role_id: 'MOD', dow: 0, part: 'PM', needed: 1 },
    { hall_id: 'sc', role_id: 'CALL', dow: 0, part: 'PM', needed: 3 },
  ];
  const asg = [
    { session_id: 's1', role_id: 'MOD', staff_id: 'a' },
    { session_id: 's1', role_id: 'MOD', staff_id: 'b' },
    { session_id: 's1', role_id: 'CALL', staff_id: 'c' },
    { session_id: 's1', role_id: 'CALL', staff_id: 'd', is_training: true },
  ];
  const c = coverage(sessions, asg, needs, []);
  const mod = c.bySlot.find((r) => r.roleId === 'MOD');
  const call = c.bySlot.find((r) => r.roleId === 'CALL');
  assert.deepEqual([mod.needed, mod.filled, mod.short, mod.over], [1, 2, 0, 1]);
  assert.deepEqual([call.needed, call.filled, call.short, call.over], [3, 1, 2, 0]);
  assert.equal(c.totals.training, 1);
  assert.equal(c.totals.pct, 2 / 4, 'over-staffed MOD does not offset short callers');

  const o = coverage(sessions, asg, needs, [{ session_id: 's1', role_id: 'CALL', needed: 1 }]);
  const call2 = o.bySlot.find((r) => r.roleId === 'CALL');
  assert.deepEqual([call2.needed, call2.short], [1, 0]);
  assert.equal(o.totals.pct, 1);
});

test('seventh consecutive scheduled day is flagged within a Monday week only', () => {
  const all7 = [0, 1, 2, 3, 4, 5, 6].map(day);
  const straddle = [6, 7, 8, 9, 10, 11, 12].map(day);   // Sun 9 → Sat 15
  const flags = seventhDayFlags(new Map([['a', all7], ['b', straddle]]));
  assert.deepEqual(flags.map((f) => [f.staffId, f.weekStart]), [['a', MON]]);
});

test('the wage line uses commission and hours only', () => {
  const w = wageLine({ commission: 30000, hours: 40, ot1_5: 4, ot2_0: 1 });
  close(w.rateAdj, 750);
  close(w.otAdj, 750 * 0.5 * 4 + 750 * 1);
  assert.deepEqual(wageLine({ commission: 30000, hours: 0 }), { rateAdj: null, otAdj: null });
  assert.deepEqual(wageLine({ commission: null, hours: 10 }), { rateAdj: null, otAdj: null });
});

/* ===========================================================================
   Privacy — the allowlist
=========================================================================== */

test('no pay columns are requested, and the new tables are read', async () => {
  assert.equal(assertNoPayColumns(), true);
  // The only "rate"-like columns are the session commission RATE (already read
  // for the Commission screen) and the RPA TARGET — sales figures, not pay.
  for (const [table, cols] of Object.entries(COLUMNS)) {
    for (const c of cols.split(',')) {
      assert.ok(!/premium|wage|salary|hourly|base_?rate|regular_?rate/i.test(c), `${table}.${c}`);
      if (/rate/i.test(c)) assert.ok(['comm_rate', 'target_rpa'].includes(c) || /rpa/.test(c), `${table}.${c}`);
    }
  }
  assert.ok(!COLUMNS.sched_time_entries.includes('premium'));
  assert.ok(!/phone|email|employee_ref|last_name/.test(COLUMNS.sched_staff));
  assert.ok(COLUMNS.sched_staff.includes('on_roster'));
  for (const t of ['sched_hall_role_times', 'sched_hall_role_needs', 'sched_session_roles', 'sched_rpa_defaults']) {
    assert.ok(COLUMNS[t], `${t} must be in the allowlist`);
  }
  const queries = [];
  const result = await readOperations({ connect: async () => ({
    query: async (sql) => { queries.push(sql); return { rows: [] }; }, release: () => {},
  }) });
  for (const k of ['hallRoleTimes', 'hallRoleNeeds', 'sessionRoles', 'rpaDefaults']) assert.ok(Array.isArray(result[k]), k);
  assert.ok(queries.every((q) => !/premium|hourly|wage|salary/.test(q)));
});

/* ===========================================================================
   Commission — the target comes from sched_rpa_defaults when unset
=========================================================================== */

test('commission uses the hall default target when the session has none', () => {
  const rpaDefaults = [{ hall_id: 'rwc', dow: 4, part: 'PM', target_rpa: 478.95 }];
  const sessions = [{ id: 'q', hall_id: 'rwc', part: 'PM', session_date: '2026-08-27',   // Thursday
    total_sales: '150000.00', attendance: 100, comm_rate: '0.15', target_rpa: null }];
  const payouts = [{ session_id: 'q', staff_id: 'a', session_date: '2026-08-27', shares: '1',
    total_shares: '8', commission_pool: '22500.00', payout_amount: '2812.50' }];
  const [row] = sessionRows({ payouts, sessions, staff: [], rpaDefaults });
  assert.equal(row.targetRpa, 47895, 'cents per attendee');
  assert.equal(row.targetSource, 'default');
  // (1500.00 − 478.95) × 100 × 0.15 = 15,315.75
  assert.equal(row.computedPool, 1531575);
  assert.equal(row.computedPool, Math.round(commissionPool({ rpa: 15000000 / 100, targetRpa: 47895, attendance: 100, rate: 0.15 })));
  assert.ok(row.poolGap > 0, 'the scheduler stored rate x gross; the gap is surfaced');

  const own = targetFor({ ...sessions[0], target_rpa: '500.00' }, rpaDefaults);
  assert.deepEqual(own, { targetRpa: 50000, targetSource: 'session' }, 'a session target wins');
  assert.deepEqual(targetFor({ ...sessions[0], hall_id: 'sc' }, rpaDefaults), { targetRpa: null, targetSource: null });
  assert.equal(poolFor({ sales: 100, attendance: 0, targetRpa: 10, rate: 0.1 }).pool, null,
    'a target with no attendance cannot be applied');

  const { node } = render(renderCommission, { schedule: { ok: true, sessions, payouts: [],
    commissionPayouts: payouts, staff: [{ id: 'a', name: 'Ana' }], rpaDefaults } }, { tab: 'sessions' });
  const text = inspect(node, 'commission default target');
  assert.match(text, /hall default/);
  assert.doesNotMatch(text, /No RPA target is set/);
});

/* ===========================================================================
   The whole screen, against a hand-built fixture
=========================================================================== */

/*
  Aug 2026. Weeks: Mon 10–Sun 16, Mon 17–Sun 23. Default period 16–31 Aug.

  ANA works every day Mon 17 – Sun 23 (both halls):
    Mon 17 sc PM 14:00–00:00 10h  → 8 reg, 2 daily          cum 8
    Tue/Wed/Thu rwc PM 10h each   → 8 reg, 2 daily each      cum 32
    Fri 21 sc PM 10h              → 8 reg, 2 daily           cum 40
    Sat 22 sc AM 09:30–18:45 9.25 (two roles, counted once)
                                  → 8 reg +1.25 daily; cum 48 → 8 weekly → 0 reg, 9.25 at 1.5x
    Sun 23 sc PM 10h, 7th day     → 8 at 1.5x, 2 at 2x
    Totals: 69.25h; regular 40; 1.5x 27.25; 2x 2; daily 11.25, weekly 8, seventh 10.
    Commission $300 → rateAdj 30000/69.25 c/h; otAdj = rateAdj × (0.5×27.25 + 2).

  BEN: Sun 16 sc AM 09:30–18:45 + PM 15:30–00:00 = 09:30–24:00 = 14.5h → 8 / 4 / 2.5.
       Mon 17 sc PM, MOD, no times → template 15:00–23:00 = 8h (new week) → 8 reg.
       Fri 21 sc PM, Callers, start only, template is a placeholder → NO END TIME.
       A $39,473.72 payout on a test session — excluded.
  CAL: a draft session (Thu 27 rwc) → not counted; a TRAINING shift Sun 23
       14:00–00:00 → counted as hours (a trainee works), not as coverage.
  DEE: active, never scheduled. EVE: inactive.
*/
function fixture() {
  const roles = [{ id: 'rM', name: 'MOD' }, { id: 'rC', name: 'Callers/Strip' }];
  const staff = [
    { id: 'A', name: 'Ana', active: true, on_roster: true },
    { id: 'B', name: 'Ben', active: true, on_roster: true },
    { id: 'C', name: 'Cal', active: true, on_roster: true },
    { id: 'D', name: 'Dee', active: true, on_roster: true },
    { id: 'E', name: 'Eve', active: false, on_roster: false },
  ];
  const S = (id, hall, date, part, status = 'deployed', extra = {}) => ({ id, hall_id: hall,
    session_date: date, part, status, ...extra });
  const sessions = [
    S('su16a', 'sc', '2026-08-16', 'AM'), S('su16p', 'sc', '2026-08-16', 'PM'),
    S('mo17', 'sc', '2026-08-17', 'PM'), S('tu18', 'rwc', '2026-08-18', 'PM'),
    S('we19', 'rwc', '2026-08-19', 'PM'), S('th20', 'rwc', '2026-08-20', 'PM'),
    S('fr21', 'sc', '2026-08-21', 'PM'), S('sa22', 'sc', '2026-08-22', 'AM', 'planned'),
    S('su23', 'sc', '2026-08-23', 'PM'), S('th27', 'rwc', '2026-08-27', 'PM', 'draft'),
    S('sa08', 'sc', '2026-08-08', 'AM', 'planned'), S('fr14', 'sc', '2026-08-14', 'PM'),
    S('test', 'sc', '2026-08-24', 'PM', 'draft',
      { total_sales: '5000005.00', attendance: 5555, comm_rate: '0.15' }),
  ];
  const A = (id, sid, staffId, roleId, start, end, extra = {}) => ({ id, session_id: sid, staff_id: staffId,
    role_id: roleId, scheduled_start: start, scheduled_end: end, is_training: false, ...extra });
  const assignments = [
    A('a1', 'mo17', 'A', 'rC', '14:00:00', '00:00:00'),
    A('a2', 'tu18', 'A', 'rC', '14:00:00', '00:00:00'),
    A('a3', 'we19', 'A', 'rC', '14:00:00', '00:00:00'),
    A('a4', 'th20', 'A', 'rC', '14:00:00', '00:00:00'),
    A('a5', 'fr21', 'A', 'rC', '14:00:00', '00:00:00'),
    A('a6', 'sa22', 'A', 'rM', '09:30:00', '18:45:00'),
    A('a7', 'sa22', 'A', 'rC', '09:30:00', '18:45:00'),
    A('a8', 'su23', 'A', 'rM', '14:00:00', '00:00:00'),
    A('b1', 'su16a', 'B', 'rM', '09:30:00', '18:45:00'),
    A('b2', 'su16p', 'B', 'rM', '15:30:00', '00:00:00'),
    A('b3', 'mo17', 'B', 'rM', null, null),
    A('b4', 'fr21', 'B', 'rC', '14:00:00', null),
    A('c1', 'th27', 'C', 'rC', null, null),
    A('c2', 'sa08', 'C', 'rC', '09:30:00', '18:45:00'),
    A('t1', 'su23', 'C', 'rC', '14:00:00', '00:00:00', { is_training: true }),
  ];
  const hallRoleTimes = [
    { hall_id: 'sc', role_id: 'rM', dow: 1, part: 'PM', start_time: '15:00:00', end_time: '23:00:00', is_placeholder: false },
    { hall_id: 'sc', role_id: 'rC', dow: 5, part: 'PM', start_time: '14:00:00', end_time: '00:00:00', is_placeholder: true },
  ];
  const hallRoleNeeds = [
    { hall_id: 'sc', role_id: 'rM', dow: 0, part: 'PM', needed: 1 },
    { hall_id: 'sc', role_id: 'rC', dow: 0, part: 'PM', needed: 2 },
    { hall_id: 'sc', role_id: 'rM', dow: 1, part: 'PM', needed: 1 },
  ];
  const timeEntries = [
    { id: 'te1', staff_id: 'A', hall_id: 'sc', work_date: '2026-08-17', hours_worked: '0.00',
      clock_in: '2026-08-17T21:00:00Z', clock_out: '2026-08-17T21:00:00Z', is_worked_time: true, category: 'worked' },
    { id: 'te2', staff_id: 'A', hall_id: 'sc', work_date: '2026-08-21', hours_worked: null,
      clock_in: '2026-08-21T21:00:00Z', is_worked_time: true, category: 'worked' },
  ];
  const commissionPayouts = [
    { session_id: 'su23', staff_id: 'A', session_date: '2026-08-23', shares: '1', total_shares: '1',
      commission_pool: '300.00', payout_amount: '300.00' },
    { session_id: 'test', staff_id: 'B', session_date: '2026-08-24', shares: '1', total_shares: '19',
      commission_pool: '750000.75', payout_amount: '39473.72' },
  ];
  return { ok: true, roles, staff, sessions, assignments, hallRoleTimes, hallRoleNeeds,
    sessionRoles: [], timeEntries, commissionPayouts, rpaDefaults: [] };
}
const LOCATIONS = [{ id: 'LS', name: 'Santa Clara' }, { id: 'LR', name: 'Redwood City' }];

test('model: default period, hand-checked overtime, honest counts', () => {
  const m = buildStaffOverview(fixture(), { excludedPayoutSessions: new Set(['test']) });
  assert.deepEqual(m.window, { start: '2026-08-08', end: '2026-08-27' });
  assert.equal(m.period.key, '2026-08-16', 'latest period with any assignment');

  const ana = m.rows.find((r) => r.name === 'Ana');
  close(ana.scheduled, 69.25, 'Sat counted once despite two roles');
  assert.equal(ana.shifts, 7);
  close(ana.regular, 40); close(ana.ot1_5, 27.25); close(ana.ot2_0, 2);
  close(ana.byCause.daily, 11.25); close(ana.byCause.weekly, 8); close(ana.byCause.seventh, 10);
  assert.equal(ana.basis, 'scheduled');
  assert.equal(ana.actual, null, 'a zero punch and a null are not 0 hours');
  assert.equal(ana.commission, 30000);
  close(ana.rateAdj, 30000 / 69.25);
  close(ana.otAdj, (30000 / 69.25) * (0.5 * 27.25 + 2));

  const ben = m.rows.find((r) => r.name === 'Ben');
  close(ben.scheduled, 22.5);
  assert.equal(ben.unmeasured, 1);
  close(ben.regular, 16); close(ben.ot1_5, 4); close(ben.ot2_0, 2.5);
  assert.equal(ben.commission, null, 'the test payout is excluded');

  const cal = m.rows.find((r) => r.name === 'Cal');
  close(cal.scheduled, 10, 'the training shift counts as hours; the draft does not');
  assert.equal(cal.shifts, 1);
  assert.ok(!m.rows.some((r) => r.name === 'Dee'), 'activity filter on by default');
  assert.deepEqual(m.notCounted, { draft: 1 });
  assert.equal(m.kpis.noEnd, 1);
  close(m.kpis.scheduled, 101.75);
  assert.equal(m.kpis.actual, null);
  assert.equal(m.entriesInPeriod, 2);
  assert.deepEqual(m.seventh.map((f) => [f.name, f.weekStart]), [['Ana', '2026-08-17']]);
  assert.equal(m.dumbbell.length, 0);

  // Coverage: Sun PM Callers need 2 on each of Sun 16 and Sun 23 and get 0
  // (Cal is a trainee); Mon 17 PM has a caller nobody asked for.
  // Overall: needed 7 (Sun 16: 1+2, Sun 23: 1+2, Mon 17: 1), filled within need 3.
  const callSun = m.coverage.bySlot.find((s) => s.dow === 0 && s.part === 'PM' && s.roleId === 'rC');
  assert.deepEqual([callSun.sessions, callSun.needed, callSun.filled, callSun.short], [2, 4, 0, 4]);
  assert.equal(m.kpis.needed, 7);
  assert.equal(m.kpis.filledCapped, 3);
  const callMon = m.coverage.bySlot.find((s) => s.dow === 1 && s.roleId === 'rC');
  assert.deepEqual([callMon.needed, callMon.filled, callMon.over], [0, 1, 1]);

  const all = buildStaffOverview(fixture(), { activeOnly: false });
  assert.ok(all.rows.some((r) => r.name === 'Dee'));
  assert.ok(!all.rows.some((r) => r.name === 'Eve'), 'inactive and off the roster');

  const prev = buildStaffOverview(fixture(), { period: m.periods.prev.start });
  assert.equal(prev.period.key, '2026-08-01');
});

test('model: OT is classified on the whole week even when the period splits it', () => {
  // Ben's Sun 16 belongs to Mon 10 – Sun 16. Viewing 1–15 Aug must not show it.
  const early = buildStaffOverview(fixture(), { period: '2026-08-01' });
  assert.ok(!early.rows.some((r) => r.name === 'Ben'));
});

test('model: recorded hours switch the basis and wake compliance and the dumbbell', () => {
  const f = fixture();
  // Ben actually worked 11h on Sun 16: no meal, no second meal, 1 rest of 3.
  f.timeEntries.push({ id: 'te3', staff_id: 'B', hall_id: 'sc', work_date: '2026-08-16',
    hours_worked: '11.00', is_worked_time: true, category: 'worked', meal_taken: false,
    meal_waived: false, second_meal_taken: false, second_meal_waived: false, rest_breaks_taken: 1 });
  const m = buildStaffOverview(f, {});
  const ben = m.rows.find((r) => r.name === 'Ben');
  assert.equal(ben.basis, 'mixed');
  close(ben.actual, 11);
  close(ben.ot1_5, 3); close(ben.ot2_0, 0); close(ben.regular, 16);
  assert.equal(ben.premiumHours, 2);
  assert.equal(ben.daysOut, 1);
  assert.deepEqual(m.violations.map((v) => `${v.kind}:${v.type}:${v.premiumHours}`),
    ['rest:not_taken:1', 'meal:not_taken:1', 'second_meal:not_taken:0']);
  assert.equal(m.dumbbell.length, 1);
  close(m.dumbbell[0].variance, 11 - 22.5);

  const only = buildStaffOverview(f, { complianceOnly: true });
  assert.deepEqual(only.rows.map((r) => r.name), ['Ben']);
});

test('model: venue and role filters', () => {
  const rwc = buildStaffOverview(fixture(), { hall: 'rwc' });
  const ana = rwc.rows.find((r) => r.name === 'Ana');
  close(ana.scheduled, 30, 'three Redwood City shifts');
  assert.ok(!rwc.rows.some((r) => r.name === 'Ben'));
  const mod = buildStaffOverview(fixture(), { role: 'rM' });
  assert.deepEqual(mod.rows.map((r) => r.name).sort(), ['Ana', 'Ben']);
  assert.ok(mod.coverage.bySlot.every((s) => s.roleId === 'rM'));
});

test('screen: renders every panel cleanly and states its assumptions', () => {
  const { node, inspector } = render(renderStaff, { locations: LOCATIONS, schedule: fixture() }, {});
  const text = inspect(node, 'staff overview');
  inspect(inspector, 'staff overview inspector');
  assert.match(text, /Scheduler data: 8 Aug – 27 Aug 2026/);
  assert.match(text, /Workweek: Monday–Sunday/);
  assert.match(text, /Sunday workweek/);
  assert.match(text, /16–31 Aug 2026/);
  assert.match(text, /not today's/);
  assert.match(text, /1 shift had no end time/);
  assert.match(text, /Not yet recorded/);
  assert.match(text, /1 shift on draft sessions is not counted/);
  assert.match(text, /not defined anywhere in the scheduler \(Q26\)/);
  assert.match(text, /Seventh consecutive day/);
  assert.match(text, /Ana/);
  assert.doesNotMatch(text, /from the time clock/i);
  assert.equal(node.querySelectorAll('.rn-dir').length, 1, 'one sort indicator');
  assert.ok(node.querySelector('.so-kpis .so-tone-bad'), 'coverage below 90% wears the bad tone');
  assert.ok(node.querySelector('.so-m-short') && node.querySelector('.so-m-over'),
    'shortfall and over-staffing both drawn');
  assert.match(text, /Dormant/);
  assert.match(readableText(inspector), /Monday to Sunday/);
});

test('screen: every sparkline shares one y-domain', () => {
  const { node } = render(renderStaff, { locations: LOCATIONS, schedule: fixture() }, {});
  const heights = [...node.querySelectorAll('.so-spark-bar')].map((r) => Number(r.getAttribute('height')));
  // Ana's 69.25h week is the tallest bar anywhere; nobody else's bar may reach it.
  const max = Math.max(...heights);
  assert.equal(heights.filter((x) => x === max).length, 1);
  assert.ok(heights.some((x) => x < max / 2), 'Ben\'s smaller weeks are drawn smaller');
});

test('screen: filters and sorting go through onNavigate', () => {
  const { node, calls } = render(renderStaff, { locations: LOCATIONS, schedule: fixture() }, {});
  node.querySelector('th[data-sort="name"]').dispatchEvent(new dom.window.Event('click'));
  assert.deepEqual(calls.at(-1), ['staff-overview', { sort: 'name', dir: 'asc' }]);
  const prev = [...node.querySelectorAll('button')].find((b) => /Previous/.test(b.textContent));
  prev.dispatchEvent(new dom.window.Event('click'));
  assert.equal(calls.at(-1)[1].period, '2026-08-01');
  const chip = [...node.querySelectorAll('button')].find((b) => /Only people with activity/.test(b.textContent));
  chip.dispatchEvent(new dom.window.Event('click'));
  assert.equal(calls.at(-1)[1].activity, 'off');
  const venue = node.querySelector('select[aria-label="Venue"]');
  assert.ok([...venue.options].some((o) => o.textContent === 'Redwood City'), 'hall names via the managers hall map');
  venue.value = 'rwc'; venue.dispatchEvent(new dom.window.Event('change'));
  assert.equal(calls.at(-1)[1].hall, 'rwc');
});

test('screen: filtered, compliance-only, empty and woken states all render cleanly', () => {
  const f = fixture();
  f.timeEntries.push({ id: 'te3', staff_id: 'B', hall_id: 'sc', work_date: '2026-08-16',
    hours_worked: '11.00', is_worked_time: true, category: 'worked', rest_breaks_taken: 1 });
  for (const params of [{ hall: 'rwc' }, { role: 'rM' }, { compliance: 'on' }, { activity: 'off' },
    { period: '2026-09-16' }, { sort: 'commission', dir: 'asc' }, { tab: 'capability' }]) {
    const { node } = render(renderStaff, { locations: LOCATIONS, schedule: f }, params);
    inspect(node, `staff ${JSON.stringify(params)}`);
  }
  const { node } = render(renderStaff, { locations: LOCATIONS, schedule: f }, {});
  const text = inspect(node, 'staff with hours');
  assert.match(text, /Waived when not waivable|Not taken/);
  assert.ok(node.querySelector('.so-db-act'), 'the dumbbell wakes');
  const empty = render(renderStaff, { schedule: { ok: true, staff: [], sessions: [], assignments: [] } }, {});
  assert.match(inspect(empty.node, 'staff empty'), /No scheduled shifts/);
  const off = render(renderStaff, { schedule: { ok: false } }, {});
  assert.match(readableText(off.node), /Scheduler not connected/);
});
