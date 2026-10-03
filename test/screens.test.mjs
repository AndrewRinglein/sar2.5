/* ============================================================================
   Screen QA harness

   The substitute for "look at the screenshot" when there is no browser
   available. It renders every built screen against realistic data and asserts
   the things a person notices at a glance:

     · no NaN, undefined, null or "$NaN" reaching the DOM
     · no Infinity from a division by zero
     · no "[object Object]"
     · money always formatted, never a raw cent count
     · totals reconciling between screens
     · every interactive control actually wired

   This does NOT replace a human looking at it — layout, contrast and density
   are invisible here. It replaces the *class* of bug that a glance catches,
   which is the one that has appeared most often on this project.
   ========================================================================== */

import { test } from 'node:test';
import { renderCompetition } from '../src/screens/competition.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { renderSession } from '../src/screens/session.js';
import { renderLeaderboard } from '../src/screens/leaderboard.js';
import { renderJackpots } from '../src/screens/jackpots.js';
import { renderMonthlyPL, monthlyRollup } from '../src/screens/monthly-pl.js';
import { renderCompare } from '../src/screens/compare.js';
import { renderVenues } from '../src/screens/venues.js';
import { renderAnomaly, findAnomalies } from '../src/screens/anomaly.js';
import { renderManagers, makeValuesOf } from '../src/screens/managers.js';
import {
  renderDashboard, CHARTS, twelveMonths, yearOverYear, yoyPairs, yoyTotals,
  ytd, ytdYear, productNet, runnerPoints, runnerCorrelation, jackpotWindow,
} from '../src/screens/dashboard.js';
import { monthSeries } from '../src/lib/charts.js';
import {
  renderData, VIEWS, sheetRows, dailyColumns, monthlyColumns,
  cellValue, sheetCsv, tableCsv, reconcile,
} from '../src/screens/data.js';
import { parseCsv } from '../src/lib/csv.js';
import {
  renderInventory, TABS as INV_TABS, onHand, cents, valueOf,
  stockByHall, stockByProduct, usageByProduct, atRisk,
} from '../src/screens/inventory.js';
import {
  renderCommission, TABS as COM_TABS, sessionRows, peopleRows, poolFor,
  implausible, toCents, PLAUSIBLE,
} from '../src/screens/commission.js';
import { renderStaff, TABS as ST_TABS, rosterRows, coverage, hoursByPerson, neverScheduled }
  from '../src/screens/staff.js';
import { renderSources, TABS as SRC_TABS, sourceList, HAZARDS } from '../src/screens/sources.js';
import { renderPromotions, TABS as PR_TABS, noteRows } from '../src/screens/promotions.js';
import {
  renderUnitEconomics, ASSUMPTIONS, loadAssumptions, costOfGoods, sessionEconomics,
  hoursBySession,
} from '../src/screens/unit-economics.js';
import {
  renderForecast,
} from '../src/screens/forecast.js';
import {
  renderAsk, buildContext, answerLocally, askClaude, SUGGESTIONS, splitBasis, conversation, resetConversation,
} from '../src/screens/ask.js';
import {
  renderNotifications, withReadState, unreadCount, filterRows, groupCounts,
  humanType, TYPE_GROUPS, SEVERITIES,
} from '../src/screens/notifications.js';
import { esc } from '../src/lib/fmt.js';
import { COLUMNS as OPS_COLUMNS } from '../src/lib/ops.js';
import { buildManagerModel } from '../src/lib/managers.js';
import { welchT, effectSize, significance } from '../src/lib/model.js';
import { indexMetrics, sessionTotals, metricsFor } from '../src/lib/model.js';
import {
  CATEGORIES, METRIC_DEFS, idx, byKey, LOCS, CONFIG, TYPED_DEFS, makeData,
  withRunners, withManagers, withMonths, withInventory, withCommission,
  withStaff, withPromoNotes, withNotifications,
} from './fixtures/screen-data.mjs';

/* ---------------------------------------------------------------------------
   A DOM, and data shaped exactly like production
--------------------------------------------------------------------------- */
const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;


/* ---------------------------------------------------------------------------
   The checks a glance would make
--------------------------------------------------------------------------- */
/**
 * Patterns that mean something broke, as word-boundary regexes.
 *
 * The first version used plain substrings, and `'e-'` matched the word
 * "re-sort" in the inspector's own help text. A check that fires on ordinary
 * English is worse than no check: it trains you to ignore it.
 */
const FORBIDDEN = [
  [/\bNaN\b/, 'NaN'],
  [/\bundefined\b/, 'undefined'],
  [/\bnull\b/, 'null'],
  [/\bInfinity\b/, 'Infinity'],
  [/\[object \w+\]/, '[object Object]'],
  [/\d[eE][+-]\d/, 'scientific notation'],   // 1.5e+21 reaching the screen
  [/\$-/, '$- (sign after the currency symbol)'],
];

/**
 * Text as a READER sees it, with a space between separate elements.
 *
 * `node.textContent` runs adjacent cells together, so a table cell reading
 * "$367" followed by the next row's row-number "16" concatenates to "$36716"
 * and trips the unformatted-money check. That is a phantom: neither cell is
 * wrong. Joining text nodes with a space is what the eye actually does, and it
 * removes a whole class of false positives — and false negatives, since a
 * genuine "$3322900" is still one text node.
 */
function readableText(node) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue); return; }
    // Elements marked `data-raw` hold literal data shown on purpose — the Ask
    // screen prints the exact JSON payload, and JSON contains `null`. Reading
    // it as rendered copy turns correct output into a false failure.
    if (n.nodeType === 1 && n.hasAttribute?.('data-raw')) { out.push(' '); return; }
    for (const c of n.childNodes ?? []) walk(c);
    out.push(' ');
  };
  walk(node);
  return out.join(' ');
}

function inspect(node, label) {
  const text = readableText(node).replace(/\s+/g, ' ');
  for (const [re, name] of FORBIDDEN) {
    const m = text.match(re);
    assert.ok(!m, `${label}: rendered ${name} — "${
      text.slice(Math.max(0, m?.index - 60), (m?.index ?? 0) + 40)}"`);
  }
  // A raw cent count leaking past the formatter: "$3322900" not "$33,229".
  const raw = text.match(/\$\d{5,}(?!,)/);
  assert.ok(!raw, `${label}: unformatted money "${raw?.[0]}"`);
  return text;
}

function render(fn, data, params = {}, { onNavigate = () => {} } = {}) {
  let inspectorHtml = '';
  const node = fn({
    data, params,
    onNavigate,
    setInspectorContent: (h) => { inspectorHtml = h; },
  });
  const holder = document.createElement('div');
  holder.innerHTML = inspectorHtml;
  return { node, inspector: holder };
}

/* ---------------------------------------------------------------------------
   Session detail
--------------------------------------------------------------------------- */

test('session detail renders cleanly on realistic data', () => {
  const data = makeData();
  const { node, inspector } = render(renderSession, data);
  inspect(node, 'session');
  inspect(inspector, 'session inspector');
});

test('session detail survives a session with NO recorded attendance', () => {
  // e3 has no attendance metric at all. RPA must be a dash, not $0 or NaN.
  const data = makeData();
  const { node } = render(renderSession, data, { id: 'e3' });
  const text = inspect(node, 'session (no attendance)');
  assert.ok(text.includes('—'), 'expected a dash for the unmeasured value');
});

test('session detail survives an all-zero session', () => {
  const data = makeData({ degenerate: true });
  const { node, inspector } = render(renderSession, data);
  inspect(node, 'session (zeros)');
  inspect(inspector, 'session inspector (zeros)');
});

test('session detail survives having only one session', () => {
  // Pool of zero. Every comparison must withhold rather than divide by nothing.
  const data = makeData();
  data.events = data.events.slice(0, 1);
  const { node } = render(renderSession, data);
  inspect(node, 'session (single)');
});

test('session detail survives NO sessions at all', () => {
  const data = makeData();
  data.events = [];
  data.metrics = {};
  const { node } = render(renderSession, data);
  inspect(node, 'session (empty)');
});

test('session picker cards are all clickable', () => {
  const data = makeData();
  const { node } = render(renderSession, data);
  const cards = node.querySelectorAll('.sess-card');
  assert.ok(cards.length >= 6, `expected at least 6 cards, got ${cards.length}`);
  for (const c of cards) assert.ok(c.dataset.id, 'card has no session id');
});

test('the gremlin never gets a thermometer', () => {
  // It is a payout that happens, not a pot that builds.
  const data = makeData();
  const { node } = render(renderSession, data, { id: 'e5' });   // e5 has a gremlin payout
  const line = node.querySelector('.jp-line');
  assert.ok(line, 'gremlin line missing');
  assert.equal(line.querySelector('.jp-track'), null, 'gremlin must not have a fill bar');
  assert.ok(line.textContent.includes('Gremlin'));
});

/* ---------------------------------------------------------------------------
   Leaderboard
--------------------------------------------------------------------------- */

test('leaderboard renders cleanly', () => {
  const data = makeData();
  const { node, inspector } = render(renderLeaderboard, data);
  inspect(node, 'leaderboard');
  inspect(inspector, 'leaderboard inspector');
});

test('EVERY row carries a card for EVERY metric, and each card sorts', () => {
  // The structural requirement, taken from SAR 1.0: the metrics live IN the
  // rows. There is no strip of sort buttons above the board.
  const data = makeData();
  const { node } = render(renderLeaderboard, data);
  const rows = node.querySelectorAll('.lb-row');
  assert.ok(rows.length > 0);
  const expected = 5 + CATEGORIES.length;          // 5 universal + one per category
  for (const r of rows) {
    assert.equal(r.querySelectorAll('.mcard').length, expected);
  }
  // and none of them is an inert label
  for (const c of node.querySelectorAll('.mcard')) {
    assert.equal(c.tagName, 'BUTTON', 'a metric card must be clickable');
    assert.ok(c.dataset.aspect, 'a metric card must name the aspect it sorts by');
  }
});

test('there is NO separate strip of sort chips above the board', () => {
  // Built that way twice; it is not the design.
  const { node } = render(renderLeaderboard, makeData());
  assert.equal(node.querySelectorAll('.aspects').length, 0);
});

test('the sorted metric is highlighted in every row, once per row', () => {
  const data = makeData();
  const { node } = render(renderLeaderboard, data, { aspect: 'margin' });
  for (const r of node.querySelectorAll('.lb-row')) {
    const active = r.querySelectorAll('.mcard.is-active');
    assert.equal(active.length, 1);
    assert.equal(active[0].dataset.aspect, 'margin');
  }
});

test('rows are actually ordered by the chosen metric', () => {
  const data = makeData();
  const { node } = render(renderLeaderboard, data, { aspect: 'attendance', dir: 'desc' });
  const vals = [...node.querySelectorAll('.lb-row')].map((r) => {
    const c = r.querySelector('.mcard.is-active .mcard-value');
    return Number(c.textContent.replace(/[^0-9.-]/g, '')) || null;
  }).filter((v) => v !== null);
  for (let i = 1; i < vals.length; i++) {
    assert.ok(vals[i - 1] >= vals[i], `not descending at row ${i}`);
  }
});

test('every metric can be sorted by without breaking a row', () => {
  const data = makeData();
  for (const key of ['netSales', 'totalSales', 'margin', 'rpa', 'attendance',
                     'flash', 'strip', 'other']) {
    const { node } = render(renderLeaderboard, data, { aspect: key });
    inspect(node, `leaderboard[${key}]`);
  }
});

test('leaderboard handles an empty period without collapsing', () => {
  const data = makeData();
  data.events = [];
  const { node } = render(renderLeaderboard, data, { period: '30' });
  const text = inspect(node, 'leaderboard (empty)');
  assert.ok(text.includes('No sessions'), 'expected an explicit empty state');
});

test('the session name opens the session', () => {
  const data = makeData();
  const { node } = render(renderLeaderboard, data);
  assert.ok(node.querySelectorAll('.lb-name').length > 0);
});

/* ---------------------------------------------------------------------------
   Cross-screen reconciliation — IMPL §7.2
--------------------------------------------------------------------------- */

test('the same session reports the same gross on both screens', () => {
  // SAR 1.0 has two net-revenue calculations that disagree (SPEC §19.5).
  // This is the check that stops that happening again.
  const data = makeData();
  const target = data.events[0];

  const expected = sessionTotals(metricsFor(target.id, data.metrics, data.idx),
                                 data.categories).revenue;

  const { node: sess } = render(renderSession, data, { id: target.id });
  const { node: lb } = render(renderLeaderboard, data, { aspect: 'gross', period: 'all' });

  const money = (t) => (t.match(/\$[\d,]+/g) ?? []);
  const fmt = new Intl.NumberFormat('en-US',
    { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(expected / 100);

  assert.ok(money(sess.textContent).includes(fmt),
    `session detail should show ${fmt}`);
  assert.ok(money(lb.textContent).includes(fmt),
    `leaderboard should show the same ${fmt}`);
});

/* ---------------------------------------------------------------------------
   Jackpots
--------------------------------------------------------------------------- */

test('jackpots screen renders cleanly', () => {
  const data = makeData();
  const { node, inspector } = render(renderJackpots, data, { hall: 'LR' });
  inspect(node, 'jackpots');
  inspect(inspector, 'jackpots inspector');
});

test('jackpots survives all-zero balances', () => {
  const { node } = render(renderJackpots, makeData({ degenerate: true }), { hall: 'LR' });
  inspect(node, 'jackpots (zeros)');
});

test('the gremlin panel has no thermometer anywhere', () => {
  const data = makeData();
  const { node } = render(renderJackpots, data, { hall: 'LS' });
  const panels = [...node.querySelectorAll('.panel')];
  const gremlin = panels.find((p) => p.textContent.includes('Gremlin'));
  assert.ok(gremlin, 'gremlin panel missing');
  assert.equal(gremlin.querySelector('.jp-track'), null,
    'the gremlin must never get a fill bar — it has no balance');
});

test('both configured progressives get a card, and only those two', () => {
  const data = makeData();
  const { node } = render(renderJackpots, data, { hall: 'LR' });
  assert.equal(node.querySelectorAll('.jp-track').length, 2);
});

/* ---------------------------------------------------------------------------
   Monthly P&L
--------------------------------------------------------------------------- */

test('monthly P&L renders cleanly', () => {
  const data = makeData();
  const { node, inspector } = render(renderMonthlyPL, data);
  inspect(node, 'monthly-pl');
  inspect(inspector, 'monthly-pl inspector');
});

test('the expense rows are empty, never zero', () => {
  // A zero would read as "we spent nothing". There is no expense data in
  // production at all.
  const data = makeData();
  const { node } = render(renderMonthlyPL, data);
  const text = node.textContent;
  assert.ok(text.includes('not held in this database'));
  assert.ok(!/Operating expenses[\s\S]{0,40}\$0/.test(text),
    'expenses must not render as $0');
});

test('a partial month is never compared against a complete one', () => {
  // SPEC §19 — a fake -67% came from plotting a third of a month as if whole.
  const rows = monthlyRollup(
    [{ id: 'a', location_id: 'LR', event_date: '2026-08-01', event_type: 'regular' },
     { id: 'b', location_id: 'LR', event_date: '2026-07-01', event_type: 'regular' }],
    { a: {}, b: {} }, idx, CATEGORIES, { today: '2026-08-13' });
  const aug = rows.find((r) => r.month === '2026-08');
  const jul = rows.find((r) => r.month === '2026-07');
  assert.equal(aug.partial, true);
  assert.equal(jul.partial, false);
});

test('months come back newest first', () => {
  const data = makeData();
  const rows = monthlyRollup(data.events, data.metrics, data.idx, data.categories,
    { today: '2026-08-13' });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].month > rows[i].month, 'months out of order');
  }
});

test('monthly category nets sum to the monthly net', () => {
  const data = makeData();
  const rows = monthlyRollup(data.events, data.metrics, data.idx, data.categories,
    { today: '2026-08-13' });
  for (const m of rows) {
    assert.equal(m.categories.reduce((s, c) => s + c.net, 0), m.net,
      `${m.month}: category nets do not reconcile`);
  }
});

/* ---------------------------------------------------------------------------
   Compare, Venues, Anomalies
--------------------------------------------------------------------------- */

test('compare renders cleanly', () => {
  const { node, inspector } = render(renderCompare, makeData());
  inspect(node, 'compare');
  inspect(inspector, 'compare inspector');
});

test('compare withholds a verdict when a group is tiny', () => {
  const data = makeData();
  data.events = data.events.slice(0, 4);
  const { node } = render(renderCompare, data);
  const text = inspect(node, 'compare (small)');
  assert.ok(/Not enough sessions|theatre/.test(text));
});

test("Welch's t agrees with a hand-checked example", () => {
  // Two clearly different groups: p must be small and the effect large.
  const A = [100, 102, 98, 101, 99, 103];
  const B = [200, 198, 202, 199, 201, 197];
  const r = welchT(A, B);
  assert.equal(r.enough, true);
  assert.ok(r.p < 0.001, `p was ${r.p}`);
  assert.equal(significance(r.p), 'very strong');
  assert.equal(effectSize(r.cohensD), 'large');
  // means are 100.5 and 199.5, so the difference is -99 exactly.
  // This assertion first read -100, from assuming round means rather than
  // adding the six numbers up. Second time on this project that a test caught
  // my arithmetic and not the code's — which is what independent expected
  // values are for.
  assert.equal(r.diff, -99);
  assert.equal(r.df, 10);
});

test("Welch's t finds nothing between identical groups", () => {
  const A = [100, 102, 98, 101, 99, 103];
  const r = welchT(A, [...A]);
  assert.ok(r.p > 0.9, `p was ${r.p}`);
  assert.equal(significance(r.p), 'none');
  assert.equal(effectSize(r.cohensD), 'negligible');
});

test('a group with no variance does not produce a divide-by-zero', () => {
  const r = welchT([5, 5, 5, 5], [5, 5, 5, 5]);
  assert.equal(r.enough, false);
});

test('venues renders cleanly and covers both halls', () => {
  const data = makeData();
  const { node, inspector } = render(renderVenues, data);
  const text = inspect(node, 'venues');
  inspect(inspector, 'venues inspector');
  assert.ok(text.includes('Redwood City') && text.includes('Santa Clara'));
});

test('venues survives no sessions', () => {
  const data = makeData();
  data.events = [];
  const { node } = render(renderVenues, data);
  inspect(node, 'venues (empty)');
});

test('anomalies renders cleanly', () => {
  const { node, inspector } = render(renderAnomaly, makeData());
  inspect(node, 'anomaly');
  inspect(inspector, 'anomaly inspector');
});

test('a missing attendance is flagged as a data fault, not an outlier', () => {
  // e3 has no attendance recorded at all.
  const found = findAnomalies(makeData(), { days: 3650 });
  const structural = found.filter((f) => f.kind === 'structural');
  assert.ok(structural.some((f) => f.label === 'Attendance not recorded'),
    'expected the unrecorded attendance to be reported');
});

test('a clean dataset produces no statistical findings', () => {
  // Every session identical -> zero variance -> nothing can be an outlier.
  const data = makeData();
  for (const id of Object.keys(data.metrics)) {
    data.metrics[id] = { ...data.metrics[Object.keys(data.metrics)[0]] };
  }
  const found = findAnomalies(data, { days: 3650 })
    .filter((f) => f.kind === 'statistical');
  assert.equal(found.length, 0, 'flat data should yield no outliers');
});

test('anomaly findings are ranked worst first', () => {
  const found = findAnomalies(makeData(), { days: 3650 });
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].score >= found[i].score, 'findings out of order');
  }
});

/* ---------------------------------------------------------------------------
   Reporting — SPEC §8a
--------------------------------------------------------------------------- */
const RP = await import('../src/screens/reporting.js');

test('reporting renders cleanly', () => {
  const { node, inspector } = render(RP.renderReporting, makeData());
  inspect(node, 'reporting');
  inspect(inspector, 'reporting inspector');
});

test('SESSION COUNT is the number of sessions, not of metric rows', () => {
  // SPEC §8a.6 — this is the denominator of five other figures and is printed
  // twice. Counting join rows has already produced three wrong answers here.
  const data = makeData();
  const periods = RP.buildPeriods(data.events, data, { hall: 'all', mode: 'monthly' });
  const counted = periods.reduce((s, p) => s + p.metrics.eventCount, 0);
  assert.equal(counted, data.events.length);
  for (const p of periods) assert.equal(p.metrics.eventCount, p.events.length);
});

test('a period with no sessions yields nulls, never NaN', () => {
  // SAR 1.0 divides by eventCount unguarded and renders $NaN.
  const m = RP.periodMetrics([], { metrics: {}, idx, categories: CATEGORIES });
  assert.equal(m.eventCount, 0);
  assert.equal(m.profitPerEvent, null);
  assert.equal(m.salesPerEvent, null);
  assert.equal(m.margin, null);
  assert.equal(m.rpa, null);
  assert.equal(m.attendancePerEvent, null);
});

test('period totals reconcile to the sum of their sessions', () => {
  const data = makeData();
  const periods = RP.buildPeriods(data.events, data, {});
  const gross = periods.reduce((s, p) => s + p.metrics.totalSales, 0);
  const expected = data.events.reduce((s, e) =>
    s + sessionTotals(metricsFor(e.id, data.metrics, data.idx), data.categories).revenue, 0);
  assert.equal(gross, expected);
});

test('net is sales minus payouts, in every period', () => {
  for (const p of RP.buildPeriods(makeData().events, makeData(), {})) {
    assert.equal(p.metrics.netSales, p.metrics.totalSales - p.metrics.totalPayouts);
  }
});

test('a zero baseline gives no change indicator rather than infinity', () => {
  assert.equal(RP.percentChange(100, 0), null);
  assert.equal(RP.percentChange(100, null), null);
  assert.equal(RP.percentChange(150, 100), 0.5);
});

test('margin and attendance change in POINTS, not percent', () => {
  // SPEC §8a.4 — they are already rates, so the change is a subtraction.
  // 25% against 20% is +5 POINTS, not +25%.
  assert.ok(Math.abs(RP.pointChange(0.25, 0.20) - 0.05) < 1e-9);
  assert.ok(Math.abs(RP.percentChange(0.25, 0.20) - 0.25) < 1e-9);
  assert.equal(RP.pointChange(0.25, null), null);
});

test('ORACLE: reporting capacity sums each hall\'s own seats (SC 430 + RWC 200), as SAR 1.0', () => {
  const d = withMonths();
  d.locations = d.locations.map((l) => ({ ...l, settings: { max_attendance: l.id === 'LS' ? 430 : 200 } }));
  const evs = d.events.filter((e) => e.event_date.startsWith('2025-01'));
  const m = RP.periodMetrics(evs, d);
  const sc = evs.filter((e) => e.location_id === 'LS').length;
  const rwc = evs.length - sc;
  assert.equal(m.totalCapacity, sc * 430 + rwc * 200);
});

test('an in-progress period suppresses ABSOLUTE comparisons but keeps rates', () => {
  // SPEC §8a.5 — a third of a month against a whole one is meaningless, but
  // margin and RPA are rates and stay valid mid-period.
  const prior = { metrics: { totalSales: 100, totalPayouts: 60, netSales: 40,
    margin: 0.4, rpa: 500, attendance: 200, attendancePercent: 0.6, profitPerEvent: 10 } };
  const partial = { inProgress: true, metrics: { totalSales: 30, totalPayouts: 18,
    netSales: 12, margin: 0.4, rpa: 520, attendance: 60, attendancePercent: 0.62,
    profitPerEvent: 11 } };
  const c = RP.changesFor(partial, prior);
  assert.equal(c.totalSales, null);
  assert.equal(c.totalPayouts, null);
  assert.equal(c.netSales, null);
  assert.equal(c.attendance, null);
  assert.ok(c.rpa !== null, 'RPA is a rate and must still compare');
  assert.ok(c.attendancePercent !== null, 'attendance % is a rate');
});

test('a complete period compares everything', () => {
  const prior = { metrics: { totalSales: 100, totalPayouts: 60, netSales: 40,
    margin: 0.4, rpa: 500, attendance: 200, attendancePercent: 0.6, profitPerEvent: 10 } };
  const done = { inProgress: false, metrics: { totalSales: 120, totalPayouts: 70,
    netSales: 50, margin: 0.42, rpa: 520, attendance: 220, attendancePercent: 0.62,
    profitPerEvent: 12 } };
  const c = RP.changesFor(done, prior);
  assert.ok(Math.abs(c.totalSales - 0.2) < 1e-9);
  assert.ok(Math.abs(c.netSales - 0.25) < 1e-9);
});

test('every column carries all eight boxes, and each one opens', () => {
  const { node } = render(RP.renderReporting, makeData());
  const cols = node.querySelectorAll('.rp-col');
  assert.ok(cols.length > 0);
  for (const c of cols) {
    const boxes = c.querySelectorAll('.rp-box');
    assert.equal(boxes.length, 8, 'eight boxes per column');
    for (const b of boxes) {
      assert.equal(b.tagName, 'BUTTON', 'the whole box must be the target');
      assert.ok(b.querySelector('.rp-detail'), 'every box has an expansion');
    }
  }
});

test('all eight boxes are coloured, none left plain', () => {
  const { node } = render(RP.renderReporting, makeData());
  const tones = ['rp-sales', 'rp-payouts', 'rp-net', 'rp-products',
                 'rp-margin', 'rp-rpa', 'rp-profit', 'rp-attendance'];
  const col = node.querySelector('.rp-col');
  for (const t of tones) {
    assert.ok(col.querySelector(`.${t}`), `missing coloured box: ${t}`);
  }
});

test('the header states the session count', () => {
  const { node } = render(RP.renderReporting, makeData());
  const head = node.querySelector('.rp-count');
  assert.ok(/\d+\s+sessions?/.test(head.textContent), head.textContent);
});

test('quarterly groups months into quarters', () => {
  const data = makeData();
  const months = RP.buildPeriods(data.events, data, { mode: 'monthly' });
  const quarters = RP.buildPeriods(data.events, data, { mode: 'quarterly' });
  assert.ok(quarters.length <= months.length);
  // No session is lost or double-counted in the regrouping.
  assert.equal(quarters.reduce((s, p) => s + p.metrics.eventCount, 0),
               months.reduce((s, p) => s + p.metrics.eventCount, 0));
});

test('periods run oldest first, so changes compare against the prior one', () => {
  const periods = RP.buildPeriods(makeData().events, makeData(), {});
  for (let i = 1; i < periods.length; i++) {
    assert.ok(periods[i - 1].key < periods[i].key, 'periods out of order');
  }
});

test('filtering by hall changes the session count', () => {
  const data = makeData();
  const all = RP.buildPeriods(data.events, data, { hall: 'all' })
    .reduce((s, p) => s + p.metrics.eventCount, 0);
  const one = RP.buildPeriods(data.events, data, { hall: 'LR' })
    .reduce((s, p) => s + p.metrics.eventCount, 0);
  assert.ok(one > 0 && one < all, `expected a subset, got ${one} of ${all}`);
});

test('the Products box lists category shares, it does not count them', () => {
  // Second pass against SAR 1.0 found this: collapsed it shows one line per
  // category with its % of sales, filtered to those that show RPA or margin.
  const { node } = render(RP.renderReporting, makeData());
  const box = node.querySelector('.rp-products');
  assert.ok(box, 'products box missing');
  const shares = box.querySelectorAll('.rp-share');
  assert.ok(shares.length > 0, 'expected a line per category');
  assert.ok(!/\d+ categories/.test(box.textContent), 'must not be a count');
  // `other` shows neither RPA nor margin, so it is excluded from the summary
  // but still present in the expansion.
  const summary = [...shares].map((s) => s.textContent).join(' ');
  assert.ok(!summary.includes('Other'), 'Other should not be in the summary');
  assert.ok(box.querySelector('.rp-detail').textContent.includes('Other'),
    'Other should still appear in the expansion');
});

test('sound is available, respects a preference, and never throws', async () => {
  const s = await import('../src/lib/sound.js');
  assert.equal(typeof s.play, 'function');
  s.setEnabled(false);
  assert.equal(s.isEnabled(), false);
  s.play('expand');                 // silent, and must not throw
  s.setEnabled(true);
  assert.equal(s.isEnabled(), true);
  s.play('expand');                 // no AudioContext in node: still no throw
  s.play('nonsense-name');
});

test('every reporting box detail is present in the DOM even when collapsed', () => {
  // Expansion is a `hidden` attribute, not a re-render, so opening a box is
  // instant and the content is searchable by the browser's find.
  const { node } = render(RP.renderReporting, makeData());
  const box = node.querySelector('.rp-box');
  const detail = box.querySelector('.rp-detail');
  assert.ok(detail, 'detail missing');
  assert.ok(detail.hasAttribute('hidden'), 'should start collapsed');
  assert.ok(detail.textContent.trim().length > 0, 'detail should be populated');
});

test('reporting survives a hall with a single session', () => {
  const data = makeData();
  data.events = data.events.slice(0, 1);
  const { node } = render(RP.renderReporting, data);
  inspect(node, 'reporting (one session)');
});

test('reporting survives zero sessions with an explicit empty state', () => {
  const data = makeData();
  data.events = [];
  const { node } = render(RP.renderReporting, data);
  const text = inspect(node, 'reporting (empty)');
  assert.ok(text.includes('No sessions recorded'));
});

test('reporting survives all-zero money', () => {
  const { node } = render(RP.renderReporting, makeData({ degenerate: true }));
  inspect(node, 'reporting (zeros)');
});

/* ---------------------------------------------------------------------------
   Runners — SPEC §9
--------------------------------------------------------------------------- */
const RN = await import('../src/screens/runners.js');


test('runners renders cleanly on all three tabs', () => {
  const d = withRunners();
  for (const tab of ['comparison', 'profile', 'breakdown']) {
    const { node, inspector } = render(RN.renderRunners, d, { tab, type: 'all' });
    inspect(node, `runners[${tab}]`);
    inspect(inspector, `runners inspector[${tab}]`);
  }
});

test('SELL-THROUGH IS A RATIO OF SUMS, not a mean of ratios', () => {
  // SPEC §9.4. One tiny perfect night and one large poor night is NOT 80%.
  const evs = [
    { tickets_checked_out: 10, tickets_sold: 10 },     // 100%
    { tickets_checked_out: 1000, tickets_sold: 600 },  // 60%
  ];
  const s = RN.runnerStats(evs);
  // Ratio of sums: 610 / 1010 = 60.4%. Mean of ratios would say 80%.
  assert.ok(Math.abs(s.avgSellThrough - 610 / 1010) < 1e-12);
  assert.ok(s.avgSellThrough < 0.61, `got ${s.avgSellThrough}, mean-of-ratios bug gives 0.8`);
});

test('sell-through of nothing taken out is null, not 0%', () => {
  assert.equal(RN.sellThrough(0, 0), null);
  assert.equal(RN.sellThrough(null, 5), null);
  assert.equal(RN.sellThrough(100, 90), 0.9);
});

test('sell-through bands are 90 and 70', () => {
  assert.equal(RN.sellThroughBand(0.95), 'good');
  assert.equal(RN.sellThroughBand(0.90), 'good');
  assert.equal(RN.sellThroughBand(0.80), 'fair');
  assert.equal(RN.sellThroughBand(0.70), 'fair');
  assert.equal(RN.sellThroughBand(0.69), 'poor');
  assert.equal(RN.sellThroughBand(null), null);
});

test('comparison table has SAR 1.0 columns, in order', () => {
  const { node } = render(RN.renderRunners, withRunners(), { tab: 'comparison', type: 'all' });
  const heads = [...node.querySelectorAll('.rn-table th')].map((t) => t.textContent.trim().replace(/[▲▼]/g, '').trim());
  assert.deepEqual(heads, ['#', 'Runner', 'Events', 'Tickets Sold', 'Tickets Out',
    'Avg Sell-Through', 'Total Revenue', 'Avg Revenue/Event']);
});

test('event breakdown has SAR 1.0 columns and ends with a TOTAL row', () => {
  const d = withRunners();
  const evId = d.runnerEvents[0].event_id;
  const { node } = render(RN.renderRunners, d, { tab: 'breakdown', event: evId, type: 'all' });
  const heads = [...node.querySelectorAll('.rn-table th')]
    .map((t) => t.textContent.replace(/[▲▼]/g, '').trim());
  // Updated: SPEC §9.4 lists `expected` and `overShort` among the runner
  // formulas, and SAR 1.0's analytics never showed them (the formula lived
  // only in the data-entry form, with the §19.10 price fallback). They now
  // sit beside Cash, the figure they explain. SAR 1.0's eleven columns are
  // otherwise unchanged and in SAR 1.0's order.
  assert.deepEqual(heads, ['Runner', 'Type', 'Tickets Out', 'Sold', 'Returned',
    'Unsold', 'Cash', 'Expected', 'Over/Short', 'Credit', 'Revenue', 'Sell-Through', 'Restocks']);
  // Exactly ONE column may carry a sort arrow. `c.key === sortKey` was true
  // for undefined === undefined, so every header was marked.
  assert.equal(node.querySelectorAll('.rn-table th.is-sorted').length, 1);
  const total = node.querySelector('tr.rn-total');
  assert.ok(total, 'TOTAL row missing');
  assert.ok(total.textContent.includes('TOTAL'));
});

test('the TOTAL row sums its own table', () => {
  const d = withRunners();
  const evId = d.runnerEvents[0].event_id;
  const rows = d.runnerEvents.filter((e) => e.event_id === evId);
  const expectedOut = rows.reduce((s, e) => s + e.tickets_checked_out, 0);
  const { node } = render(RN.renderRunners, d, { tab: 'breakdown', event: evId, type: 'all' });
  const cells = [...node.querySelector('tr.rn-total').children].map((c) => c.textContent.trim());
  assert.equal(cells[2], String(expectedOut));
});

test('profile shows the five summary cards and best/worst by revenue', () => {
  const d = withRunners();
  const { node } = render(RN.renderRunners, d, { tab: 'profile', runner: 'r1', type: 'all' });
  const text = node.textContent;
  for (const label of ['Events Worked', 'Total Revenue', 'Avg Rev/Event',
                       'Best Event', 'Worst Event', 'Sell-Through']) {
    assert.ok(text.includes(label), `missing card: ${label}`);
  }
});

test('Floor and Desk are separated by is_flash_desk', () => {
  const d = withRunners();
  const floor = render(RN.renderRunners, d, { tab: 'comparison', type: 'floor' }).node;
  const desk = render(RN.renderRunners, d, { tab: 'comparison', type: 'desk' }).node;
  assert.ok(floor.textContent.includes('Alice') && !floor.textContent.includes('Bob'));
  assert.ok(desk.textContent.includes('Bob') && !desk.textContent.includes('Alice'));
});

test('an inactive runner is absent from the data, not merely from the picker', () => {
  // SPEC §19a — SAR 1.0 hides them from the dropdown but still counts them.
  // api.getRunners filters the events; here the screen must not resurrect one.
  const d = withRunners();
  d.runners = d.runners.filter((r) => r.id !== 'r2');
  d.runnerEvents = d.runnerEvents.filter((e) => e.runner_id !== 'r2');
  const { node } = render(RN.renderRunners, d, { tab: 'comparison', type: 'all' });
  assert.ok(!node.textContent.includes('Bob'));
});

test('an empty date range says so rather than showing an empty table', () => {
  const { node } = render(RN.renderRunners, withRunners(),
    { tab: 'comparison', from: '2030-01-01', to: '2030-12-31', type: 'all' });
  assert.ok(node.textContent.includes('No runner data found for this date range'));
});

test('runners survives having no runner data at all', () => {
  const d = makeData();
  d.runners = []; d.runnerEvents = [];
  for (const tab of ['comparison', 'profile', 'breakdown']) {
    const { node } = render(RN.renderRunners, d, { tab });
    inspect(node, `runners empty[${tab}]`);
  }
});

test('exactly one column is marked sorted, on every runners table', () => {
  const d = withRunners();
  const cases = [
    { tab: 'comparison', type: 'all' },
    { tab: 'profile', runner: 'r1', type: 'all' },
    { tab: 'breakdown', event: d.runnerEvents[0].event_id, type: 'all' },
  ];
  for (const p of cases) {
    const { node } = render(RN.renderRunners, d, p);
    assert.equal(node.querySelectorAll('.rn-table th.is-sorted').length, 1,
      `${p.tab}: expected exactly one sorted column`);
  }
});

test('every runners table header is clickable to sort', () => {
  const d = withRunners();
  const { node } = render(RN.renderRunners, d,
    { tab: 'breakdown', event: d.runnerEvents[0].event_id, type: 'all' });
  const heads = [...node.querySelectorAll('.rn-table th')];
  assert.equal(heads.filter((x) => x.dataset.sort).length, heads.length);
});

test('sell-through above 100% is allowed and reads as good', () => {
  // Real production behaviour: restocks are not added to tickets_checked_out,
  // so most runners exceed 100%. Nathan is 103.9% across 196 sessions.
  const s = RN.runnerStats([{ tickets_checked_out: 1744281, tickets_sold: 1812426 }]);
  assert.ok(s.avgSellThrough > 1, 'must not be clamped to 100%');
  assert.equal(RN.sellThroughBand(s.avgSellThrough), 'good');
});

test('the fleet average matches production for a known runner', () => {
  // Abygail: 967,570 out and 821,983 sold across 134 sessions -> 85.0%.
  const s = RN.runnerStats([{ tickets_checked_out: 967570, tickets_sold: 821983 }]);
  assert.equal((s.avgSellThrough * 100).toFixed(1), '85.0');
});


/* ===========================================================================
   Managers — MANAGERS DESIGN
=========================================================================== */


for (const tab of ['overview', 'person', 'dayshape']) {
  test(`managers ${tab} renders cleanly`, () => {
    const d = withManagers();
    const { node, inspector } = render(renderManagers, d,
      { tab, staff: 'S1', role: 'MOD' });
    inspect(node, `managers ${tab}`);
    inspect(inspector, `managers ${tab} inspector`);
  });
}

test('managers explains itself rather than rendering blank', () => {
  const d = { ...makeData(), managers: { ok: false, reason: 'anonymous client' } };
  const { node } = render(renderManagers, d, {});
  // No `needsSignIn`, so this is the "cannot be fixed by signing in" branch.
  assert.match(node.textContent, /Roster unavailable/i);
  assert.doesNotMatch(node.textContent, /anonymous client/);
  assert.equal(node.querySelector('form.ops-form'), null,
    'offering a sign-in here would be a false promise');
  inspect(node, 'managers disconnected');
});

test('managers refuses to rank on a thin sample and says why', () => {
  const d = withManagers({ sessions: 12 });   // ~4 for Gina, ~8 for Sagit
  const { node } = render(renderManagers, d, { tab: 'overview' });
  const gina = d.managers.people.find((p) => p.name === 'Gina' && p.role === 'MOD');
  assert.ok(gina.roll.net.n < 10, 'fixture must be thin for this test to mean anything');
  assert.match(node.textContent, /Not enough sessions to rank/);
  inspect(node, 'managers thin');
});

test('every score on the screen carries its interval', () => {
  const d = withManagers();
  const { node } = render(renderManagers, d, { tab: 'overview' });
  const rows = [...node.querySelectorAll('tbody tr')];
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    const cells = [...r.querySelectorAll('td')].map((c) => c.textContent.trim());
    // Score column then interval column; an interval reads "+0.12σ to +0.98σ".
    assert.match(cells[4], /(σ to .*σ|—)/, `interval missing on "${cells[1]}"`);
  }
});

test('a person page lists every role they hold and the nights they work', () => {
  const d = withManagers();
  const { node } = render(renderManagers, d, { tab: 'person', staff: 'S1' });
  assert.match(node.textContent, /MOD/);
  assert.match(node.textContent, /Paymaster/);
  assert.match(node.textContent, /Nights worked/);
  assert.match(node.textContent, /Mon Regular/);
});

test('day shape shows the index and spread for each slot', () => {
  const d = withManagers();
  const { node } = render(renderManagers, d, { tab: 'dayshape' });
  assert.match(node.textContent, /Index|×/);
  const rows = node.querySelectorAll('tbody tr');
  assert.ok(rows.length >= 1);
  inspect(node, 'managers dayshape');
});

test('the crew line appears on session detail and names the roles', () => {
  const d = withManagers();
  const { node } = render(renderSession, d, { id: d.events[0].id });
  const crew = node.querySelector('.crew');
  assert.ok(crew, 'session detail must carry a crew line');
  assert.match(crew.textContent, /MOD/);
  assert.match(crew.textContent, /Paymaster/);
  assert.match(crew.textContent, /Flash Manager/);
  // Flash Manager is unassigned in the fixture and must still be labelled.
  assert.ok(crew.querySelector('.crew-none'), 'an empty role keeps its label');
});

test('the crew line degrades to a sentence when the scheduler is absent', () => {
  const d = makeData();
  const { node } = render(renderSession, d, {});
  const crew = node.querySelector('.crew');
  assert.ok(crew);
  assert.match(crew.textContent, /not connected/i);
});

test('no manager screen renders a raw cent count as money', () => {
  const d = withManagers();
  for (const tab of ['overview', 'person', 'dayshape']) {
    const { node } = render(renderManagers, d, { tab, staff: 'S1' });
    const text = node.textContent;
    // A cent count leaking through looks like $3300000 — six or more digits
    // with no separator.
    assert.ok(!/\$\d{6,}(?!,)/.test(text.replace(/,/g, 'X')),
      `${tab}: an unformatted amount reached the screen`);
  }
});


test('operations never asks the viewer to configure a database account', () => {
  for (const needsSignIn of [false, true]) {
    const { node } = render(renderManagers, { ...makeData(), managers: { ok: false, needsSignIn } }, {});
    assert.equal(node.querySelector('input, form'), null);
    assert.doesNotMatch(node.textContent, /sign in|connect the scheduler/i);
    assert.match(node.textContent, /temporarily unavailable/i);
  }
});

test('operations never displays a connection account or disconnect button', () => {
  const data = withManagers();
  data.managers.user = { email: 'private-connection@example.com' };
  const { node } = render(renderManagers, data, {});
  assert.doesNotMatch(node.textContent, /private-connection|disconnect/i);
});




/* ===========================================================================
   Dashboard — the six chart panels
=========================================================================== */


for (const c of CHARTS) {
  test(`dashboard "${c.label}" renders cleanly`, () => {
    const d = withMonths();
    const { node, inspector } = render(renderDashboard, d, { chart: c.id });
    inspect(node, `dashboard ${c.id}`);
    inspect(inspector, `dashboard ${c.id} inspector`);
    assert.ok(node.querySelector('svg, .placeholder'), `${c.id} drew nothing at all`);
  });
}

test('all six SAR 1.0 charts are present, including the one the audit missed', () => {
  assert.equal(CHARTS.length, 6);
  assert.ok(CHARTS.some((c) => c.id === 'jackpot'), 'Jackpot Impact was missing from the gap list');
});

test('the twelve-month window is the newest twelve and reads oldest first', () => {
  const d = withMonths();
  const rows = monthSeries(d.events, d);
  const r = twelveMonths(rows);
  assert.equal(r.win.length, 12);
  assert.ok(r.win[0].key < r.win[11].key, 'left to right is old to new');
  assert.equal(r.win[11].key, rows[rows.length - 1].key);
});

test('year over year keeps only months with a prior-year match', () => {
  const d = withMonths();
  const rows = monthSeries(d.events, d);
  const pairs = yoyPairs(rows);
  assert.ok(pairs.length > 0);
  for (const p of pairs) {
    assert.equal(Number(p.cur.key.slice(0, 4)) - 1, Number(p.prior.key.slice(0, 4)));
    assert.equal(p.cur.key.slice(5), p.prior.key.slice(5), 'same month, prior year');
  }
});

test('year over year leaves out the month still in progress', () => {
  const d = withMonths();
  const rows = monthSeries(d.events, d);
  const last = rows[rows.length - 1].key;
  const withIt = yoyPairs(rows, { current: '9999-12' });
  const without = yoyPairs(rows, { current: last });
  assert.ok(withIt.some((p) => p.cur.key === last) || !withIt.length);
  assert.ok(!without.some((p) => p.cur.key === last), 'the current month is not compared');
});

test('monthly RPA ignores sessions with no attendance recorded', () => {
  const d = makeData();
  const rows = monthSeries(d.events, d);
  const before = rows.map((r) => r.rpa);
  // Blank the attendance of one session: RPA must not rise because its sales
  // stay in while its head count drops out.
  const e = d.events[0];
  const saved = e.attendance; e.attendance = null;
  for (const k of Object.keys(d.metrics[e.id] ?? {})) {
    const def = d.metricDefs?.find?.((m) => m.id === k);
    if (def && /attendance/i.test(def.key)) d.metrics[e.id][k] = null;
  }
  const after = monthSeries(d.events, d);
  const row = after.find((r) => r.key === e.event_date.slice(0, 7));
  assert.ok(row.rpa === null || row.rpa <= Math.max(...before.filter((v) => v !== null)) * 1.5);
  assert.ok(row.missingAttendance >= 0);
  e.attendance = saved;
});

test('year over year draws nothing rather than guessing on short history', () => {
  const d = withMonths({ months: 4 });
  const rows = monthSeries(d.events, d);
  assert.equal(yoyPairs(rows).length, 0);
  assert.equal(yearOverYear(rows).empty, true);
  const { node } = render(renderDashboard, d, { chart: 'yoy' });
  assert.match(node.textContent, /Not enough history/);
  inspect(node, 'yoy short history');
});

test('the margin delta is in percentage POINTS, not percent', () => {
  const pairs = [{
    cur: { key: '2026-01', gross: 1000, net: 300, margin: 0.3 },
    prior: { key: '2025-01', gross: 1000, net: 200, margin: 0.2 },
  }];
  const t = yoyTotals(pairs);
  assert.equal(Number(t.margin.points.toFixed(4)), 0.1, '30% vs 20% is 10 points');
  assert.equal(Number(t.gross.change.toFixed(4)), 0, 'gross unchanged');
  assert.equal(Number(t.net.change.toFixed(4)), 0.5, 'net up by half');
});

test('a zero prior year gives no change rather than infinity', () => {
  const t = yoyTotals([{ cur: { gross: 100, net: 50, margin: 0.5 },
                         prior: { gross: 0, net: 0, margin: null } }]);
  assert.equal(t.gross.change, null);
  assert.equal(t.margin.points, null);
});

test('YTD accumulates and its final net equals the sum of monthly nets', () => {
  const d = withMonths();
  const rows = monthSeries(d.events, d);
  const now = new Date(`${rows[rows.length - 1].key}-15T00:00:00Z`);
  const r = ytd(rows, { now });
  const inYear = rows.filter((x) => x.year === r.year);
  assert.equal(r.cumNet, inYear.reduce((s, m) => s + m.net, 0));
  assert.equal(r.cumGross, inYear.reduce((s, m) => s + m.gross, 0));
  assert.equal(r.payouts, r.cumGross - r.cumNet, 'the band between the areas is payouts');
});

test('YTD falls back a year and says so', () => {
  const d = withMonths();
  const rows = monthSeries(d.events, d);
  const future = new Date('2031-03-01T00:00:00Z');
  const y = ytdYear(rows, future);
  assert.equal(y.year, 2030);
  assert.equal(ytd(rows, { now: future }).empty, true, '2030 has no data either');
});

test('the product stack and the net line differ by the uncategorised remainder', () => {
  const d = withMonths();
  const rows = monthSeries(d.events, d);
  const r = productNet(rows, CATEGORIES);
  assert.equal(r.empty, false);
  r.win.forEach((m, i) => {
    const stack = r.stacks[i].up + r.stacks[i].down;
    const catSum = CATEGORIES.reduce((s, c) => s + (m.categories.get(c.key)?.net ?? 0), 0);
    assert.equal(stack, catSum, 'the stack is exactly the visible categories');
    assert.equal(m.net, catSum, 'and here every metric is categorised, so they agree');
  });
});

test('runner correlation refuses a trend line on too few points', () => {
  const base = withMonths();
  const d = { ...base, runners: [{ id: 'r1', name: 'A', is_active: true }],
              runnerEvents: base.events.slice(0, 3).map((e, i) => ({
                id: `x${i}`, event_id: e.id, runner_id: 'r1' })) };
  const pts = runnerPoints(d);
  assert.equal(pts.length, 3);
  const r = runnerCorrelation(pts, LOCS);
  assert.equal(r.drawable, false, 'three points must not draw a trend line');
  const { node } = render(renderDashboard, d, { chart: 'runners' });
  assert.match(node.textContent, /fewer than|same number of runners/);
  inspect(node, 'runners thin');
});

test('runner correlation says so when every session had the same crew size', () => {
  const base = withMonths();
  const runnerEvents = [];
  base.events.slice(0, 20).forEach((e, i) => {
    runnerEvents.push({ id: `a${i}`, event_id: e.id, runner_id: 'r1' });
    runnerEvents.push({ id: `b${i}`, event_id: e.id, runner_id: 'r2' });
  });
  const d = { ...base, runners: [], runnerEvents };
  const pts = runnerPoints(d);
  assert.equal(new Set(pts.map((p) => p.x)).size, 1);
  const r = runnerCorrelation(pts, LOCS);
  assert.equal(r.drawable, false);
  assert.equal(r.fit.degenerate, true, 'and must not divide by zero');
  const { node } = render(renderDashboard, d, { chart: 'runners' });
  assert.match(node.textContent, /same number of runners/);
  inspect(node, 'runners degenerate');
});

test('jackpot impact reads events, one slot per session, newest window', () => {
  const d = withMonths();
  const now = new Date(`${d.events[0].event_date}T00:00:00Z`);
  const w = jackpotWindow(d, { now });
  assert.ok(w.jackpots.length >= 1);
  for (const r of w.rows) {
    assert.ok(r.event.event_date <= d.events[0].event_date);
  }
  // Two sessions on one date must BOTH appear — not collapsed to a day.
  const dates = w.rows.map((r) => r.event.event_date);
  assert.ok(dates.length >= new Set(dates).size);
});

test('the hall filter changes the numbers on every monthly panel', () => {
  const d = withMonths();
  const both = monthSeries(d.events, d, { hall: 'combined' });
  const one = monthSeries(d.events, d, { hall: 'LS' });
  assert.ok(both[0].gross > one[0].gross, 'combined must exceed a single hall');
  assert.equal(both.length, one.length);
});

test('no dashboard panel leaks a raw cent count', () => {
  const d = withMonths();
  for (const c of CHARTS) {
    const { node } = render(renderDashboard, d, { chart: c.id });
    const text = node.textContent.replace(/,/g, 'X');
    assert.ok(!/\$\d{7,}/.test(text), `${c.id}: an unformatted amount reached the screen`);
  }
});

test('every dashboard control is wired', () => {
  const d = withMonths();
  const { node } = render(renderDashboard, d, { chart: '12months' });
  const sel = node.querySelector('select.ch-select');
  assert.ok(sel, 'the chart picker must exist');
  assert.equal(sel.querySelectorAll('option').length, 6);
  assert.ok(node.querySelectorAll('button.chip').length >= 3);
});


/* ===========================================================================
   Data view — the sheet and its export
=========================================================================== */


const withSheet = () => ({ ...makeData(), metricDefs: TYPED_DEFS });

for (const v of VIEWS) {
  test(`data view "${v.label}" renders cleanly`, () => {
    const d = withSheet();
    const { node, inspector } = render(renderData, d, { view: v.id });
    inspect(node, `data ${v.id}`);
    inspect(inspector, `data ${v.id} inspector`);
  });
}

test('the sheet is transposed: rows are metrics, columns are sessions', () => {
  const d = withSheet();
  const { node } = render(renderData, d, { view: 'daily' });
  const head = [...node.querySelectorAll('thead tr:last-child th')].map((t2) => t2.textContent);
  assert.equal(head[0], '#');
  assert.equal(head[1], 'Metric');
  assert.match(head[2], /^\d+\/\d+\/\d{4}/, 'data columns are dates');
  const firstLabel = node.querySelector('tbody td.sheet-label').textContent;
  assert.equal(firstLabel, 'Location', 'first row is Location, as SAR 1.0');
});

test('columns are newest first', () => {
  const d = withSheet();
  const cols = dailyColumns(d, {});
  for (let i = 1; i < cols.length; i += 1) {
    assert.ok(cols[i - 1].event.event_date >= cols[i].event.event_date);
  }
});

test('Total Sales is exactly the sum of the sales rows shown', () => {
  // The point of filtering sales rows to category-assigned metrics: a reader
  // can add the column up on screen and reach the total.
  const d = withSheet();
  const rows = sheetRows(d, 'daily');
  const col = dailyColumns(d, {})[0];
  const salesRows = [];
  for (const r of rows) {
    if (r.key === '_totalSales') break;
    if (r.key && r.format === 'money') salesRows.push(r);
  }
  const sum = salesRows.reduce((s, r) => s + (cellValue(r, col, 'daily') ?? 0), 0);
  assert.equal(sum, cellValue({ key: '_totalSales' }, col, 'daily'));
  assert.ok(salesRows.length >= 2);
});

test('Net equals Total Sales minus Total Payouts, per column', () => {
  const d = withSheet();
  for (const col of dailyColumns(d, {}).slice(0, 5)) {
    const g = cellValue({ key: '_totalSales' }, col, 'daily');
    const p = cellValue({ key: '_totalPayouts' }, col, 'daily');
    assert.equal(cellValue({ key: '_net' }, col, 'daily'), g - p);
  }
});

test('the monthly sheet can show an individual metric row, not just totals', () => {
  const d = withSheet();
  const cols = monthlyColumns(d, {});
  const v = cellValue({ key: 'flash', format: 'money' }, cols[0], 'monthly');
  assert.ok(Number.isFinite(v) && v > 0, 'monthSeries must carry per-metric totals');
});

test('the hall filter narrows the columns', () => {
  const d = withSheet();
  const all = dailyColumns(d, { hall: 'all' }).length;
  const one = dailyColumns(d, { hall: 'LS' }).length;
  assert.ok(one > 0 && one < all);
});

test('a date range narrows the columns', () => {
  const d = withSheet();
  const all = dailyColumns(d, {});
  const mid = all[Math.floor(all.length / 2)].event.event_date;
  const cut = dailyColumns(d, { from: mid });
  assert.ok(cut.length < all.length);
  assert.ok(cut.every((c) => c.event.event_date >= mid));
});

test('no sessions gives a message, not an empty grid', () => {
  const d = withSheet();
  const { node } = render(renderData, d, { view: 'daily', from: '2099-01-01' });
  assert.match(node.textContent, /No sessions match/);
  assert.equal(node.querySelector('table.sheet'), null);
});

/* ---- export ------------------------------------------------------------- */

test('the sheet export round-trips and matches the rendered values', () => {
  const d = withSheet();
  const rows = sheetRows(d, 'daily');
  const cols = dailyColumns(d, {}).slice(0, 4);
  const back = parseCsv(sheetCsv(rows, cols, 'daily'));

  assert.deepEqual(back[0].slice(0, 2), ['Row', 'Metric']);
  assert.equal(back[0].length, cols.length + 2);

  const netRow = back.find((r) => r[1] === 'Net Sales');
  assert.ok(netRow, 'Net Sales must be in the file');
  cols.forEach((c, i) => {
    // Exported in DOLLARS; the app works in cents.
    assert.equal(Number(netRow[i + 2]), c.totals.net / 100);
  });
});

test('the export carries the filters that are on screen', () => {
  const d = withSheet();
  const rows = sheetRows(d, 'daily');
  const all = parseCsv(sheetCsv(rows, dailyColumns(d, {}), 'daily'))[0].length;
  const one = parseCsv(sheetCsv(rows, dailyColumns(d, { hall: 'LS' }), 'daily'))[0].length;
  assert.ok(one < all, 'a filtered view must export fewer columns');
});

test('the table export is the transpose: one row per session', () => {
  const d = withSheet();
  const cols = dailyColumns(d, {}).slice(0, 6);
  const back = parseCsv(tableCsv(cols, d.categories, 'daily'));
  assert.equal(back.length, cols.length + 1, 'a header plus one row per session');
  assert.deepEqual(back[0].slice(0, 4), ['Date', 'Day', 'Location', 'Session']);
  assert.equal(back[1][0], cols[0].event.event_date);
});

test('a metric name containing a comma and a quote survives export', () => {
  const d = withSheet();
  const nasty = 'Flash, "late" desk';
  const defs = d.metricDefs.map((x) => (x.key === 'flash' ? { ...x, display_name: nasty } : x));
  const rows = sheetRows({ ...d, metricDefs: defs }, 'daily');
  const back = parseCsv(sheetCsv(rows, dailyColumns(d, {}).slice(0, 2), 'daily'));
  const row = back.find((r) => r[1] === nasty);
  assert.ok(row, 'the awkward name must come back intact');
  assert.equal(row.length, 4, 'and must not have split into extra columns');
});

/* ---- reconcile ---------------------------------------------------------- */

test('reconcile compares STORED against computed, and flags a real gap', () => {
  const d = withSheet();
  const computed = monthSeries(d.events, d);
  const target = computed[computed.length - 1];
  // A stored row carrying 3% of the truth — the shape of the real divergence.
  d.monthlySummary = computed.map((m) => ({
    month: `${m.key}-01`, location_id: 'LS',
    total_sales: m.key === target.key ? Math.round(m.gross * 0.03) : m.gross,
    net_sales: m.key === target.key ? Math.round(m.net * 0.03) : m.net,
    event_count: m.eventCount, total_attendance: m.attendance,
  }));

  const rec = reconcile(d, {});
  const bad = rec.find((r) => r.key === target.key);
  const sales = bad.lines.find((l) => l.label === 'Total Sales');
  assert.ok(Math.abs(sales.diff) > 1, 'the divergent month must be flagged');
  const good = rec.find((r) => r.key !== target.key && r.available);
  assert.equal(good.lines.find((l) => l.label === 'Total Sales').diff, 0);
});

test('reconcile says so when there is nothing stored to compare', () => {
  const d = withSheet();
  const { node } = render(renderData, d, { view: 'reconcile' });
  assert.match(node.textContent, /not loaded/i);
  inspect(node, 'reconcile empty');
});

test('reconcile cannot be a tautology: the two sides have different sources', () => {
  // SAR 1.0's Data Test reads both sides from the same event metrics, so every
  // money row shows a difference of exactly zero and the check cannot fail.
  const d = withSheet();
  const computed = monthSeries(d.events, d);
  d.monthlySummary = computed.map((m) => ({
    month: `${m.key}-01`, location_id: 'LS',
    total_sales: 1, net_sales: 1, event_count: 1, total_attendance: 1,
  }));
  const rec = reconcile(d, {});
  assert.ok(rec.some((r) => r.lines.some((l) => Math.abs(l.diff) > 1)),
    'a stored value that disagrees MUST produce a difference');
});


/* ===========================================================================
   Inventory — reads the OPERATIONAL database
=========================================================================== */


for (const t of INV_TABS) {
  test(`inventory "${t.label}" renders cleanly`, () => {
    const d = withInventory();
    const { node, inspector } = render(renderInventory, d, { tab: t.id });
    inspect(node, `inventory ${t.id}`);
    inspect(inspector, `inventory ${t.id} inspector`);
  });
}

test('on hand means in inventory or opened, and nothing else', () => {
  // Counting on_order overstates stock by boxes that have not arrived;
  // counting sold_out counts boxes that are gone. On production that is
  // $46,411 and $71,328 respectively.
  assert.equal(onHand({ state: 'in_inventory' }), true);
  assert.equal(onHand({ state: 'opened' }), true);
  assert.equal(onHand({ state: 'on_order' }), false);
  assert.equal(onHand({ state: 'sold_out' }), false);
  assert.equal(onHand({ state: 'missing' }), false);
});

test('Ops money is numeric dollars and converts once', () => {
  assert.equal(cents('191.96'), 19196);
  assert.equal(cents(0), 0);
  assert.equal(cents(null), null, 'a box with no cost is unknown, not free');
  assert.equal(cents(''), null);
});

test('a box with no cost is counted but not valued', () => {
  const v = valueOf([{ cost: '10.00' }, { cost: null }, { cost: '5.00' }]);
  assert.equal(v.count, 3);
  assert.equal(v.value, 1500);
  assert.equal(v.unpriced, 1, 'and the screen says how many');
});

test('stock by hall values only what is on hand', () => {
  const d = withInventory();
  const rows = stockByHall(d.schedule.boxes);
  const sc = rows.find((r) => r.hall === 'sc');
  const rwc = rows.find((r) => r.hall === 'rwc');
  assert.equal(sc.onHand.count, 2, 'sold_out and on_order excluded');
  assert.equal(sc.onHand.value, 19196 * 2);
  assert.equal(rwc.onHand.count, 2, 'opened counts, missing does not');
  assert.equal(rwc.onHand.value, 42800, 'and the box with no cost adds nothing');
  assert.equal(rwc.onHand.unpriced, 1);
  assert.equal(rwc.ticketsRemaining, 5751);
});

test('every state present is reported, so nothing is silently dropped', () => {
  const [top] = stockByHall(withInventory().schedule.boxes);
  const states = new Set(top.byState.map((s) => s.state));
  assert.ok(states.size >= 2);
  for (const s of top.byState) assert.ok(s.count > 0, 'no empty state rows');
});

test('retail face is separate from cost and never added to it', () => {
  const d = withInventory();
  const rows = stockByProduct(d.schedule.boxes, d.schedule.products, { hall: 'sc' });
  const p1 = rows.find((r) => r.productId === 'p1');
  assert.equal(p1.count, 2);
  assert.equal(p1.value, 19196 * 2, 'cost');
  assert.equal(p1.face, 1795 * 100 * 2, 'retail face, about nine times cost');
  assert.ok(p1.face > p1.value * 5, 'the two are not comparable and are shown apart');
});

test('a product with no ticket count has no retail face, not a zero one', () => {
  const rows = stockByProduct(
    [{ id: 'b', hall_id: 'sc', product_id: 'x', state: 'in_inventory', cost: '10.00' }],
    [{ id: 'x', name: 'Mystery', tickets: null, price_per_ticket: null }], {},
  );
  assert.equal(rows[0].face, null);
  assert.equal(rows[0].value, 1000);
});

test('usage counts sessions and flags games that can no longer be ordered', () => {
  const d = withInventory();
  const rows = usageByProduct(d.schedule.gameUsage);
  const old = rows.find((r) => r.productId === 'p2');
  assert.equal(old.sessions, 3);
  assert.equal(old.qty, 3);
  assert.equal(old.lastUsed, '2026-08-13');
  // One row says still_stocked true, two say false. Any false settles it —
  // running out is the fact worth surfacing.
  assert.equal(old.stillStocked, false);
  assert.deepEqual(atRisk(rows).map((r) => r.productId), ['p2']);
});

test('a game used once and unstocked is not raised as an alert', () => {
  const rows = usageByProduct([
    { hall_id: 'sc', session_date: '2026-08-01', product_id: 'z', game: 'Z',
      still_stocked: false, qty: 1 },
  ]);
  assert.equal(atRisk(rows).length, 0, 'three sessions is the bar');
});

test('the usage tab warns about at-risk games', () => {
  const { node } = render(renderInventory, withInventory(), { tab: 'usage' });
  const said = node.textContent.replace(/\s+/g, ' ');
  assert.match(said, /can no longer be ordered/i);
  assert.match(said, /Old Faithful/);
});

test('the hall filter changes what is counted', () => {
  const d = withInventory();
  const both = stockByProduct(d.schedule.boxes, d.schedule.products, { hall: 'all' });
  const sc = stockByProduct(d.schedule.boxes, d.schedule.products, { hall: 'sc' });
  const total = (rs) => rs.reduce((s, r) => s + r.count, 0);
  assert.ok(total(sc) < total(both));
});

test('inventory says so when the scheduler is not connected', () => {
  const { node } = render(renderInventory, { ...makeData(), schedule: { ok: false } }, {});
  // Normalised: the copy wraps across lines inside the template literal, so a
  // raw textContent match on a two-word phrase is testing the indentation.
  const said = node.textContent.replace(/\s+/g, ' ');
  assert.match(said, /Scheduler not connected/i);
  assert.match(said, /temporarily unavailable/i);
  inspect(node, 'inventory disconnected');
});

test('inventory copes with every table being empty', () => {
  const d = { ...makeData(), schedule: { ok: true, products: [], boxes: [],
    gameUsage: [], purchaseOrders: [] } };
  for (const t of INV_TABS) {
    const { node } = render(renderInventory, d, { tab: t.id });
    assert.ok(node.querySelector('.placeholder'), `${t.id} must say it is empty`);
    inspect(node, `inventory empty ${t.id}`);
  }
});

test('a box whose product is unknown still renders', () => {
  const d = withInventory({ boxes: [
    { id: 'x', hall_id: 'sc', product_id: 'nope', state: 'in_inventory', cost: '1.00' },
  ] });
  const { node } = render(renderInventory, d, { tab: 'onhand' });
  inspect(node, 'inventory unknown product');
  assert.match(node.textContent, /Unknown product|nope/);
});

/* ===========================================================================
   Commission
=========================================================================== */


for (const t of COM_TABS) {
  test(`commission "${t.label}" renders cleanly`, () => {
    const d = withCommission();
    const { node, inspector } = render(renderCommission, d, { tab: t.id });
    inspect(node, `commission ${t.id}`);
    inspect(inspector, `commission ${t.id} inspector`);
  });
}

test('Ops money arrives as numeric dollars and is converted once', () => {
  assert.equal(toCents('540.00'), 54000);
  assert.equal(toCents('0.15'), 15);
  assert.equal(toCents(null), null);
  assert.equal(toCents(''), null);
});

test('PRODUCTION: the pool is the rate times gross when no target is set', () => {
  // 0.15 x 5,000,005.00 = 750,000.75, matching the stored pool to the penny.
  const { pool, aboveTarget } = poolFor({
    sales: 500000500, attendance: 5555, targetRpa: null, rate: 0.15,
  });
  assert.equal(pool, 75000075);
  assert.equal(aboveTarget, false, 'and the screen must say the target is unset');
});

test('with a target set, only the excess is commissionable', () => {
  const { pool, aboveTarget } = poolFor({
    sales: 100000, attendance: 100, targetRpa: 500, rate: 0.1,
  });
  // target = 500 x 100 = 50,000 cents; excess 50,000; pool 5,000.
  assert.equal(pool, 5000);
  assert.equal(aboveTarget, true);
});

test('a session below its target pays nothing, never a negative pool', () => {
  assert.equal(poolFor({ sales: 1000, attendance: 100, targetRpa: 500, rate: 0.1 }).pool, 0);
});

test('the seeded test row is flagged, and hidden by default', () => {
  const d = withCommission();
  const rows = sessionRows({
    payouts: d.schedule.commissionPayouts, sessions: d.schedule.sessions, staff: d.schedule.staff,
  });
  const bad = rows.find((r) => r.id === 's2');
  assert.ok(bad.flags.length, 'attendance 5555 and $5m sales must be flagged');

  const { node } = render(renderCommission, d, { tab: 'sessions' });
  assert.match(node.textContent, /look like test data/i);
  assert.equal(node.querySelectorAll('tbody tr').length, 1, 'only the plausible session');
});

test('the flagged rows can be shown deliberately', () => {
  const { node } = render(renderCommission, withCommission(), { tab: 'sessions', flagged: 'on' });
  assert.equal(node.querySelectorAll('tbody tr').length, 2);
});

test('the plausibility bounds are wide enough not to hide a good night', () => {
  // A big real night is ~$90,000 with ~300 in. Neither may trip the guard.
  assert.deepEqual(implausible({ attendance: 300, sales: 9000000, maxPayout: 20000 }), []);
  assert.ok(PLAUSIBLE.maxSessionSales > 9000000);
  assert.ok(PLAUSIBLE.maxAttendance > 300);
});

test('shares split the pool and the split is checked against what was paid', () => {
  const d = withCommission({ testRow: false });
  const [row] = sessionRows({
    payouts: d.schedule.commissionPayouts, sessions: d.schedule.sessions, staff: d.schedule.staff,
  });
  assert.equal(row.storedPool, 54000);
  assert.equal(row.paid, 54000, 'three equal shares of $540');
  assert.equal(row.unpaid, 0);
  assert.equal(row.people.length, 3);
});

test('a stored pool that disagrees with the recomputation is surfaced', () => {
  const d = withCommission({ testRow: false });
  d.schedule.sessions[0].total_sales = '9999.00';   // sales changed after payout
  const [row] = sessionRows({
    payouts: d.schedule.commissionPayouts, sessions: d.schedule.sessions, staff: d.schedule.staff,
  });
  assert.ok(Math.abs(row.poolGap) > 1);
  const { node } = render(renderCommission, d, { tab: 'sessions' });
  assert.ok(node.querySelector('.st-poor'), 'the disagreement must be visible');
});

test('by person totals across sessions, biggest first', () => {
  const d = withCommission({ testRow: false });
  const people = peopleRows(sessionRows({
    payouts: d.schedule.commissionPayouts, sessions: d.schedule.sessions, staff: d.schedule.staff,
  }));
  assert.equal(people.length, 3);
  assert.equal(people[0].total, 18000);
  assert.equal(people[0].average, 18000);
  for (let i = 1; i < people.length; i += 1) {
    assert.ok(people[i - 1].total >= people[i].total);
  }
});

test('commission says so when the scheduler is not connected', () => {
  const { node } = render(renderCommission, { ...makeData(), schedule: { ok: false } }, {});
  assert.match(node.textContent, /Scheduler not connected/i);
  inspect(node, 'commission disconnected');
});

test('commission warns that no RPA target is set', () => {
  const { node } = render(renderCommission, withCommission(), { tab: 'sessions' });
  const said = node.textContent.replace(/\s+/g, ' ');
  assert.match(said, /No RPA target is set/i);
  assert.match(said, /gross sales/i);
});


/* ===========================================================================
   Staff overview
=========================================================================== */


for (const t of ST_TABS) {
  test(`staff "${t.label}" renders cleanly`, () => {
    const d = withStaff();
    const { node, inspector } = render(renderStaff, d, { tab: t.id });
    inspect(node, `staff ${t.id}`);
    inspect(inspector, `staff ${t.id} inspector`);
  });
}

test('roster counts shifts and records when someone last worked', () => {
  const rows = rosterRows(withStaff().schedule);
  const sagit = rows.find((r) => r.name === 'Sagit');
  assert.equal(sagit.shifts, 2);
  assert.equal(sagit.lastWorked, '2026-08-08');
  assert.deepEqual(sagit.roles, ['MOD']);
});

test('never scheduled is null, not an old date', () => {
  const rows = rosterRows(withStaff().schedule);
  const n = rows.find((r) => r.name === 'Newbie');
  assert.equal(n.lastWorked, null, 'new and long-gone are different things');
  assert.equal(n.shifts, 0);
  assert.deepEqual(neverScheduled(rows).map((r) => r.name), ['Newbie']);
});

test('a capability marked can_do false is not a capability', () => {
  const rows = rosterRows(withStaff().schedule);
  assert.deepEqual(rows.find((r) => r.name === 'Newbie').canDo, []);
});

test('coverage flags a role only one person can do', () => {
  const d = withStaff();
  const cov = coverage(rosterRows(d.schedule), d.schedule.roles);
  assert.equal(cov.length, 2);
  for (const c of cov) assert.equal(c.thin, true, 'each role has exactly one capable person');
});

test('coverage distinguishes "nobody recorded" from "nobody can"', () => {
  const d = withStaff();
  d.schedule.capability = [];
  const cov = coverage(rosterRows(d.schedule), d.schedule.roles);
  assert.ok(cov.every((c) => c.undeclared), 'people have worked these roles');
  assert.ok(cov.every((c) => !c.thin), 'and that is not a staffing alarm');
});

test('hours sum, and a missing entry is counted not treated as zero', () => {
  const d = withStaff();
  const rows = hoursByPerson(d.schedule.timeEntries, d.schedule.staff);
  const sagit = rows.find((r) => r.name === 'Sagit');
  assert.equal(sagit.hours, 6.5);
  assert.equal(sagit.shifts, 2);
  assert.equal(sagit.unrecorded, 1);
  assert.equal(sagit.average, 6.5, 'averaged over recorded shifts only');
  assert.equal(rows.find((r) => r.name === 'Gina').walkUps, 1);
});

test('staff says so when the scheduler is not connected', () => {
  const { node } = render(renderStaff, { ...makeData(), schedule: { ok: false } }, {});
  assert.match(node.textContent.replace(/\s+/g, ' '), /Scheduler not connected/i);
});

/* ===========================================================================
   Data sources
=========================================================================== */

for (const t of SRC_TABS) {
  test(`data sources "${t.label}" renders cleanly`, () => {
    const { node, inspector } = render(renderSources, makeData(), { tab: t.id });
    inspect(node, `sources ${t.id}`);
    inspect(inspector, `sources ${t.id} inspector`);
  });
}

test('sources reports live row counts, not a static description', () => {
  const d = makeData();
  const list = sourceList(d);
  const analytics = list.find((s) => s.group === 'Analytics');
  const events = analytics.items.find((i) => i.name === 'analytics_events');
  assert.equal(events.count, d.events.length, 'must reflect what is actually loaded');
});

test('sources shows the Operational project as not connected when it is not', () => {
  const list = sourceList({ ...makeData(), schedule: { ok: false } });
  assert.equal(list.find((s) => s.group === 'Operational').state, 'not connected');
});

test('every hazard has a title, a body and a severity', () => {
  assert.ok(HAZARDS.length >= 6);
  for (const hz of HAZARDS) {
    assert.ok(hz.title.length > 10);
    assert.ok(hz.body.length > 40, `${hz.title} needs its evidence`);
    assert.ok(['high', 'medium', 'low'].includes(hz.severity));
  }
});

test('the hazards name the specific traps this project actually hit', () => {
  const all = HAZARDS.map((x) => `${x.title} ${x.body}`).join(' ');
  assert.match(all, /demo/i, 'the wrong-database episode');
  assert.match(all, /monthly_summary/i, 'the broken view');
  assert.match(all, /double count/i, 'the paper vs paper_sales trap');
  assert.match(all, /AM\/PM|regular\/late/i, 'the session naming mismatch');
});

/* ===========================================================================
   Promotions
=========================================================================== */


for (const t of PR_TABS) {
  test(`promotions "${t.label}" renders cleanly`, () => {
    const { node, inspector } = render(renderPromotions, withPromoNotes(), { tab: t.id });
    inspect(node, `promotions ${t.id}`);
    inspect(inspector, `promotions ${t.id} inspector`);
  });
}

test('only sessions with a real note are listed', () => {
  const rows = noteRows(withPromoNotes());
  assert.equal(rows.length, 2, 'a whitespace-only note is not a note');
  assert.ok(rows.every((r) => r.note.length > 1));
});

test('the empty promotions table is explained, not rendered as a broken grid', () => {
  const { node } = render(renderPromotions, { ...makeData(), promotions: [] },
    { tab: 'catalogue' });
  const said = node.textContent.replace(/\s+/g, ' ');
  assert.match(said, /table is empty/i);
  assert.match(said, /never had a row/i);
  assert.ok(node.querySelector('thead'), 'the real columns are still shown');
});

test('promotions fills in by itself once rows exist', () => {
  const d = { ...makeData(), promotions: [{
    id: 'p1', code: 'DBL', name: 'Double points', promo_type: 'points',
    discount_type: 'percent', discount_value: 10, valid_from: '2026-08-01T00:00:00Z',
    is_active: true, current_uses: 4, max_uses: 100,
  }] };
  const { node } = render(renderPromotions, d, { tab: 'catalogue' });
  assert.match(node.textContent, /Double points/);
  assert.ok(!/table is empty/i.test(node.textContent));
  inspect(node, 'promotions populated');
});

/* ===========================================================================
   Unit economics
=========================================================================== */

test('unit economics renders cleanly', () => {
  const { node, inspector } = render(renderUnitEconomics, makeData(), {});
  inspect(node, 'unit economics');
  inspect(inspector, 'unit economics inspector');
});

test('cost of goods only counts boxes that name a session', () => {
  // A box with no session cannot be attributed; smearing it across sessions
  // would look precise and be invented.
  const cogs = costOfGoods([
    { session_id: 'e0', cost: '191.96' },
    { session_id: 'e0', cost: '100.00' },
    { session_id: null, cost: '500.00' },
    { session_id: 'e1', cost: null },
  ]);
  assert.equal(cogs.get('e0').cost, 29196);
  assert.equal(cogs.get('e0').boxes, 2);
  assert.equal(cogs.has('e1'), false, 'a box with no cost adds nothing');
  assert.equal(cogs.size, 1);
});

test('the bridge marks every line that leans on an assumption', () => {
  const d = makeData();
  const a = loadAssumptions({ getItem: () => null });
  const e = sessionEconomics(d.events[0], d, { assumptions: a, cogs: new Map(), hours: null });
  const byKey = Object.fromEntries(e.lines.map((l) => [l.key, l]));
  assert.equal(byKey.gross.assumed, false);
  assert.equal(byKey.net.assumed, false);
  assert.equal(byKey.fixed.assumed, true);
  assert.equal(byKey.staff.assumed, true, 'no time-clock hours for this session');
  assert.equal(byKey.profit.assumed, true, 'profit inherits the assumptions');
  assert.equal(byKey.contribution.assumed, false, 'contribution does not');
});

test('real hours from the time clock stop the staff line being an assumption', () => {
  const d = makeData();
  const a = loadAssumptions({ getItem: () => null });
  const e = sessionEconomics(d.events[0], d, { assumptions: a, cogs: new Map(), hours: 42 });
  const staff = e.lines.find((l) => l.key === 'staff');
  assert.equal(staff.assumed, false);
  assert.match(staff.note, /time clock/);
});

test('cost of goods is blank when nothing is linked, never zero', () => {
  const d = makeData();
  const a = loadAssumptions({ getItem: () => null });
  const e = sessionEconomics(d.events[0], d, { assumptions: a, cogs: new Map() });
  assert.equal(e.lines.find((l) => l.key === 'cogs').value, null);
  assert.equal(e.goodsLinked, false);
});

test('the bridge arithmetic ties out', () => {
  const d = makeData();
  const a = { staffCostPerHour: 2500, fixedPerSession: 80000, staffPerSession: 60 };
  const cogs = new Map([[d.events[0].id, { cost: 50000, boxes: 3 }]]);
  const e = sessionEconomics(d.events[0], d, { assumptions: a, cogs, hours: 10 });
  const g = e.lines.find((l) => l.key === 'gross').value;
  const p = e.lines.find((l) => l.key === 'payouts').value;
  assert.equal(e.net, g + p, 'payouts are already negative');
  assert.equal(e.contribution, e.net - 50000);
  assert.equal(e.profit, e.contribution - 10 * 2500 - 80000);
});

test('assumptions fall back to defaults when storage is unavailable', () => {
  const a = loadAssumptions({ getItem: () => { throw new Error('private mode'); } });
  for (const def of ASSUMPTIONS) assert.equal(a[def.key], def.default);
});

/* ===========================================================================
   Forecast
=========================================================================== */

test('forecast renders cleanly', () => {
  const { node, inspector } = render(renderForecast, withMonths(), {});
  inspect(node, 'forecast');
  inspect(inspector, 'forecast inspector');
});

// The forecast model's unit tests — slot bar, roster type resolution, partial
// roster, roster owning its day — moved to test/forecast.test.mjs with the U12
// rebuild (src/lib/forecast-model.js).


/* ===========================================================================
   Ask SAR
=========================================================================== */

test('Ask SAR has no API key form and removes a previously saved browser key', () => {
  const real = globalThis.localStorage;
  const removed = [];
  globalThis.localStorage = { removeItem: key => removed.push(key), getItem: () => 'private-old-key' };
  try {
    const { node, inspector } = render(renderAsk, makeData(), {});
    inspect(node, 'ask'); inspect(inspector, 'ask inspector');
    assert.equal(node.querySelector('input[type=password]'), null);
    assert.doesNotMatch(node.textContent, /API key|private-old-key|Connect the Claude/i);
    assert.deepEqual(removed, ['sar2-anthropic-key']);
  } finally { globalThis.localStorage = real; }
});

test('the API key is never in the source', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../src/screens/ask.js', import.meta.url), 'utf8');
  assert.ok(!/sk-ant-[A-Za-z0-9_-]{10,}/.test(src), 'no key literal may ever be committed');
});

test('the payload carries no names of any kind', () => {
  const d = withMonths();
  const ctx = buildContext(d);
  const json = JSON.stringify(ctx).toLowerCase();
  for (const forbidden of ['sagit', 'gina', 'paolo', 'staff', 'runner', 'commission', 'payout_amount']) {
    assert.ok(!json.includes(forbidden), `"${forbidden}" must not leave the browser`);
  }
  assert.ok(ctx.months.length > 0);
  assert.ok(ctx.months.every((m) => typeof m.gross === 'number'));
});

test('the payload is money in dollars, so the model is not told cents', () => {
  const d = withMonths();
  const ctx = buildContext(d);
  const m = ctx.months[ctx.months.length - 1];
  assert.ok(m.gross < 1000000, 'dollars, not cents');
  assert.ok(m.marginPct === null || (m.marginPct > -100 && m.marginPct < 100));
});

test('the offline answerer answers real questions and refuses the rest', () => {
  const d = withMonths();
  assert.ok(answerLocally('how did last month go?', d).text.length > 20);
  assert.match(answerLocally('what is our margin?', d).text, /Margin/);
  assert.equal(answerLocally('what is the airspeed of a swallow?', d), null,
    'it must refuse rather than guess');
  assert.equal(answerLocally('', d), null);
});

test('REGRESSION: asking for net must not be answered with gross', () => {
  // "best month for net" contains both "month" and "net". An earlier version
  // matched the gross branch first and confidently answered a different
  // question with a different number.
  const d = withMonths();
  const net = answerLocally('what was our best month for net?', d).text;
  const gross = answerLocally('what was our best month for gross?', d).text;
  assert.match(net, /best month for net/i);
  assert.match(gross, /best month for gross/i);
  const money = (s) => s.match(/\$[\d,]+/)[0];
  assert.notEqual(money(net), money(gross), 'the two must not quote the same figure');
});

test('the category comparison is answered as a comparison', () => {
  const d = withMonths();
  const a = answerLocally('which product category makes the most money?', d);
  assert.ok(a, 'this is an offered suggestion and must be answerable');
  assert.match(a.text, /earns the most/i);
  assert.match(a.text, /months loaded/i, 'and says what period it covers');
});

test('the offline answerer never invents a number', () => {
  const empty = { ...makeData(), events: [], metrics: {} };
  const a = answerLocally('how did last month go?', empty);
  assert.match(a.text, /No sessions/);
});

test('Ask SAR gracefully handles unavailable server answers', async () => {
  assert.equal((await askClaude({ question: '  ' })).ok, false);
  const result = await askClaude({ question: 'q', context: {}, request: async () => { throw Error('secret database details'); } });
  assert.equal(result.ok, false);
  assert.match(result.error, /temporarily unavailable/);
  assert.doesNotMatch(result.error, /secret database details/);
});

test('Ask SAR sends only the question and context to its own server', async () => {
  let sent;
  const result = await askClaude({ question: ' q ', context: { months: [] },
    request: async (path, options) => { sent = { path, options }; return { ok: true, text: 'Answer' }; } });
  assert.equal(result.text, 'Answer');
  assert.deepEqual(sent, { path: '/api/ask-sar', options: { body: { question: 'q', context: { months: [] }, history: [] } } });
});

test('the payload carries every session as a row plus summaries the model can trust', () => {
  const d = withMonths();
  const ctx = buildContext(d);
  assert.equal(ctx.sessions.length, d.events.length, 'one row per loaded session');
  assert.equal(ctx.columns.length, ctx.sessions[0].length, 'rows match the column list');
  assert.deepEqual(ctx.columns.slice(0, 4), ['date', 'hall', 'type', 'weekday']);
  const dates = ctx.sessions.map((r) => r[0]);
  assert.deepEqual(dates, [...dates].sort(), 'rows are oldest first');
  assert.ok(ctx.sessions.every((r) => typeof r[5] === 'number' && r[5] < 1000000), 'gross in dollars');
  assert.ok(ctx.monthly.length > 0 && Object.keys(ctx.monthlyByHall).length === d.locations.length);
  assert.ok(ctx.weekdayProfile.rows.every((r) => r.sessions > 0 && typeof r.avgNet === 'number'));
  // monthly keeps the last 24 months; compare each month's summary to its own rows.
  for (const m of ctx.monthly) {
    const rowNet = ctx.sessions.filter((r) => r[0].startsWith(m.month)).reduce((s, r) => s + r[7], 0);
    assert.ok(Math.abs(m.net - rowNet) < 0.05 * m.sessions, `summary and rows agree for ${m.month}`);
  }
});

test('the payload still carries no names of any kind', () => {
  const json = JSON.stringify(buildContext(withMonths())).toLowerCase();
  for (const forbidden of ['sagit', 'gina', 'paolo', 'staff', 'runner', 'commission', 'payout_amount', 'email']) {
    assert.ok(!json.includes(forbidden), `"${forbidden}" must not leave the browser`);
  }
});

test('a trailing Basis line is split off the answer', () => {
  assert.deepEqual(splitBasis('Net was $10.\n\nBasis: Santa Clara, Aug 2026, 14 sessions.'),
    { answer: 'Net was $10.', basis: 'Basis: Santa Clara, Aug 2026, 14 sessions.' });
  assert.deepEqual(splitBasis('Just an answer.'), { answer: 'Just an answer.', basis: null });
});

test('follow-up questions carry the conversation and the reset clears it', async () => {
  resetConversation();
  const sent = [];
  const request = async (path, options) => { sent.push(options.body); return { ok: true, text: 'A1\nBasis: x' }; };
  const d = withMonths();
  const { node } = render(renderAsk, d, {});
  conversation.push({ role: 'user', content: 'first' }, { role: 'assistant', content: 'A0' });
  const r = await askClaude({ question: 'second', context: {}, history: conversation.map(({ role, content }) => ({ role, content })), request });
  assert.equal(r.ok, true);
  assert.deepEqual(sent[0].history, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'A0' }]);
  node.querySelector('#ask-reset').click();
  assert.equal(conversation.length, 0);
  assert.equal(node.querySelector('.ask-out').children.length, 0);
});

test('every suggestion is answerable offline', () => {
  const d = withMonths();
  for (const s of SUGGESTIONS) {
    const a = answerLocally(s, d);
    assert.ok(a && a.text, `"${s}" is offered but cannot be answered without a key`);
  }
});


/* ===========================================================================
   Every route renders — the catch-all
=========================================================================== */

test('every screen in the nav renders without throwing', async () => {
  const { SCREENS } = await import('../src/lib/router.js');
  const renderers = {
    dashboard: renderDashboard, session: renderSession, leaderboard: renderLeaderboard,
    compare: renderCompare, jackpots: renderJackpots, promotions: renderPromotions,
    runners: RN.renderRunners, anomaly: renderAnomaly, reporting: RP.renderReporting,
    'monthly-pl': renderMonthlyPL, 'unit-economics': renderUnitEconomics,
    forecast: renderForecast, venues: renderVenues, inventory: renderInventory,
    commission: renderCommission, managers: renderManagers,
    'staff-overview': renderStaff, data: renderData, sources: renderSources,
    ask: renderAsk, notifications: renderNotifications, competition: () => renderCompetition({request:async()=>({halls:[]})}),
  };

  const missing = Object.keys(SCREENS).filter((id) => !renderers[id]);
  assert.deepEqual(missing, [], 'every route must have a renderer');

  // A realistic bundle: analytics data, a connected scheduler, promotions.
  const base = withMonths();
  const st = withStaff().schedule;
  const inv = withInventory().schedule;
  const com = withCommission().schedule;
  const d = {
    ...base,
    metricDefs: TYPED_DEFS,
    promotions: [],
    runners: [], runnerEvents: [],
    schedule: { ok: true, ...st, ...inv, ...com },
  };
  d.managers = { ok: false, reason: 'not connected in this test' };

  for (const [id, fn] of Object.entries(renderers)) {
    const { node } = render(fn, d, {});
    assert.ok(node, `${id} rendered nothing`);
    inspect(node, `route ${id}`);
  }
});

test('every screen survives having no data at all', async () => {
  const { SCREENS } = await import('../src/lib/router.js');
  const renderers = {
    dashboard: renderDashboard, session: renderSession, leaderboard: renderLeaderboard,
    compare: renderCompare, jackpots: renderJackpots, promotions: renderPromotions,
    runners: RN.renderRunners, anomaly: renderAnomaly, reporting: RP.renderReporting,
    'monthly-pl': renderMonthlyPL, 'unit-economics': renderUnitEconomics,
    forecast: renderForecast, venues: renderVenues, inventory: renderInventory,
    commission: renderCommission, managers: renderManagers,
    'staff-overview': renderStaff, data: renderData, sources: renderSources,
    ask: renderAsk, notifications: renderNotifications, competition: () => renderCompetition({request:async()=>({halls:[]})}),
  };
  const empty = {
    events: [], metrics: {}, idx, categories: [], locations: [],
    config: { name: 'Nothing', settings: { jackpots: [] } }, metricDefs: [],
    promotions: [], runners: [], runnerEvents: [],
    schedule: { ok: false }, managers: { ok: false },
  };
  for (const [id, fn] of Object.entries(renderers)) {
    const { node } = render(fn, empty, {});
    assert.ok(node, `${id} threw on empty data`);
    inspect(node, `empty ${id}`);
  }
  assert.equal(Object.keys(SCREENS).length, Object.keys(renderers).length);
});


/* ===========================================================================
   Notifications — a real SAR 1.0 view the gap audit missed
=========================================================================== */


test('notifications render cleanly', () => {
  const { node, inspector } = render(renderNotifications, withNotifications(), {});
  inspect(node, 'notifications');
  inspect(inspector, 'notifications inspector');
});

test('read state is per user, and another user reading does not mark mine read', () => {
  const d = withNotifications();
  const rows = withReadState(d.notifications, d.notificationReads, { userId: 'u1' });
  assert.equal(rows.find((n) => n.id === 'n3').read, true, 'u1 read n3');
  assert.equal(rows.find((n) => n.id === 'n1').read, false, 'u2 read n1, not u1');
});

test('an archived notification is hidden, matching SAR 1.0', () => {
  const d = withNotifications();
  const rows = withReadState(d.notifications, d.notificationReads, { userId: 'u1' });
  assert.equal(rows.find((n) => n.id === 'n6'), undefined);
  assert.equal(rows.length, 5);
});

test('newest first', () => {
  const d = withNotifications();
  const rows = withReadState(d.notifications, d.notificationReads, { userId: 'u1' });
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].created_at >= rows[i].created_at);
  }
});

test('unread count excludes archived and other users reads', () => {
  const d = withNotifications();
  const rows = withReadState(d.notifications, d.notificationReads, { userId: 'u1' });
  assert.equal(unreadCount(rows), 4, 'five visible, one read by me');
});

test('the type groups cover the production event types', () => {
  const real = ['sar.impossible_value', 'sar.ingestion_error', 'sar.jackpot_hit',
    'sar.jackpot_state_changed', 'sar.new_high_water', 'sar.reconciliation_mismatch',
    'sar.stale_location', 'sar.worst_day_alert', 'auth.role_granted', 'auth.role_revoked'];
  for (const t2 of real) {
    const hit = TYPE_GROUPS.filter((g) => g.id !== 'all').some((g) => g.match(t2));
    assert.ok(hit, `${t2} falls into no group`);
  }
});

test('an unknown event type is still shown under Everything', () => {
  const rows = withReadState([{ id: 'x', event_type: 'sar.something_new',
    severity: 'info', created_at: '2026-08-01T00:00:00Z' }], []);
  assert.equal(filterRows(rows, { group: 'all' }).length, 1,
    'a notification nobody anticipated is the one worth seeing');
});

test('filters compose, and counts match what a filter would show', () => {
  const d = withNotifications();
  const rows = withReadState(d.notifications, d.notificationReads, { userId: 'u1' });
  const counts = groupCounts(rows);
  for (const g of TYPE_GROUPS) {
    assert.equal(filterRows(rows, { group: g.id }).length, counts[g.id],
      `${g.id} count disagrees with its filter`);
  }
  assert.equal(filterRows(rows, { group: 'all', severity: 'alert' }).length, 1);
  assert.equal(filterRows(rows, { group: 'all', unreadOnly: true }).length, 4);
});

test('event types read as English', () => {
  assert.equal(humanType('sar.new_high_water'), 'New high water');
  assert.equal(humanType('auth.role_granted'), 'Role granted');
  assert.equal(humanType(null), 'Unknown');
});

test('notifications never offers to mark anything read', () => {
  // SAR 2.0 writes to no database, so a mark-read button would silently do
  // nothing. The screen says so instead.
  const { node } = render(renderNotifications, withNotifications(), {});
  const said = node.textContent.replace(/\s+/g, ' ');
  assert.ok(!/mark all as read/i.test(said));
  assert.match(said, /does not mark it read/i);
});

test('notifications copes with none at all', () => {
  const { node } = render(renderNotifications,
    { ...makeData(), notifications: [], notificationReads: [] }, {});
  assert.match(node.textContent, /No notifications/);
  inspect(node, 'notifications empty');
});

/* ===========================================================================
   Review fixes — each of these is a real defect that was found and corrected
=========================================================================== */

test('REGRESSION: Commission fetches the columns it recomputes the pool from', () => {
  // The pool is recomputed from total_sales x comm_rate. Those columns were
  // missing from the query, so Sales, Rate and Recomputed were blank on every
  // row and the stored-vs-recomputed check could never fire — a screen built
  // around a comparison that could not happen.
  for (const col of ['total_sales', 'attendance', 'comm_rate', 'target_rpa']) {
    assert.ok(OPS_COLUMNS.sched_sessions.includes(col),
      `sched_sessions must fetch ${col}`);
  }
});

test('REGRESSION: an unrecorded shift is not a zero-hour shift', () => {
  // Number(null) is 0 and passes Number.isFinite, so a null hours_worked used
  // to arrive as a real 0 — which then bypassed the "hours ?? default"
  // fallback, priced staff at $0, and labelled it "from the time clock".
  const sessions = [
    { id: 's1', hall_id: 'h1', session_date: '2026-08-01', part: 'PM' },
    { id: 's2', hall_id: 'h1', session_date: '2026-08-02', part: 'PM' },
  ];
  const by = hoursBySession([
    { work_date: '2026-08-01', hall_id: 'h1', hours_worked: null },
    { work_date: '2026-08-01', hall_id: 'h1', hours_worked: undefined },
    { work_date: '2026-08-01', hall_id: 'h1', hours_worked: '0.00' },
    { work_date: '2026-08-02', hall_id: 'h1', hours_worked: '6.5' },
  ], sessions);
  assert.equal(by.has('s1'), false, 'a day of unrecorded shifts has no hours');
  assert.equal(by.get('s2'), 6.5);

  const a = loadAssumptions({ getItem: () => null });
  const d = makeData();
  const e = sessionEconomics(d.events[0], d, {
    assumptions: a, cogs: new Map(), hours: by.get('s1') ?? null,
  });
  const staff = e.lines.find((l) => l.key === 'staff');
  assert.equal(staff.assumed, true, 'and the staff line is honestly marked assumed');
  assert.ok(staff.value !== 0, 'not priced at zero');
});

test('staff hours belong to their own session, not to every session that day', () => {
  const sessions = [
    { id: 'am', hall_id: 'h1', session_date: '2026-08-01', part: 'AM' },
    { id: 'pm', hall_id: 'h1', session_date: '2026-08-01', part: 'PM' },
    { id: 'other', hall_id: 'h2', session_date: '2026-08-01', part: 'PM' },
  ];
  const assignments = [{ id: 'a1', session_id: 'am' }, { id: 'a2', session_id: 'pm' }];
  const by = hoursBySession([
    { work_date: '2026-08-01', hall_id: 'h1', hours_worked: '4', assignment_id: 'a1' },
    { work_date: '2026-08-01', hall_id: 'h1', hours_worked: '6', assignment_id: 'a2' },
    { work_date: '2026-08-01', hall_id: 'h2', hours_worked: '5' },                 // one session: attributable
    { work_date: '2026-08-01', hall_id: 'h1', hours_worked: '3' },                 // two sessions: not
    { work_date: '2026-08-01', hall_id: 'h1', hours_worked: '7', category: 'pto', is_worked_time: false, assignment_id: 'a2' },
  ], sessions, assignments);
  assert.equal(by.get('am'), 4);
  assert.equal(by.get('pm'), 6, 'PTO is not worked time');
  assert.equal(by.get('other'), 5);
});

// Forecast roster regressions: see test/forecast.test.mjs.


/* ---- escaping ----------------------------------------------------------- */

test('esc neutralises the characters that make markup', () => {
  assert.equal(esc('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(esc('"quoted"'), '&quot;quoted&quot;');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0', 'zero is a value, not an absence');
});

test('a session note cannot inject markup on the Leaderboard', () => {
  const d = makeData();
  d.events[0].notes = '<img src=x onerror="window.__pwned=1">';
  const { node } = render(renderLeaderboard, d, {});
  assert.equal(node.querySelectorAll('img').length, 0, 'no element may be created');
  assert.match(node.textContent, /<img src=x/, 'it renders as literal text');
});

test('a promotion note cannot inject markup', () => {
  const d = makeData();
  d.events[0].promotion_notes = '<script>window.__pwned=1</script>';
  const { node } = render(renderPromotions, d, { tab: 'notes' });
  assert.equal(node.querySelectorAll('script').length, 0);
  assert.match(node.textContent, /<script>/);
});

test('a notification body cannot inject markup', () => {
  const d = { ...makeData(), notificationReads: [], notifications: [{
    id: 'x', event_type: 'sar.jackpot_hit', severity: 'info',
    title: '<b>bold</b>', body: '<img src=x onerror=1>', created_at: '2026-08-01T00:00:00Z',
  }] };
  const { node } = render(renderNotifications, d, {});
  assert.equal(node.querySelectorAll('img, b').length, 0);
});

/* ---- consistency and accessibility -------------------------------------- */

test('RPA reads the same on every screen that shows it', () => {
  // Leaderboard used usd (whole dollars) while Session detail, Venues and
  // Reporting used usd2 — the same session read $481 on one and $481.23 on
  // another.
  const d = makeData();
  const lb = render(renderLeaderboard, d, {}).node.textContent;
  const se = render(renderSession, d, {}).node.textContent;
  const rpaIn = (s) => (s.match(/\$\d[\d,]*\.\d{2}/g) ?? []);
  assert.ok(rpaIn(lb).length > 0, 'the Leaderboard must show RPA to the cent');
  assert.ok(rpaIn(se).length > 0);
});

test('a click target is a real control, reachable by keyboard', () => {
  const d = makeData();
  d.events[0].promotion_notes = 'Double points';
  const promo = render(renderPromotions, d, { tab: 'notes' }).node;
  assert.ok(promo.querySelector('button.cell-link'), 'a <td> click handler is unreachable');

  const sheet = render(renderData, { ...d, metricDefs: TYPED_DEFS }, { view: 'daily' }).node;
  const th = sheet.querySelector('th.sheet-head.is-clickable');
  assert.ok(th);
  assert.equal(th.getAttribute('role'), 'button');
  assert.equal(th.tabIndex, 0);
  assert.ok(th.getAttribute('aria-label'));
});

test('a band is stated in words, not only in colour', () => {
  const d = withRunners();
  const { node } = render(RN.renderRunners, d, { tab: 'comparison', type: 'all' });
  const said = node.textContent;
  assert.ok(/good|fair|low/.test(said),
    'sell-through bands must not be conveyed by colour alone');
});

/* ===========================================================================
   Dead-screen fixes, 1 Oct 2026
=========================================================================== */

test('FIX: promotion notes come from the field the API selects (notes)', async () => {
  const PR = await import('../src/screens/promotions.js');
  const d = withMonths();
  d.events[0] = { ...d.events[0], notes: 'Two-for-one flash' };
  const rows = PR.noteRows(d);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'Two-for-one flash');
});

test('FIX: reconcile shows stored-vs-computed once the monthly summary is loaded', async () => {
  const DA = await import('../src/screens/data.js');
  const d = withMonths();
  const m = DA.reconcile(d)[0];
  d.monthlySummary = [{ location_id: 'LS', month: `${m.key}-01`, event_count: 1, total_sales: 100, net_sales: 50, total_attendance: 10 }];
  const rec = DA.reconcile(d);
  assert.ok(rec[0].available);
  assert.ok(DA.differs(rec[0].lines.find((l) => l.label === 'Total Sales').diff), 'a real divergence is flagged');
  const { node } = render(DA.renderData, d, { view: 'reconcile' });
  assert.doesNotMatch(node.textContent, /not loaded/);
});

test('FIX: data view has date inputs that drive the range', async () => {
  const DA = await import('../src/screens/data.js');
  const d = withMonths();
  const nav = [];
  const { node } = render(DA.renderData, d, { view: 'daily', from: '2025-01-01' }, { onNavigate: (s, p) => nav.push(p) });
  const inputs = node.querySelectorAll('.date-range input[type=date]');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].value, '2025-01-01');
  inputs[1].value = '2025-03-31'; inputs[1].dispatchEvent(new window.Event('change'));
  assert.equal(nav.at(-1).to, '2025-03-31');
});

test('FIX: dashboard legends toggle series and remember it in the hash', async () => {
  const DB = await import('../src/screens/dashboard.js');
  const d = withMonths();
  const nav = [];
  const { node } = render(DB.renderDashboard, d, { chart: 'product' }, { onNavigate: (s, p) => nav.push(p) });
  const keys = node.querySelectorAll('.ch-legend button.ch-key');
  assert.ok(keys.length >= 2, 'legend keys are buttons');
  keys[0].click();
  assert.match(nav.at(-1).hide, /^cat-/);
  const { node: n2 } = render(DB.renderDashboard, d, { chart: 'product', hide: nav.at(-1).hide });
  assert.ok(n2.querySelector('.ch-legend .ch-key.is-off'), 'the hidden key renders as off');
});

test('leaderboard days filter: slots, labels and selection', async () => {
  const { daySlots, selectedSlots } = await import('../src/screens/leaderboard.js');
  const ev = (date, type) => ({ event_date: date, event_type: type });
  const slots = daySlots([ev('2026-09-24', 'regular'), ev('2026-09-26', 'regular'), ev('2026-09-26', 'late'), ev('2026-09-27', 'regular')]);
  assert.deepEqual(slots.map((s) => s.label), ['Thu', 'Sat Early', 'Sat Late', 'Sun']);
  assert.equal(selectedSlots(undefined, slots).size, 4);
  assert.deepEqual([...selectedSlots('4-regular', slots)], ['4-regular']);
  assert.equal(selectedSlots('none', slots).size, 0);
  assert.equal(selectedSlots('2-regular', slots).size, 4, 'a slot this hall lacks falls back to all');
});
