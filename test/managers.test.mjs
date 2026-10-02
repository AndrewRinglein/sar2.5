/* ============================================================================
   Tests for lib/managers.js and lib/ops.js

   The join fixture is REAL: 31 July – 16 August 2026, both databases, read out
   of production before any of this was written. Expected results were worked
   out from those rows by hand, so a pass means the code agrees with the data
   rather than with itself.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHalls, joinSessions, attributeManagers,
  slotKey, weekdayIndex, dayNumber,
  buildBaselines, scoreSession, rollup, separable, daySlots,
  buildManagerModel, ROLE_METRIC, METRICS,
  SLOT_WINDOW_DAYS, MIN_SLOT_SESSIONS, MIN_RANK_SESSIONS,
  trendLevels, TREND_HALF_WINDOW_DAYS,
  balanceChecks, wilson, rollupBalance, RATE_ROLES, BALANCE_TOLERANCE_CENTS,
} from '../src/lib/managers.js';
import {
  COLUMNS, assertNoPayColumns,
} from '../src/lib/ops.js';

const SC = '2f1dddc3-33a1-4d89-9f9c-c56675270651';
const RWC = 'ff061e83-598a-4c30-9df2-6532ba1c0795';
const LOCATIONS = [{ id: SC, name: 'Santa Clara' }, { id: RWC, name: 'Redwood City' }];

/* Real roster rows, Ops. */
const OPS = [
  { id: 'o1', hall_id: 'sc', session_date: '2026-08-03', part: 'PM', day_type: 'weekday' },
  { id: 'o2', hall_id: 'sc', session_date: '2026-08-08', part: 'AM', day_type: 'weekend' },
  { id: 'o3', hall_id: 'sc', session_date: '2026-08-08', part: 'PM', day_type: 'weekend' },
  { id: 'o4', hall_id: 'rwc', session_date: '2026-08-11', part: 'PM', day_type: 'weekday' },
];

/* The matching analytics events. */
const EVENTS = [
  { id: 'e1', location_id: SC, event_date: '2026-08-03', event_type: 'regular' },
  { id: 'e2', location_id: SC, event_date: '2026-08-08', event_type: 'regular' },
  { id: 'e3', location_id: SC, event_date: '2026-08-08', event_type: 'late' },
  { id: 'e4', location_id: RWC, event_date: '2026-08-11', event_type: 'regular' },
];

/* ---------------------------------------------------------------------------
   Halls
--------------------------------------------------------------------------- */

test('halls resolve by name, not by hardcoded uuid', () => {
  const m = resolveHalls(LOCATIONS);
  assert.equal(m.get('sc'), SC);
  assert.equal(m.get('rwc'), RWC);
});

test('an unresolvable hall is reported, not guessed', () => {
  const m = resolveHalls([{ id: 'x', name: 'Somewhere Else' }]);
  assert.equal(m.size, 0);
});

/* ---------------------------------------------------------------------------
   The join — DESIGN §2
--------------------------------------------------------------------------- */

test('the ordinal join matches all four real sessions', () => {
  const { links, report } = joinSessions(OPS, EVENTS, resolveHalls(LOCATIONS));
  assert.equal(report.matched, 4);
  assert.equal(report.mismatched.length, 0);
  assert.equal(links.get('e1'), 'o1');   // weekday: PM  <-> regular
  assert.equal(links.get('e2'), 'o2');   // weekend: AM  <-> regular
  assert.equal(links.get('e3'), 'o3');   // weekend: PM  <-> late
  assert.equal(links.get('e4'), 'o4');
});

test('REGRESSION: a static PM->late map would lose the weekday sessions', () => {
  // This is the bug the ordinal rule exists to prevent. On a weekday the hall
  // runs one session; Ops calls it PM and analytics calls it regular. Anyone
  // "simplifying" the join back to a lookup table trips this test.
  const staticMap = { AM: 'regular', PM: 'late' };
  const wouldMatch = OPS.filter((o) => EVENTS.some(
    (e) => e.event_date === o.session_date && e.event_type === staticMap[o.part],
  ));
  // It matches the two weekend sessions and loses BOTH weekdays: 3 August at
  // Santa Clara and 11 August at Redwood City are each a single session that
  // Ops calls PM and the analytics call regular.
  assert.equal(wouldMatch.length, 2, 'only the weekend pair survives a static map');
  const lost = OPS.filter((o) => !wouldMatch.includes(o)).map((o) => o.session_date);
  assert.deepEqual(lost, ['2026-08-03', '2026-08-11']);
  assert.equal(joinSessions(OPS, EVENTS, resolveHalls(LOCATIONS)).report.matched, 4,
    'while the ordinal rule keeps all four');
});

test('a day whose counts disagree is skipped and recorded, never guessed', () => {
  // Two rostered sessions, one result. Matching first-to-first would credit an
  // evening's takings to whoever was rostered in the morning.
  const ops = [
    { id: 'a', hall_id: 'sc', session_date: '2026-08-16', part: 'AM' },
    { id: 'b', hall_id: 'sc', session_date: '2026-08-16', part: 'PM' },
  ];
  const evs = [{ id: 'x', location_id: SC, event_date: '2026-08-16', event_type: 'regular' }];
  const { links, report } = joinSessions(ops, evs, resolveHalls(LOCATIONS));
  assert.equal(links.size, 0);
  assert.equal(report.mismatched.length, 1);
  assert.deepEqual(
    { ops: report.mismatched[0].ops, events: report.mismatched[0].events },
    { ops: 2, events: 1 },
  );
});

test('a hall the analytics side does not know is counted, not crashed on', () => {
  const ops = [{ id: 'z', hall_id: 'gilroy', session_date: '2026-08-03', part: 'PM' }];
  const { report } = joinSessions(ops, EVENTS, resolveHalls(LOCATIONS));
  assert.equal(report.unmatchedOps, 1);
});

/* ---------------------------------------------------------------------------
   Attribution
--------------------------------------------------------------------------- */

const ROLES = [
  { id: 'r-mod', name: 'MOD' },
  { id: 'r-pay', name: 'Paymaster' },
  { id: 'r-fm', name: 'Flash Manager' },
  { id: 'r-run', name: 'Flash Runners' },
];
const STAFF = [
  { id: 's-sagit', name: 'Sagit' }, { id: 's-paolo', name: 'Paolo' },
  { id: 's-esther', name: 'Esther' }, { id: 's-trainee', name: 'Trainee' },
];

test('a person holding two roles on one night is counted under each, once', () => {
  // Real: Sagit was MOD and Paymaster on 3 August.
  const links = new Map([['e1', 'o1']]);
  const crew = attributeManagers({
    links, roles: ROLES, staff: STAFF,
    assignments: [
      { session_id: 'o1', role_id: 'r-mod', staff_id: 's-sagit' },
      { session_id: 'o1', role_id: 'r-pay', staff_id: 's-sagit' },
      { session_id: 'o1', role_id: 'r-fm', staff_id: 's-paolo' },
    ],
  });
  assert.equal(crew.get('e1').MOD.name, 'Sagit');
  assert.equal(crew.get('e1').Paymaster.name, 'Sagit');
  assert.equal(crew.get('e1')['Flash Manager'].name, 'Paolo');
});

test('Flash Runners are not treated as managers', () => {
  const crew = attributeManagers({
    links: new Map([['e1', 'o1']]), roles: ROLES, staff: STAFF,
    assignments: [{ session_id: 'o1', role_id: 'r-run', staff_id: 's-paolo' }],
  });
  assert.equal(crew.has('e1'), false);
});

test('a trainee shadowing a role is not credited with running it', () => {
  const crew = attributeManagers({
    links: new Map([['e1', 'o1']]), roles: ROLES, staff: STAFF,
    assignments: [
      { session_id: 'o1', role_id: 'r-pay', staff_id: 's-paolo' },
      { session_id: 'o1', role_id: 'r-mod', staff_id: 's-trainee', is_training: true },
    ],
  });
  assert.equal(crew.get('e1').Paymaster.name, 'Paolo');
  assert.equal(crew.get('e1').MOD, undefined);
});

/* ---------------------------------------------------------------------------
   Slots and baselines — DESIGN §4
--------------------------------------------------------------------------- */

test('a slot is hall, weekday and session type', () => {
  assert.equal(weekdayIndex('2026-08-03'), 1);            // a Monday, in UTC
  assert.equal(slotKey(EVENTS[0]), `${SC}|1|regular`);
  assert.notEqual(slotKey(EVENTS[1]), slotKey(EVENTS[2])); // regular != late
});

test('dates are handled in UTC, so a timezone cannot shift a weekday', () => {
  assert.equal(dayNumber('2026-08-04') - dayNumber('2026-08-03'), 1);
  assert.equal(weekdayIndex('2026-01-01'), 4);            // a Thursday
});

/** 30 Mondays at Santa Clara, values 1000..1029, plus the target. */
function mondays(n, value) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10);
    out.push({ id: `m${i}`, location_id: SC, event_date: d, event_type: 'regular', v: 1000 + i });
  }
  if (value !== undefined) out[out.length - 1].v = value;
  return out;
}

test('a session is excluded from its own baseline', () => {
  const evs = mondays(12);
  const base = buildBaselines(evs, (e) => e.v);
  const last = base.get('m11');
  // The last Monday's baseline is the eleven before it: 1000..1010, mean 1005.
  assert.equal(last.n, 11);
  assert.equal(last.mean, 1005);
  assert.ok(!last.slot.includes('undefined'));
});

test('the window is trailing, so an old session drops out', () => {
  const evs = mondays(80);                    // 80 weeks = more than a year
  const base = buildBaselines(evs, (e) => e.v);
  const last = base.get('m79');
  assert.ok(last.n <= Math.ceil(SLOT_WINDOW_DAYS / 7),
    `expected at most a year of Mondays, got ${last.n}`);
  assert.ok(last.n >= 50, 'and enough of them to be worth using');
});

test('a slot with too few sessions yields no score at all, not a zero', () => {
  const evs = mondays(MIN_SLOT_SESSIONS - 2);
  const base = buildBaselines(evs, (e) => e.v);
  const target = base.get(`m${MIN_SLOT_SESSIONS - 3}`);
  assert.equal(target.usable, false);
  assert.equal(scoreSession(target).z, null);
});

test('a slot where every session is identical has no spread and no score', () => {
  const evs = mondays(20).map((e) => ({ ...e, v: 5000 }));
  const base = buildBaselines(evs, (e) => e.v);
  assert.equal(base.get('m19').sd, 0);
  assert.equal(base.get('m19').usable, false);
  assert.equal(scoreSession(base.get('m19')).z, null);
});

test('a null metric takes no part in the baseline', () => {
  const evs = mondays(15).map((e, i) => (i % 3 === 0 ? { ...e, v: null } : e));
  const base = buildBaselines(evs, (e) => e.v);
  assert.equal(base.has('m0'), false, 'a null-valued session is not scored');
  assert.ok(base.get('m14').n < 14, 'and does not pad the baseline');
});

test('the score is the distance in that slot own spread', () => {
  // Baseline 1000..1010 -> mean 1005, sd of 1000..1010 = 3.3166...
  const evs = mondays(12, 1015);
  const base = buildBaselines(evs, (e) => e.v);
  const b = base.get('m11');
  const { z, ratio } = scoreSession(b);
  assert.equal(b.mean, 1005);
  assert.equal(Number(b.sd.toFixed(4)), 3.3166);
  assert.equal(Number(z.toFixed(3)), 3.015);            // (1015-1005)/3.3166
  assert.equal(Number((ratio * 100).toFixed(3)), 0.995); // 10/1005
});

test('for cash variance, smaller is better and the sign is inverted', () => {
  const evs = mondays(12, 1015);
  const b = buildBaselines(evs, (e) => e.v).get('m11');
  const up = scoreSession(b, { better: 1 });
  const down = scoreSession(b, { better: -1 });
  assert.ok(up.z > 0 && down.z < 0);
  assert.equal(down.z, -up.z);
  assert.equal(down.ratio, -up.ratio);
});

/* ---------------------------------------------------------------------------
   Rolling up — DESIGN §4.5 and §5
--------------------------------------------------------------------------- */

test('the interval narrows with the root of the sample', () => {
  const nine = rollup(Array.from({ length: 9 }, () => ({ z: 0.5 })));
  assert.equal(nine.n, 9);
  assert.equal(nine.score, 0.5);
  assert.equal(Number(nine.se.toFixed(4)), 0.3333);
  // The number quoted in the design document and on the screen.
  assert.equal(Number(((nine.hi - nine.lo) / 2).toFixed(2)), 0.65);
});

test('nine sessions is below the bar to be ranked, ten is not', () => {
  assert.equal(rollup(Array.from({ length: 9 }, () => ({ z: 1 }))).rankable, false);
  assert.equal(rollup(Array.from({ length: MIN_RANK_SESSIONS }, () => ({ z: 1 }))).rankable, true);
});

test('unscored sessions do not count toward the sample', () => {
  const r = rollup([{ z: 1 }, { z: null }, { z: null }, { z: 3 }]);
  assert.equal(r.n, 2);
  assert.equal(r.score, 2);
});

test('a person with no scored session has no score, not zero', () => {
  const r = rollup([{ z: null }]);
  assert.equal(r.n, 0);
  assert.equal(r.score, null);
  assert.equal(r.rankable, false);
});

test('two small samples a whisker apart are not called separable', () => {
  const a = rollup(Array.from({ length: 9 }, () => ({ z: 0.6 })));
  const b = rollup(Array.from({ length: 9 }, () => ({ z: 0.2 })));
  assert.equal(separable(a, b), false, '0.4 sigma on nine each is noise');

  const big = rollup(Array.from({ length: 60 }, () => ({ z: 1.2 })));
  const small = rollup(Array.from({ length: 60 }, () => ({ z: 0.2 })));
  assert.equal(separable(big, small), true);
});

/* ---------------------------------------------------------------------------
   Day shape
--------------------------------------------------------------------------- */

test('day shape indexes each slot against the same window', () => {
  const evs = [
    ...mondays(20),                                        // ~1000 each
    ...mondays(20).map((e, i) => ({
      ...e, id: `t${i}`, location_id: RWC, event_type: 'regular', v: 500 + i,
    })),
  ];
  const slots = daySlots(evs, (e) => e.v);
  assert.equal(slots.length, 2);
  assert.ok(slots[0].index > slots[1].index, 'sorted busiest first');
  assert.ok(Math.abs(slots[0].index / slots[1].index - 2) < 0.05,
    'the busy slot is about twice the quiet one');
  assert.ok(slots[0].cv > 0 && slots[0].cv < 0.1);
});

/* ---------------------------------------------------------------------------
   End to end
--------------------------------------------------------------------------- */

test('the whole model builds, and scores land under person AND role', () => {
  const evs = [];
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10);
    evs.push({ id: `e${i}`, location_id: SC, event_date: d, event_type: 'regular' });
  }
  const ops = evs.map((e, i) => ({
    id: `o${i}`, hall_id: 'sc', session_date: e.event_date, part: 'PM',
  }));
  const assignments = ops.flatMap((o) => ([
    { session_id: o.id, role_id: 'r-mod', staff_id: 's-sagit' },
    { session_id: o.id, role_id: 'r-pay', staff_id: 's-sagit' },
  ]));

  const model = buildManagerModel({
    events: evs,
    locations: LOCATIONS,
    schedule: { sessions: ops, assignments, staff: STAFF, roles: ROLES },
    valuesOf: (e) => {
      const i = Number(e.id.slice(1));
      return {
        net: 100000 + i * 500, gross: 200000 + i * 800, flash: 40000 + i * 100,
        rpa: 47700, attendance: 220, margin: 0.2, variance: (i % 5) * 1000 - 2000,
      };
    },
  });

  assert.equal(model.ok, true);
  assert.equal(model.report.matched, 30);

  const mod = model.people.find((p) => p.role === 'MOD');
  const pay = model.people.find((p) => p.role === 'Paymaster');
  assert.equal(mod.name, 'Sagit');
  assert.equal(pay.name, 'Sagit');
  assert.equal(mod.staffId, pay.staffId);
  assert.notEqual(mod.role, pay.role, 'two records, one person, two roles');

  // Each role is scored on its own metric.
  assert.equal(ROLE_METRIC.MOD, 'gross');
  assert.equal(ROLE_METRIC.Paymaster, 'balance');
  assert.ok(mod.primary.n > 0, 'the MOD has a gross score');
  assert.ok(mod.roll.gross.rankable, '30 sessions is plenty to rank');
});

test('the model reports itself unavailable rather than guessing a hall', () => {
  const model = buildManagerModel({
    events: EVENTS, locations: [{ id: 'x', name: 'Nowhere' }],
    schedule: { sessions: OPS, assignments: [], staff: [], roles: [] },
    valuesOf: () => ({}),
  });
  assert.equal(model.ok, false);
  assert.match(model.reason, /hall/i);
});

/* ---------------------------------------------------------------------------
   Privacy — DESIGN §8
--------------------------------------------------------------------------- */

test('no salary column may be read from the Operational database', () => {
  assert.equal(assertNoPayColumns(), true);
  assert.throws(() => assertNoPayColumns({ sched_staff: 'id,name,hourly_rate' }), /forbidden/);
  assert.throws(() => assertNoPayColumns({ sched_staff: 'id,base_salary' }), /forbidden/);
  // `commission_pct` is a RATE, not a person's earnings, and SAR already reads
  // `sched_sessions.comm_rate` to recompute the pool. Permitted deliberately:
  // the boundary is anything that prices somebody's time.
  assert.equal(assertNoPayColumns({ x: 'id,commission_pct' }), true);
});

test('phone and email are not in the allowlist', () => {
  assert.ok(!COLUMNS.sched_staff.includes('phone'));
  assert.ok(!COLUMNS.sched_staff.includes('email'));
});

test('salary columns stay forbidden even though commission is now read', () => {
  // The line is anything that prices a person's TIME. Commission is explicitly
  // permitted; wages and the meal/rest premiums are not.
  assert.throws(() => assertNoPayColumns({ x: 'id,hourly_wage' }), /forbidden/);
  assert.throws(() => assertNoPayColumns({ x: 'id,meal_premium_owed' }), /forbidden/);
  assert.throws(() => assertNoPayColumns({ x: 'id,annual_salary' }), /forbidden/);
  assert.equal(assertNoPayColumns({ x: 'commission_pool,payout_amount,shares' }), true);
});

test('the premium columns are not in the time-entry allowlist', () => {
  assert.ok(COLUMNS.sched_time_entries.includes('hours_worked'), 'hours are permitted');
  assert.ok(!COLUMNS.sched_time_entries.includes('premium'));
  assert.ok(!COLUMNS.sched_time_entries.includes('approved_by'));
});

test('every metric declares a direction', () => {
  for (const m of METRICS) {
    assert.ok(m.better === 1 || m.better === -1, `${m.key} needs a direction`);
  }
  assert.equal(METRICS.find((m) => m.key === 'variance').better, -1);
});


/* ---------------------------------------------------------------------------
   The trend correction — DESIGN §4.6
--------------------------------------------------------------------------- */

test('the concurrent level is the mean of nearby sessions', () => {
  const zs = new Map([['a', 1], ['b', 1], ['c', 1], ['far', -3]]);
  const day = { a: 100, b: 101, c: 102, far: 400 };
  const lv = trendLevels(zs, (id) => day[id]);
  assert.equal(lv.get('a'), 1, 'the far session is outside the window');
  assert.equal(lv.get('far'), -3, 'and is alone in its own');
});

test('the window is +/- 14 days, not one-sided', () => {
  const zs = new Map([['x', 0], ['before', 2], ['after', 2], ['outside', 10]]);
  const day = { x: 100, before: 100 - TREND_HALF_WINDOW_DAYS, after: 100 + TREND_HALF_WINDOW_DAYS,
                outside: 100 + TREND_HALF_WINDOW_DAYS + 1 };
  assert.equal(trendLevels(zs, (id) => day[id]).get('x'), (0 + 2 + 2) / 3);
});

test('unscored sessions do not drag the level toward zero', () => {
  const zs = new Map([['a', 2], ['b', null], ['c', 2]]);
  const lv = trendLevels(zs, () => 0);
  assert.equal(lv.get('a'), 2);
  assert.equal(lv.has('b'), false);
});

test('a rising period is removed from the score, not credited to the manager', () => {
  // This is the production finding, reduced to a fixture: every session in the
  // window is a full sigma up, so nobody in it has actually outperformed.
  const scores = Array.from({ length: 12 }, () => ({ z: 1.0, adj: 0.0 }));
  const r = rollup(scores);
  assert.equal(r.raw, 1.0, 'the night really was above a typical one');
  assert.equal(r.score, 0.0, 'but not above what everyone else was doing');
  assert.equal(r.trend, 1.0, 'and the difference is attributed to the period');
});

test('a manager who beats a hot period keeps the credit', () => {
  const r = rollup(Array.from({ length: 12 }, () => ({ z: 1.8, adj: 0.8 })));
  assert.equal(Number(r.score.toFixed(2)), 0.8);
  assert.equal(Number(r.trend.toFixed(2)), 1.0);
  assert.ok(r.lo > 0, 'and is distinguishable from the period at this sample size');
});

test('a session with no concurrent level falls back to its raw score', () => {
  const r = rollup([{ z: 0.5, adj: null }, { z: 1.5, adj: null }]);
  assert.equal(r.score, 1.0);
  assert.equal(r.trend, 0);
});

test('the model attaches a level and an adjusted score to every session', () => {
  const evs = [];
  for (let i = 0; i < 30; i += 1) {
    evs.push({ id: `e${i}`, location_id: SC, event_type: 'regular',
               event_date: new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10) });
  }
  const ops = evs.map((e, i) => ({ id: `o${i}`, hall_id: 'sc', session_date: e.event_date, part: 'PM' }));
  const model = buildManagerModel({
    events: evs, locations: LOCATIONS,
    schedule: {
      sessions: ops, staff: STAFF, roles: ROLES,
      assignments: ops.map((o) => ({ session_id: o.id, role_id: 'r-mod', staff_id: 's-sagit' })),
    },
    valuesOf: (e) => ({ net: 100000 + Number(e.id.slice(1)) * 900 }),
  });
  const p = model.people[0];
  const scored = p.sessions.filter((s) => s.scores.net.z !== null);
  assert.ok(scored.length > 0);
  for (const s of scored) {
    assert.ok(Number.isFinite(s.scores.net.level), 'every scored session has a level');
    assert.equal(Number(s.scores.net.adj.toFixed(9)),
      Number((s.scores.net.z - s.scores.net.level).toFixed(9)));
  }
  // Steadily rising net means the trend soaks up the rise and the manager,
  // who worked every single night, ends up near zero rather than a hero.
  assert.ok(Math.abs(p.roll.net.score) < Math.abs(p.roll.net.raw),
    'the corrected score is smaller than the raw one on a rising series');
});


/* ---------------------------------------------------------------------------
   Gross, not net
--------------------------------------------------------------------------- */

test('the MOD is scored on gross, because payouts are not theirs to control', () => {
  // A jackpot landing is luck. Scoring on net would blame the manager for it.
  assert.equal(ROLE_METRIC.MOD, 'gross');
  assert.equal(METRICS[0].key, 'gross', 'and gross leads the card order');
});

/* ---------------------------------------------------------------------------
   Balancing — the Paymaster
--------------------------------------------------------------------------- */

test('a deposit within tolerance balances, outside it does not', () => {
  assert.equal(balanceChecks({ variance: 0 })[0].ok, true);
  assert.equal(balanceChecks({ variance: BALANCE_TOLERANCE_CENTS })[0].ok, true);
  assert.equal(balanceChecks({ variance: BALANCE_TOLERANCE_CENTS + 1 })[0].ok, false);
  assert.equal(balanceChecks({ variance: -(BALANCE_TOLERANCE_CENTS + 1) })[0].ok, false,
    'short counts as much as over');
});

test('the sales tie-out compares line items with the sheet own total', () => {
  const ok = balanceChecks({ lineSales: 5000000, sourceSales: 5000050 });
  assert.equal(ok.find((c) => c.key === 'sales').ok, true);
  const bad = balanceChecks({ lineSales: 5000000, sourceSales: 5090000 });
  assert.equal(bad.find((c) => c.key === 'sales').ok, false);
});

test('a check with a missing input is omitted, not failed', () => {
  // An unrecorded figure is not the Paymaster's mistake.
  assert.deepEqual(balanceChecks({}), []);
  assert.equal(balanceChecks({ variance: 0 }).length, 1, 'only the check it can make');
  assert.equal(balanceChecks({ variance: 0, lineSales: 1, sourceSales: 1 }).length, 2);
});

test('Wilson keeps an interval honest when everything passed', () => {
  const w = wilson(3, 3);
  assert.equal(w.rate, 1);
  assert.ok(w.lo < 0.5, `three from three must not claim near-certainty, got ${w.lo}`);
  assert.equal(w.hi, 1);
  // The normal approximation would give zero width here, which is the bug.
  assert.ok(w.hi - w.lo > 0.4);
});

test('Wilson stays inside nought and one', () => {
  for (const [k, n] of [[0, 1], [1, 1], [0, 8], [8, 8], [4, 9]]) {
    const w = wilson(k, n);
    assert.ok(w.lo >= 0 && w.hi <= 1, `${k}/${n} produced ${w.lo}..${w.hi}`);
    assert.ok(w.lo <= w.rate && w.rate <= w.hi);
  }
});

test('the balance rate counts checks, and clean nights count sessions', () => {
  const r = rollupBalance([
    [{ ok: true }, { ok: true }],     // a clean night
    [{ ok: true }, { ok: false }],    // half
    [{ ok: false }, { ok: false }],   // neither
  ]);
  assert.equal(r.n, 3);
  assert.equal(r.checks, 6);
  assert.equal(r.passed, 3);
  assert.equal(r.rate, 0.5);
  assert.equal(r.clean, 1);
  assert.equal(Number(r.cleanRate.toFixed(4)), 0.3333);
});

test('a session with no checks does not count as a session', () => {
  const r = rollupBalance([[], [{ ok: true }]]);
  assert.equal(r.n, 1);
  assert.equal(r.rate, 1);
});

test('the Paymaster primary is the balance rate, the MOD primary is a sigma', () => {
  const evs = []; const ops = [];
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10);
    evs.push({ id: `e${i}`, location_id: SC, event_date: d, event_type: 'regular' });
    ops.push({ id: `o${i}`, hall_id: 'sc', session_date: d, part: 'PM' });
  }
  const model = buildManagerModel({
    events: evs, locations: LOCATIONS,
    schedule: {
      sessions: ops, staff: STAFF, roles: ROLES,
      assignments: ops.flatMap((o) => ([
        { session_id: o.id, role_id: 'r-mod', staff_id: 's-sagit' },
        { session_id: o.id, role_id: 'r-pay', staff_id: 's-paolo' },
      ])),
    },
    valuesOf: (e) => {
      const i = Number(e.id.slice(1));
      return {
        gross: 200000 + i * 800, net: 100000, flash: 40000,
        // Half the nights are out by more than the tolerance.
        variance: i % 2 === 0 ? 100 : 90000,
        lineSales: 200000, sourceSales: 200000,
      };
    },
  });

  const pay = model.people.find((p) => p.role === 'Paymaster');
  const mod = model.people.find((p) => p.role === 'MOD');
  assert.ok(RATE_ROLES.includes('Paymaster'));
  assert.equal(pay.isRate, true);
  assert.equal(mod.isRate, false);
  // Two checks a night, one of which fails on half the nights: 3 in 4.
  assert.equal(pay.primary.rate, 0.75);
  assert.equal(pay.primary.checks, 28);
  assert.ok(Number.isFinite(mod.primary.score), 'the MOD still gets a sigma');
});


/* ---------------------------------------------------------------------------
   Two sessions, two projects — DESIGN §13.4
--------------------------------------------------------------------------- */




