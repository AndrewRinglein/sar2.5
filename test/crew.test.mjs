/* ============================================================================
   Crew from the data validator — server read, crew model, Managers sources,
   Staff "Worked", session crew line, Sources, and the forecast's
   owner-confirmed closure.

   Fixtures only. Every person below is invented; no real staff name appears
   in this file. Hall codes SC / RWC and the 13:00 / 18:30 session times are
   the production shapes, because the join is what is under test.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  VALIDATOR_COLUMNS, VALIDATOR_FORBIDDEN, VALIDATOR_STATE_PATHS, projectValidatorRow,
  assertNoPayColumns,
} from '../src/lib/ops-schema.js';
import { VALIDATOR_SQL, readOperations, readValidator } from '../server/database.mjs';
import { createLocalApi } from '../server/local-api.mjs';
import { getSchedule } from '../src/lib/ops.js';
import {
  cleanName, nameKey, normaliseValidator, pickSessions, buildIdentities, possibleDuplicates,
  joinValidator, managerCrew, buildCrewModel, mergeCrewSources, buildWorked, scheduledVsWorked,
  latestValidatorPeriod, minutesOf, buildNameMerge, ruleKey, nameParts, fullCrew, schedulerSourcedUses,
} from '../src/lib/crew-model.js';
import { buildManagerModel, dayNumber } from '../src/lib/managers.js';
import {
  hallMapFromLocations, sessionRows, prepare, buildForecast, horizonMonths, monthStartDay,
  resolveOwnerClosures, holidayKeyOf, rosterSessions, monthEndDay,
} from '../src/lib/forecast-model.js';
import { OWNER_CLOSURES, OWNER_NAME_RULE, OWNER_NAME_KEEP_APART, OWNER_NAME_ALIASES } from '../src/lib/config.js';
import { indexMetrics } from '../src/lib/model.js';

const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;

const { renderStaff } = await import('../src/screens/staff.js');
const { renderManagers, makeValuesOf } = await import('../src/screens/managers.js');
const { renderSession } = await import('../src/screens/session.js');
const { renderSources, sourceList } = await import('../src/screens/sources.js');
const { renderForecast } = await import('../src/screens/forecast.js');

/* ---------------------------------------------------------------------------
   Shared fixture
--------------------------------------------------------------------------- */

const LOCS = [
  { id: 'LS', name: 'Santa Clara', code: 'SC', settings: {} },
  { id: 'LR', name: 'Redwood City', code: 'RWC', settings: {} },
];
const HALLS = hallMapFromLocations(LOCS).map;
const ROLES = [
  { id: 'r-mod', name: 'MOD' }, { id: 'r-pay', name: 'Paymaster' }, { id: 'r-fm', name: 'Flash Manager' },
  { id: 'r-call', name: 'Callers/Strip' }, { id: 'r-run', name: 'Flash Runners' },
  { id: 'r-open', name: 'Opener/Swing Shift' },
];
const STAFF = [
  { id: 's1', name: 'Robin Vale' }, { id: 's2', name: 'Quinn' }, { id: 's3', name: 'Quinn' },
  { id: 's4', name: 'Jo Finch' }, { id: 's5', name: 'Max Tern' },
];

let vid = 0;
/** A validator row as the server projects it. crew: [name, role, slot]. */
const vrow = (hall, date, time, crew, staffStatus = 'approved', extra = {}) => ({
  id: `v${++vid}`, hall_id: hall, session_date: date, session_time: time, slot_name: `${hall} slot`,
  status: 'closed', closed_at: null, updated_at: `${date}T23:00:00Z`, staff_status: staffStatus,
  crew: crew.map(([name, role, slot = 0]) => ({ name, role, slot })),
  commission_rate: '0.15', commission_target: '400', ...extra,
});

const FORBIDDEN_TEXT = [/\bNaN\b/, /\bundefined\b/, /\bnull\b/, /\bInfinity\b/, /\[object \w+\]/];
function inspect(node, label) {
  const text = node.textContent.replace(/\s+/g, ' ');
  for (const re of FORBIDDEN_TEXT) assert.ok(!re.test(text), `${label}: rendered ${re} — ${text.slice(0, 200)}`);
  return text;
}
function render(fn, data, params = {}, nav = () => {}) {
  let inspector = '';
  const node = fn({ data, params, onNavigate: nav, setInspectorContent: (x) => { inspector = x; } });
  return { node, inspector };
}

/* ---------------------------------------------------------------------------
   1. The server read: projection and allowlist
--------------------------------------------------------------------------- */

test('validator SQL selects only the allowlisted fields and never a whole jsonb column', () => {
  for (const col of VALIDATOR_FORBIDDEN.filter((c) => c !== 'state')) {
    assert.doesNotMatch(VALIDATOR_SQL, new RegExp(`\\b${col}\\b`), `${col} must not be selected`);
  }
  // Every reference to `state` goes through #> / #>> with an allowlisted path.
  const refs = [...VALIDATOR_SQL.matchAll(/r\.state\b(.{0,30})/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4);
  const allowed = Object.values(VALIDATOR_STATE_PATHS).map((p) => `'{${p.join(',')}}'`);
  for (const r of refs) {
    const m = /^\s*#>>?\s*('\{[^}]*\}')/.exec(r);
    assert.ok(m, `state reached without a path: "state${r}"`);
    assert.ok(allowed.includes(m[1]), `state path ${m[1]} is not allowlisted`);
  }
  assert.doesNotMatch(VALIDATOR_SQL, /SELECT \*|r\.state\s*(,|AS|\n|$)/);
  // The crew array is rebuilt with name, role and slot only.
  assert.match(VALIDATOR_SQL, /jsonb_build_object\('name', e\.value ->> 'name', 'role', e\.value ->> 'role', 'slot', e\.value ->> 'slot'\)/);
  assert.doesNotMatch(VALIDATOR_SQL, /e\.value -> '/, 'no crew field is selected as jsonb');
  for (const c of VALIDATOR_COLUMNS) assert.match(VALIDATOR_SQL, new RegExp(`\\b${c}\\b`));
});

test('the projection strips anything outside the allowlist, row and crew alike', () => {
  const out = projectValidatorRow({
    ...vrow('sc', '2026-08-12', '18:30', [['Pat Ember', 'MOD']]),
    state: { cash: 1 }, figures: { x: 1 }, totals: {}, payout_lines: [], hotball_ledger: [],
    crew: [{ name: 'Pat Ember', role: 'MOD', slot: 0, cash: 500, note: 'x' }],
  });
  assert.deepEqual(Object.keys(out).sort(), [...VALIDATOR_COLUMNS].sort());
  assert.deepEqual(out.crew, [{ name: 'Pat Ember', role: 'MOD', slot: 0 }]);
  assert.equal(assertNoPayColumns(), true, 'the default check includes the validator projection');
  assert.throws(() => assertNoPayColumns({ recon_sessions: 'id,hourly_rate' }), /forbidden/);
});

test('a crew slot is an integer or null — a nested object can never pass through', () => {
  const crewOf = (slot, extra = {}) => projectValidatorRow({ ...vrow('sc', '2026-08-12', '18:30', []),
    crew: [{ name: 'Pat', role: 'MOD', slot, ...extra }] }).crew[0];
  // The SQL now reads slot as text, so the common case is a numeric string.
  assert.equal(crewOf('3').slot, 3);
  assert.equal(crewOf(0).slot, 0);
  for (const bad of [{ cash: 500 }, [1], '2.5', '', 'x', null, undefined, '1e400', true]) {
    assert.equal(crewOf(bad).slot, null, `slot ${JSON.stringify(bad)}`);
  }
  // Name and role are text or nothing, never an object.
  const odd = projectValidatorRow({ ...vrow('sc', '2026-08-12', '18:30', []),
    crew: [{ name: { first: 'Pat' }, role: ['MOD'], slot: '1' }] }).crew[0];
  assert.deepEqual(odd, { name: null, role: null, slot: 1 });
});

test('operations reads the validator in the same read-only snapshot, behind a savepoint', async () => {
  const queries = [];
  const result = await readOperations({ connect: async () => ({
    query: async (sql) => {
      queries.push(sql);
      if (sql === VALIDATOR_SQL) {
        return { rows: [{ ...vrow('sc', '2026-08-12', '18:30', [['Pat Ember', 'MOD']]), state: { cash: 9 } }] };
      }
      return { rows: [] };
    },
    release: () => {},
  }) });
  assert.equal(result.validator.ok, true);
  assert.equal(result.validator.rows.length, 1);
  assert.equal(result.validator.rows[0].state, undefined, 'state never reaches the browser');
  assert.match(queries[0], /READ ONLY/);
  assert.ok(queries.includes('SAVEPOINT validator'));
  assert.equal(queries.at(-1), 'COMMIT');
});

test('a validator failure degrades: the rest of Operations still loads', async () => {
  const queries = [];
  const warn = console.warn; console.warn = () => {};
  try {
    const result = await readOperations({ connect: async () => ({
      query: async (sql) => {
        queries.push(sql);
        if (sql === VALIDATOR_SQL) throw Error('relation "recon_sessions" does not exist');
        return { rows: sql.includes('sched_staff') ? [{ id: 's1' }] : [] };
      },
      release: () => {},
    }) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.staff, [{ id: 's1' }]);
    assert.deepEqual(result.validator, { ok: false, rows: [] });
    assert.ok(queries.includes('ROLLBACK TO SAVEPOINT validator'));
    assert.equal(queries.at(-1), 'COMMIT');
    assert.doesNotMatch(JSON.stringify(result), /does not exist/);
  } finally { console.warn = warn; }
});

test('readValidator never throws, even when the savepoint itself fails', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await readValidator({ query: async () => { throw Error('down'); } });
    assert.deepEqual(r, { ok: false, rows: [] });
  } finally { console.warn = warn; }
});

test('the browser adapter falls back with the validator marked not connected', async () => {
  const bad = await getSchedule({ request: async () => { throw Error('x'); } });
  assert.deepEqual(bad.validator, { ok: false, rows: [] });
  const api = createLocalApi({ pool: {}, authenticate: async () => 'viewer',
    loadOperations: async () => ({ ok: true, staff: [], validator: { ok: false, rows: [] } }) });
  let body;
  const { Readable } = await import('node:stream');
  const req = Readable.from([]);
  Object.assign(req, { url: '/api/operations', method: 'GET', headers: { authorization: 'Bearer t', host: 'h' } });
  await api(req, { setHeader() {}, end(t) { body = JSON.parse(t); } }, () => {});
  assert.deepEqual(body.validator, { ok: false, rows: [] });
});

/* ---------------------------------------------------------------------------
   2. Names and identities
--------------------------------------------------------------------------- */

test('names are trimmed, spaces collapsed and case-folded for matching only', () => {
  assert.equal(cleanName('  Robin   VALE '), 'Robin VALE');
  assert.equal(nameKey('  Robin   VALE '), 'robin vale');
  assert.equal(cleanName(null), '');
  assert.equal(minutesOf('18:30:00'), 1110);
});

test('the display form is the most frequent spelling', () => {
  const s = normaliseValidator([
    vrow('sc', '2026-08-12', '18:30', [['ari lune', 'Callers/Strip']]),
    vrow('sc', '2026-08-13', '18:30', [['Ari Lune', 'Callers/Strip']]),
    vrow('sc', '2026-08-14', '18:30', [['Ari  Lune ', 'Callers/Strip']]),
  ]);
  const ids = buildIdentities(s, STAFF);
  const ari = ids.get('ari lune');
  assert.equal(ari.display, 'Ari Lune');
  assert.equal(ari.entries, 3);
  assert.equal(ari.match, 'none');
  assert.equal(ari.id, 'v:ari lune');
});

test('a name maps to a scheduler person only on an exact AND unique match', () => {
  const s = normaliseValidator([vrow('sc', '2026-08-12', '18:30', [
    ['robin  vale', 'MOD'], ['Quinn', 'Paymaster'], ['Robin', 'Flash Manager'], ['jo finch', 'Callers/Strip'],
  ])]);
  const ids = buildIdentities(s, STAFF);
  assert.equal(ids.get('robin vale').staffId, 's1');
  assert.equal(ids.get('robin vale').name, 'Robin Vale', 'a matched person reads as the scheduler names them');
  assert.equal(ids.get('quinn').match, 'ambiguous', 'two scheduler staff named Quinn');
  assert.equal(ids.get('quinn').staffId, null);
  assert.equal(ids.get('robin').match, 'none', 'a first name alone is never mapped');
  assert.equal(ids.get('robin').id, 'v:robin');
  assert.equal(ids.get('jo finch').staffId, 's4');
});

test('possible duplicates: one-word name = first word of exactly one longer name, same hall and role', () => {
  const s = normaliseValidator([
    vrow('sc', '2026-08-12', '18:30', [['Pat', 'Flash Runners'], ['Lee', 'Callers/Strip'], ['Sky', 'Paymaster']]),
    vrow('sc', '2026-08-13', '18:30', [['Pat Ember', 'Flash Runners'], ['Lee Ash', 'Callers/Strip'],
      ['Lee Birch', 'Callers/Strip']]),
    vrow('rwc', '2026-08-13', '18:30', [['Sky Morrow', 'Paymaster']]),
  ]);
  const d = possibleDuplicates(s, buildIdentities(s, STAFF));
  assert.equal(d.length, 1);
  assert.equal(d[0].short.name, 'Pat');
  assert.equal(d[0].long.name, 'Pat Ember');
  assert.deepEqual(d[0].where, [{ hall: 'sc', role: 'Flash Runners', shortEntries: 1, longEntries: 1 }]);
  // "Lee" has two candidates; "Sky" and "Sky Morrow" are at different halls.
});

test('a pair the scheduler knows as two people is not suggested', () => {
  const staff = [{ id: 'a', name: 'Kit' }, { id: 'b', name: 'Kit Rowe' }];
  const s = normaliseValidator([vrow('sc', '2026-08-12', '18:30', [['Kit', 'MOD'], ['Kit Rowe', 'MOD', 1]])]);
  assert.equal(possibleDuplicates(s, buildIdentities(s, staff)).length, 0);
});

/* ---------------------------------------------------------------------------
   3. The join to analytics
--------------------------------------------------------------------------- */

const ev = (id, loc, date, type = 'regular') => ({ id, location_id: loc, event_date: date, event_type: type });

test('SC weekend: 13:00 joins the regular session and 18:30 the late one', () => {
  const s = normaliseValidator([
    vrow('sc', '2026-08-15', '18:30', [['Max Tern', 'MOD']]),
    vrow('sc', '2026-08-15', '13:00', [['Robin Vale', 'MOD']]),
    vrow('rwc', '2026-08-18', '18:30', [['Jo Finch', 'MOD']]),
  ]);
  const { links, report } = joinValidator(s,
    [ev('late', 'LS', '2026-08-15', 'late'), ev('reg', 'LS', '2026-08-15'), ev('tue', 'LR', '2026-08-18')], HALLS);
  assert.equal(links.get('reg').time, '13:00');
  assert.equal(links.get('late').time, '18:30');
  assert.equal(links.get('tue').hall, 'rwc', 'a weekday 18:30 is the regular session');
  assert.equal(report.matched, 3);
});

test('the count guard: one validator session against two results is skipped, not guessed', () => {
  const s = normaliseValidator([
    vrow('sc', '2026-08-22', '13:00', [['Robin Vale', 'MOD']]),
    vrow('rwc', '2026-08-23', '18:30', [['Jo Finch', 'MOD']]),
    vrow('xx', '2026-08-23', '18:30', [['Jo Finch', 'MOD']]),
  ]);
  const { links, report } = joinValidator(s,
    [ev('a', 'LS', '2026-08-22'), ev('b', 'LS', '2026-08-22', 'late')], HALLS);
  assert.equal(links.size, 0);
  assert.deepEqual(report.mismatched, [{ date: '2026-08-22', locationId: 'LS', hall: 'sc', validator: 1, events: 2 }]);
  assert.deepEqual(report.unmatched.map((u) => u.reason).sort(), ['count', 'hall', 'no-results']);
});

test('one row per session: the approved row wins over a newer one still in progress', () => {
  const rows = normaliseValidator([
    vrow('sc', '2026-08-12', '18:30', [['Max Tern', 'MOD']], 'progress', { updated_at: '2026-08-14T00:00:00Z' }),
    vrow('sc', '2026-08-12', '18:30', [['Robin Vale', 'MOD']], 'approved', { updated_at: '2026-08-13T00:00:00Z' }),
  ]);
  const { sessions, superseded } = pickSessions(rows);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].crew[0].name, 'Robin Vale');
  assert.equal(superseded.length, 1);
});

test('where a role lists two people the first by slot is credited, and the extra is counted', () => {
  const [s] = normaliseValidator([vrow('sc', '2026-08-12', '18:30', [['Max Tern', 'MOD', 1], ['Robin Vale', 'MOD', 0]])]);
  const m = managerCrew(s, buildIdentities([s], STAFF));
  assert.deepEqual(m.MOD, { staffId: 's1', name: 'Robin Vale', extra: 1 });
});

/* ---------------------------------------------------------------------------
   4. Crew source precedence and the Managers model
--------------------------------------------------------------------------- */

test('crew source: validator first, scheduler second, progress flagged, empty crew falls back', () => {
  const crew = buildCrewModel({ validator: { ok: true, rows: [
    vrow('sc', '2026-08-03', '18:30', [['Max Tern', 'MOD']]),
    vrow('sc', '2026-08-04', '18:30', [['Max Tern', 'MOD']], 'progress'),
    vrow('sc', '2026-08-05', '18:30', [['  ', 'MOD']]),
  ] }, staff: STAFF, hallMap: HALLS,
  events: [ev('e3', 'LS', '2026-08-03'), ev('e4', 'LS', '2026-08-04'), ev('e5', 'LS', '2026-08-05'),
    ev('e6', 'LS', '2026-08-06'), ev('e7', 'LS', '2026-08-07')] });
  const sched = new Map([['e3', { MOD: { staffId: 's1', name: 'Robin Vale' } }],
    ['e5', { MOD: { staffId: 's1', name: 'Robin Vale' } }], ['e6', { MOD: { staffId: 's1', name: 'Robin Vale' } }]]);
  const events = [ev('e3', 'LS', '2026-08-03'), ev('e4', 'LS', '2026-08-04'), ev('e5', 'LS', '2026-08-05'),
    ev('e6', 'LS', '2026-08-06'), ev('e7', 'LS', '2026-08-07'), ev('e9', 'LS', '2026-09-30')];
  const m = mergeCrewSources({ events, schedCrew: sched, crew });
  assert.equal(m.crewOf.get('e3').MOD.staffId, 's5', 'validator beats the scheduler');
  assert.deepEqual(m.sourceOf.get('e4'), { source: 'validator', approved: false,
    sessionId: crew.byEvent.get('e4').session.id, sessionStatus: 'closed', closedAt: null });
  assert.equal(m.sourceOf.get('e5').source, 'scheduler', 'a validator crew with no names falls back');
  assert.equal(m.sourceOf.get('e6').source, 'scheduler');
  assert.equal(m.sourceOf.has('e7'), false);
  assert.deepEqual(m.span, { start: '2026-08-03', end: '2026-08-06' });
  assert.deepEqual(m.counts, { validator: 2, validatorProgress: 1, scheduler: 2, none: 0, total: 4 },
    'a night outside the crewed span is not counted as "no crew"');
  const off = mergeCrewSources({ events, schedCrew: sched, crew: buildCrewModel({}) });
  assert.equal(off.sourceOf.get('e3').source, 'scheduler', 'with the validator down the scheduler carries on');
});

/** 57 weekly Santa Clara Mondays from 2 Jun 2025, with a spread of takings. */
function managersFixture() {
  const events = []; const values = new Map();
  for (let i = 0; i < 57; i += 1) {
    const date = new Date(Date.UTC(2025, 5, 2 + 7 * i)).toISOString().slice(0, 10);
    events.push(ev(`m${i}`, 'LS', date));
    values.set(`m${i}`, { gross: 1000000 + ((i * 37) % 11) * 50000, net: 400000, flash: 300000 + ((i * 13) % 7) * 10000,
      rpa: 5000, attendance: 200, margin: 0.4, variance: i % 3 ? 200 : 9000, lineSales: 100, sourceSales: 100 });
  }
  const dateOf = (i) => events[i].event_date;
  const sessions = []; const assignments = [];
  for (let i = 40; i <= 44; i += 1) {
    sessions.push({ id: `o${i}`, hall_id: 'sc', session_date: dateOf(i), part: 'PM', status: 'deployed' });
    assignments.push({ session_id: `o${i}`, role_id: 'r-mod', staff_id: 's1' },
      { session_id: `o${i}`, role_id: 'r-pay', staff_id: 's4' });
  }
  sessions.push({ id: 'o45', hall_id: 'sc', session_date: dateOf(45), part: 'PM', status: 'draft' });
  assignments.push({ session_id: 'o45', role_id: 'r-mod', staff_id: 's5' });
  const rows = [vrow('sc', dateOf(44), '18:30', [['Max Tern', 'MOD'], ['Jo Finch', 'Paymaster']])];
  for (let i = 46; i <= 56; i += 1) {
    if (i === 50) continue;
    rows.push(vrow('sc', dateOf(i), '18:30', [[i % 2 ? 'robin  VALE' : 'Robin Vale', 'MOD'], ['Jo Finch', 'Paymaster'],
      ['Ari Lune', 'Callers/Strip']], i === 46 ? 'progress' : 'approved'));
  }
  const schedule = { ok: true, sessions, assignments, staff: STAFF, roles: ROLES, validator: { ok: true, rows } };
  const crew = buildCrewModel({ validator: schedule.validator, staff: STAFF, events, hallMap: HALLS });
  return { events, schedule, crew, valuesOf: (e) => values.get(e.id) };
}

test('Managers: counts by source, drafts excluded, and more people pass the ranking gate', () => {
  const { events, schedule, crew, valuesOf } = managersFixture();
  const before = buildManagerModel({ events, locations: LOCS, schedule, valuesOf });
  const after = buildManagerModel({ events, locations: LOCS, schedule, valuesOf, crew });
  assert.deepEqual(after.sources, { validator: 11, validatorProgress: 1, scheduler: 4, none: 2, total: 17 });
  assert.equal(after.report.notCounted, 1, 'the draft session is not used');
  assert.equal(before.people.some((p) => p.staffId === 's5'), false, 'a draft assignment credits nobody');
  const robin = (m) => m.people.find((p) => p.staffId === 's1' && p.role === 'MOD');
  assert.equal(robin(before).roll.gross.n, 5);
  assert.equal(robin(before).roll.gross.rankable, false);
  assert.equal(robin(after).roll.gross.n, 14, '4 scheduler nights + 10 validator nights under two spellings');
  assert.equal(robin(after).roll.gross.rankable, true);
  const jo = after.people.find((p) => p.staffId === 's4' && p.role === 'Paymaster');
  assert.equal(jo.balance.n, 15);
  assert.equal(jo.balance.rankable, true);
  const progress = robin(after).sessions.find((s) => s.approved === false);
  assert.equal(progress.source, 'validator', 'a progress crew is used and flagged');
  assert.equal(after.people.find((p) => p.name === 'Max Tern').staffId, 's5');
});

test('Managers screen states the counts by source and the span, and escapes typed names', () => {
  const f = managersFixture();
  f.schedule.validator.rows.push(vrow('sc', f.events[50].event_date, '18:30', [['<img src=x onerror=alert(1)>', 'MOD']]));
  const crew = buildCrewModel({ validator: f.schedule.validator, staff: STAFF, events: f.events, hallMap: HALLS });
  const data = { events: [...f.events].reverse(), locations: LOCS, metrics: {}, idx: indexMetrics([]), categories: [],
    config: { name: 'T', settings: {} }, metricDefs: [], schedule: f.schedule, crew };
  data.managers = buildManagerModel({ events: f.events, locations: LOCS, schedule: f.schedule, valuesOf: f.valuesOf, crew });
  const { node, inspector } = render(renderManagers, data, { tab: 'overview' });
  const text = inspect(node, 'managers with validator');
  assert.match(text, /12 sessions from the validator \(1 not yet approved\), 4 sessions from the scheduler, 1 session with no crew/);
  assert.match(text, /· 9 Mar 2026 – 29 Jun 2026/);
  assert.equal(node.querySelector('img'), null, 'a typed name is text, never markup');
  assert.match(inspector, /Validator matching/);
  const person = render(renderManagers, data, { tab: 'person', staff: 's1' }).node;
  assert.match(person.textContent, /validator, not yet approved/);
  assert.match(person.textContent, /scheduler/);
  const noV = { ...data, managers: buildManagerModel({ events: f.events, locations: LOCS, schedule: f.schedule, valuesOf: f.valuesOf, crew: buildCrewModel({}) }) };
  assert.match(render(renderManagers, noV, {}).node.textContent, /validator not connected/);
});

/* ---------------------------------------------------------------------------
   5. Staff Overview — Worked
--------------------------------------------------------------------------- */

function workedCrew() {
  return buildCrewModel({ validator: { ok: true, rows: [
    vrow('sc', '2026-09-05', '13:00', [['Robin Vale', 'MOD'], ['Ari Lune', 'Callers/Strip'], ['Ari Lune', 'Flash Runners', 2]]),
    vrow('sc', '2026-09-05', '18:30', [['Robin Vale', 'MOD'], ['Pat', 'Flash Runners']]),
    vrow('rwc', '2026-09-17', '18:30', [['robin vale', 'Paymaster'], ['Pat Ember', 'Flash Runners']], 'progress'),
    vrow('sc', '2026-09-20', '18:30', [['Ari Lune', 'Callers/Strip'], ['Pat Ember', 'Flash Runners']]),
  ] }, staff: STAFF, hallMap: HALLS });
}

test('Worked: sessions per person, by role and hall, first and last — default the latest period', () => {
  const crew = workedCrew();
  assert.equal(latestValidatorPeriod(crew).label, '16–30 Sep 2026');
  // An unapproved session in a later period does not move the default.
  const later = { ...crew, sessions: [...crew.sessions, { ...crew.sessions.at(-1), date: '2026-10-01', approved: false }] };
  assert.equal(latestValidatorPeriod(later).label, '16–30 Sep 2026');
  const w = buildWorked(crew, {});
  assert.equal(w.period.label, '16–30 Sep 2026');
  const robin = w.rows.find((r) => r.name === 'Robin Vale');
  assert.deepEqual({ s: robin.sessions, roles: robin.byRole, halls: robin.byHall, first: robin.first, n: robin.notApproved },
    { s: 1, roles: { Paymaster: 1 }, halls: { rwc: 1 }, first: '2026-09-17', n: 1 });
  const pat = w.rows.find((r) => r.name === 'Pat Ember');
  assert.equal(pat.sessions, 2);
  assert.deepEqual(w.totals, { people: 3, sessions: 2, places: 4,
    byRole: { Paymaster: 1, 'Callers/Strip': 1, 'Flash Runners': 2 }, notApproved: 1, unmatchedPeople: 2 });

  const sep = buildWorked(crew, { period: '2026-09-01' });
  const ari = sep.rows.find((r) => r.name === 'Ari Lune');
  assert.equal(ari.sessions, 1, 'two roles on one night is one session');
  assert.deepEqual(ari.byRole, { 'Callers/Strip': 1, 'Flash Runners': 1 });
  const r = sep.rows.find((x) => x.name === 'Robin Vale');
  assert.equal(r.sessions, 2);
  assert.equal(r.match, 'matched');
  assert.equal(buildWorked(crew, { period: '2026-09-01', role: 'MOD' }).rows.length, 1);
  assert.equal(buildWorked(crew, { period: '2026-09-16', hall: 'sc' }).totals.sessions, 1);
});

/* ---------------------------------------------------------------------------
   6. Scheduled vs worked
--------------------------------------------------------------------------- */

function overlapFixture() {
  const sessions = [
    { id: 'am', hall_id: 'sc', session_date: '2026-08-15', part: 'AM', status: 'deployed' },
    { id: 'pm', hall_id: 'sc', session_date: '2026-08-15', part: 'PM', status: 'planned' },
    { id: 'r17', hall_id: 'rwc', session_date: '2026-08-17', part: 'PM', status: 'deployed' },
    { id: 'r17d', hall_id: 'rwc', session_date: '2026-08-17', part: 'AM', status: 'draft' },
    { id: 'c1', hall_id: 'sc', session_date: '2026-08-22', part: 'AM', status: 'deployed' },
    { id: 'c2', hall_id: 'sc', session_date: '2026-08-22', part: 'PM', status: 'deployed' },
    { id: 'only', hall_id: 'rwc', session_date: '2026-08-16', part: 'PM', status: 'deployed' },
  ];
  const a = (session_id, staff_id, role_id, is_training = false) => ({ session_id, staff_id, role_id, is_training });
  const assignments = [
    a('am', 's1', 'r-mod'), a('am', 's4', 'r-pay'), a('am', 's5', 'r-call'), a('am', 's2', 'r-call', true),
    a('pm', 's1', 'r-mod'), a('r17', 's2', 'r-mod'), a('r17d', 's3', 'r-mod'),
    a('c1', 's1', 'r-mod'), a('c2', 's1', 'r-mod'), a('only', 's5', 'r-mod'),
  ];
  const schedule = { ok: true, staff: STAFF, roles: ROLES, sessions, assignments };
  const crew = buildCrewModel({ validator: { ok: true, rows: [
    vrow('sc', '2026-08-15', '13:00', [['Robin Vale', 'MOD'], ['Jo', 'Paymaster'], ['Ari Lune', 'Callers/Strip']]),
    vrow('sc', '2026-08-15', '18:30', [['Max Tern', 'MOD']]),
    vrow('rwc', '2026-08-17', '18:30', [['Quinn', 'MOD']]),
    vrow('sc', '2026-08-22', '13:00', [['Robin Vale', 'MOD']]),
    vrow('sc', '2026-09-20', '18:30', [['Robin Vale', 'MOD']]),
  ] }, staff: STAFF, hallMap: HALLS });
  return { schedule, crew };
}

test('scheduled vs worked: exact-unique matches only; unmatched names listed, not counted', () => {
  const { schedule, crew } = overlapFixture();
  const c = scheduledVsWorked({ crew, schedule });
  assert.deepEqual(c.span, { start: '2026-08-15', end: '2026-08-22' });
  assert.equal(c.compared, 3);
  assert.equal(c.both, 1, 'Robin Vale, scheduled and on the 13:00 crew');
  assert.deepEqual(c.scheduledOnly.map((x) => `${x.date} ${x.name} ${x.part}`).sort(),
    ['2026-08-15 Jo Finch AM', '2026-08-15 Max Tern AM', '2026-08-15 Robin Vale PM', '2026-08-17 Quinn PM']);
  assert.deepEqual(c.workedOnly.map((x) => `${x.date} ${x.name} ${x.roles}`), ['2026-08-15 Max Tern MOD']);
  assert.deepEqual(c.unmatched.map((x) => x.name).sort(), ['Ari Lune', 'Jo', 'Quinn']);
  assert.equal(c.unmatched.find((x) => x.name === 'Quinn').match, 'ambiguous');
  // A hint beside both, never a count.
  assert.equal(c.unmatched.find((x) => x.name === 'Jo').possibly, 'Jo Finch');
  assert.equal(c.scheduledOnly.find((x) => x.name === 'Jo Finch').possibly, 'Jo');
  assert.equal(c.unmatched.find((x) => x.name === 'Ari Lune').possibly, null);
  assert.equal(c.possiblePairs, 2);
  assert.deepEqual(c.clashes, [{ date: '2026-08-22', hall: 'sc', scheduled: 2, validator: 1 }]);
  // Training places and drafts never count.
  assert.ok(!c.scheduledOnly.some((x) => x.staffId === 's3'));
  assert.equal(c.scheduledOnly.filter((x) => x.staffId === 's2').length, 1, 'the training place on the AM is not counted');
  // Period and hall filters.
  assert.equal(scheduledVsWorked({ crew, schedule, hall: 'rwc' }).compared, 1);
  assert.equal(scheduledVsWorked({ crew, schedule, period: { start: '2026-09-16', end: '2026-09-30' } }).compared, 0);
});

/* ---------------------------------------------------------------------------
   7. Staff, session detail and Sources render with and without the validator
--------------------------------------------------------------------------- */

function screenData({ validator = true } = {}) {
  const { schedule, crew } = overlapFixture();
  const DEFS = [{ id: 'g', key: 'g' }, { id: 'p', key: 'p' }, { id: 'a', key: 'attendance' }];
  const events = [ev('x1', 'LS', '2026-09-20'), ev('x2', 'LS', '2026-08-15', 'late'), ev('x3', 'LS', '2026-08-15')];
  const metrics = Object.fromEntries(events.map((e, i) => [e.id, { g: 1000000 + i, p: 600000, a: 150 }]));
  const data = { events, metrics, idx: indexMetrics(DEFS), metricDefs: DEFS,
    categories: [{ key: 'all', display_name: 'All', revenue_keys: ['g'], payout_keys: ['p'] }],
    locations: LOCS, config: { name: 'T', settings: { jackpots: [] } }, promotions: [], runners: [], runnerEvents: [],
    schedule: { ...schedule, validator: validator ? { ok: true, rows: [] } : { ok: false, rows: [] } } };
  data.crew = validator ? buildCrewModel({ validator: { ok: true, rows: [
    ...crew.sessions.filter((s) => s.date !== '2026-09-20').map((s) => ({ id: s.id, hall_id: s.hall, session_date: s.date, session_time: s.time,
      status: s.status, closed_at: s.closedAt,
      staff_status: 'approved', crew: s.crew.map((c) => ({ name: c.name, role: c.role, slot: c.slot })) })),
    vrow('sc', '2026-09-20', '18:30', [['Robin Vale', 'MOD'], ['<b>Pat</b>', 'Flash Runners']], 'progress'),
  ] }, staff: STAFF, events, hallMap: HALLS }) : buildCrewModel({});
  data.managers = buildManagerModel({ events, locations: LOCS, schedule: data.schedule,
    valuesOf: makeValuesOf(data), crew: data.crew });
  return data;
}

test('Staff "Worked" renders, defaults to the latest validator period and says hours are the scheduler\'s', () => {
  const data = screenData();
  const { node } = render(renderStaff, data, { tab: 'worked' });
  const text = inspect(node, 'worked');
  assert.match(text, /Hours and overtime still come from the scheduler only/);
  // The fixture's only September session is not yet approved, so the default
  // is the latest period with an approved crew list.
  assert.match(text, /Showing 16–31 Aug 2026, the latest pay period with an approved crew list/);
  assert.match(text, /Possible duplicate names/);
  assert.equal(node.querySelector('b'), null, 'typed names are escaped');
  const sepRender = render(renderStaff, data, { tab: 'worked', period: '2026-09-16' }).node;
  const sep = inspect(sepRender, 'worked sep');
  assert.match(sep, /No session in 16–30 Sep 2026 is covered by both/);
  assert.ok([...sepRender.querySelectorAll('button')].some((b) => /Show 16–31 Aug 2026/.test(b.textContent)));
  assert.equal(sepRender.querySelector('b'), null, 'typed names are escaped');
  const aug = inspect(render(renderStaff, data, { tab: 'worked', period: '2026-08-16' }).node, 'worked aug');
  assert.match(aug, /Scheduled, not on the validator crew/);
  assert.match(aug, /Validator names that match no scheduler person/);
  assert.ok(render(renderStaff, data, { tab: 'worked' }).node.querySelectorAll('.rn-tab').length === 3);
});

test('Staff "Worked" says the validator is not connected, and the other tabs are unaffected', () => {
  const data = screenData({ validator: false });
  assert.match(inspect(render(renderStaff, data, { tab: 'worked' }).node, 'worked off').toLowerCase(), /validator not connected/);
  inspect(render(renderStaff, data, { tab: 'overview' }).node, 'overview off');
  inspect(render(renderStaff, data, { tab: 'capability' }).node, 'capability off');
});

test('session detail prefers the validator crew, by role, labelled with its approval', () => {
  const data = screenData();
  const nav = [];
  const late = render(renderSession, data, { id: 'x2' }, (...a) => nav.push(a)).node.querySelector('.crew');
  assert.match(late.textContent, /Max Tern/);
  assert.match(late.textContent, /from the validator \(approved\)/);
  assert.match(late.textContent, /session closed/);
  const early = render(renderSession, data, { id: 'x3' }, (...a) => nav.push(a)).node.querySelector('.crew');
  assert.match(early.textContent, /Callers\/Strip/);
  assert.match(early.textContent, /Ari Lune/);
  assert.ok(early.querySelector('.crew-none'), 'Flash Manager keeps its label with a dash');
  early.querySelector('.crew-name').click();
  assert.deepEqual(nav.at(-1), ['managers', { tab: 'person', staff: 's1', role: 'MOD' }]);
  const pending = render(renderSession, data, { id: 'x1' }).node.querySelector('.crew');
  assert.match(pending.textContent, /from the validator \(not yet approved\)/);
  assert.match(pending.textContent, /<b>Pat<\/b>/, 'shown as typed, as text');
  assert.equal(pending.querySelector('b'), null);
  const off = screenData({ validator: false });
  const sched = render(renderSession, off, { id: 'x3' }).node.querySelector('.crew');
  assert.match(sched.textContent, /from the scheduler · validator not connected/);
});

test('approved staff on an open or unknown session is not presented as a closed reconciliation', () => {
  for (const [status, label] of [['open', 'session open'], ['closed', 'session closed'], [null, 'session status unknown']]) {
    const data = screenData();
    const v = data.crew.byEvent.get('x2');
    v.session.status = status;
    // Reopening can leave an earlier close timestamp; current status governs the label.
    v.session.closedAt = '2026-08-16T01:00:00Z';
    data.managers = buildManagerModel({ events: data.events, locations: LOCS,
      schedule: data.schedule, valuesOf: makeValuesOf(data), crew: data.crew });
    const person = data.managers.people.find(p => p.staffId === 's5' && p.role === 'MOD');
    const night = person.sessions.find(s => s.eventId === 'x2');
    assert.equal(night.approved, true);
    assert.equal(night.sessionStatus, status);
    assert.equal(night.closedAt, v.session.closedAt);
    const session = render(renderSession, data, { id: 'x2' }).node.querySelector('.crew').textContent;
    assert.ok(session.includes(`from the validator (approved) · ${label}`));
    const manager = render(renderManagers, data, { tab: 'person', staff: 's5', role: 'MOD' }).node.textContent;
    assert.ok(manager.includes(`validator · ${label}`));
  }
});

test('Managers Coverage exposes missing roles, fallback and missing crews without extending the coverage period', () => {
  const data = screenData();
  data.events.push(ev('gap', 'LS', '2026-08-18'), ev('old', 'LS', '2025-01-01'));
  data.managers.sourceOf.set('x2', { source: 'scheduler', approved: null });
  data.managers.crewOf.set('x2', { MOD: { name: 'Max Tern', staffId: 's5' } });
  const nav = [];
  const node = render(renderManagers, data, { tab: 'coverage' }, (...a) => nav.push(a)).node;
  const rows = [...node.querySelectorAll('.mg-coverage tbody tr')];
  const gap = rows.find((r) => r.textContent.includes('18 Aug 2026'));
  assert.ok(gap);
  assert.match(gap.textContent, /No crew recorded/);
  assert.match(gap.textContent, /MOD, Paymaster, Flash Manager/);
  assert.ok(!rows.some((r) => r.textContent.includes('2025')), 'old unstaffed history is outside the headline period');
  const fallback = rows.find((r) => r.textContent.includes('scheduler'));
  assert.match(fallback.textContent, /Paymaster, Flash Manager/);
  gap.querySelector('button').click();
  assert.deepEqual(nav.at(-1), ['session', { id: 'gap' }]);
  [...node.querySelectorAll('button')].find((b) => /All sessions/.test(b.textContent)).click();
  assert.deepEqual(nav.at(-1), ['managers', { tab: 'coverage', coverage: 'all' }]);
});

test('Managers Coverage treats staff approval separately from reconciliation closure and lists matching failures once per day', () => {
  const data = screenData();
  // An approved, complete crew remains covered even if the reconciliation is open.
  data.managers.sourceOf.set('x2', { source: 'validator', approved: true, sessionStatus: 'open' });
  data.managers.crewOf.set('x2', Object.fromEntries(['MOD', 'Paymaster', 'Flash Manager'].map((r) => [r, { name: 'Alex' }])));
  data.managers.validator.report = { matched: 1,
    unmatched: [
      { date: '2026-10-02', hall: 'sc', time: '18:30', reason: 'no-results' },
      { date: '2026-08-23', hall: 'sc', time: '13:00', reason: 'count' },
      { date: '2026-08-23', hall: 'sc', time: '18:30', reason: 'count' },
      { date: '2026-08-22', hall: '<b>Unknown</b>', time: '18:30', reason: 'hall' },
    ], mismatched: [{ date: '2026-08-23', hall: 'sc', validator: 2, events: 1 }] };
  const gaps = render(renderManagers, data, { tab: 'coverage' }).node;
  assert.ok(![...gaps.querySelectorAll('.mg-coverage tbody tr')].some((r) => /Late/.test(r.textContent)));
  const all = render(renderManagers, data, { tab: 'coverage', coverage: 'all' }).node;
  assert.match(all.querySelector('.mg-coverage').textContent, /validator · session open/);
  const failures = all.querySelectorAll('.mg-unmatched tbody tr');
  assert.equal(failures.length, 3);
  assert.match(failures[0].textContent, /2 Oct 2026.*Santa Clara.*No analytics results/);
  assert.match(failures[1].textContent, /2 Validator sessions, 1 analytics sessions/);
  assert.match(failures[2].textContent, /Hall has no matching analytics location/);
  assert.equal(all.querySelector('b'), null, 'unknown hall names are rendered as text');
  const off = render(renderManagers, screenData({ validator: false }), { tab: 'coverage' }).node;
  assert.match(off.textContent, /Validator data is unavailable/);
});

test('Sources lists the validator with its coverage, or says it is not connected', () => {
  const on = sourceList(screenData()).find((s) => s.group === 'Data validator');
  assert.equal(on.state, 'connected');
  assert.match(on.note, /Covers 15 Aug 2026 to 20 Sep 2026: 5 sessions/);
  assert.equal(on.items[0].count, 5);
  const off = sourceList(screenData({ validator: false })).find((s) => s.group === 'Data validator');
  assert.equal(off.state, 'not connected');
  assert.match(off.note, /Validator not connected/);
  inspect(render(renderSources, screenData(), {}).node, 'sources');
  inspect(render(renderSources, screenData({ validator: false }), {}).node, 'sources off');
});

test('every crew-touching screen renders with and without validator data', () => {
  for (const validator of [true, false]) {
    const d = screenData({ validator });
    for (const [fn, params] of [[renderManagers, {}], [renderManagers, { tab: 'person', staff: 's1' }],
      [renderManagers, { tab: 'dayshape' }], [renderStaff, {}], [renderStaff, { tab: 'worked' }],
      [renderSession, {}], [renderSources, {}]]) {
      inspect(render(fn, d, params).node, `${fn.name} ${JSON.stringify(params)} validator=${validator}`);
    }
  }
});

/* ---------------------------------------------------------------------------
   8. Forecast — owner-confirmed closure
--------------------------------------------------------------------------- */

const FDEFS = [{ id: 'm-sales', key: 'sales' }, { id: 'm-prizes', key: 'prizes' }, { id: 'm-att', key: 'attendance' }];
const FCATS = [{ key: 'bingo', display_name: 'Bingo', revenue_keys: ['sales'], payout_keys: ['prizes'] }];

/** Santa Clara Fridays (regular) and Redwood City Fridays, 13 weeks to 25 Sep 2026. */
function forecastBundle() {
  const events = []; const metrics = {};
  for (let i = 0; i < 13; i += 1) {
    const date = new Date(Date.UTC(2026, 6, 3 + 7 * i)).toISOString().slice(0, 10);
    for (const [loc, base] of [['LS', 2000], ['LR', 900]]) {
      const id = `${loc}${i}`;
      events.push(ev(id, loc, date));
      metrics[id] = { 'm-sales': (base + (i % 4) * 100) * 100, 'm-prizes': base * 50, 'm-att': 100 };
    }
  }
  events.sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
  return { events, metrics, idx: indexMetrics(FDEFS), categories: FCATS, metricDefs: FDEFS, locations: LOCS,
    config: { name: 'T', timezone: null, settings: { jackpots: [] } } };
}

test('owner closures resolve by location code and holiday alias, and report what they cannot', () => {
  assert.equal(holidayKeyOf('christmas'), 'xmas');
  assert.equal(holidayKeyOf('Christmas Day'), 'xmas');
  assert.equal(holidayKeyOf('xmaseve'), 'xmaseve');
  assert.equal(holidayKeyOf('boxing day'), null);
  assert.deepEqual(OWNER_CLOSURES, [{ holiday: 'christmas', hall: 'SC', confirmed: '2026-10-01' }]);
  const r = resolveOwnerClosures([...OWNER_CLOSURES, { holiday: 'christmas', hall: 'ZZ' }, { holiday: 'boxing day', hall: 'SC' }], LOCS);
  assert.deepEqual([...r.map.entries()], [['xmas|LS', { holiday: 'xmas', hall: 'SC', confirmed: '2026-10-01' }]]);
  assert.equal(r.unknown.length, 2);
  assert.equal(resolveOwnerClosures(OWNER_CLOSURES, [{ id: 'LS', name: 'Santa Clara' }]).map.size, 0,
    'never matched by name');
});

test('HAND: SC Fri 25 Dec 2026 is closed by the owner; rest of 2026 gross drops by that night\'s baseline', () => {
  const data = forecastBundle();
  const today = '2026-10-01';
  const rows = sessionRows(data.events, data);
  const prep = prepare(rows, { today: dayNumber(today) });
  const months = horizonMonths('year', today);
  assert.deepEqual(months, ['2026-10', '2026-11', '2026-12']);
  const ownerClosed = resolveOwnerClosures(OWNER_CLOSURES, LOCS).map;
  const without = buildForecast({ rows, prep, months });
  const withOwner = buildForecast({ rows, prep, months, ownerClosed });

  const xmas = withOwner.closed.filter((s) => s.date === '2026-12-25');
  assert.deepEqual(xmas.map((s) => `${s.locationId}|${s.type}`), ['LS|regular']);
  assert.deepEqual(xmas[0].holiday.owner, { confirmed: '2026-10-01' });
  assert.equal(xmas[0].holiday.history, 'none', 'there was no history: the owner outranks "no history"');
  assert.ok(withOwner.projected.some((s) => s.date === '2026-12-25' && s.locationId === 'LR'),
    'Redwood City is not covered by the confirmation');
  assert.ok(without.projected.some((s) => s.date === '2026-12-25' && s.locationId === 'LS'));

  // The drop is exactly that night's SC Friday regular baseline.
  const b = prep.baselines.get('LS|5|regular');
  assert.ok(b.usable);
  assert.ok(Math.abs((without.totals.gross - withOwner.totals.gross) - b.meanGross) < 1e-6);
  assert.equal(withOwner.totals.closed - without.totals.closed, 1);

  // Still re-openable.
  const reopened = buildForecast({ rows, prep, months, ownerClosed, open: new Set(['2026-12-25|LS|regular']) });
  assert.equal(reopened.totals.gross, without.totals.gross);
  assert.equal(reopened.projected.find((s) => s.date === '2026-12-25' && s.locationId === 'LS').holiday.reopened, true);

  // A deployed or planned roster session still wins.
  const roster = rosterSessions([{ hall_id: 'sc', session_date: '2026-12-25', part: 'PM', status: 'deployed' }],
    { hallMap: HALLS, fromDay: monthStartDay('2026-10'), toDay: monthEndDay('2026-12'), rows, cutoff: prep.cutoff });
  const rostered = buildForecast({ rows, prep, months, ownerClosed, roster: roster.sessions });
  assert.ok(rostered.projected.some((s) => s.date === '2026-12-25' && s.locationId === 'LS' && s.source === 'roster'));
});

test('the owner closure outranks a "held" history too', () => {
  const data = forecastBundle();
  // SC held Christmas 2025 (a Thursday) — make Thursdays a running slot then.
  const extra = [];
  for (let i = 0; i < 13; i += 1) {
    const date = new Date(Date.UTC(2025, 9, 2 + 7 * i)).toISOString().slice(0, 10);
    extra.push(ev(`th${i}`, 'LS', date));
    data.metrics[`th${i}`] = { 'm-sales': 100000, 'm-prizes': 50000 };
  }
  data.events = [...data.events, ...extra];
  const rows = sessionRows(data.events, data);
  const prep = prepare(rows, { today: dayNumber('2026-10-01') });
  assert.equal(prep.holidays.get('xmas|LS').latest.outcome, 'held');
  const f = buildForecast({ rows, prep, months: horizonMonths('year', '2026-10-01'),
    ownerClosed: resolveOwnerClosures(OWNER_CLOSURES, LOCS).map });
  const s = f.closed.find((x) => x.date === '2026-12-25' && x.locationId === 'LS');
  assert.ok(s, 'closed despite being held last year');
  assert.equal(s.holiday.history, 'held');
});

test('forecast screen labels the night "Closed — confirmed by owner" with an Open switch', () => {
  const data = forecastBundle();
  const node = renderForecast({ data, params: { horizon: 'year' }, onNavigate: () => {},
    setInspectorContent: () => {}, now: new Date('2026-10-01T18:00:00Z'), store: null });
  const panel = [...node.querySelectorAll('section')].find((x) => /Holidays in this period/.test(x.textContent));
  assert.ok(panel);
  const row = [...panel.querySelectorAll('tbody tr')].find((tr) => /Santa Clara/.test(tr.textContent) && /Christmas Day/.test(tr.textContent));
  assert.match(row.textContent, /Closed — confirmed by owner/);
  assert.ok(row.querySelector('input[type=checkbox]'), 'still re-openable');
  inspect(node, 'forecast owner closure');
});

test('every route renders with and without validator data', async () => {
  const { SCREENS } = await import('../src/lib/router.js');
  const mods = {
    dashboard: ['dashboard', 'renderDashboard'], session: ['session', 'renderSession'],
    leaderboard: ['leaderboard', 'renderLeaderboard'], compare: ['compare', 'renderCompare'],
    jackpots: ['jackpots', 'renderJackpots'], promotions: ['promotions', 'renderPromotions'],
    runners: ['runners', 'renderRunners'], anomaly: ['anomaly', 'renderAnomaly'],
    reporting: ['reporting', 'renderReporting'], 'monthly-pl': ['monthly-pl', 'renderMonthlyPL'],
    'unit-economics': ['unit-economics', 'renderUnitEconomics'], forecast: ['forecast', 'renderForecast'],
    venues: ['venues', 'renderVenues'], inventory: ['inventory', 'renderInventory'],
    commission: ['commission', 'renderCommission'], managers: ['managers', 'renderManagers'],
    'staff-overview': ['staff', 'renderStaff'], data: ['data', 'renderData'], sources: ['sources', 'renderSources'],
    ask: ['ask', 'renderAsk'], notifications: ['notifications', 'renderNotifications'],
  };
  // Bingo Scout (competition) reads its own route, not the crew data; it is
  // rendered in screens.test.mjs and competition.test.mjs.
  assert.deepEqual(Object.keys(SCREENS).filter((id) => !mods[id] && id !== 'competition'), []);
  for (const validator of [true, false]) {
    const d = { ...screenData({ validator }), notifications: [], notificationReads: [], userId: null };
    for (const [id, [file, name]] of Object.entries(mods)) {
      const fn = (await import(`../src/screens/${file}.js`))[name];
      inspect(render(fn, d, {}).node, `route ${id} validator=${validator}`);
    }
  }
});

/* ---------------------------------------------------------------------------
   9. The owner's name rule (OWNER_NAME_RULE, 2 Oct 2026) — invented names
--------------------------------------------------------------------------- */

const mergeOf = (rows, extra = {}) => buildNameMerge({ sessions: normaliseValidator(rows), staff: STAFF, ...extra });
const row = (t) => (r) => r.canonical === t;
const vnames = (r) => r.variants.map((v) => `${v.name}|${v.source}|${v.count}`);

test('config records the owner rule, with empty keep-apart and alias lists', () => {
  assert.deepEqual(OWNER_NAME_RULE, { mergeByFirstName: true, exceptRoles: ['Flash Runners'], confirmed: '2026-10-02' });
  assert.deepEqual(OWNER_NAME_KEEP_APART, []);
  assert.deepEqual(OWNER_NAME_ALIASES, {});
  assert.equal(ruleKey('  Dale   M. '), 'dale m');
  assert.deepEqual(nameParts('Dale M.'), { key: 'dale m', first: 'dale', surname: 'm' });
  assert.deepEqual(nameParts('dale'), { key: 'dale', first: 'dale', surname: '' });
});

test('name rule: "Dale", "Dale M." and "Dale Moreno" are one person, shown under the fullest form', () => {
  const rows = [
    vrow('sc', '2026-08-12', '18:30', [['Dale Moreno', 'MOD'], ['Dale M.', 'Paymaster']]),
    vrow('sc', '2026-08-13', '18:30', [['Dale', 'MOD'], ['dale m', 'Callers/Strip']]),
    vrow('rwc', '2026-08-14', '18:30', [['Dale Moreno', 'Flash Manager']]),
  ];
  const t = mergeOf(rows).table;
  assert.equal(t.length, 1);
  assert.equal(t[0].canonical, 'Dale Moreno');
  assert.equal(t[0].status, 'merged');
  assert.deepEqual(vnames(t[0]), ['Dale Moreno|validator|2', 'Dale|validator|1', 'dale m|validator|1', 'Dale M.|validator|1']);
  assert.deepEqual(t[0].variants[0].roles, ['MOD', 'Flash Manager']);
  const crew = buildCrewModel({ validator: { ok: true, rows }, staff: STAFF, hallMap: HALLS });
  const ids = new Set(crew.sessions.flatMap((s) => fullCrew(s, crew.identities).map((c) => c.id)));
  assert.deepEqual([...ids], ['v:dale moreno']);
  const w = buildWorked(crew, { period: '2026-08-12' });
  assert.equal(w.rows.length, 1);
  assert.deepEqual({ name: w.rows[0].name, s: w.rows[0].sessions }, { name: 'Dale Moreno', s: 3 });
  assert.equal(crew.coverage.people, 1);
});

test('name rule: "Jamie Cole", "Jamie C." and "jamie" are one person', () => {
  const t = mergeOf([
    vrow('sc', '2026-08-12', '18:30', [['Jamie Cole', 'MOD']]),
    vrow('sc', '2026-08-13', '18:30', [['Jamie C.', 'MOD']]),
    vrow('sc', '2026-08-14', '18:30', [['jamie', 'Paymaster']]),
  ]).table;
  assert.deepEqual(t.map((r) => [r.canonical, r.status, r.variants.length]), [['Jamie Cole', 'merged', 3]]);
});

test('name rule: two surnames are two people; "Jamie G." joins Gray and a bare "Jamie" is ambiguous', () => {
  const rows = [
    vrow('sc', '2026-08-12', '18:30', [['Jamie Cole', 'MOD'], ['Jamie Gray', 'Paymaster']]),
    vrow('sc', '2026-08-13', '18:30', [['Jamie', 'MOD'], ['Jamie G.', 'Paymaster']]),
    vrow('sc', '2026-08-14', '18:30', [['Jamie C', 'MOD'], ['Jamie Gray', 'Paymaster']]),
  ];
  const m = mergeOf(rows);
  assert.deepEqual(m.table.map((r) => [r.canonical, r.status]),
    [['Jamie Cole', 'merged'], ['Jamie Gray', 'merged'], ['Jamie', 'ambiguous']]);
  assert.deepEqual(vnames(m.table.find(row('Jamie Gray'))), ['Jamie Gray|validator|2', 'Jamie G.|validator|1']);
  assert.deepEqual(m.table.find(row('Jamie')).candidates, ['Jamie Cole', 'Jamie Gray']);
  assert.deepEqual(m.counts, { merged: 2, ambiguous: 1, keptApart: 0, variants: 4 });
  const crew = buildCrewModel({ validator: { ok: true, rows }, staff: STAFF, hallMap: HALLS });
  const names = new Set([...crew.identities.values()].map((i) => i.name));
  assert.deepEqual([...names].sort(), ['Jamie', 'Jamie Cole', 'Jamie Gray'], 'bare Jamie stays its own name');
});

test('name rule: Flash Runners are never merged, and a person\'s Flash Runner entries keep the typed name', () => {
  const rows = [
    vrow('sc', '2026-08-12', '18:30', [['Dale Moreno', 'MOD'], ['Pat', 'Flash Runners'], ['Dale', 'Flash Runners', 1]]),
    vrow('sc', '2026-08-13', '18:30', [['Dale', 'MOD'], ['Pat Ember', 'Flash Runners']]),
  ];
  const crew = buildCrewModel({ validator: { ok: true, rows }, staff: STAFF, hallMap: HALLS });
  assert.deepEqual(crew.names.table.map((r) => r.canonical), ['Dale Moreno']);
  assert.deepEqual(crew.names.table[0].variants.map((v) => v.roles), [['MOD'], ['MOD']],
    'the Flash Runner "Dale" is not counted in the merge');
  const flat = crew.sessions.flatMap((s) => fullCrew(s, crew.identities));
  assert.deepEqual(flat.filter((c) => c.role === 'MOD').map((c) => c.id), ['v:dale moreno', 'v:dale moreno']);
  assert.equal(flat.find((c) => c.role === 'Flash Runners' && c.key === 'dale').id, 'v:dale');
  assert.deepEqual(flat.filter((c) => c.key.startsWith('pat')).map((c) => c.id).sort(), ['v:pat', 'v:pat ember']);
  // The Flash Runner duplicate hint is kept; nothing else is hinted.
  assert.deepEqual(crew.duplicates.map((d) => `${d.short.name}/${d.long.name}/${d.where[0].role}`), ['Pat/Pat Ember/Flash Runners']);
});

test('name rule: OWNER_NAME_KEEP_APART and OWNER_NAME_ALIASES override it', () => {
  const rows = [
    vrow('sc', '2026-08-12', '18:30', [['Dale Moreno', 'MOD'], ['Dale M.', 'Paymaster']]),
    vrow('sc', '2026-08-13', '18:30', [['Dale', 'MOD'], ['Bobby', 'Paymaster'], ['Robin Vale', 'Flash Manager']]),
  ];
  const apart = mergeOf(rows, { keepApart: [['dale m', 'DALE MORENO']] });
  assert.deepEqual(apart.table.map((r) => [r.canonical, r.status]), [['Dale', 'ambiguous'], ['Dale M.', 'kept apart']],
    'Dale M. is a different person, so a bare Dale could be either');
  assert.deepEqual(apart.table[0].candidates, ['Dale M.', 'Dale Moreno']);
  const bareApart = mergeOf(rows, { keepApart: [['Dale', 'Dale Moreno']] });
  assert.deepEqual(bareApart.table.map((r) => [r.canonical, r.status]), [['Dale Moreno', 'merged'], ['Dale', 'kept apart']]);

  const alias = mergeOf(rows, { keepApart: [['Dale M.', 'Dale Moreno']], aliases: { Dale: 'Dale Moreno', 'bobby ': 'Robin Vale' } });
  assert.deepEqual(alias.table.filter((r) => r.status === 'merged').map((r) => [r.canonical, r.id, vnames(r)]), [
    ['Dale Moreno', 'v:dale moreno', ['Dale Moreno|validator|1', 'Dale|validator|1']],
    ['Robin Vale', 's1', ['Robin Vale|validator|1', 'Bobby|validator|1']],
  ]);
  assert.equal(alias.table.find(row('Robin Vale')).variants[1].alias, true);
  assert.equal(alias.whoOf('bobby', 'Paymaster'), 'robin vale');
  assert.equal(alias.whoOf('bobby', 'Flash Runners'), 'bobby', 'aliases leave Flash Runners alone too');

  const off = mergeOf(rows, { rule: { mergeByFirstName: false, exceptRoles: ['Flash Runners'] } });
  assert.deepEqual(off.table, [], 'with the rule off nothing merges');
});

test('name rule: a scheduler short name merges with the validator full name, and Managers combines their sessions', () => {
  const f = managersFixture();
  const staff = [...STAFF, { id: 'sd', name: 'Dale' }];
  const dateOf = (i) => f.events[i].event_date;
  const sessions = []; const assignments = [];
  for (let i = 40; i <= 44; i += 1) {
    sessions.push({ id: `o${i}`, hall_id: 'sc', session_date: dateOf(i), part: 'PM', status: 'deployed' });
    assignments.push({ session_id: `o${i}`, role_id: 'r-mod', staff_id: 'sd' },
      { session_id: `o${i}`, role_id: 'r-run', staff_id: 's5' });
  }
  const rows = [];
  for (let i = 45; i <= 56; i += 1) {
    if (i === 50) continue;
    rows.push(vrow('sc', dateOf(i), '18:30', [[i % 2 ? 'Dale Moreno' : 'Dale M.', 'MOD'], ['Jo Finch', 'Paymaster']]));
  }
  const schedule = { ok: true, sessions, assignments, staff, roles: ROLES, validator: { ok: true, rows } };
  const build = (nameRule) => {
    const crew = buildCrewModel({ validator: schedule.validator, staff, events: f.events, hallMap: HALLS, schedule, nameRule });
    return { crew, m: buildManagerModel({ events: f.events, locations: LOCS, schedule, valuesOf: f.valuesOf, crew }) };
  };
  const before = build({ mergeByFirstName: false, exceptRoles: ['Flash Runners'] });
  const after = build(OWNER_NAME_RULE);
  const mods = (m) => m.people.filter((p) => p.role === 'MOD').map((p) => [p.name, p.staffId, p.roll.gross.n, p.roll.gross.rankable])
    .sort((a, b) => b[2] - a[2]);
  assert.deepEqual(mods(before.m), [['Dale Moreno', 'v:dale moreno', 6, false], ['Dale', 'sd', 5, false], ['Dale M.', 'v:dale m.', 5, false]]);
  assert.deepEqual(mods(after.m), [['Dale Moreno', 'sd', 16, true]], 'one person, ranked, under the fullest name');
  const t = after.crew.names.table;
  assert.deepEqual(t.map((r) => [r.canonical, r.id, vnames(r)]),
    [['Dale Moreno', 'sd', ['Dale Moreno|validator|6', 'Dale|scheduler|5', 'Dale M.|validator|5']]]);
  assert.deepEqual(t[0].variants.find((v) => v.source === 'scheduler').roles, ['MOD'],
    'the scheduler person\'s Flash Runner places take no part');
  assert.deepEqual(after.m.sources, before.m.sources, 'the source counts are unchanged');
  // The scheduler-sourced crew line reads as the merged person.
  assert.equal(after.m.crewOf.get(f.events[40].id).MOD.name, 'Dale Moreno');
  // Only scheduler people on scheduler-sourced sessions count: not those the validator covers.
  assert.deepEqual(schedulerSourcedUses({ schedule, events: f.events, hallMap: HALLS,
    validatorLinks: after.crew.join.links }).map((u) => `${u.staffId}|${u.role}|${u.count}`).sort(),
  ['s5|Flash Runners|5', 'sd|MOD|5']);
});

test('Merged names panel on Managers and Staff › Worked; Flash Runner hints keep their own panel', () => {
  const data = screenData();
  const rows = [
    vrow('sc', '2026-08-29', '18:30', [['Jamie Cole', 'MOD'], ['Jamie Gray', 'Paymaster'], ['Jamie', 'Flash Manager'],
      ['<i>Jamie</i> C.', 'Callers/Strip']]),
    vrow('sc', '2026-08-30', '18:30', [['Jamie C.', 'MOD'], ['Pat', 'Flash Runners'], ['Pat Ember', 'Flash Runners']]),
  ];
  data.crew = buildCrewModel({ validator: { ok: true, rows }, staff: STAFF, events: data.events, hallMap: HALLS });
  data.managers = buildManagerModel({ events: data.events, locations: LOCS, schedule: data.schedule,
    valuesOf: makeValuesOf(data), crew: data.crew });
  const mgr = render(renderManagers, data, { tab: 'overview' }).node;
  const text = inspect(mgr, 'managers merged names');
  assert.match(text, /Merged names \(owner rule, 2 Oct 2026\) · 1 merged, 1 ambiguous/);
  const panel = mgr.querySelector('.nm-panel');
  assert.ok(panel.querySelector('details') && !panel.querySelector('details').open, 'collapsed by default');
  assert.match(panel.textContent, /Jamie Cole/);
  assert.match(panel.textContent, /could be Jamie Cole or Jamie Gray/);
  assert.equal(panel.querySelector('i'), null, 'typed names are escaped');
  assert.ok(mgr.querySelector('.mg-sources'), 'the source-count line is still there');
  const staff = render(renderStaff, data, { tab: 'worked', period: '2026-08-16' }).node;
  const st = inspect(staff, 'worked merged names');
  assert.match(st, /Merged names \(owner rule, 2 Oct 2026\)/);
  assert.match(st, /Possible duplicate names — Flash Runners/);
  assert.match(st, /Pat Ember/);
});
