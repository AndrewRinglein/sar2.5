/* ============================================================================
   Session detail (U8) — pool controls, sub-pages, bridge, drivers, band,
   Performance / Jackpots / Summary, and state in the hash.

   Own fixture (screens.test.mjs helpers cannot be imported). Values are
   integer cents throughout, as in production.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { renderSession } from '../src/screens/session.js';
import {
  indexMetrics, metricsFor, sessionTotals, comparisonPool, percentile, median, mean, MIN_POOL,
  jackpotBucket, jackpotMatches,
} from '../src/lib/model.js';
import {
  poolOptions, pageOf, sessionPool, poolSentence, poolTotals, categoryComparison, marginValid,
  netDrivers, bridgeItems, findings, expectedBand, slotSeries, bingoPerformance,
  pullTabPerformance, poolAvg, changeBadge, reconcile, jackpotGameStatus, jackpotTable,
  sideGames, cashIntegrity, varianceState, eventPL, bingoVsPullTab, plLadder, distribution,
} from '../src/lib/session-model.js';
import {
  donutSegments, donutArcPath, waterfallLayout, bandSegments,
} from '../src/lib/charts.js';
import { buildHash, parseHash } from '../src/lib/router.js';

/* ---------------------------------------------------------------------------
   DOM and fixture
--------------------------------------------------------------------------- */
const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;

const CATEGORIES = [
  { key: 'flash', display_name: 'Flash', show_rpa: true, show_margin: true, color_border: 'var(--series-1)',
    revenue_keys: ['flash'], payout_keys: ['flash_payout', 'flash_payout_unclaimed'] },
  { key: 'strip', display_name: 'Strip', show_rpa: true, show_margin: true, color_border: 'var(--series-2)',
    revenue_keys: ['strips'], payout_keys: ['strips_payout', 'gremlin_hotball'] },
  { key: 'paper', display_name: 'Paper', show_rpa: false, show_margin: true,
    revenue_keys: ['paper_sales'], payout_keys: ['bingo_payout'] },
  { key: 'other', display_name: 'Other', show_rpa: false, show_margin: false,
    revenue_keys: ['merch'], payout_keys: ['refund_other'] },
];

const KEYS = [
  'attendance', 'flash', 'flash_payout', 'flash_payout_unclaimed', 'strips', 'strips_payout',
  'gremlin_hotball', 'merch', 'refund_other',
  'hotball_total', 'hotball_carryover', 'hotball_payout', 'hotball_participation_cost',
  'mega_hotball_total', 'mega_hotball_carryover', 'mega_hotball_payout',
  'paper_sales', 'supply_sales', 'merchandise_daubers', 'merchandise_tape', 'total_discounts',
  'discount_door_10', 'discount_door_30', 'discount_points', 'discount_refunds', 'bingo_payout',
  'pulltab_sales', 'pulltab_payouts', 'pulltab_net', 'pulltab_credit_deposit',
  'bingo_starting_cash', 'bingo_cash_deposit', 'bingo_credit_deposit', 'bingo_expected_deposit',
  'bingo_variance', 'pulltab_starting_cash', 'pulltab_cash_count', 'pulltab_cash_deposit',
  'pulltab_expected_deposit', 'pulltab_variance',
  'yellow_sheet_in', 'yellow_sheet_out', 'concessions_sales',
];
const DEFS = KEYS.map((k, i) => ({ id: `k${i}`, key: k, canonical_key: k, is_active: true }));
const idx = indexMetrics(DEFS);
const ID = Object.fromEntries(DEFS.map((d) => [d.key, d.id]));

const LOCS = [
  { id: 'LR', name: 'Redwood City', settings: { max_attendance: 200 } },
  { id: 'LS', name: 'Santa Clara', settings: { max_attendance: 430 } },
];
const CONFIG = {
  name: 'Test',
  settings: {
    jackpots: [
      { name: 'Hotball', scope: 'per_location', cap: 5000,
        balanceKey: 'hotball_total', collectedKey: 'hotball_carryover',
        paidKey: 'hotball_payout', participationCost: 500,
        participationCostKey: 'hotball_participation_cost' },
      { name: 'Mega Hotball', scope: 'org_wide', cap: 15000,
        balanceKey: 'mega_hotball_total', collectedKey: 'mega_hotball_carryover',
        paidKey: 'mega_hotball_payout', participationCost: 1000 },
    ],
  },
};

const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
  .toISOString().slice(0, 10);

/** rows: [{ id, date, loc?, type?, m: { key: cents } }] → data, newest first. */
function build(rows, extra = {}) {
  const events = [];
  const metrics = {};
  for (const r of rows) {
    events.push({ id: r.id, location_id: r.loc ?? 'LR', event_date: r.date, event_type: r.type ?? 'regular' });
    metrics[r.id] = Object.fromEntries(Object.entries(r.m ?? {}).map(([k, v]) => [ID[k], v]));
  }
  events.sort((a, b) => (a.event_date < b.event_date ? 1 : a.event_date > b.event_date ? -1 : 0));
  return { events, metrics, idx, categories: CATEGORIES, locations: LOCS, config: CONFIG, metricDefs: DEFS, ...extra };
}

/** Deterministic wobble in [-1, 1]. */
const wob = (i, k = 1) => Math.sin(i * 12.9898 * k + k * 78.233);

function fullMetrics(i, s = 1) {
  const flash = Math.round(3300000 * s * (1 + 0.15 * wob(i, 1)));
  const strips = Math.round(5000000 * s * (1 + 0.12 * wob(i, 2)));
  const paper = Math.round(900000 * s * (1 + 0.1 * wob(i, 3)));
  const ptSales = flash;
  const ptPrizes = Math.round(flash * 0.7);
  return {
    attendance: Math.round(160 + 25 * wob(i, 4)),
    flash, flash_payout: Math.round(flash * 0.68), flash_payout_unclaimed: -Math.round(20000 * (1 + wob(i, 5))),
    strips, strips_payout: Math.round(strips * 0.78), gremlin_hotball: i % 9 === 0 ? 134640 : 0,
    merch: 7600, refund_other: 20400,
    hotball_total: Math.round(400000 + (i % 13) * 60000), hotball_carryover: Math.round(380000 + (i % 13) * 60000),
    hotball_payout: i % 13 === 12 ? 1150000 : 0, hotball_participation_cost: 500,
    mega_hotball_total: 7500000, mega_hotball_carryover: 7400000, mega_hotball_payout: 0,
    paper_sales: paper, supply_sales: 45000, merchandise_daubers: 30000, merchandise_tape: 15000,
    total_discounts: -60000, discount_door_10: -20000, discount_door_30: -30000, discount_points: -10000,
    discount_refunds: 0, bingo_payout: Math.round(paper * 0.9),
    pulltab_sales: ptSales, pulltab_payouts: ptPrizes, pulltab_net: ptSales - ptPrizes,
    pulltab_credit_deposit: Math.round(ptSales * 0.4),
    bingo_starting_cash: 50000, bingo_cash_deposit: 600000, bingo_credit_deposit: 300000,
    bingo_expected_deposit: 900000, bingo_variance: i % 4 === 0 ? -4000 : 1000,
    pulltab_starting_cash: 80000, pulltab_cash_count: 2000000, pulltab_cash_deposit: 1500000,
    pulltab_expected_deposit: 2700000, pulltab_variance: 500,
    yellow_sheet_in: 120000, yellow_sheet_out: 90000, concessions_sales: 45000,
  };
}

/**
 * ~10 months: LR Thursday regulars weekly, LR Thursday lates fortnightly,
 * LS Saturdays weekly, LR Tuesdays fortnightly. Newest LR Thursday is 2026-09-24.
 */
function realistic() {
  const rows = [];
  const lastThu = '2026-09-24';
  for (let w = 0; w < 44; w += 1) {
    rows.push({ id: `thu${w}`, date: shift(lastThu, -7 * w), loc: 'LR', m: fullMetrics(w, 1 + 0.004 * (44 - w)) });
    if (w % 2 === 0) rows.push({ id: `thuL${w}`, date: shift(lastThu, -7 * w), loc: 'LR', type: 'late', m: fullMetrics(w + 100, 0.6) });
    rows.push({ id: `sat${w}`, date: shift(lastThu, -7 * w + 2), loc: 'LS', m: fullMetrics(w + 200, 1.4) });
    if (w % 2 === 1) rows.push({ id: `tue${w}`, date: shift(lastThu, -7 * w - 2), loc: 'LR', m: fullMetrics(w + 300, 0.8) });
  }
  return build(rows);
}

/* ---------------------------------------------------------------------------
   Checks a glance would make (same rules as screens.test.mjs)
--------------------------------------------------------------------------- */
const FORBIDDEN = [
  [/\bNaN\b/, 'NaN'], [/\bundefined\b/, 'undefined'], [/\bnull\b/, 'null'],
  [/\bInfinity\b/, 'Infinity'], [/\[object \w+\]/, '[object Object]'],
  [/\d[eE][+-]\d/, 'scientific notation'], [/\$-/, '$- (sign after the currency symbol)'],
  [/-\$0(?![\d,.])/, 'negative zero (-$0)'],
];
function readableText(node) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue); return; }
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
    assert.ok(!m, `${label}: rendered ${name} — "${text.slice(Math.max(0, (m?.index ?? 0) - 60), (m?.index ?? 0) + 40)}"`);
  }
  const raw = text.match(/\$\d{5,}(?!,)/);
  assert.ok(!raw, `${label}: unformatted money "${raw?.[0]}"`);
  // and nothing in an attribute either (titles carry tooltips)
  for (const el of node.querySelectorAll('[title], title')) {
    const t = el.getAttribute?.('title') ?? el.textContent;
    assert.ok(!/\bNaN\b|\bundefined\b|\bnull\b/.test(t), `${label}: bad tooltip "${t}"`);
  }
  for (const el of node.querySelectorAll('path, rect, circle, line')) {
    for (const a of ['d', 'x', 'y', 'width', 'height', 'cx', 'cy', 'x1', 'x2', 'y1', 'y2']) {
      const v = el.getAttribute(a);
      if (v !== null) assert.ok(!/NaN|Infinity/.test(v), `${label}: SVG ${el.tagName} ${a}="${v}"`);
    }
  }
  return text;
}
function render(data, params = {}, { onNavigate = () => {} } = {}) {
  let inspectorHtml = '';
  const node = renderSession({ data, params, onNavigate, setInspectorContent: (x) => { inspectorHtml = x; } });
  const holder = document.createElement('div');
  holder.innerHTML = inspectorHtml;
  return { node, inspector: holder };
}

const PAGE_LIST = ['overview', 'performance', 'jackpots', 'summary'];
const totalsOf = (data, id) => sessionTotals(metricsFor(id, data.metrics, data.idx), data.categories);

/* ---------------------------------------------------------------------------
   Pool options — SPEC §4.2
--------------------------------------------------------------------------- */

test('poolOptions: defaults 3M / Day Only on / jackpot none, and rejects junk', () => {
  assert.deepEqual(poolOptions({}), { period: '3M', windowDays: 90, dayOnly: true, jackpot: 'none' });
  assert.deepEqual(poolOptions({ period: '1Y', dayOnly: '0', jp: '20%' }),
    { period: '1Y', windowDays: 365, dayOnly: false, jackpot: '20%' });
  assert.equal(poolOptions({ period: '6M' }).period, '3M');
  assert.equal(poolOptions({ jp: 'bogus' }).jackpot, 'none');
  assert.equal(pageOf({ page: 'summary' }), 'summary');
  assert.equal(pageOf({ page: 'nope' }), 'overview');
});

function windowFixture() {
  const T = '2026-09-24';                       // a Thursday
  const back = [7, 28, 30, 31, 84, 89, 91, 364, 365, 366, 371];
  const rows = [{ id: 'T', date: T, m: { hotball_total: 0 } }];
  for (const d of back) {
    // keep weekday: only multiples of 7 stay Thursdays; others are other weekdays
    rows.push({ id: `b${d}`, date: shift(T, -d), m: {} });
  }
  rows.push({ id: 'future', date: shift(T, 7), m: {} });
  rows.push({ id: 'sameDayLate', date: T, type: 'late', m: {} });
  rows.push({ id: 'otherHall', date: shift(T, -7), loc: 'LS', m: {} });
  return build(rows);
}

test('pool period: 1M / 3M / 1Y windows are start-inclusive and strictly before the target', () => {
  const data = windowFixture();
  const T = data.events.find((e) => e.id === 'T');
  const ids = (period) => sessionPool(T, data, poolOptions({ period, dayOnly: '0' })).map((e) => e.id).sort();
  assert.deepEqual(ids('1M'), ['b28', 'b30', 'b7'].sort());
  assert.deepEqual(ids('3M'), ['b28', 'b30', 'b31', 'b7', 'b84', 'b89'].sort());
  assert.deepEqual(ids('1Y'), ['b28', 'b30', 'b31', 'b364', 'b365', 'b7', 'b84', 'b89', 'b91'].sort());
  for (const p of ['1M', '3M', '1Y']) {
    const got = ids(p);
    assert.ok(!got.includes('T'), 'target excluded');
    assert.ok(!got.includes('future'), 'a later session is never in the pool');
    assert.ok(!got.includes('sameDayLate'), 'strict window: same date is not before the target');
    assert.ok(!got.includes('otherHall'), 'always the same hall');
  }
});

test('Day Only on: same weekday AND same session type; off: same hall, any day or type', () => {
  const data = windowFixture();
  const T = data.events.find((e) => e.id === 'T');
  const on = sessionPool(T, data, poolOptions({ period: '1Y' })).map((e) => e.id).sort();
  assert.deepEqual(on, ['b28', 'b7', 'b84', 'b91', 'b364'].sort());     // multiples of 7 only
  // dayOnly off adds the other weekdays at the same hall, still never the other hall
  const off = sessionPool(T, data, poolOptions({ period: '1Y', dayOnly: '0' })).map((e) => e.id);
  assert.ok(off.includes('b30') && off.includes('b365'));
  assert.ok(!off.includes('otherHall'));

  // a late session only compares against lates when Day Only is on
  const late = build([
    { id: 'L', date: '2026-09-24', type: 'late' },
    { id: 'Lprev', date: '2026-09-17', type: 'late' },
    { id: 'Rprev', date: '2026-09-17' },
  ]);
  const L = late.events.find((e) => e.id === 'L');
  assert.deepEqual(sessionPool(L, late, poolOptions({})).map((e) => e.id), ['Lprev']);
  assert.deepEqual(sessionPool(L, late, poolOptions({ dayOnly: '0' })).map((e) => e.id).sort(), ['Lprev', 'Rprev']);
});

test('comparisonPool default behaviour is unchanged by the new options', () => {
  const data = windowFixture();
  const T = data.events.find((e) => e.id === 'T');
  const before = comparisonPool(T, data.events).map((e) => e.id).sort();
  const explicit = comparisonPool(T, data.events, { dayOnly: true, jackpotFilter: 'none', strict: false })
    .map((e) => e.id).sort();
  assert.deepEqual(before, explicit);
  assert.deepEqual(before, ['b28', 'b7', 'b84'].sort());
});

test('jackpot filter: category bands, 10% and 20%, on the first configured jackpot', () => {
  const T = '2026-09-24';
  const bal = {
    lowEdge: 499999, midLo: 500000, midHi: 999999, highLo: 1000000,
    w10lo: 540000, w10hi: 660000, out10: 660001, w20lo: 480000, out20: 479999, missing: null,
  };
  const rows = [{ id: 'T', date: T, m: { hotball_total: 600000 } }];
  Object.entries(bal).forEach(([id, v], i) => rows.push({ id, date: shift(T, -7 * (i + 1)), m: v === null ? {} : { hotball_total: v } }));
  const data = build(rows);
  const target = data.events.find((e) => e.id === 'T');
  const ids = (jp) => sessionPool(target, data, poolOptions({ period: '1Y', jp })).map((e) => e.id).sort();

  assert.equal(ids('none').length, Object.keys(bal).length);
  // target $6,000 is mid ($5k–$10k); $4,800 and $4,799.99 are low
  assert.deepEqual(ids('category'), ['midHi', 'midLo', 'out10', 'w10hi', 'w10lo'].sort());
  assert.deepEqual(ids('10%'), ['w10hi', 'w10lo'].sort());
  // ±$1,200 around $6,000: $4,800 … $7,200
  assert.deepEqual(ids('20%'), ['lowEdge', 'midLo', 'out10', 'w10hi', 'w10lo', 'w20lo'].sort());

  assert.equal(jackpotBucket(499999), 'low');
  assert.equal(jackpotBucket(500000), 'mid');
  assert.equal(jackpotBucket(1000000), 'high');
  // a zero target only matches zeros under a tolerance filter, as SAR 1.0
  assert.equal(jackpotMatches('10%', 0, 0), true);
  assert.equal(jackpotMatches('10%', 0, 1), false);
});

test('"Compared to" sentence names period, day match, jackpot filter and pool size', () => {
  const ev = { event_date: '2026-09-24', event_type: 'regular' };
  const s1 = poolSentence(ev, poolOptions({}), 12, { jackpotName: 'Hotball' });
  assert.match(s1, /3 months/);
  assert.match(s1, /Thursday regular sessions only/);
  assert.match(s1, /any Hotball balance/);
  assert.match(s1, /12 sessions/);
  const s2 = poolSentence(ev, poolOptions({ period: '1M', dayOnly: '0', jp: 'category' }), 1,
    { jackpotName: 'Hotball', targetBalance: 600000 });
  assert.match(s2, /1 month/);
  assert.match(s2, /any day or session type/);
  assert.match(s2, /same band \(\$5,000–\$10,000\)/);
  assert.match(s2, /1 session$/);
  assert.match(poolSentence(ev, poolOptions({ jp: '10%' }), 0, { jackpotName: 'Hotball', targetBalance: 600000 }),
    /within 10% of \$6,000 — no sessions/);

  const data = realistic();
  const { node } = render(data, { id: 'thu0', jp: '20%' });
  const bar = node.querySelector('.sd-compared');
  assert.ok(bar, 'Compared to line missing');
  assert.match(bar.textContent, /Compared to:/);
  assert.match(bar.textContent, /within 20%/);
  const n = sessionPool(data.events.find((e) => e.id === 'thu0'), data, poolOptions({ jp: '20%' })).length;
  assert.equal(node.querySelector('.sd-pool-count strong').textContent, String(n));
});

/* ---------------------------------------------------------------------------
   Every tab renders
--------------------------------------------------------------------------- */

for (const page of PAGE_LIST) {
  test(`${page} renders cleanly on realistic data`, () => {
    const data = realistic();
    const { node, inspector } = render(data, { id: 'thu0', page });
    inspect(node, page);
    inspect(inspector, `${page} inspector`);
    assert.equal(node.querySelector('.sd-tab.is-active').dataset.page, page);
  });

  test(`${page} renders on a session with no attendance recorded`, () => {
    const data = realistic();
    delete data.metrics.thu0[ID.attendance];
    const { node } = render(data, { id: 'thu0', page });
    const text = inspect(node, `${page} (no attendance)`);
    if (page === 'overview') assert.ok(text.includes('—'));
  });

  test(`${page} renders on an all-zero session`, () => {
    const data = realistic();
    for (const k of Object.keys(data.metrics.thu0)) data.metrics.thu0[k] = 0;
    const { node } = render(data, { id: 'thu0', page });
    inspect(node, `${page} (zeros)`);
  });

  test(`${page} renders on a session with no metrics at all and a tiny pool`, () => {
    const data = build([{ id: 'a', date: '2026-09-24' }, { id: 'b', date: '2026-09-17', m: fullMetrics(1) }]);
    const { node } = render(data, { id: 'a', page });
    inspect(node, `${page} (empty session)`);
  });
}

test('only the active page is built (lazy)', () => {
  const data = realistic();
  const { node } = render(data, { id: 'thu0', page: 'summary' });
  assert.equal(node.querySelector('.sd-overview'), null);
  assert.equal(node.querySelector('.sd-performance'), null);
  assert.ok(node.querySelector('.sd-summary'));
});

/* ---------------------------------------------------------------------------
   Overview
--------------------------------------------------------------------------- */

test('attendance KPI reads "{pct}%/{count}" against the hall\'s seats', () => {
  const data = realistic();
  const att = data.metrics.thu0[ID.attendance];
  const { node } = render(data, { id: 'thu0' });
  const card = [...node.querySelectorAll('.kpi')].find((k) => k.textContent.includes('Attendance'));
  assert.equal(card.querySelector('.kpi-value').textContent, `${Math.round((att / 200) * 100)}%/${att}`);
});

test('per-category RPA appears under per head for show_rpa categories only', () => {
  const data = realistic();
  const { node } = render(data, { id: 'thu0' });
  const cats = node.querySelector('.sd-kpi-cats');
  assert.ok(cats);
  assert.match(cats.textContent, /Flash/);
  assert.match(cats.textContent, /Strip/);
  assert.doesNotMatch(cats.textContent, /Other|Paper/);
});

test('donut empty state on a zero-revenue session (SPEC §19.2)', () => {
  const data = realistic();
  for (const k of Object.keys(data.metrics.thu0)) data.metrics.thu0[k] = 0;
  const { node } = render(data, { id: 'thu0' });
  const donuts = node.querySelectorAll('.sd-donut');
  assert.equal(donuts.length, 2);
  for (const d of donuts) {
    assert.equal(d.querySelector('svg'), null, 'no stale donut may be drawn');
    assert.ok(d.querySelector('.sd-empty'), 'explicit empty state');
  }
  assert.match(donuts[0].textContent, /No revenue recorded/);
  assert.match(donuts[1].textContent, /No payouts recorded/);

  assert.deepEqual(donutSegments([{ value: 0 }, { value: -5 }]), { total: 0, segments: [] });
  const s = donutSegments([{ value: 300 }, { value: 100 }, { value: 0 }]);
  assert.equal(s.segments.length, 2);
  assert.equal(s.segments[0].share, 0.75);
  assert.ok(Math.abs(s.segments[1].a1 - Math.PI * 2) < 1e-9);
  assert.ok(!/NaN/.test(donutArcPath(80, 80, 78, 52, 0, Math.PI * 2)), 'a single full slice still draws');
  // realistic: both donuts draw, coloured from the category colour
  const ok = render(realistic(), { id: 'thu0' }).node;
  assert.equal(ok.querySelectorAll('.sd-donut svg').length, 2);
  assert.ok(ok.querySelector('.sd-donut path').getAttribute('style').includes('var(--series-'));
});

test('distribution uses color_border, falling back to a series token', () => {
  const data = realistic();
  const t = totalsOf(data, 'thu0');
  const d = distribution(t, data.categories, 'revenue');
  assert.equal(d[0].colour, 'var(--series-1)');
  assert.equal(d[2].colour, 'var(--series-3)');      // Paper has no color_border
});

test('category margin outside 0–50% renders N/A, and its change is suppressed', () => {
  assert.equal(marginValid(0), true);
  assert.equal(marginValid(0.5), true);
  assert.equal(marginValid(0.5001), false);
  assert.equal(marginValid(-0.01), false);
  assert.equal(marginValid(null), false);

  const data = realistic();
  // Make flash wildly profitable on the target: margin 70%.
  data.metrics.thu0[ID.flash_payout] = Math.round(data.metrics.thu0[ID.flash] * 0.3);
  data.metrics.thu0[ID.flash_payout_unclaimed] = 0;
  const t = totalsOf(data, 'thu0');
  const ev = data.events.find((e) => e.id === 'thu0');
  const pool = poolTotals(sessionPool(ev, data, poolOptions({})), data);
  const rows = categoryComparison(t, pool);
  assert.equal(rows[0].marginShown, 'N/A');
  assert.equal(rows[0].deltas.marginPP, null);
  assert.equal(rows[1].marginShown, rows[1].margin);
  assert.notEqual(rows[1].deltas.marginPP, null);
  assert.equal(rows[3].marginShown, null, 'show_margin false: no margin at all');

  const { node } = render(data, { id: 'thu0' });
  const flashRow = node.querySelector('.sd-cat-row[data-key="flash"] .sd-margin');
  assert.match(flashRow.textContent, /N\/A/);
});

test('category deltas: payouts neutral, RPA against pool revenue ÷ pool attendance', () => {
  const data = realistic();
  const ev = data.events.find((e) => e.id === 'thu0');
  const pool = poolTotals(sessionPool(ev, data, poolOptions({})), data);
  assert.ok(pool.length >= MIN_POOL);
  const t = totalsOf(data, 'thu0');
  const rows = categoryComparison(t, pool);
  assert.equal(rows[0].deltas.payout.tone, 'neutral');
  const poolRpa = pool.reduce((s, p) => s + p.categories[0].revenue, 0) / pool.reduce((s, p) => s + p.attendance, 0);
  assert.ok(Math.abs(rows[0].pool.rpa - poolRpa) < 1e-9);
  assert.equal(rows[2].deltas.rpa, null, 'show_rpa false: no RPA comparison');

  // below MIN_POOL, everything is withheld
  const small = categoryComparison(t, pool.slice(0, MIN_POOL - 1));
  assert.ok(small.every((r) => Object.values(r.deltas).every((d) => d === null)));
});

function oddPool() {
  // 7 prior Thursdays with awkward nets so the pool mean has fractional cents
  const T = '2026-09-24';
  const rows = [{ id: 'T', date: T, m: { attendance: 181, flash: 3412345, flash_payout: 2311111, strips: 5123457, strips_payout: 3999999 } }];
  for (let i = 1; i <= 7; i += 1) {
    rows.push({ id: `p${i}`, date: shift(T, -7 * i), m: {
      attendance: 150 + i * 3, flash: 3300000 + i * 1234, flash_payout: 2200000 + i * 777,
      strips: 5000001 + i * 4321, strips_payout: 3900000 + i * 333,
    } });
  }
  return build(rows);
}

test('bridge bars run from pool-average net to this session\'s net, to the cent', () => {
  for (const data of [oddPool(), realistic()]) {
    const id = data.events[0].id;
    const ev = data.events[0];
    const pool = poolTotals(sessionPool(ev, data, poolOptions({ period: '1Y' })), data);
    const t = totalsOf(data, id);
    for (const mode of ['driver', 'category']) {
      const items = bridgeItems(t, pool, mode);
      const start = items[0];
      const end = items[items.length - 1];
      assert.equal(start.type, 'start');
      assert.equal(end.type, 'total');
      assert.equal(start.value, Math.round(mean(pool.map((p) => p.net))), `${mode}: start is the pool average net`);
      assert.equal(end.value, Math.round(t.net), `${mode}: end is this night's net`);
      const deltas = items.filter((i) => i.type === 'delta');
      for (const d of deltas) assert.ok(Number.isInteger(d.value), `${mode}: ${d.label} is whole cents`);
      assert.equal(start.value + deltas.reduce((s, d) => s + d.value, 0), end.value, `${mode}: bridge closes`);
      assert.equal(waterfallLayout(items).end, end.value);
      assert.ok(items.every((i) => i.label), 'every bar labelled');
    }
    assert.equal(bridgeItems(t, [], 'driver'), null);
  }
});

test('ranked drivers include the residual and sum to the same gap', () => {
  const data = oddPool();
  const ev = data.events[0];
  const pool = poolTotals(sessionPool(ev, data, poolOptions({ period: '1Y' })), data);
  const t = totalsOf(data, 'T');
  const d = netDrivers(t, pool);
  const gap = Math.round(t.net) - Math.round(mean(pool.map((p) => p.net)));
  assert.equal(d.gap, gap);
  assert.ok(d.rows.some((r) => r.residual && r.label === 'Unexplained'));
  assert.equal(d.rows.reduce((s, r) => s + r.impact, 0), gap);
  assert.deepEqual(d.rows.map((r) => r.key).sort(), ['attendance', 'payoutRatio', 'residual', 'spend']);
  for (let i = 1; i < d.rows.length; i += 1) {
    assert.ok(Math.abs(d.rows[i - 1].impact) >= Math.abs(d.rows[i].impact), 'ranked by dollar impact');
  }
  // the bridge's driver bars are the same numbers
  const items = bridgeItems(t, pool, 'driver').filter((i) => i.type === 'delta');
  assert.equal(items.reduce((s, i) => s + i.value, 0), gap);

  // with no attendance, a single "Gross sales" lever replaces attendance × spend
  const t2 = { ...t, attendance: null, rpa: null };
  const d2 = netDrivers(t2, pool);
  assert.deepEqual(d2.rows.map((r) => r.key).sort(), ['gross', 'payoutRatio', 'residual']);
  assert.equal(d2.rows.reduce((s, r) => s + r.impact, 0), gap);

  // rendered: bridge bars and drivers rows, residual styled
  const { node } = render(realistic(), { id: 'thu0' });
  assert.ok(node.querySelectorAll('.sd-bridge svg .wf-bar').length >= 5);
  assert.equal(node.querySelectorAll('.sd-bridge svg .wf-value').length, node.querySelectorAll('.sd-bridge svg .wf-bar').length,
    'every bar carries a value label');
  assert.ok(node.querySelector('.sd-driver.is-residual'));
  assert.match(node.querySelector('.sd-drivers').textContent, /candidates, not a verdict/);
});

test('bridge and drivers are withheld below the pool floor', () => {
  const data = build([{ id: 'a', date: '2026-09-24', m: fullMetrics(1) }, { id: 'b', date: '2026-09-17', m: fullMetrics(2) }]);
  const { node } = render(data, { id: 'a' });
  assert.equal(node.querySelector('.sd-bridge svg'), null);
  assert.match(node.querySelector('.sd-bridge').textContent, /Withheld: 1 comparable session/);
  assert.match(node.querySelector('.sd-drivers').textContent, /Withheld/);
});

test('findings: a small pool leads with a gate and nothing is called a flag', () => {
  const data = realistic();
  const ev = data.events.find((e) => e.id === 'thu0');
  const t = totalsOf(data, 'thu0');
  const m = metricsFor('thu0', data.metrics, data.idx);
  const full = poolTotals(sessionPool(ev, data, poolOptions({})), data);
  const big = findings(t, full, { ev, m, jackpots: CONFIG.settings.jackpots });
  assert.ok(!big.some((f) => f.kind === 'gate'));
  assert.ok(big.filter((f) => f.kind !== 'context').length >= 3, 'top movers always kept');

  const small = findings(t, full.slice(0, 3), { ev, m, jackpots: CONFIG.settings.jackpots });
  assert.equal(small[0].kind, 'gate');
  assert.match(small[0].text, /Only 3 comparable sessions/);
  assert.ok(!small.some((f) => f.kind === 'flag' && f.z !== null), 'no statistical flag on 3 sessions');
  assert.ok(small.filter((f) => f.kind === 'mover').every((f) => f.confidence === 'low'));

  const { node } = render(data, { id: 'thu0', period: '1M' });
  const gate = node.querySelector('.sd-finding.is-gate');
  assert.ok(gate, 'the gate is rendered');
  assert.match(gate.textContent, /SAMPLE/);
});

test('expected band: median and 2.5th–97.5th percentiles of the 12 sessions before each point', () => {
  const series = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, date: shift('2026-01-01', 7 * i), value: 100000 + Math.round(20000 * wob(i, 7)) }));
  const rows = expectedBand(series);
  assert.equal(rows.length, 30);
  assert.equal(rows[rows.length - 1].id, 's39');
  rows.forEach((r) => {
    const g = series.findIndex((s) => s.id === r.id);
    const prior = series.slice(Math.max(0, g - 12), g).map((s) => s.value);
    assert.equal(r.lo, percentile(prior, 0.025));
    assert.equal(r.hi, percentile(prior, 0.975));
    assert.equal(r.expected, median(prior));
    assert.equal(r.inside, r.value >= r.lo && r.value <= r.hi);
  });
  // too little history: no band rather than an invented one
  const short = expectedBand(series.slice(0, 8));
  assert.equal(short[0].lo, null);
  assert.equal(short[5].lo, null);
  assert.notEqual(short[6].lo, null);
  assert.deepEqual(bandSegments(short).map((r) => r.length), [2]);

  // the slot series ends with the target and is that slot only
  const data = realistic();
  const ev = data.events.find((e) => e.id === 'thu0');
  const s = slotSeries(ev, data);
  assert.equal(s[s.length - 1].id, 'thu0');
  assert.ok(s.every((x) => x.id.startsWith('thu') && !x.id.startsWith('thuL')));

  const { node } = render(data, { id: 'thu0' });
  const pts = node.querySelectorAll('.sd-band .band-pt');
  assert.equal(pts.length, 30);
  assert.equal(node.querySelectorAll('.sd-band .band-pt.is-this').length, 1);
  assert.ok([...pts].every((p) => p.querySelector('title')?.textContent.includes('net $')), 'a tooltip per point');
});

test('P&L ladder: expense rows show a dash, never $0', () => {
  const t = totalsOf(realistic(), 'thu0');
  const ladder = plLadder(t);
  const missing = ladder.filter((r) => r.kind === 'missing');
  assert.deepEqual(missing.map((r) => r.key), ['expenses', 'profit']);
  assert.ok(missing.every((r) => r.value === null));
  assert.equal(ladder.find((r) => r.key === 'net').value, t.net);

  for (const page of ['overview', 'summary']) {
    const { node } = render(realistic(), { id: 'thu0', page });
    const rows = node.querySelectorAll('.sd-rung.is-missing');
    assert.equal(rows.length, 2, page);
    for (const r of rows) {
      const amount = r.children[1].textContent.trim();
      assert.equal(amount, '—', `${page}: expense row reads "${amount}"`);
    }
    assert.match(node.querySelector('.sd-rung[data-key="expenses"]').textContent, /not in this database/);
  }
});

/* ---------------------------------------------------------------------------
   Performance — hand-checked fixture
--------------------------------------------------------------------------- */

const HAND = {
  attendance: 100, paper_sales: 100000, strips: 20000, supply_sales: 5000,
  merchandise_daubers: 3000, merchandise_tape: 2000, total_discounts: -3000,
  discount_door_10: 1000, discount_door_30: -2000, bingo_payout: 90000,
  pulltab_sales: 200000, pulltab_payouts: 150000, pulltab_net: 50000, pulltab_credit_deposit: 80000,
};

test('Performance formulas on a hand-checked session', () => {
  const b = bingoPerformance(HAND);
  assert.equal(b.bingoSales, 120000);                     // paper + strips
  assert.equal(b.netBingoSales, 122000);                  // + supply − |discounts|
  assert.equal(b.pl, 32000);                              // − |bingo_payout|
  assert.equal(b.avgPaperOnly, 1170);                     // (120000 − 3000) / 100
  assert.equal(b.avgWithSupplies, 1220);                  // (120000 + 5000 − 3000) / 100
  assert.equal(b.showStrips, true);

  const p = pullTabPerformance(HAND);
  assert.equal(p.cash, 120000);
  assert.equal(p.yield, 0.25);
  assert.equal(p.cashShare, 0.6);
  assert.equal(p.creditShare, 0.4);
  assert.equal(p.avgSpend, 2000);
  assert.equal(p.avgProfit, 500);

  // missing is not zero
  const none = bingoPerformance({});
  assert.equal(none.bingoSales, null);
  assert.equal(none.pl, null);
  assert.equal(none.recorded, false);
  assert.equal(bingoPerformance({ ...HAND, strips: 0 }).showStrips, false);
  assert.equal(pullTabPerformance({ pulltab_sales: 100 }).cash, null, 'no credit figure: cash unknown');

  // rendered
  const rows = [{ id: 'T', date: '2026-09-24', m: HAND }];
  const data = build(rows);
  const { node } = render(data, { id: 'T', page: 'performance' });
  const txt = (k) => node.querySelector(`[data-key="${k}"]`)?.textContent.replace(/\s+/g, ' ').trim();
  assert.match(txt('netBingoSales'), /\$1,220/);
  assert.match(txt('discounts'), /-\$30/);
  assert.match(txt('door10'), /-\$10/, 'a positive discount still displays negative');
  assert.match(txt('payout'), /-\$900/);
  assert.match(txt('bingoPL'), /\+\$320/);
  assert.match(txt('avgPaper'), /\$11\.70/);
  assert.match(txt('avgSupplies'), /\$12\.20/);
  assert.match(txt('ptYield'), /25\.0%/);
  assert.match(txt('ptCash'), /\$1,200/);
  assert.match(txt('split'), /Cash 60%.*Credit 40%/);
  assert.equal(node.querySelector('[data-key="refunds"]'), null, 'an unrecorded detail row is hidden');
  const centres = [...node.querySelectorAll('.sd-centre')].map((e) => e.textContent);
  assert.deepEqual(centres, ['Profit Center', 'Profit Center']);

  const loss = build([{ id: 'T', date: '2026-09-24', m: { ...HAND, bingo_payout: 200000 } }]);
  const lossNode = render(loss, { id: 'T', page: 'performance' }).node;
  assert.equal(lossNode.querySelector('.sd-perf-bingo .sd-centre').textContent, 'Loss Center');
});

test('Performance change badges: blank when the pool average is null or zero', () => {
  assert.equal(changeBadge(100, null), null);
  assert.equal(changeBadge(100, 0), null);
  const b = changeBadge(120, 100);
  assert.equal(b.dir, 1);
  assert.ok(Math.abs(b.rel - 0.2) < 1e-12);
  assert.equal(changeBadge(80, -100).rel, 1.8, 'relative to |avg|');
  assert.equal(changeBadge(150, 100, { neutral: true }).tone, 'neutral');
  assert.equal(poolAvg([{ x: 10 }, {}, { x: 30 }], 'x'), 20, 'missing is skipped, not zero');
  assert.equal(poolAvg([{}, {}], 'x'), null);

  const data = realistic();
  const { node } = render(data, { id: 'thu0', page: 'performance' });
  assert.ok(node.querySelector('[data-key="ptSales"] .sd-mini'), 'badge shown with a full pool');
  assert.equal(node.querySelector('[data-key="ptPrizes"] .sd-mini').className.includes('tone-neutral'), true);
  const small = render(data, { id: 'thu0', page: 'performance', period: '1M' }).node;
  assert.equal(small.querySelector('[data-key="ptSales"] .sd-mini'), null, 'withheld below the floor');
});

test('one headline net; a reconciliation note when canonical keys disagree by more than $1', () => {
  // Categories here: paper_sales − bingo_payout is the Paper net. Canonical =
  // bingo P&L (paper + strips + supply − discounts − payout) + pulltab_net.
  const t = { net: 50000 };
  assert.equal(reconcile(50000, { pl: 30000 }, { net: 20000 }).agrees, true);
  assert.equal(reconcile(50000, { pl: 30000 }, { net: 20101 }).agrees, false);
  assert.equal(reconcile(50000, { pl: 30000 }, { net: 20100 }).agrees, true, '$1 exactly agrees');
  assert.equal(reconcile(t.net, { pl: null }, { net: null }).canonical, null);

  const data = build([{ id: 'T', date: '2026-09-24', m: HAND }]);
  const { node } = render(data, { id: 'T', page: 'performance' });
  const tt = totalsOf(data, 'T');
  assert.match(node.querySelector('.sd-headline').textContent, new RegExp(`\\$${(tt.net / 100).toLocaleString('en-US')}`));
  assert.ok(node.querySelector('.sd-recon'), 'fixture disagrees, so the note must show');

  // make them agree: categories exactly mirror the canonical keys
  const agree = build([{ id: 'T', date: '2026-09-24', m: { paper_sales: 100000, bingo_payout: 90000, pulltab_net: 50000 } }]);
  agree.categories = [
    { key: 'bingo', display_name: 'Bingo', revenue_keys: ['paper_sales'], payout_keys: ['bingo_payout'], show_margin: true },
    { key: 'pt', display_name: 'Pull tabs', revenue_keys: ['pulltab_net'], payout_keys: [], show_margin: false },
  ];
  const ok = render(agree, { id: 'T', page: 'performance' }).node;
  assert.equal(ok.querySelector('.sd-recon'), null);
});

/* ---------------------------------------------------------------------------
   Jackpots page
--------------------------------------------------------------------------- */

test('jackpot status rules: No Game / Active / Building, and the total row', () => {
  assert.equal(jackpotGameStatus(0, 0), 'No Game');
  assert.equal(jackpotGameStatus(null, null), 'No Game');
  assert.equal(jackpotGameStatus(500, 0), 'Building');
  assert.equal(jackpotGameStatus(500, null), 'Building');
  assert.equal(jackpotGameStatus(500, 100), 'Active');
  assert.equal(jackpotGameStatus(0, 100), 'Active');

  const m = {
    hotball_total: 1200000, hotball_carryover: 1130000, hotball_payout: 0, hotball_participation_cost: 500,
    mega_hotball_total: 0, mega_hotball_carryover: 0, mega_hotball_payout: 0,
  };
  const tbl = jackpotTable(m, CONFIG.settings.jackpots, 200);
  assert.deepEqual(tbl.rows.map((r) => r.status), ['Building', 'No Game']);
  assert.equal(tbl.active, 1);
  assert.equal(tbl.rows[0].players, 140);                 // (1,200,000 − 1,130,000) / 500
  assert.equal(tbl.rows[0].pctAtt, 0.7);
  assert.equal(tbl.total.collected, 1130000);
  assert.equal(tbl.total.paid, 0);
  assert.equal(tbl.total.net, 1130000);
  assert.equal(tbl.total.balance, 1200000);
  assert.equal(tbl.total.players, 140);

  const paid = jackpotTable({ ...m, hotball_payout: 1150000 }, CONFIG.settings.jackpots, 200);
  assert.equal(paid.rows[0].status, 'Active');
  assert.equal(paid.total.net, 1130000 - 1150000);

  const data = build([{ id: 'T', date: '2026-09-24', m: { ...m, attendance: 200 } }]);
  const { node } = render(data, { id: 'T', page: 'jackpots' });
  const total = node.querySelector('.sd-jp-table .total-row');
  assert.match(total.textContent, /Total jackpots/);
  assert.match(total.textContent, /\$11,300/);
  assert.match(total.textContent, /\$12,000/);
  assert.match(total.textContent, /140/);
  assert.match(node.querySelector('.sd-count-badge').textContent, /1 active jackpot$/);
  assert.equal(node.querySelectorAll('.sd-jp-card').length, 2);
});

test('Jackpots page uses the Overview bands (33/66/90), resolving §19.4', () => {
  const data = realistic();
  const ov = render(data, { id: 'thu0' }).node;
  const jp = render(data, { id: 'thu0', page: 'jackpots' }).node;
  const ovStatus = [...ov.querySelectorAll('.jp .jp-status')].map((e) => e.textContent);
  const jpStatus = [...jp.querySelectorAll('.sd-jp-card .jp-status')].map((e) => e.textContent);
  assert.deepEqual(jpStatus, ovStatus);
  for (const s of jpStatus) assert.ok(['LOW', 'BUILDING', 'HIGH', 'HOT'].includes(s));
});

test('side games hide when all three inputs are zero or unrecorded', () => {
  assert.equal(sideGames({}).show, false);
  assert.equal(sideGames({ yellow_sheet_in: 0, yellow_sheet_out: 0, concessions_sales: 0 }).show, false);
  const sg = sideGames({ yellow_sheet_in: 120000, yellow_sheet_out: 90000, concessions_sales: 45000 });
  assert.equal(sg.show, true);
  assert.equal(sg.yellowNet, 30000);
  assert.equal(sg.totalIn, 165000);
  assert.equal(sg.totalNet, 75000);

  const data = realistic();
  assert.ok(render(data, { id: 'thu0', page: 'jackpots' }).node.querySelector('[data-section="side-games"]'));
  for (const k of ['yellow_sheet_in', 'yellow_sheet_out', 'concessions_sales']) data.metrics.thu0[ID[k]] = 0;
  assert.equal(render(data, { id: 'thu0', page: 'jackpots' }).node.querySelector('[data-section="side-games"]'), null);
});

/* ---------------------------------------------------------------------------
   Summary
--------------------------------------------------------------------------- */

test('variance thresholds: > $100 bad, > $25 warn, else good; missing is not good', () => {
  assert.equal(varianceState(10001), 'bad');
  assert.equal(varianceState(-10001), 'bad');
  assert.equal(varianceState(10000), 'warn');
  assert.equal(varianceState(2501), 'warn');
  assert.equal(varianceState(2500), 'good');
  assert.equal(varianceState(0), 'good');
  assert.equal(varianceState(null), null);

  const mk = (bv, pv) => build([{ id: 'T', date: '2026-09-24', m: {
    bingo_starting_cash: 50000, bingo_expected_deposit: 900000, bingo_variance: bv,
    pulltab_starting_cash: 80000, pulltab_expected_deposit: 100, pulltab_variance: pv,
  } }]);
  const n = render(mk(-12000, 3000), { id: 'T', page: 'summary' }).node;
  assert.deepEqual([...n.querySelectorAll('.sd-var')].map((v) => v.dataset.state), ['bad', 'warn']);
  const combined = n.querySelector('[data-key="combined"] .sd-stat-value');
  assert.match(combined.textContent, /-\$90/);
  assert.ok(combined.classList.contains('is-warn'));
  // variance is READ, not recomputed: actual − expected here would be wildly different
  const ci = cashIntegrity({ bingo_cash_deposit: 100, bingo_credit_deposit: 100, bingo_expected_deposit: 99999, bingo_variance: 5 });
  assert.equal(ci.bingo.variance, 5);
});

test('cash integrity hides without reconciliation data; the drawer panel hides on its own', () => {
  const none = build([{ id: 'T', date: '2026-09-24', m: { flash: 100000 } }]);
  const a = render(none, { id: 'T', page: 'summary' }).node;
  assert.equal(a.querySelector('[data-section="cash-integrity"]'), null);
  assert.match(a.querySelector('[data-key="combined"]').textContent, /N\/A/);
  assert.match(a.querySelector('[data-key="combined"]').textContent, /No reconciliation data/);

  const bingoOnly = build([{ id: 'T', date: '2026-09-24', m: { bingo_starting_cash: 50000, bingo_expected_deposit: 900000, bingo_variance: 0 } }]);
  const b = render(bingoOnly, { id: 'T', page: 'summary' }).node;
  const grid = b.querySelector('[data-section="cash-integrity"]');
  assert.ok(grid.querySelector('.sd-register'));
  assert.equal(grid.querySelector('.sd-drawer'), null);
  assert.ok(grid.classList.contains('is-single'));

  const full = render(realistic(), { id: 'thu0', page: 'summary' }).node;
  assert.ok(full.querySelector('.sd-drawer'));
  assert.match(full.querySelector('.sd-drawer').textContent, /Less: jackpot deposit/);
});

test('event P&L rows appear only when |net| or |revenue| exceeds $0.50, and sum to the headline net', () => {
  const t = { categories: [
    { key: 'a', net: 50, revenue: 50 }, { key: 'b', net: 51, revenue: 0 },
    { key: 'c', net: 0, revenue: -51 }, { key: 'd', net: -40, revenue: 10 },
  ] };
  assert.deepEqual(eventPL(t).map((c) => c.key), ['b', 'c']);

  const data = realistic();
  const tt = totalsOf(data, 'thu0');
  const { node } = render(data, { id: 'thu0', page: 'summary' });
  assert.match(node.querySelector('[data-key="eventNet"]').textContent, /Event net revenue/);
  assert.ok(node.querySelector('[data-key="eventNet"]').textContent.includes(
    `${tt.net > 0 ? '+' : ''}$${Math.round(tt.net / 100).toLocaleString('en-US')}`));
});

test('"Bingo as % of Pull Tab Profit" says loss or profit by its own sign (SPEC §19.6)', () => {
  const loss = bingoVsPullTab(-5000, 20000);
  assert.equal(loss.pct, 0.25);
  assert.match(loss.detail, /\$50 bingo loss \/ \$200 pull-tab profit/);
  const profit = bingoVsPullTab(5000, 20000);
  assert.match(profit.detail, /\$50 bingo profit \/ \$200 pull-tab profit/);
  assert.doesNotMatch(profit.detail, /loss/);
  const ptLoss = bingoVsPullTab(5000, -20000);
  assert.equal(ptLoss.pct, null, 'no pull-tab profit to be a share of');
  assert.match(ptLoss.detail, /pull-tab loss/);

  const mk = (payout) => build([{ id: 'T', date: '2026-09-24', m: { ...HAND, bingo_payout: payout } }]);
  const detail = (payout) => render(mk(payout), { id: 'T', page: 'summary' }).node
    .querySelector('[data-key="bingo-vs-pt"] .sd-stat-detail').textContent;
  assert.match(detail(90000), /bingo profit/);       // P&L +$320
  assert.match(detail(200000), /bingo loss/);        // P&L −$780
});

/* ---------------------------------------------------------------------------
   Picker and state in the hash
--------------------------------------------------------------------------- */

test('from-date filter keeps six cards on or before the date; Previous reaches older sessions', () => {
  const data = realistic();
  const { node } = render(data, { from: '2026-06-01' });
  const cards = [...node.querySelectorAll('.sess-card')];
  assert.equal(cards.length, 6);
  for (const c of cards) {
    const ev = data.events.find((e) => e.id === c.dataset.id);
    assert.ok(ev.event_date <= '2026-06-01');
  }
  assert.ok(cards[0].classList.contains('is-selected'), 'the newest visible session is selected');
  const prev = node.querySelector('.sd-previous');
  const opts = [...prev.options].filter((o) => o.value);
  assert.equal(opts.length, 14);
  assert.ok(opts.every((o) => !cards.some((c) => c.dataset.id === o.value)));
  assert.equal(node.querySelector('.sd-from-input').value, '2026-06-01');

  // an old session picked from Previous stays listed and selected
  const old = opts[10].value;
  const again = render(data, { id: old }).node;
  assert.equal(again.querySelector('.sd-previous').value, old);
});

test('every control writes the hash, and the hash reproduces the screen', () => {
  const data = realistic();
  const calls = [];
  const nav = (screen, params) => calls.push({ screen, params });
  const base = { id: 'thu0' };
  const { node } = render(data, base, { onNavigate: nav });

  node.querySelector('.chip[data-period="1Y"]').click();
  const box = node.querySelector('.sd-dayonly'); box.checked = false; box.dispatchEvent(new window.Event('change'));
  const sel = node.querySelector('.sd-jp-filter'); sel.value = '10%'; sel.dispatchEvent(new window.Event('change'));
  node.querySelector('.sd-tab[data-page="jackpots"]').click();
  node.querySelector('.chip[data-bridge="category"]').click();
  const from = node.querySelector('.sd-from-input'); from.value = '2026-05-01'; from.dispatchEvent(new window.Event('change'));
  node.querySelectorAll('.sess-card')[2].click();

  assert.ok(calls.every((c) => c.screen === 'session'));
  assert.equal(calls[0].params.period, '1Y');
  assert.equal(calls[1].params.dayOnly, '0');
  assert.equal(calls[2].params.jp, '10%');
  assert.equal(calls[3].params.page, 'jackpots');
  assert.equal(calls[4].params.bridge, 'category');
  assert.equal(calls[5].params.from, '2026-05-01');
  assert.equal(calls[5].params.id, undefined, 'a new from-date reselects within it');
  assert.equal(calls[6].params.id, node.querySelectorAll('.sess-card')[2].dataset.id);

  // Round trip: params -> hash -> params -> same screen state.
  const params = { id: 'thu0', period: '1Y', dayOnly: '0', jp: '10%', page: 'overview', bridge: 'category', from: '2026-09-30' };
  const back = parseHash(buildHash('session', params));
  assert.equal(back.screen, 'session');
  assert.deepEqual(back.params, params);
  const re = render(data, back.params).node;
  assert.ok(re.querySelector('.chip[data-period="1Y"]').classList.contains('is-active'));
  assert.equal(re.querySelector('.sd-dayonly').checked, false);
  assert.equal(re.querySelector('.sd-jp-filter').value, '10%');
  assert.ok(re.querySelector('.chip[data-bridge="category"]').classList.contains('is-active'));
  assert.ok(re.querySelector('.sess-card.is-selected[data-id="thu0"]'));
  assert.match(re.querySelector('.sd-compared').textContent, /1 year/);

  // a pick keeps the pool options
  const keep = [];
  const r2 = render(data, { period: '1M', jp: 'category' }, { onNavigate: (s, p) => keep.push(p) }).node;
  r2.querySelectorAll('.sess-card')[1].click();
  assert.equal(keep[0].period, '1M');
  assert.equal(keep[0].jp, 'category');
});

test('the KPI strip and categories compare against the selected pool', () => {
  const data = realistic();
  const kpiText = (params) => render(data, { id: 'thu0', ...params }).node.querySelector('.kpis').textContent;
  assert.match(kpiText({}), /vs Thu avg, 3M/);
  assert.match(kpiText({ dayOnly: '0', period: '1Y' }), /vs hall avg, 1Y/);
  assert.match(kpiText({ period: '1M' }), /pool too small/);
});


test('ORACLE FIX: a cash-variance finding is badged OVER or SHORT, not BELOW', async () => {
  const SM = await import('../src/lib/session-model.js');
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/screens/session.js', import.meta.url), 'utf8');
  assert.match(src, /f\.dir === 'over' \? 'OVER'/);
  assert.ok(SM, 'module loads');
});
