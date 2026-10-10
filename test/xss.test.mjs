/* ============================================================================
   XSS regression suite

   Every screen builds most of its markup from template literals. That is safe
   for numbers that went through fmt.js and for constants, and for nothing
   else: hall names, staff names, crew roles, notes, game names, collector
   messages and URL parameters are all text somebody else controls.

   This suite puts a hostile string into EVERY free-text field the fixtures
   carry — and into every route parameter — renders every screen on every tab,
   and fails if the payload ever becomes markup anywhere: in the screen, in the
   inspector HTML, or in any fragment assigned to innerHTML along the way (a
   tripwire on the innerHTML setter and insertAdjacentHTML catches fragments
   that are built and then thrown away, or that only exist for a moment).

   What a failure here means: some value reaches innerHTML without esc().
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/* ---------------------------------------------------------------------------
   The payloads. One for element context, one for each attribute quote style.
--------------------------------------------------------------------------- */
const IMG = '<img src=x onerror=alert(1)>';
const HOSTILE = `${IMG}"><svg onload=alert(2)>'><svg onload=alert(3)>`;

/* ---------------------------------------------------------------------------
   A DOM with a tripwire on every HTML sink
--------------------------------------------------------------------------- */
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://sar.test/' });
const W = dom.window;
Object.assign(globalThis, {
  window: W, document: W.document, Node: W.Node, Event: W.Event, HTMLElement: W.HTMLElement,
  localStorage: W.localStorage, getComputedStyle: W.getComputedStyle.bind(W),
});

/** Every element the payload could have produced. */
const BAD = 'img[src="x"], svg[onload], [onerror], [onload], [onclick], [onmouseover], [onfocus]';
const hits = [];
let where = 'setup';
function scan(root, how) {
  if (!root?.querySelectorAll) return;
  const found = [...root.querySelectorAll(BAD)];
  // The root itself (insertAdjacentHTML on an element can only add children,
  // but outerHTML-style sinks would replace it).
  if (root.matches?.(BAD)) found.unshift(root);
  for (const el of found) hits.push(`${where} (${how}): <${el.tagName.toLowerCase()} ${
    [...el.attributes].map((a) => `${a.name}="${a.value}"`).join(' ')}>`);
}
const inner = Object.getOwnPropertyDescriptor(W.Element.prototype, 'innerHTML');
Object.defineProperty(W.Element.prototype, 'innerHTML', {
  ...inner,
  set(v) { inner.set.call(this, v); scan(this, 'innerHTML'); },
});
const adjacent = W.Element.prototype.insertAdjacentHTML;
W.Element.prototype.insertAdjacentHTML = function insertAdjacentHTML(pos, html) {
  adjacent.call(this, pos, html);
  scan(this.parentNode ?? this, 'insertAdjacentHTML');
};

/** Render, collect the inspector, and check the finished tree as well. */
function check(label, fn) {
  where = label;
  const before = hits.length;
  let inspectorHtml = '';
  const node = fn((h) => { inspectorHtml = typeof h === 'string' ? h : (h?.outerHTML ?? ''); });
  assert.ok(node, `${label}: rendered nothing`);
  scan(node, 'rendered tree');
  const holder = document.createElement('div');
  holder.innerHTML = inspectorHtml;                  // tripwire scans it
  const mine = hits.slice(before);
  assert.deepEqual(mine, [], `${label}: hostile text became markup:\n  ${mine.join('\n  ')}`);
  return node;
}

/* ---------------------------------------------------------------------------
   Poisoning: append the payload to every free-text field
--------------------------------------------------------------------------- */
/**
 * Keys that hold text a person typed or a source supplied. Ids, keys, dates
 * and numbers are left alone so joins still work and every screen still has
 * something to draw — a poisoned fixture that renders an empty state proves
 * nothing.
 */
const FREE_TEXT = new Set([
  'name', 'display_name', 'title', 'body', 'note', 'notes', 'promotion_notes', 'promo_notes',
  'role', 'game', 'name_raw', 'category', 'type', 'status', 'vendor_id', 'num', 'part',
  'event_type', 'game_type', 'label', 'city', 'address', 'subject', 'severity', 'platform',
  'details', 'operatingStatus', 'researchStatus', 'slot_name', 'staff_status', 'session_time',
  'channel', 'kind_label', 'state_label',
]);
/** Fields that also drive logic (counted statuses, approval, session type). */
const ENUMS = new Set(['status', 'staff_status', 'part', 'event_type', 'session_time', 'severity', 'channel']);
const p = (v) => (String(v).includes(HOSTILE) ? v : `${v}${HOSTILE}`);

/**
 * Append the payload to every free-text field, in place. `keys` narrows it:
 * the models are built from data poisoned WITHOUT the enum-like fields (so a
 * "deployed" session is still counted), and the rest is poisoned afterwards,
 * when it is only display.
 */
function poison(value, keys = FREE_TEXT, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) { value.forEach((v) => poison(v, keys, seen)); return value; }
  if (value instanceof Map || value instanceof Set) return value;   // models are rebuilt
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && keys.has(k)) value[k] = p(v);
    else if (Array.isArray(v) && keys.has(k)) value[k] = v.map((x) => (typeof x === 'string' ? p(x) : x));
    else poison(v, keys, seen);
  }
  return value;
}
const TEXT_ONLY = new Set([...FREE_TEXT].filter((k) => !ENUMS.has(k)));

/** Every route parameter any screen reads, all hostile. */
const PARAM_KEYS = [
  'a_days', 'a_from', 'a_to', 'a_type', 'activity', 'area', 'aspect', 'att', 'b_days', 'b_from',
  'b_to', 'b_type', 'back', 'bridge', 'chart', 'compliance', 'coverage', 'date', 'dayOnly', 'days',
  'dir', 'event', 'flagged', 'from', 'group', 'hall', 'hide', 'horizon', 'id', 'inactive', 'jp',
  'labels', 'mdates', 'mdays', 'metric', 'mode', 'off', 'open', 'page', 'payout', 'period', 'q',
  'role', 'runner', 'severity', 'sort', 'spend', 'staff', 'tab', 'to', 'type', 'unread', 'view',
];
const hostileParams = (over = {}) => ({
  ...Object.fromEntries(PARAM_KEYS.map((k) => [k, HOSTILE])), ...over,
});

/* ---------------------------------------------------------------------------
   Screens, imported after the DOM exists
--------------------------------------------------------------------------- */
const F = await import('./fixtures/screen-data.mjs');
const { buildManagerModel } = await import('../src/lib/managers.js');
const { buildCrewModel } = await import('../src/lib/crew-model.js');
const { hallMapFromLocations } = await import('../src/lib/forecast-model.js');
const { makeValuesOf, renderManagers } = await import('../src/screens/managers.js');
const { renderSession } = await import('../src/screens/session.js');
const { renderLeaderboard } = await import('../src/screens/leaderboard.js');
const { renderJackpots } = await import('../src/screens/jackpots.js');
const { renderMonthlyPL } = await import('../src/screens/monthly-pl.js');
const { renderCompare } = await import('../src/screens/compare.js');
const { renderVenues } = await import('../src/screens/venues.js');
const { renderAnomaly } = await import('../src/screens/anomaly.js');
const { renderReporting } = await import('../src/screens/reporting.js');
const { renderRunners, TABS: RN_TABS } = await import('../src/screens/runners.js');
const { renderDashboard, CHARTS } = await import('../src/screens/dashboard.js');
const { renderData, VIEWS } = await import('../src/screens/data.js');
const { renderInventory, TABS: INV_TABS } = await import('../src/screens/inventory.js');
const { renderCommission, TABS: COM_TABS } = await import('../src/screens/commission.js');
const { renderStaff, TABS: ST_TABS } = await import('../src/screens/staff.js');
const { renderSources, TABS: SRC_TABS } = await import('../src/screens/sources.js');
const { renderPromotions, TABS: PR_TABS } = await import('../src/screens/promotions.js');
const { renderUnitEconomics } = await import('../src/screens/unit-economics.js');
const { renderForecast } = await import('../src/screens/forecast.js');
const { renderAsk } = await import('../src/screens/ask.js');
const { renderNotifications } = await import('../src/screens/notifications.js');
const { renderHotball } = await import('../src/screens/hotball.js');
const { projectHotballRow, projectMovementRow } = await import('../src/lib/ops-schema.js');
const { renderCompetition } = await import('../src/screens/competition.js');
const { inspectorIdle } = await import('../src/components/inspector.js');
const { renderRail } = await import('../src/components/rail.js');
const { SCREENS } = await import('../src/lib/router.js');

/* ---------------------------------------------------------------------------
   One bundle carrying every source a screen reads
--------------------------------------------------------------------------- */
function hostileBundle() {
  const base = F.withMonths();
  const recent = F.makeData();                       // dates near "now" for session/crew
  const events = [...recent.events, ...base.events];
  const metrics = { ...base.metrics, ...recent.metrics };
  const locations = [
    { id: 'LR', name: 'Redwood City', code: 'RWC', settings: { max_attendance: 200 } },
    { id: 'LS', name: 'Santa Clara', code: 'SC', settings: { max_attendance: 430 } },
  ];

  // Notes a manager typed on sessions, in both places SAR reads them.
  events[0].notes = 'Fire alarm at 8';
  events[0].promotion_notes = 'Double points night';
  events[1].metadata = { promo_notes: 'Free dauber' };

  const runners = F.withRunners({ ...base, events: recent.events });
  const st = F.withStaff().schedule;
  const inv = F.withInventory().schedule;
  const com = F.withCommission().schedule;
  const notes = F.withNotifications();

  // Scheduler sessions on the recent nights, with the three manager roles, so
  // Managers has people to score and session detail has a scheduler crew.
  const roles = [
    { id: 'R1', name: 'MOD' }, { id: 'R2', name: 'Paymaster' }, { id: 'R3', name: 'Flash Manager' },
    ...st.roles.map((r) => ({ ...r, name: `${r.name} (staff)` })),
  ];
  const staff = [...st.staff, { id: 'S1', name: 'Sagit Ortiz' }, { id: 'S2', name: 'Gina Lowe' }];
  const opsSessions = recent.events.map((e, i) => ({
    id: `os${i}`, hall_id: e.location_id === 'LS' ? 'sc' : 'rwc', session_date: e.event_date,
    part: 'PM', status: 'deployed',
  }));
  const assignments = [
    ...st.assignments,
    ...opsSessions.flatMap((o, i) => ([
      { session_id: o.id, role_id: 'R1', staff_id: i % 3 ? 'S1' : 'S2' },
      { session_id: o.id, role_id: 'R2', staff_id: 'S1' },
    ])),
  ];

  // The data validator: crew names AND roles are free text typed by managers.
  const validatorRows = recent.events.slice(0, 12).map((e, i) => ({
    id: `v${i}`, hall_id: e.location_id === 'LS' ? 'sc' : 'rwc', session_date: e.event_date,
    session_time: '18:30', slot_name: 'Evening', status: 'closed', closed_at: null,
    updated_at: `${e.event_date}T23:00:00Z`, staff_status: i % 2 ? 'approved' : 'progress',
    commission_rate: '0.15', commission_target: '400',
    crew: [
      { name: 'Sagit Ortiz', role: 'MOD', slot: 1 },
      { name: 'Gina Lowe', role: 'Paymaster', slot: 2 },
      { name: p('Robin Vale'), role: p('Caller'), slot: 3 },
      { name: p('Jo'), role: 'Flash Runners', slot: 4 },
    ],
  }));

  const schedule = {
    ok: true, ...st, ...inv, ...com,
    staff: poison(staff), roles, sessions: [...st.sessions, ...com.sessions, ...opsSessions],
    assignments, validator: { ok: true, rows: validatorRows },
  };

  const data = {
    ...base, events, metrics, locations,
    metricDefs: F.TYPED_DEFS.map((d) => ({ ...d })),
    categories: F.CATEGORIES.map((c) => ({ ...c })),
    config: structuredClone(F.CONFIG),
    runners: runners.runners, runnerEvents: runners.runnerEvents,
    promotions: [{ id: 'pr1', name: 'Early bird', description: 'Before 6pm', discount_type: 'percent',
      discount_value: '10', is_active: true, valid_from: '2026-01-01', valid_to: null }],
    notifications: notes.notifications, notificationReads: notes.notificationReads, userId: 'u1',
    monthlySummary: [],
    schedule,
  };

  // Models are built from the clean ids and the poisoned names, exactly as
  // main.js builds them.
  const hallMap = hallMapFromLocations(locations).map;
  // Staff names are free text; the three manager ROLE names are what the
  // model keys on, so roles are poisoned only after the models exist.
  for (const k of ['staff', 'products', 'gameUsage', 'purchaseOrders', 'timeEntries', 'capability']) {
    poison(data.schedule[k], TEXT_ONLY);
  }
  data.crew = buildCrewModel({ validator: schedule.validator, staff: schedule.staff, schedule,
    events: data.events, hallMap });
  data.managers = buildManagerModel({ events: data.events, locations, schedule,
    valuesOf: makeValuesOf(data), crew: data.crew });

  // Display-only text last, so nothing above had to match a poisoned name.
  poison(data.schedule);
  poison(data.runners);
  poison(data.runnerEvents, TEXT_ONLY);
  poison(data.notifications);
  poison(data.promotions);
  poison(data.events);
  poison(data.locations);
  poison(data.categories);
  poison(data.metricDefs);
  data.config.name = p(data.config.name);
  for (const j of data.config.settings.jackpots) j.name = p(j.name);
  return data;
}

const DATA = hostileBundle();

/** Hotball rows from the live fixture, every free-text field poisoned —
 *  including the hall id, which becomes part of a pot's name. */
const HOTBALL_DATA = (() => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/hotball-2026-10-09.json', import.meta.url), 'utf8'))
    .map((r, i) => projectHotballRow({ ...r, slot_name: HOSTILE, override_reason: HOSTILE,
      overridden: i % 7 === 0 ? 'true' : r.overridden, hall_id: i % 2 ? r.hall_id : `${r.hall_id}${HOSTILE}` }));
  const movements = ['payout', 'cash_in', 'cash_out', 'count'].map((kind, i) => projectMovementRow({
    id: i, pot_key: 'mega', movement_date: '2026-10-08', session_time: '18:30', kind, amount: '10', note: HOSTILE }));
  return { ...DATA, schedule: { ...DATA.schedule, ok: true, hotball: { ok: true, rows, movements, movementsOk: true } } };
})();
const hotball = (props) => renderHotball({ ...props, data: HOTBALL_DATA });
const nav = () => {};
const run = (fn, params, data = DATA) => (inspect) => fn({
  data, params, onNavigate: nav, setInspectorContent: inspect,
});

/* ---------------------------------------------------------------------------
   The fixtures really are hostile — otherwise this suite proves nothing
--------------------------------------------------------------------------- */
test('the bundle carries the payload in every class of free text', () => {
  assert.ok(DATA.locations.every((l) => l.name.includes(IMG)), 'hall names');
  assert.ok(DATA.events[0].notes.includes(IMG), 'session notes');
  assert.ok(DATA.categories.every((c) => c.display_name.includes(IMG)), 'category names');
  assert.ok(DATA.schedule.staff.every((s) => s.name.includes(IMG)), 'staff names');
  assert.ok(DATA.schedule.gameUsage.every((g) => g.game.includes(IMG)), 'game names');
  assert.ok(DATA.config.settings.jackpots.every((j) => j.name.includes(IMG)), 'jackpot names');
  const crew = [...DATA.crew.byEvent.values()].flatMap((v) => v.crew);
  assert.ok(crew.some((c) => c.role.includes(IMG)), 'validator crew roles reach the crew model');
  assert.ok(DATA.managers.ok && DATA.managers.people.length, 'managers has people to render');
});

test('the tripwire itself fires on an unescaped value', () => {
  const before = hits.length;
  const el = document.createElement('div');
  where = 'tripwire self-test';
  el.innerHTML = `<p>${HOSTILE}</p>`;
  assert.ok(hits.length > before, 'an unescaped payload must be caught');
  hits.length = before;
});

/* ---------------------------------------------------------------------------
   Every screen, every tab, clean and hostile parameters
--------------------------------------------------------------------------- */
const SESSION_IDS = DATA.events.slice(0, 6).map((e) => e.id);

const CASES = [
  ...SESSION_IDS.flatMap((id) => ['overview', 'performance', 'jackpots', 'summary']
    .map((page) => ['session', renderSession, { id, page }])),
  ['session hostile params', renderSession, hostileParams()],
  ...['all', 'LS', HOSTILE].map((hall) => ['leaderboard', renderLeaderboard, { hall }]),
  ['leaderboard hostile params', renderLeaderboard, hostileParams()],
  ...['LS', 'LR', HOSTILE].map((hall) => ['jackpots', renderJackpots, { hall }]),
  ...['all', 'LS', HOSTILE].map((hall) => ['monthly-pl', renderMonthlyPL, { hall }]),
  ['compare', renderCompare, {}],
  ['compare hostile params', renderCompare, hostileParams()],
  ['venues', renderVenues, {}],
  ['venues hostile params', renderVenues, hostileParams()],
  ['anomaly', renderAnomaly, { days: '365' }],
  ['anomaly hostile params', renderAnomaly, hostileParams()],
  ...['monthly', 'quarterly'].map((mode) => ['reporting', renderReporting, { mode }]),
  ['reporting hostile params', renderReporting, hostileParams()],
  ...RN_TABS.flatMap((t) => [
    ['runners', renderRunners, { tab: t.id, runner: 'r1', event: DATA.runnerEvents[0].event_id, type: 'all' }],
    ['runners hostile', renderRunners, hostileParams({ tab: t.id })],
  ]),
  ...['overview', 'person', 'dayshape', 'coverage'].flatMap((tab) => [
    ['managers', renderManagers, { tab, staff: 'S1', role: 'MOD' }],
    ['managers hostile', renderManagers, hostileParams({ tab })],
  ]),
  ...CHARTS.flatMap((c) => ['combined', 'LS', HOSTILE].map((hall) =>
    ['dashboard', renderDashboard, { chart: c.id, hall, metric: HOSTILE, hide: HOSTILE }])),
  ...VIEWS.flatMap((v) => [
    ['data', renderData, { view: v.id }],
    ['data hostile hall', renderData, { view: v.id, hall: HOSTILE }],
  ]),
  ...INV_TABS.flatMap((t) => [['inventory', renderInventory, { tab: t.id }],
    ['inventory hostile', renderInventory, hostileParams({ tab: t.id })]]),
  ...COM_TABS.flatMap((t) => [['commission', renderCommission, { tab: t.id, flagged: 'on' }],
    ['commission hostile', renderCommission, hostileParams({ tab: t.id })]]),
  ...ST_TABS.flatMap((t) => [['staff', renderStaff, { tab: t.id }],
    ['staff hostile', renderStaff, hostileParams({ tab: t.id })]]),
  ...SRC_TABS.map((t) => ['sources', renderSources, { tab: t.id }]),
  ...PR_TABS.flatMap((t) => [['promotions', renderPromotions, { tab: t.id }],
    ['promotions hostile', renderPromotions, hostileParams({ tab: t.id })]]),
  ['unit-economics', renderUnitEconomics, {}],
  ['unit-economics hostile', renderUnitEconomics, hostileParams()],
  ['forecast', renderForecast, {}],
  ['forecast expenses', renderForecast, { mode: 'expenses', hall: 'LS' }],
  ['forecast hostile', renderForecast, hostileParams()],
  ['ask', renderAsk, {}],
  ['ask hostile', renderAsk, hostileParams()],
  ['notifications', renderNotifications, {}],
  ...['mega', 'rwc_hotball', 'sc_hotball', HOSTILE].map((pot) => ['hotball', hotball, { pot }]),
  ['hotball hostile params', hotball, hostileParams()],
  ['notifications hostile', renderNotifications, hostileParams()],
];

for (const [label, fn, params] of CASES) {
  test(`${label} ${JSON.stringify(params).slice(0, 80)} never turns text into markup`, () => {
    check(label, run(fn, params));
  });
}

test('every routed screen is covered by this suite', () => {
  const covered = new Set(CASES.map(([l]) => l.split(' ')[0]));
  covered.add('competition');                          // below, with a stubbed request
  covered.add('staff-overview');                       // routed id for renderStaff
  const missing = Object.keys(SCREENS).filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], 'add a case for each new screen');
});

test('session crew roles typed in the validator are text, never markup', () => {
  const ev = DATA.events.find((e) => DATA.crew.byEvent.has(e.id));
  assert.ok(ev, 'a session with a validator crew');
  const node = check('session crew', run(renderSession, { id: ev.id }));
  const roles = [...node.querySelectorAll('.crew-role')].map((r) => r.textContent);
  assert.ok(roles.some((r) => r.includes(IMG)), 'the hostile role is shown, as typed');
});

/* ---------------------------------------------------------------------------
   Bingo Scout — the collector is a third party
--------------------------------------------------------------------------- */
test('Bingo Scout escapes collector hall names, counts and messages', async () => {
  const hall = {
    id: 'h1', name: p('Test Hall'), city: p('San Jose'), address: p('1 Main St'),
    location: { lat: 37.33, lng: -121.89 },
    category: p('charity_hall'), operatingStatus: p('open'), website: 'https://example.org/',
    competitionEligibility: { status: 'qualified' }, schedule: { days: ['Friday'], details: p('Fridays') },
    presales: { status: 'available', platform: p('Bingo App'), details: p('Online') },
    publishedPrograms: [{
      title: p('Friday program'), checkedAt: p('2026-01-01'), notes: p('notes'),
      sourceUrl: 'javascript:alert(1)', advertisedTotal: HOSTILE, buyIns: [HOSTILE, 20],
      gameGroups: [{ label: p('Regular'), count: HOSTILE, prize: 100 }],
    }],
  };
  const message = { id: 'm1', hallId: 'h1', channel: 'sms', kind: 'promotion', subject: p('Tonight'),
    body: p('10 games $2,500'), receivedAt: p('2026-10-01T12:00:00Z'), sourceUrl: 'javascript:alert(2)' };
  const snapshot = { halls: [hall], lastSync: HOSTILE, lastEmailSync: HOSTILE,
    summaries: [{ hallId: 'h1', count: HOSTILE, latest: message }] };
  const request = async (path) => (path.includes('hall=') ? { messages: [message], hasMore: true } : snapshot);
  const settle = () => new Promise((r) => setTimeout(r, 30));

  let inspector = '';
  where = 'competition';
  const before = hits.length;
  const root = renderCompetition({ request, params: { hall: 'h1' },
    setInspectorContent: (h) => { inspector = h; } });
  // Deliberately NOT attached to the document: the map code skips a host that
  // is not connected, so Leaflet (which jsdom cannot run) never mounts, and
  // every table, popup-free list and evidence card still renders.
  await settle();
  const visit = async (title) => {
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent === title);
    if (b) b.click();
    await settle();
    scan(root, `after ${title}`);
  };
  // The area list, then the hall's evidence, business model and projection.
  scan(root, 'areas');
  const select = root.querySelector('select[aria-label="Hall"]');
  if (select) { select.value = 'h1'; select.dispatchEvent(new W.Event('change')); await settle(); }
  for (const t of ['Program evidence', 'Use this offer as a scenario starting point', 'Business model', 'Projection', 'Map']) {
    // eslint-disable-next-line no-await-in-loop
    await visit(t);
  }
  const holder = document.createElement('div');
  holder.innerHTML = inspector;
  root.dispose?.();
  const mine = hits.slice(before);
  assert.deepEqual(mine, [], `competition: hostile text became markup:\n  ${mine.join('\n  ')}`);
  assert.match(inspector, /\b0 promotional updates/, 'a non-numeric count is shown as 0, not interpolated');
  assert.equal(root.querySelector('a[href^="javascript"]'), null, 'unsafe source URLs are dropped');
});

/* ---------------------------------------------------------------------------
   The shell: inspector idle state and the rail
--------------------------------------------------------------------------- */
test('the idle inspector and the rail escape route ids, tenant and filter values', () => {
  check('inspector idle', (inspect) => {
    inspect(inspectorIdle({
      screenLabel: HOSTILE,
      description: `No screen called "${HOSTILE}". Showing Dashboard instead.`,
      filters: [{ label: HOSTILE, value: HOSTILE }],
    }));
    return document.createElement('div');
  });
  check('rail', () => renderRail({ active: 'dashboard', customerName: HOSTILE, onNavigate: nav }));
});

/**
 * main.js boots Supabase and cannot be imported under node, so its sinks are
 * checked at the source: the values that come from outside — the route id,
 * an exception message, the signed-in email, a boot status — must be escaped
 * where they are interpolated.
 */
test('main.js escapes the error message, email, status and tenant name it interpolates', () => {
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  for (const raw of ['${ex.message}', '${user.email}', '${status}', '${orgName}', '<h2>${screen.label}']) {
    assert.ok(!src.includes(raw), `main.js interpolates ${raw} without esc()`);
  }
  for (const safe of ['${esc(user.email)}', '${esc(status)}', '${esc(orgName)}']) {
    assert.ok(src.includes(safe), `main.js should interpolate ${safe}`);
  }
  assert.match(src, /status\.textContent = error\.message/, 'login errors must use a text-only sink');
  // The unknown route id goes through inspectorIdle, which escapes (above).
  assert.match(src, /description: route\.unknown/);
});
