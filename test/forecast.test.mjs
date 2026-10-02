/* ============================================================================
   Forecast (U12) — model and screen

   The first test is worked out BY HAND in the comments beside it. If it
   fails, the code is wrong, not the arithmetic. Money is integer cents, as
   sessionTotals() returns it; the comments use dollars for readability.

   Fixtures only — no real staff or customer names. Hall names are invented,
   except where the shared name-based fallback is itself under test.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { indexMetrics } from '../src/lib/model.js';
import { MIN_SLOT_SESSIONS, Z_95, dayNumber } from '../src/lib/managers.js';
import {
  sessionRows, prepare, slotBaselines, runningSlots, rosterSessions, expectedSessions,
  buildForecast, backtest, horizonMonths, monthEndDay, todayIso, applyDrivers,
  hallMapFromLocations, parseForecastParams, forecastParams, normaliseDrivers, expensesFor,
  cogsPerSession, loadScenarios, saveScenario, deleteScenario, resetScenarioMemory,
  SCENARIO_KEY, RUNNING_WINDOW_WEEKS, RUNNING_MIN_SESSIONS, HORIZONS, BACKTEST_MONTHS,
  easterSunday, holidaysForYear, holidayOn, holidayEvidence,
} from '../src/lib/forecast-model.js';

const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;

const { renderForecast } = await import('../src/screens/forecast.js');

/* ---------------------------------------------------------------------------
   Fixture
--------------------------------------------------------------------------- */

const DEFS = [
  { id: 'm-sales', key: 'sales' },
  { id: 'm-prizes', key: 'prizes' },
  { id: 'm-att', key: 'attendance' },
];
const idx = indexMetrics(DEFS);
const CATEGORIES = [{ key: 'bingo', display_name: 'Bingo', revenue_keys: ['sales'], payout_keys: ['prizes'] }];
const LOCS = [
  { id: 'H1', name: 'Hall One', code: 'H1', settings: { max_attendance: 300 } },
  { id: 'H2', name: 'Hall Two', code: 'H2', settings: {} },
];

/** A data bundle from [date, hall, type, gross $, prizes $, attendance] tuples. */
function bundle(list, extra = {}) {
  const events = []; const metrics = {};
  list.forEach(([date, loc, type, gross, prizes, att], i) => {
    const id = `ev${i}`;
    events.push({ id, location_id: loc, event_date: date, event_type: type });
    metrics[id] = { 'm-sales': gross * 100, 'm-prizes': prizes * 100 };
    if (att !== null && att !== undefined) metrics[id]['m-att'] = att;
  });
  events.sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
  return { events, metrics, idx, categories: CATEGORIES, locations: LOCS,
           config: { name: 'Test', timezone: null, settings: {} }, metricDefs: DEFS, ...extra };
}

/*
   Slot A — Hall One, Monday, regular       Slot B — Hall One, Thursday, regular
     14 Sep  gross 1,000  prizes   600  50     10 Sep  gross   900  prizes 500  40
     21 Sep  gross 2,000  prizes 1,200 100     17 Sep  gross 1,000  prizes 500  40
     28 Sep  gross 3,000  prizes 1,800 150     24 Sep  gross 1,100  prizes 500  40
*/
const HAND = [
  ['2026-09-14', 'H1', 'regular', 1000, 600, 50],
  ['2026-09-21', 'H1', 'regular', 2000, 1200, 100],
  ['2026-09-28', 'H1', 'regular', 3000, 1800, 150],
  ['2026-09-10', 'H1', 'regular', 900, 500, 40],
  ['2026-09-17', 'H1', 'regular', 1000, 500, 40],
  ['2026-09-24', 'H1', 'regular', 1100, 500, 40],
];
const A = 'H1|1|regular';
const B = 'H1|4|regular';

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6,
  `${msg ?? ''} expected ${expected}, got ${actual}`);

function handForecast({ today = '2026-10-01', drivers, off, assumptions, months = ['2026-10'] } = {}) {
  const d = bundle(HAND);
  const rows = sessionRows(d.events, d);
  // Three sessions a slot: the hand test lowers the bar from MIN_SLOT_SESSIONS
  // to 3 so the arithmetic stays small. The real bar is tested separately.
  const prep = prepare(rows, { today, minSessions: 3 });
  return { rows, prep, f: buildForecast({ rows, prep, months, drivers, off, assumptions }) };
}

/* ---------------------------------------------------------------------------
   1. The hand-computed test
--------------------------------------------------------------------------- */

test('HAND: slot means, the projected month, the range, a driver and expense-mode profit', () => {
  const { prep, f } = handForecast();

  /* Slot means.
     A: gross (1000+2000+3000)/3 = $2,000; SD √((1000²+0+1000²)/2) = $1,000
        payout (600+1200+1800)/3 = $1,200 → ratio 0.60; net (400+800+1200)/3 = $800, SD $400
        attendance (50+100+150)/3 = 100
     B: gross (900+1000+1100)/3 = $1,000; SD √((100²+0+100²)/2) = $100
        payout $500 → ratio 0.50; net (400+500+600)/3 = $500, SD $100; attendance 40 */
  const a = prep.baselines.get(A); const b = prep.baselines.get(B);
  assert.equal(a.n, 3); assert.equal(b.n, 3);
  close(a.meanGross, 200000); close(a.sdGross, 100000); close(a.meanPayout, 120000);
  close(a.payoutRatio, 0.6); close(a.meanNet, 80000); close(a.sdNet, 40000); close(a.meanAttendance, 100);
  close(b.meanGross, 100000); close(b.sdGross, 10000); close(b.payoutRatio, 0.5);
  close(b.meanNet, 50000); close(b.sdNet, 10000); close(b.meanAttendance, 40);

  /* October 2026, today Thu 1 Oct, nothing entered yet.
     Mondays 5, 12, 19, 26 → 4 × A.  Thursdays 1 (today — still projectable), 8, 15, 22, 29 → 5 × B.
     gross   4 × 2,000 + 5 × 1,000 = $13,000
     payout  4 × 1,200 + 5 ×   500 =  $7,300
     net                             $5,700
     attendance 4 × 100 + 5 × 40   =     600 */
  const m = f.months[0];
  assert.equal(m.projected.sessions, 9);
  assert.equal(m.actual.sessions, 0);
  close(m.total.gross, 1300000); close(m.total.payout, 730000);
  close(m.total.net, 570000); close(m.total.attendance, 600);
  assert.ok(f.projected.some((s) => s.date === '2026-10-01'), 'today with no data is projected');

  /* Range, night-to-night only (no drift passed).
     var = 4 × 1,000² + 5 × 100² = 4,050,000 $²  → σ = $2,012.4612
     half = 1.96 × 2,012.4612 = $3,944.4239
     low  = 13,000 − 3,944.42 = $9,055.58     high = $16,944.42 */
  assert.equal(Z_95, 1.96);
  close(m.range.gross.noise, 1.96 * Math.sqrt(4.05e10));
  assert.equal(Math.round(m.range.gross.low), 905558);
  assert.equal(Math.round(m.range.gross.high), 1694442);
  /* Net: var = 4 × 400² + 5 × 100² = 690,000 $² → half = 1.96 × 830.6624 = $1,628.10 */
  assert.equal(Math.round(m.range.net.high - m.total.net), 162810);

  /* Drivers: attendance +10 %, payout +2 pp.
     A: gross 2,000 × 1.1 = 2,200; ratio 0.62 → payout 1,364; net 836; attendance 110
     B: gross 1,000 × 1.1 = 1,100; ratio 0.52 → payout   572; net 528; attendance  44
     month gross  4 × 2,200 + 5 × 1,100 = $14,300
           payout 4 × 1,364 + 5 ×   572 =  $8,316
           net                              $5,984
           attendance 4 × 110 + 5 × 44   =     660 */
  const { f: g } = handForecast({ drivers: { att: 10, spend: 0, payout: 2 } });
  const gm = g.months[0];
  assert.equal(Math.round(gm.total.gross), 1430000);
  assert.equal(Math.round(gm.total.payout), 831600);
  assert.equal(Math.round(gm.total.net), 598400);
  assert.equal(Math.round(gm.total.attendance), 660);

  /* Expense mode: $20/h × 10 h = $200 staff, $100 fixed → $300 a session.
     9 sessions → $2,700. Profit = 5,700 − 2,700 = $3,000. Margin = 3,000 / 13,000 = 23.08 % */
  const assumptions = { staffCostPerHour: 2000, staffPerSession: 10, fixedPerSession: 10000 };
  const { f: e } = handForecast({ assumptions });
  const em = e.months[0];
  close(em.expenses.staff, 180000); close(em.expenses.fixed, 90000);
  assert.equal(em.expenses.cogs, null, 'no goods line without linked boxes');
  close(em.profit, 300000);
  close(em.margin, 3000 / 13000);
  close(e.totals.profit, 300000);
});

test('with no drivers a projected session is exactly its slot mean', () => {
  const { prep } = handForecast();
  const v = applyDrivers(prep.baselines.get(A));
  close(v.gross, 200000); close(v.payout, 120000); close(v.net, 80000); close(v.attendance, 100);
});

test('spend per player multiplies gross but not attendance', () => {
  const { prep } = handForecast();
  // A: 2,000 × 1.10 × 1.20 = 2,640; attendance 100 × 1.10 = 110
  const v = applyDrivers(prep.baselines.get(A), { att: 10, spend: 20, payout: 0 });
  close(v.gross, 264000); close(v.attendance, 110); close(v.payout, 264000 * 0.6);
});

test('the payout shift is clamped to a sane range', () => {
  assert.equal(normaliseDrivers({ payout: 50 }).payout, 10);
  assert.equal(normaliseDrivers({ payout: -50 }).payout, -10);
  assert.equal(normaliseDrivers({ att: 'abc' }).att, 0);
  const { prep } = handForecast();
  // Even at the limit the ratio cannot pass 100 % or fall below 0.
  const v = applyDrivers({ ...prep.baselines.get(A), payoutRatio: 0.97 }, { payout: 10 });
  close(v.payoutRatio, 1);
});

/* ---------------------------------------------------------------------------
   2. Missing days, the windowed pattern, the slot bar
--------------------------------------------------------------------------- */

test('a day more than one day past with no data is missing, not projected; yesterday is projected', () => {
  // Today Tue 6 Oct. Thu 1 Oct (5 days ago) has no data → missing.
  // Mon 5 Oct is yesterday → still projected (ingestion lag).
  const { f } = handForecast({ today: '2026-10-06' });
  assert.deepEqual(f.missing.map((s) => s.date), ['2026-10-01']);
  assert.ok(f.projected.some((s) => s.date === '2026-10-05'));
  assert.equal(f.months[0].missing, 1);
  // 4 Mondays (5, 12, 19, 26) + 4 Thursdays (8, 15, 22, 29)
  assert.equal(f.months[0].projected.sessions, 8);
  close(f.months[0].total.gross, 4 * 200000 + 4 * 100000, 'the missing night is not in the total');
});

test('a session that did happen is an actual, not missing', () => {
  const d = bundle([...HAND, ['2026-10-01', 'H1', 'regular', 1234, 600, 41]]);
  const rows = sessionRows(d.events, d);
  const prep = prepare(rows, { today: '2026-10-06', minSessions: 3 });
  const f = buildForecast({ rows, prep, months: ['2026-10'] });
  assert.equal(f.missing.length, 0);
  assert.equal(f.months[0].actual.sessions, 1);
  close(f.months[0].actual.gross, 123400);
});

test('a slot that stopped running is not projected forever', () => {
  // Slot C: Hall Two, Friday — eight Fridays in Jan–Feb 2026, then nothing.
  const fridays = ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23',
                   '2026-01-30', '2026-02-06', '2026-02-13', '2026-02-20'];
  const d = bundle([...HAND, ...fridays.map((x) => [x, 'H2', 'regular', 5000, 2500, 200])]);
  const rows = sessionRows(d.events, d);

  const prep = prepare(rows, { today: '2026-10-01' });
  assert.equal(prep.baselines.has('H2|5|regular'), false, 'outside the 13-week baseline window…');
  assert.equal(prep.running.has('H2|5|regular'), false, '…and not running');
  assert.ok(prep.stopped.some((s) => s.slot === 'H2|5|regular' && s.lastDate === '2026-02-20'));
  const f = buildForecast({ rows, prep, months: horizonMonths('12m', '2026-10-01') });
  assert.equal(f.projected.filter((s) => s.locationId === 'H2').length, 0);

  // And back when it WAS running, it is projected.
  const then = prepare(rows.filter((r) => r.date < '2026-02-21'), { today: '2026-02-21' });
  assert.ok(then.running.has('H2|5|regular'));
  assert.equal(RUNNING_WINDOW_WEEKS, 8);
  assert.equal(RUNNING_MIN_SESSIONS, 2);
});

test('one run in the window is not enough to count as running', () => {
  const d = bundle([['2026-09-29', 'H2', 'regular', 1000, 500, 10]]);
  const rows = sessionRows(d.events, d);
  const { running, stopped } = runningSlots(rows, { cutoff: dayNumber('2026-10-02') });
  assert.equal(running.size, 0);
  assert.equal(stopped.length, 1);
});

test('the real bar: a slot needs MIN_SLOT_SESSIONS before it is valued; short slots are unprojectable, not dropped', () => {
  const d = bundle(HAND);
  const rows = sessionRows(d.events, d);
  const prep = prepare(rows, { today: '2026-10-01' });
  assert.equal(MIN_SLOT_SESSIONS, 8);
  for (const b of prep.baselines.values()) assert.equal(b.usable, b.n >= MIN_SLOT_SESSIONS);
  const f = buildForecast({ rows, prep, months: ['2026-10'] });
  assert.equal(f.projected.length, 0);
  assert.equal(f.unprojectable.length, 9, 'every expected night is in the visible bucket');
  assert.equal(f.totals.unprojectable, 9);
  assert.equal(f.totals.gross, 0);
});

test('baselines use strictly earlier data and the trailing window', () => {
  const d = bundle([['2025-09-01', 'H1', 'regular', 9999, 0, 1], ...HAND]);
  const rows = sessionRows(d.events, d);
  const b = slotBaselines(rows, { cutoff: dayNumber('2026-09-28'), minSessions: 1 });
  // 2025-09-01 is more than 365 days before; 28 Sep itself is not before the cutoff.
  assert.equal(b.get(A).n, 2);
  close(b.get(A).meanGross, 150000);
});

/* ---------------------------------------------------------------------------
   3. The roster
--------------------------------------------------------------------------- */

test('roster: deployed and planned count, drafts are excluded and reported, the roster owns its day', () => {
  const d = bundle(HAND);
  const rows = sessionRows(d.events, d);
  const prep = prepare(rows, { today: '2026-10-01', minSessions: 3 });
  const { map } = hallMapFromLocations(LOCS);
  const ops = [
    { id: 'o1', hall_id: 'h1', session_date: '2026-10-10', part: 'PM', status: 'draft' },
    { id: 'o2', hall_id: 'h1', session_date: '2026-10-11', part: 'PM', status: 'planned' },
    { id: 'o3', hall_id: 'h1', session_date: '2026-10-12', part: 'PM', status: 'deployed' },
    { id: 'o4', hall_id: 'zz', session_date: '2026-10-13', part: 'PM', status: 'deployed' },
  ];
  const roster = rosterSessions(ops, {
    hallMap: map, fromDay: dayNumber('2026-10-01'), toDay: dayNumber('2026-10-31'), rows, cutoff: prep.cutoff,
  });
  assert.deepEqual(roster.excluded, { draft: 1 });
  assert.equal(roster.unmapped, 1);
  assert.equal(roster.sessions.length, 2);
  assert.equal(roster.lastDate, '2026-10-12');

  const f = buildForecast({ rows, prep, months: ['2026-10'], roster: roster.sessions });
  assert.equal(f.projected.filter((s) => s.date === '2026-10-10').length, 0, 'a draft adds nothing');
  const mon12 = f.projected.filter((s) => s.date === '2026-10-12');
  assert.equal(mon12.length, 1, 'roster and pattern do not double count');
  assert.equal(mon12[0].source, 'roster');
  assert.ok(f.unprojectable.some((s) => s.date === '2026-10-11'),
    'a planned Sunday with no Sunday history is unprojectable, and visible');
  assert.equal(f.sources.roster, 1);
  assert.equal(f.sources.pattern, 8);
});

test('REGRESSION: a hall with no late session keeps its roster nights (PM -> regular)', () => {
  const list = [];
  for (let i = 0; i < 12; i += 1) list.push([`2026-0${(i % 8) + 1}-0${(i % 9) + 1}`, 'H2', 'regular', 100, 50, 5]);
  const d = bundle(list);
  const rows = sessionRows(d.events, d);
  const { sessions } = rosterSessions([{ session_date: '2026-09-15', hall_id: 'h2', part: 'PM', status: 'deployed' }], {
    hallMap: new Map([['h2', 'H2']]), fromDay: dayNumber('2026-09-01'), toDay: dayNumber('2026-09-30'), rows,
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].type, 'regular');
});

test('a hall that runs a late session on that weekday maps a lone PM to late; two sessions go by order', () => {
  const d = bundle([
    ['2026-08-01', 'H1', 'regular', 100, 50, 5],
    ['2026-08-01', 'H1', 'late', 100, 50, 5],
  ]);
  const rows = sessionRows(d.events, d);
  const { sessions } = rosterSessions([
    { session_date: '2026-09-05', hall_id: 'h1', part: 'PM', status: 'deployed' },  // Saturday
    { session_date: '2026-09-06', hall_id: 'h1', part: 'AM', status: 'deployed' },  // Sunday
    { session_date: '2026-09-12', hall_id: 'h1', part: 'PM', status: 'planned' },   // Saturday, both
    { session_date: '2026-09-12', hall_id: 'h1', part: 'AM', status: 'planned' },
  ], { hallMap: new Map([['h1', 'H1']]), fromDay: dayNumber('2026-09-01'), toDay: dayNumber('2026-09-30'), rows });
  const by = (date) => sessions.filter((s) => s.date === date).map((s) => `${s.part}:${s.type}`);
  assert.deepEqual(by('2026-09-05'), ['PM:late']);
  assert.deepEqual(by('2026-09-06'), ['AM:regular']);
  assert.deepEqual(by('2026-09-12'), ['AM:regular', 'PM:late']);
});

test('REGRESSION: a partial roster does not truncate the projection', () => {
  const d = bundle(HAND);
  const rows = sessionRows(d.events, d);
  const prep = prepare(rows, { today: '2026-10-01', minSessions: 3 });
  const roster = [{ date: '2026-10-05', day: dayNumber('2026-10-05'), dow: 1, locationId: 'H1',
                    type: 'regular', slot: A, source: 'roster', status: 'deployed' }];
  const out = expectedSessions({ fromDay: dayNumber('2026-10-01'), toDay: dayNumber('2026-10-31'),
                                 running: prep.running, roster });
  assert.ok(out.some((s) => s.source === 'pattern' && s.date > '2026-10-05'),
    'days past the end of the roster are still projected');
});

test('Ops halls map to analytics locations by code, falling back to the shared name match', () => {
  assert.deepEqual([...hallMapFromLocations(LOCS).map], [['h1', 'H1'], ['h2', 'H2']]);
  const viaSettings = hallMapFromLocations([{ id: 'X', name: 'X', code: 'Q', settings: { ops_hall_id: 'x1' } }]);
  assert.equal(viaSettings.map.get('x1'), 'X');
  const byName = hallMapFromLocations([{ id: 'LS', name: 'Santa Clara' }, { id: 'LR', name: 'Redwood City' }]);
  assert.equal(byName.via, 'name');
  assert.equal(byName.map.get('sc'), 'LS');
  assert.equal(byName.map.get('rwc'), 'LR');
});

/* ---------------------------------------------------------------------------
   4. Slot toggles and horizons
--------------------------------------------------------------------------- */

test('switching a slot off removes its nights and counts them', () => {
  const { f } = handForecast({ off: new Set([A]) });
  assert.equal(f.months[0].projected.sessions, 5, 'only the Thursdays');
  close(f.totals.gross, 5 * 100000);
  assert.equal(f.switchedOff.length, 4);
  assert.equal(f.totals.switchedOff, 4);
});

test('horizon month boundaries, including the year end', () => {
  assert.deepEqual(horizonMonths('month', '2026-10-01'), ['2026-10']);
  assert.deepEqual(horizonMonths('3m', '2026-11-20'), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(horizonMonths('year', '2026-10-01'), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(horizonMonths('year', '2026-12-15'), ['2026-12']);
  const twelve = horizonMonths('12m', '2026-10-01');
  assert.equal(twelve.length, 12);
  assert.equal(twelve[11], '2027-09');
  assert.equal(monthEndDay('2026-12'), dayNumber('2026-12-31'));
  assert.equal(monthEndDay('2028-02'), dayNumber('2028-02-29'), 'leap year');
  assert.deepEqual(horizonMonths('nonsense', '2026-10-01'), ['2026-10']);

  // The walk crosses into January 2027 (1 Jan is a Friday):
  // Mondays 4, 11, 18, 25 and Thursdays 7, 14, 21, 28.
  const { f } = handForecast({ months: ['2026-12', '2027-01'] });
  const jan = f.months.find((m) => m.key === '2027-01');
  assert.equal(jan.index, 1);
  assert.equal(jan.projected.sessions, 8);
  close(jan.total.gross, 4 * 200000 + 4 * 100000);
  assert.ok(f.projected.some((s) => s.date === '2027-01-28'));
  assert.ok(f.projected.every((s) => s.date >= '2026-12-01' && s.date <= '2027-01-31'));
});

test('level drift widens the range and grows with months ahead', () => {
  const { rows, prep } = handForecast();
  const months = ['2026-10', '2026-11'];
  const plain = buildForecast({ rows, prep, months });
  const wide = buildForecast({ rows, prep, months, drift: { gross: 0.1, net: 0.1 } });
  const [o, n] = wide.months;
  // October: level = 0.10 × 13,000 × √1 = $1,300 → half = 1.96 × √(2,012.46² + 1,300²)
  close(o.range.gross.high - o.total.gross, 1.96 * Math.sqrt(4.05e10 + 130000 ** 2));
  // November: √2 months ahead
  close(n.range.gross.level, 1.96 * 0.1 * n.projected.gross * Math.SQRT2);
  assert.ok(wide.totals.range.gross.high > plain.totals.range.gross.high);
  // Across months the level part adds linearly, not in quadrature.
  close(wide.totals.range.gross.level, o.range.gross.level + n.range.gross.level);
});

/* ---------------------------------------------------------------------------
   5. Backtest
--------------------------------------------------------------------------- */

test('the backtest uses no data from the month it predicts', () => {
  // Hall One Mondays all year: $1,000 before September, $3,000 in September.
  const list = [];
  for (let day = dayNumber('2026-01-05'); day <= dayNumber('2026-09-28'); day += 7) {
    const date = new Date(day * 86400000).toISOString().slice(0, 10);
    list.push([date, 'H1', 'regular', date >= '2026-09-01' ? 3000 : 1000, 500, 100]);
  }
  const d = bundle(list);
  const rows = sessionRows(d.events, d);
  const bt = backtest(rows, { today: '2026-10-01', count: 1 });
  const sep = bt.months[0];
  assert.equal(sep.month, '2026-09');
  // September Mondays 7, 14, 21, 28 × the pre-September mean of $1,000 = $4,000
  assert.equal(sep.projected.sessions, 4);
  close(sep.projected.gross, 400000);
  close(sep.actual.gross, 1200000);
  close(sep.errGross, (400000 - 1200000) / 1200000);

  // Change September's actuals: the projection must not move.
  const changed = rows.map((r) => (r.date >= '2026-09-01' ? { ...r, gross: r.gross * 10, net: r.net * 10 } : r));
  const bt2 = backtest(changed, { today: '2026-10-01', count: 1 });
  close(bt2.months[0].projected.gross, 400000);
  close(bt2.months[0].actual.gross, 12000000);
});

test('backtest reports mean absolute error, range coverage and, with enough months, drift', () => {
  const list = [];
  for (let day = dayNumber('2025-03-03'); day <= dayNumber('2026-09-28'); day += 7) {
    const date = new Date(day * 86400000).toISOString().slice(0, 10);
    const wobble = (day % 3) * 100;
    list.push([date, 'H1', 'regular', 1000 + wobble + (date >= '2026-06-01' ? 400 : 0), 500, 100]);
  }
  const d = bundle(list);
  const rows = sessionRows(d.events, d);
  const bt = backtest(rows, { today: '2026-10-01' });
  // BACKTEST_MONTHS = 12: October 2025 to September 2026, December included.
  assert.equal(BACKTEST_MONTHS, 12);
  assert.equal(bt.months.length, 12);
  assert.equal(bt.months[0].month, '2025-10');
  assert.equal(bt.months[11].month, '2026-09');
  assert.ok(bt.months.some((m) => m.month === '2025-12'));
  const mae = bt.months.reduce((s, m) => s + Math.abs(m.errGross), 0) / 12;
  close(bt.maeGross, mae);
  assert.equal(bt.insideGross, bt.months.filter((m) => m.inRange.gross).length);
  assert.ok(bt.drift && bt.drift.gross > 0, 'a step change the noise does not explain shows up as drift');
  assert.ok(bt.insideWidenedGross >= bt.insideGross);
});

/* ---------------------------------------------------------------------------
   6. Scenarios
--------------------------------------------------------------------------- */

function fakeStore() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}
const throwing = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};

test('scenarios save, replace by name, load and delete', () => {
  resetScenarioMemory();
  const store = fakeStore();
  const s = { name: 'Close Mondays', drivers: { att: 5, spend: 0, payout: 1 }, off: [A],
              mode: 'expenses', horizon: 'year', hall: 'H1' };
  const r1 = saveScenario(s, store, { now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(r1.persisted, true);
  assert.ok(store.m.has(SCENARIO_KEY));
  resetScenarioMemory();
  const list = loadScenarios(store);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].drivers, { att: 5, spend: 0, payout: 1 });
  assert.deepEqual(list[0].off, [A]);
  assert.equal(list[0].mode, 'expenses');
  assert.equal(list[0].horizon, 'year');
  assert.equal(list[0].hall, 'H1');

  saveScenario({ ...s, drivers: { att: 9 } }, store);
  assert.equal(loadScenarios(store).length, 1, 'same name replaces');
  assert.equal(loadScenarios(store)[0].drivers.att, 9);

  saveScenario({ name: 'Upside', drivers: { att: 10 } }, store);
  assert.equal(loadScenarios(store).length, 2);
  const del = deleteScenario(list[0].id, store);
  assert.equal(del.persisted, true);
  assert.deepEqual(loadScenarios(store).map((x) => x.name), ['Upside']);
});

test('scenarios still work in-session when storage throws, and corrupt storage does not break them', () => {
  resetScenarioMemory();
  assert.deepEqual(loadScenarios(throwing), []);
  const r = saveScenario({ name: 'No storage', drivers: { att: -5 } }, throwing);
  assert.equal(r.persisted, false);
  assert.equal(loadScenarios(throwing).length, 1, 'kept in memory for the session');
  const d = deleteScenario(r.list[0].id, throwing);
  assert.equal(d.persisted, false);
  assert.equal(loadScenarios(throwing).length, 0);

  resetScenarioMemory();
  assert.deepEqual(loadScenarios({ getItem: () => '{not json' }), []);
  assert.deepEqual(loadScenarios(undefined), []);
  resetScenarioMemory();
});

test('params round-trip, with defaults left out of the link', () => {
  const p = forecastParams({ drivers: { att: 10, spend: 0, payout: -1.5 }, off: new Set([B, A]),
                             mode: 'expenses', horizon: '3m', hall: 'H1' });
  assert.deepEqual(p, { hall: 'H1', horizon: '3m', mode: 'expenses', att: 10, spend: undefined,
                        payout: -1.5, off: `${A},${B}`, open: undefined });
  const back = parseForecastParams(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === undefined ? undefined : String(v)])));
  assert.deepEqual(back.drivers, { att: 10, spend: 0, payout: -1.5 });
  assert.deepEqual([...back.off].sort(), [A, B]);
  assert.equal(back.mode, 'expenses');
  assert.equal(back.horizon, '3m');
  assert.deepEqual(forecastParams({}), { hall: undefined, horizon: undefined, mode: undefined,
    att: undefined, spend: undefined, payout: undefined, off: undefined, open: undefined });
  const withOpen = forecastParams({ open: new Set(['2026-11-26|H1|regular']) });
  assert.equal(withOpen.open, '2026-11-26|H1|regular');
  assert.deepEqual([...parseForecastParams(withOpen).open], ['2026-11-26|H1|regular']);
});

test('expenses and goods are aggregate lines, and the clock is read in the tenant timezone', () => {
  const e = expensesFor(2, { staffCostPerHour: 2500, staffPerSession: 60, fixedPerSession: 80000 },
    cogsPerSession(new Map([['a', { cost: 10000 }], ['b', { cost: 30000 }]])));
  close(e.staff, 2 * 60 * 2500); close(e.fixed, 160000); close(e.cogs, 40000);
  close(e.total, 300000 + 160000 + 40000);
  assert.equal(cogsPerSession(new Map()), null);
  // 03:00 UTC on 2 Oct is still the evening of 1 Oct in California.
  assert.equal(todayIso(new Date('2026-10-02T03:00:00Z'), 'America/Los_Angeles'), '2026-10-01');
  assert.equal(todayIso(new Date('2026-10-02T03:00:00Z'), null), '2026-10-02');
  assert.equal(todayIso(new Date('2026-10-02T03:00:00Z'), 'Not/AZone'), '2026-10-02');
});

/* ---------------------------------------------------------------------------
   7. The screen
--------------------------------------------------------------------------- */

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
function render(data, params = {}, { now = new Date('2026-10-06T18:00:00Z'), store = fakeStore() } = {}) {
  let inspectorHtml = '';
  const calls = [];
  const node = renderForecast({
    data, params, now, store,
    onNavigate: (route, p) => calls.push({ route, p }),
    setInspectorContent: (x) => { inspectorHtml = x; },
  });
  const holder = document.createElement('div');
  holder.innerHTML = inspectorHtml;
  return { node, inspector: holder, calls };
}

/** A year of weekly Mondays and Thursdays at Hall One, Fridays at Hall Two. */
function yearData(extra) {
  const list = [];
  for (let day = dayNumber('2025-09-01'); day <= dayNumber('2026-10-05'); day += 1) {
    const date = new Date(day * 86400000).toISOString().slice(0, 10);
    const dow = new Date(day * 86400000).getUTCDay();
    const w = (day % 5) * 100;
    if (dow === 1) list.push([date, 'H1', 'regular', 2000 + w, 1200, 100 + (day % 7)]);
    if (dow === 4) list.push([date, 'H1', 'regular', 1000 + w, 500, 40]);
    if (dow === 5) list.push([date, 'H2', 'regular', 1500 + w, 800, null]);
    if (dow === 6) list.push([date, 'H2', 'late', 800 + w, 400, 30]);
  }
  return bundle(list, extra);
}

test('screen renders for every horizon and mode without throwing or leaking raw values', () => {
  const data = yearData({ schedule: { ok: true, sessions: [
    { id: 'o1', hall_id: 'h1', session_date: '2026-10-12', part: 'PM', status: 'deployed' },
    { id: 'o2', hall_id: 'h1', session_date: '2026-10-15', part: 'PM', status: 'draft' },
  ] } });
  for (const hz of HORIZONS) {
    for (const mode of ['bingo', 'expenses']) {
      for (const hall of ['all', 'H1', 'H2']) {
        const { node, inspector } = render(data, { horizon: hz.id, mode, hall, att: '5', off: A });
        const text = inspect(node, `forecast ${hz.id}/${mode}/${hall}`);
        inspect(inspector, 'forecast inspector');
        assert.match(text, /How accurate has this been\?/);
        if (mode === 'expenses') assert.match(text, /assumed/);
      }
    }
  }
});

test('screen states its sources: roster vs pattern, and drafts excluded', () => {
  const data = yearData({ schedule: { ok: true, sessions: [
    { id: 'o1', hall_id: 'h1', session_date: '2026-10-12', part: 'PM', status: 'deployed' },
    { id: 'o2', hall_id: 'h1', session_date: '2026-10-15', part: 'PM', status: 'draft' },
  ] } });
  const text = inspect(render(data).node, 'sources');
  assert.match(text, /1 projected session come from it/);
  assert.match(text, /1 draft session is excluded/);
  const none = inspect(render(yearData()).node, 'no scheduler');
  assert.match(none, /scheduler is not connected/);
});

test('screen survives zero events and an all-zero dataset', () => {
  const empty = { ...bundle([]), schedule: { ok: false } };
  const { node, inspector } = render(empty);
  inspect(node, 'empty'); inspect(inspector, 'empty inspector');
  assert.match(node.textContent, /No sessions to forecast from/);
  const zeros = bundle(HAND.map(([d, l, t]) => [d, l, t, 0, 0, 0]));
  for (const mode of ['bingo', 'expenses']) inspect(render(zeros, { mode }).node, `zeros ${mode}`);
});

test('a slider recomputes live on input and commits to the link on change', () => {
  const data = yearData();
  const { node, calls } = render(data);
  const kpi = () => node.querySelector('.fc-kpis .kpi .kpi-value').textContent;
  const before = kpi();
  const slider = node.querySelector('input[type=range][data-key=att]');
  slider.value = '20';
  slider.dispatchEvent(new window.Event('input'));
  assert.notEqual(kpi(), before, 'the gross KPI moved');
  assert.equal(calls.length, 0, 'no navigation while dragging');
  assert.match(node.querySelector('.fc-delta').textContent, /\+\$/);
  slider.dispatchEvent(new window.Event('change'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, 'forecast');
  assert.equal(calls[0].p.att, 20);
});

test('a slot toggle removes the slot and commits it; reset goes back to baseline', () => {
  const { node, calls } = render(yearData(), { att: '10' });
  const box = node.querySelector('.panel input[type=checkbox]');
  box.checked = false;
  box.dispatchEvent(new window.Event('change'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].p.off, 'the switched-off slot is in the link');
  const reset = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Reset to baseline');
  reset.click();
  const last = calls[calls.length - 1].p;
  assert.equal(last.att, undefined);
  assert.equal(last.off, undefined);
});

test('saving a scenario with no storage still lists it in the comparison', () => {
  resetScenarioMemory();
  const { node } = render(yearData(), { att: '10' }, { store: throwing });
  const form = node.querySelector('.fc-save');
  form.querySelector('input').value = 'Ten per cent up';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  const table = node.querySelector('.fc-compare');
  assert.match(table.textContent, /Ten per cent up/);
  assert.match(table.textContent, /Baseline/);
  assert.match(node.textContent, /last until this tab is closed/);
  inspect(node, 'after save');
  resetScenarioMemory();
});

test('the screen reads today from the clock, not from the last data date', () => {
  // Data ends 5 Oct; on 20 Oct the gap is called out and past nights are missing.
  const { node } = render(yearData(), {}, { now: new Date('2026-10-20T18:00:00Z') });
  const text = inspect(node, 'stale');
  assert.match(text, /Nothing has been entered since/);
  assert.match(text, /missing or not yet entered/);
});

/* ---------------------------------------------------------------------------
   8. Holidays — closures learned from the data
--------------------------------------------------------------------------- */

test('HAND: holiday calendar — Easter computus and the floating holidays', () => {
  // Computus (Meeus/Jones/Butcher), 2026: a=12 b=20 c=26 d=5 e=0 f=1 g=6
  //   h=(19·12+20−5−6+15)%30 = 252%30 = 12;  i=6 k=2;  l=(32+0+12−12−2)%7 = 30%7 = 2
  //   m=⌊(12+132+44)/451⌋ = 0;  month=⌊(12+2+114)/31⌋ = 4;  day=(128%31)+1 = 5  → 5 April
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2025), '2025-04-20');
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2024), '2024-03-31');
  const y26 = Object.fromEntries(holidaysForYear(2026).map((x) => [x.key, x.date]));
  // 1 Nov 2026 is a Sunday → Thursdays 5, 12, 19, 26 → the fourth is the 26th.
  assert.equal(y26.thanksgiving, '2026-11-26');
  assert.equal(holidaysForYear(2025).find((x) => x.key === 'thanksgiving').date, '2025-11-27');
  // 1 May 2026 is a Friday → Sundays 3, 10 → Mother's Day the 10th.
  assert.equal(y26.mothers, '2026-05-10');
  // 31 May 2026 is a Sunday → last Monday the 25th.
  assert.equal(y26.memorial, '2026-05-25');
  // 1 Jun 2026 is a Monday → Sundays 7, 14, 21 → Father's Day the 21st.
  assert.equal(y26.fathers, '2026-06-21');
  // 1 Sep 2026 is a Tuesday → first Monday the 7th.
  assert.equal(y26.labor, '2026-09-07');
  assert.equal(y26.july4, '2026-07-04');
  assert.equal(holidaysForYear(2026).length, 11);
  assert.equal(holidayOn('2026-12-24').name, 'Christmas Eve');
  assert.equal(holidayOn('2026-12-23'), null);
});

/** Weekly sessions on one weekday, $1,000 gross / $500 prizes, skipping some dates. */
function weekly(from, to, hall, skip = []) {
  const out = [];
  for (let day = dayNumber(from); day <= dayNumber(to); day += 7) {
    const date = new Date(day * 86400000).toISOString().slice(0, 10);
    if (!skip.includes(date)) out.push([date, hall, 'regular', 1000, 500, 100]);
  }
  return out;
}

/*
   Hall One runs every Thursday from 4 Sep 2025 and was dark on Thanksgiving
   (Thu 27 Nov 2025). Hall Two runs every Thursday and opened on Thanksgiving.
   Christmas Eve 2025 was a Wednesday, when neither hall runs — no evidence.
*/
const HOLIDAY_ROWS = [
  ...weekly('2025-09-04', '2026-09-24', 'H1', ['2025-11-27']),
  ...weekly('2025-09-04', '2026-09-24', 'H2'),
];

test('holiday evidence: closed, held and no-slot, per hall', () => {
  const d = bundle(HOLIDAY_ROWS);
  const rows = sessionRows(d.events, d);
  const ev = holidayEvidence(rows, { before: dayNumber('2026-10-02') });
  assert.deepEqual(ev.get('thanksgiving|H1').history, [{ date: '2025-11-27', outcome: 'closed' }]);
  assert.deepEqual(ev.get('thanksgiving|H1').latest, { date: '2025-11-27', outcome: 'closed' });
  assert.equal(ev.get('thanksgiving|H2').latest.outcome, 'held');
  assert.deepEqual(ev.get('xmaseve|H1').history, [{ date: '2025-12-24', outcome: 'no-slot' }]);
  assert.equal(ev.get('xmaseve|H1').latest, null);
  // Christmas Day and New Year's Day 2025/26 were Thursdays and both halls opened.
  assert.equal(ev.get('xmas|H1').latest.outcome, 'held');
  assert.equal(ev.get('newyear|H1').latest.outcome, 'held');
});

test('HAND: a night closed last year is not projected; held last year is; no history is projected and marked', () => {
  const d = bundle(HOLIDAY_ROWS);
  const rows = sessionRows(d.events, d);
  const prep = prepare(rows, { today: '2026-10-01' });

  /* November 2026, Thursdays 5, 12, 19, 26 at each hall.
     Hall One: closed last Thanksgiving → 26 Nov not projected → 3 × $1,000 = $3,000.
     Hall Two: opened last Thanksgiving → 4 × $1,000 = $4,000. */
  const nov = buildForecast({ rows, prep, months: ['2026-11'] });
  assert.deepEqual(nov.closed.map((s) => `${s.date}|${s.locationId}`), ['2026-11-26|H1']);
  assert.equal(nov.closed[0].holiday.name, 'Thanksgiving');
  assert.equal(nov.closed[0].holiday.lastDate, '2025-11-27');
  assert.equal(nov.months[0].closed, 1);
  assert.equal(nov.totals.closed, 1);
  const h1 = nov.projected.filter((s) => s.locationId === 'H1');
  const h2 = nov.projected.filter((s) => s.locationId === 'H2');
  assert.equal(h1.length, 3); assert.equal(h2.length, 4);
  close(h1.reduce((a, s) => a + s.gross, 0), 300000);
  close(nov.totals.gross, 700000);
  const h2thanks = h2.find((s) => s.date === '2026-11-26');
  assert.equal(h2thanks.holiday.history, 'held');

  /* December 2026: Christmas Eve is a Thursday. Last Christmas Eve was a
     Wednesday — no slot, no evidence — so both halls are projected and marked.
     Thursdays 3, 10, 17, 24, 31 → 5 a hall (New Year's Eve: no evidence either). */
  const dec = buildForecast({ rows, prep, months: ['2026-12'] });
  assert.equal(dec.closed.length, 0);
  assert.equal(dec.projected.length, 10);
  const eve = dec.projected.filter((s) => s.date === '2026-12-24');
  assert.equal(eve.length, 2);
  assert.ok(eve.every((s) => s.holiday.history === 'none' && s.holiday.name === 'Christmas Eve'));

  /* Re-opened by the user: back to 4 × $1,000 at Hall One. */
  const reopened = buildForecast({ rows, prep, months: ['2026-11'], open: new Set(['2026-11-26|H1|regular']) });
  assert.equal(reopened.closed.length, 0);
  close(reopened.totals.gross, 800000);
  assert.equal(reopened.projected.find((s) => s.date === '2026-11-26' && s.locationId === 'H1').holiday.reopened, true);

  /* A scheduled session beats last year's closure. */
  const roster = [{ date: '2026-11-26', day: dayNumber('2026-11-26'), dow: 4, locationId: 'H1',
                    type: 'regular', slot: 'H1|4|regular', source: 'roster', status: 'deployed' }];
  const sched = buildForecast({ rows, prep, months: ['2026-11'], roster });
  assert.equal(sched.closed.length, 0);
});

test('the backtest learns holidays only from before the month it tests', () => {
  // As of 1 Nov 2025 there is no earlier Thanksgiving in the data, so the
  // backtest projects Hall One's 27 Nov — and then it does not happen.
  const d = bundle(HOLIDAY_ROWS);
  const rows = sessionRows(d.events, d);
  const bt = backtest(rows, { today: '2025-12-01', count: 1 });
  assert.equal(bt.months[0].month, '2025-11');
  assert.equal(bt.months[0].projected.closed, 0);
  assert.equal(bt.months[0].projected.sessions, 8, 'Thursdays 6, 13, 20, 27 at two halls');
  assert.equal(bt.months[0].actual.sessions, 7);

  // With a year more history — Hall One also dark on Thanksgiving 2024 — it learns.
  const longer = bundle([...weekly('2024-09-05', '2025-08-28', 'H1', ['2024-11-28']), ...HOLIDAY_ROWS]);
  const rows2 = sessionRows(longer.events, longer);
  const bt2 = backtest(rows2, { today: '2025-12-01', count: 1 });
  assert.equal(bt2.months[0].projected.closed, 1);
  assert.deepEqual(bt2.months[0].projected.closedNights,
    [{ date: '2025-11-27', locationId: 'H1', holiday: 'Thanksgiving' }]);
  assert.equal(bt2.months[0].projected.sessions, 7);
  assert.equal(bt2.months[0].errGross, 0, 'and so it is exact');
});

test('screen: a closed holiday night is listed and can be re-opened through the link', () => {
  const data = bundle(HOLIDAY_ROWS);
  const { node, calls } = render(data, { horizon: '3m' }, { now: new Date('2026-10-01T18:00:00Z') });
  const text = inspect(node, 'holidays');
  assert.match(text, /Holidays in this period/);
  assert.match(text, /Regular session not held last Thanksgiving/);
  assert.match(text, /holiday, no history/);
  assert.match(text, /1 closed for holidays/);
  const box = [...node.querySelectorAll('input[type=checkbox]')]
    .find((b) => /Thanksgiving/.test(b.getAttribute('aria-label') ?? ''));
  assert.ok(box, 'a closed night has an Open switch');
  box.checked = true;
  box.dispatchEvent(new window.Event('change'));
  assert.equal(calls[calls.length - 1].p.open, '2026-11-26|H1|regular');
});

test('HAND: per session — a late session dropped last Mother\'s Day is closed, the regular one is projected', () => {
  /* Hall One runs Sunday regular AND late every week from 7 Sep 2025. On
     Mother's Day 2026 (Sun 10 May) it held the regular session only.
     Mother's Day 2027: 1 May 2027 is a Saturday → Sundays 2, 9 → the 9th.
     May 2027 Sundays: 2, 9, 16, 23, 30 → 5 regular, 5 late expected.
       regular: held last Mother's Day → all 5 projected ($1,000 each)
       late:    not held last Mother's Day → 9 May closed, 4 projected
     gross = 5 × 1,000 + 4 × 1,000 = $9,000 */
  const late = weekly('2025-09-07', '2026-09-27', 'H1', ['2026-05-10']).map(([d, l]) => [d, l, 'late', 1000, 500, 80]);
  const d = bundle([...weekly('2025-09-07', '2026-09-27', 'H1'), ...late]);
  const rows = sessionRows(d.events, d);
  assert.equal(holidaysForYear(2027).find((x) => x.key === 'mothers').date, '2027-05-09');

  const ev = holidayEvidence(rows);
  assert.equal(ev.get('mothers|H1').latest.outcome, 'held', 'the hall as a whole opened');
  assert.equal(ev.get('mothers|H1|regular').latest.outcome, 'held');
  assert.deepEqual(ev.get('mothers|H1|late').latest, { date: '2026-05-10', outcome: 'closed' });

  const prep = prepare(rows, { today: '2026-10-01' });
  const may = buildForecast({ rows, prep, months: ['2027-05'] });
  assert.deepEqual(may.closed.map((s) => `${s.date}|${s.type}`), ['2027-05-09|late']);
  assert.equal(may.closed[0].holiday.level, 'session');
  const reg = may.projected.find((s) => s.date === '2027-05-09' && s.type === 'regular');
  assert.equal(reg.holiday.history, 'held');
  assert.equal(reg.holiday.level, 'session');
  assert.equal(may.projected.length, 9);
  close(may.totals.gross, 900000);

  // Hall-level fallback: a session type with no record of its own uses the hall.
  const thanks = bundle(HOLIDAY_ROWS);
  const tr = sessionRows(thanks.events, thanks);
  const nov = buildForecast({ rows: tr, prep: prepare(tr, { today: '2026-10-01' }), months: ['2026-11'] });
  assert.equal(nov.closed[0].holiday.level, 'session', 'Thanksgiving: the same regular slot was not held');

  // Re-opening is per session: opening the late session leaves the regular one alone.
  const reopened = buildForecast({ rows, prep, months: ['2027-05'], open: new Set(['2027-05-09|H1|late']) });
  assert.equal(reopened.closed.length, 0);
  close(reopened.totals.gross, 1000000);

  // And on screen it reads per session.
  const { node } = render(d, { horizon: '12m' }, { now: new Date('2026-10-01T18:00:00Z') });
  const text = inspect(node, 'per-session holiday');
  assert.match(text, /Late session not held last Mother's Day/);
  assert.match(text, /Regular session held last Mother's Day/);
});

test('hall-level evidence is the fallback when the session type has no record', () => {
  // Hall Two only ever ran a regular session, and closed last Thanksgiving.
  // A late session that started since has no Thanksgiving record of its own,
  // so it inherits the hall's closure.
  const rowsIn = [
    ...weekly('2025-09-04', '2026-09-24', 'H2', ['2025-11-27']),
    ...weekly('2026-06-04', '2026-09-24', 'H2').map(([dd, l]) => [dd, l, 'late', 600, 300, 50]),
  ];
  const d = bundle(rowsIn);
  const rows = sessionRows(d.events, d);
  const f = buildForecast({ rows, prep: prepare(rows, { today: '2026-10-01' }), months: ['2026-11'] });
  const byType = Object.fromEntries(f.closed.map((s) => [s.type, s.holiday.level]));
  assert.deepEqual(byType, { regular: 'session', late: 'hall' });
});
