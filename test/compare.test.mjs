/* ============================================================================
   Compare — U18 cohort comparison

   Checks the screen against SAR 1.0's CohortComparison behaviour (SPEC §7)
   and against the two things the rebuild fixes: one median definition
   (SPEC §19.7) and a minimum-sample gate.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  renderCompare, METRICS, DAY_METRICS, CHARTS, SESSION_TYPES, MIN_SESSIONS,
  SIGNIFICANCE_LABELS, EFFECT_LABELS,
  dayOptions, defaultCohorts, addMonths, addDays, readState, stateToParams,
  effectiveCohorts, filterCohort, cohortStats, pctChange, testMetric, compareCohorts,
  deltaChart, dayBreakdownChart, dumbbellChart, boxPlotChart,
} from '../src/screens/compare.js';
import {
  indexMetrics, mean, median, stdev, percentile, welchT, significance, effectSize,
} from '../src/lib/model.js';
import { parseHash, buildHash } from '../src/lib/router.js';

/* ---------------------------------------------------------------------------
   A DOM, and a small fixture builder
--------------------------------------------------------------------------- */
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost/' });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;

const CATEGORIES = [
  { key: 'flash', display_name: 'Flash', show_rpa: true, show_margin: true,
    revenue_keys: ['flash'], payout_keys: ['flash_payout'] },
];
const METRIC_DEFS = ['flash', 'flash_payout', 'attendance']
  .map((k, i) => ({ id: `m${i}`, key: k, canonical_key: k, is_active: true }));
const idx = indexMetrics(METRIC_DEFS);
const byKey = Object.fromEntries(METRIC_DEFS.map((d) => [d.key, d.id]));
const LOCS = [
  { id: 'LR', name: 'Redwood City' },
  { id: 'LS', name: 'Santa Clara' },
];

/**
 * sessions: [{ id, date, type, loc, flash (cents), payout (cents), att }]
 * Newest first, as the API delivers them.
 */
function fixture(sessions) {
  const events = []; const metrics = {};
  for (const s of sessions) {
    events.push({ id: s.id, location_id: s.loc ?? 'LS', event_date: s.date,
                  event_type: s.type ?? 'regular', customer_id: 'vanguard' });
    metrics[s.id] = {
      [byKey.flash]: s.flash ?? 5000000,
      [byKey.flash_payout]: s.payout ?? 3000000,
    };
    if (s.att !== undefined) metrics[s.id][byKey.attendance] = s.att;
  }
  events.sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
  return { events, metrics, idx, categories: CATEGORIES, locations: LOCS,
           config: { name: 'Test', settings: { jackpots: [] } }, metricDefs: METRIC_DEFS };
}

/** 26 months, three sessions a month per hall, the third one late. */
function withMonths({ months = 26 } = {}) {
  const out = []; let k = 0;
  const start = new Date(Date.UTC(2024, 6, 5));
  for (let m = 0; m < months; m += 1) {
    for (let s = 0; s < 3; s += 1) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 4 + s * 9));
      for (const loc of ['LS', 'LR']) {
        const sc = 1 + (m % 6) * 0.08 + (loc === 'LS' ? 0.4 : 0);
        out.push({ id: `d${k++}`, date: d.toISOString().slice(0, 10), loc,
                   type: s === 2 ? 'late' : 'regular',
                   flash: Math.round(8300000 * sc), payout: Math.round(5490000 * sc),
                   att: 150 + (m % 30) });
      }
    }
  }
  return fixture(out);
}

/* The hand-checked Welch example from screens.test.mjs: attendance values
   100.5 vs 199.5 on average, diff −99, df 10. A sits in the default A range
   (last three months to 2026-08-13), B in the default B range before it. */
const HAND_A = [100, 102, 98, 101, 99, 103];
const HAND_B = [200, 198, 202, 199, 201, 197];
function handChecked() {
  const rows = [];
  HAND_A.forEach((att, i) => rows.push({ id: `a${i}`, date: addDays('2026-08-13', -7 * i), att }));
  HAND_B.forEach((att, i) => rows.push({ id: `b${i}`, date: addDays('2026-05-01', -7 * i), att }));
  return fixture(rows);
}

/* ---- the glance checks, copied from screens.test.mjs ---- */
const FORBIDDEN = [
  [/\bNaN\b/, 'NaN'], [/\bundefined\b/, 'undefined'], [/\bnull\b/, 'null'],
  [/\bInfinity\b/, 'Infinity'], [/\[object \w+\]/, '[object Object]'],
  [/\d[eE][+-]\d/, 'scientific notation'], [/\$-/, '$- (sign after the currency symbol)'],
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
    assert.ok(!m, `${label}: rendered ${name} — "${text.slice(Math.max(0, m?.index - 60), (m?.index ?? 0) + 40)}"`);
  }
  const raw = text.match(/\$\d{5,}(?!,)/);
  assert.ok(!raw, `${label}: unformatted money "${raw?.[0]}"`);
  return text;
}
function render(data, params = {}) {
  let inspectorHtml = ''; const navs = [];
  const node = renderCompare({
    data, params,
    onNavigate: (screen, p) => navs.push({ screen, params: p }),
    setInspectorContent: (h) => { inspectorHtml = h; },
  });
  const inspector = document.createElement('div');
  inspector.innerHTML = inspectorHtml;
  return { node, inspector, navs };
}

/* ---------------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------------- */

test('compare renders cleanly on two years of sessions', () => {
  const { node, inspector } = render(withMonths());
  const text = inspect(node, 'compare');
  inspect(inspector, 'compare inspector');
  assert.equal(node.querySelectorAll('.cmp-card').length, 6, 'six metric cards');
  assert.ok(text.includes('Cohort A') && text.includes('Cohort B'));
});

test('compare renders cleanly with no data at all', () => {
  const empty = { events: [], metrics: {}, idx, categories: [], locations: [] };
  const { node, inspector } = render(empty);
  inspect(node, 'compare (empty)');
  inspect(inspector, 'compare inspector (empty)');
  assert.ok(readableText(node).includes('No sessions in either cohort'));
});

test('the six metrics are SAR 1.0\'s, in its order and with its labels', () => {
  assert.deepEqual(METRICS.map((m) => m.label),
    ['Total Sales', 'Net Sales', 'Total Payout', 'Margin %', 'RPA', 'Attendance']);
  assert.deepEqual(METRICS.map((m) => m.key),
    ['totalSales', 'netSales', 'totalPayouts', 'margin', 'rpa', 'attendance']);
  // and the day breakdown uses SAR 1.0's four sub-metrics
  assert.deepEqual(DAY_METRICS, ['attendance', 'rpa', 'netSales', 'margin']);
  const { node } = render(withMonths());
  assert.deepEqual([...node.querySelectorAll('.cmp-card')].map((c) => c.dataset.metric),
    METRICS.map((m) => m.key));
});

/* ---------------------------------------------------------------------------
   Defaults and day options
--------------------------------------------------------------------------- */

test('default cohorts are the last three months and the three months before', () => {
  const data = handChecked();                     // latest session 2026-08-13
  const d = defaultCohorts(data.events);
  assert.deepEqual(d, { aFrom: '2026-05-13', aTo: '2026-08-13', bFrom: '2026-02-13', bTo: '2026-05-12' });
  // and the inputs show them
  const { node } = render(data);
  assert.equal(node.querySelector('input[name="a_from"]').value, '2026-05-13');
  assert.equal(node.querySelector('input[name="a_to"]').value, '2026-08-13');
  assert.equal(node.querySelector('input[name="b_from"]').value, '2026-02-13');
  assert.equal(node.querySelector('input[name="b_to"]').value, '2026-05-12');
});

test('month arithmetic clamps to the month end rather than rolling over', () => {
  assert.equal(addMonths('2026-05-31', -3), '2026-02-28');
  assert.equal(addMonths('2024-05-31', -3), '2024-02-29');
  assert.equal(addMonths('2026-01-15', -3), '2025-10-15');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('day options come from the data, with an Early/Late split only where both exist', () => {
  // 2026-08-08 is a Saturday, 2026-08-06 a Thursday, 2026-08-09 a Sunday.
  const data = fixture([
    { id: 's1', date: '2026-08-08', type: 'regular' },
    { id: 's2', date: '2026-08-08', type: 'late' },
    { id: 's3', date: '2026-08-06', type: 'regular' },
    { id: 's4', date: '2026-08-09', type: 'late' },
  ]);
  const opts = dayOptions(data.events);
  assert.deepEqual(opts.map((o) => o.label), ['Thu', 'Sat Early', 'Sat Late', 'Sun Late']);
  assert.deepEqual(opts.map((o) => o.key), ['thu', 'sat', 'sat-late', 'sun-late']);
  // Monday-first ordering, as SAR 1.0 lists them; Sunday last.
  assert.deepEqual(opts.map((o) => o.dow), [4, 6, 6, 0]);
  // the checkboxes follow
  const { node } = render(data);
  const labels = [...node.querySelectorAll('.cmp-cohort-a .cmp-day')].map((l) => l.textContent.trim());
  assert.deepEqual(labels, ['Thu', 'Sat Early', 'Sat Late', 'Sun Late']);
  assert.ok([...node.querySelectorAll('.cmp-cohort-a .cmp-day input')].every((cb) => cb.checked),
    'every day is ticked by default');
});

test('a stored day_of_week wins over the date; the date decides otherwise', () => {
  const data = fixture([{ id: 's1', date: '2026-08-08' }]);
  data.events[0].day_of_week = 'Friday';
  assert.deepEqual(dayOptions(data.events).map((o) => o.label), ['Fri']);
  delete data.events[0].day_of_week;
  assert.deepEqual(dayOptions(data.events).map((o) => o.label), ['Sat']);
});

/* ---------------------------------------------------------------------------
   Mirror toggles and the session-type control
--------------------------------------------------------------------------- */

test("B mirrors A's days by default and A's dates only when asked", () => {
  const data = withMonths();
  const st = readState({}, data);
  assert.equal(st.mirrorDays, true);
  assert.equal(st.mirrorDates, false);

  const { node } = render(data);
  assert.equal(node.querySelector('.cmp-cohort-b input[name="mdays"]').checked, true);
  assert.equal(node.querySelector('.cmp-cohort-b input[name="mdates"]').checked, false);
  assert.equal(node.querySelector('.cmp-cohort-b .cmp-days-list').hidden, true, 'B days hidden while mirrored');
  assert.equal(node.querySelector('.cmp-cohort-b .cmp-dates').hidden, false, 'B dates shown');

  const on = readState({ mdates: '1', a_days: 'sat', b_days: 'thu', a_type: 'late' }, data);
  const eff = effectiveCohorts(on);
  assert.equal(eff.b.from, on.a.from);
  assert.equal(eff.b.to, on.a.to);
  assert.deepEqual(eff.b.days, ['sat'], "mirrored days are A's");
  assert.equal(eff.b.type, 'late', "mirrored days carry A's session type too");

  const off = readState({ mdays: '0', a_days: 'sat', b_days: 'thu' }, data);
  assert.deepEqual(effectiveCohorts(off).b.days, ['thu']);
  const { node: n2 } = render(data, { mdays: '0', mdates: '1' });
  assert.equal(n2.querySelector('.cmp-cohort-b .cmp-days-list').hidden, false);
  assert.equal(n2.querySelector('.cmp-cohort-b .cmp-dates').hidden, true);
});

test('ticking a mirror checkbox navigates with the flag in the params', () => {
  const data = withMonths();
  const { node, navs } = render(data);
  const cb = node.querySelector('.cmp-cohort-b input[name="mdates"]');
  cb.checked = true;
  cb.dispatchEvent(new dom.window.Event('change'));
  assert.equal(navs.at(-1).screen, 'compare');
  assert.equal(navs.at(-1).params.mdates, '1');
  const cb2 = node.querySelector('.cmp-cohort-b input[name="mdays"]');
  cb2.checked = false;
  cb2.dispatchEvent(new dom.window.Event('change'));
  assert.equal(navs.at(-1).params.mdays, '0');
});

test('the session-type control narrows a cohort to regular or late sessions', () => {
  const data = withMonths();
  assert.deepEqual(SESSION_TYPES.map((t) => t.key), ['both', 'regular', 'late']);
  const both = compareCohorts(data, readState({}, data));
  const late = compareCohorts(data, readState({ a_type: 'late' }, data));
  const reg = compareCohorts(data, readState({ a_type: 'regular' }, data));
  assert.ok(late.rowsA.length > 0 && reg.rowsA.length > 0);
  assert.ok(late.rowsA.every((r) => r.event.event_type === 'late'));
  assert.ok(reg.rowsA.every((r) => r.event.event_type === 'regular'));
  assert.equal(late.rowsA.length + reg.rowsA.length, both.rowsA.length);
  // the chip reflects it and the excluded day options are disabled
  const { node } = render(data, { a_type: 'late' });
  assert.ok(node.querySelector('.cmp-cohort-a .chip[data-type="late"]').classList.contains('is-active'));
  const offs = [...node.querySelectorAll('.cmp-cohort-a .cmp-day.is-off input')];
  assert.ok(offs.length > 0 && offs.every((cb) => cb.disabled));
});

test('location is shared and filters both cohorts', () => {
  const data = withMonths();
  const r = compareCohorts(data, readState({ hall: 'LR' }, data));
  assert.ok(r.rowsA.length > 0 && r.rowsB.length > 0);
  assert.ok([...r.rowsA, ...r.rowsB].every((x) => x.event.location_id === 'LR'));
  const { node, navs } = render(data);
  assert.deepEqual([...node.querySelectorAll('.filter-bar .chip[data-hall]')].map((c) => c.textContent),
    ['Both halls', 'Redwood City', 'Santa Clara']);
  node.querySelector('.chip[data-hall="LS"]').click();
  assert.equal(navs.at(-1).params.hall, 'LS');
});

/* ---------------------------------------------------------------------------
   Statistics — against the hand-checked example
--------------------------------------------------------------------------- */

test('cohort stats match the hand-checked fixture', () => {
  const data = handChecked();
  const cmp = compareCohorts(data, readState({}, data));
  assert.equal(cmp.rowsA.length, 6);
  assert.equal(cmp.rowsB.length, 6);
  const r = cmp.results.find((x) => x.metric.key === 'attendance');

  assert.deepEqual([...r.A.values].sort((a, b) => a - b), [...HAND_A].sort((a, b) => a - b));
  assert.equal(r.A.n, 6); assert.equal(r.B.n, 6);
  assert.equal(r.A.mean, 100.5); assert.equal(r.B.mean, 199.5);
  assert.equal(r.A.median, median(HAND_A)); assert.equal(r.A.median, 100.5);
  assert.equal(r.A.sd, stdev(HAND_A));
  assert.ok(Math.abs(r.A.sd - 1.8708) < 1e-3, `sample SD was ${r.A.sd}`);
  assert.equal(r.A.min, 98); assert.equal(r.A.max, 103); assert.equal(r.A.sum, 603);
  assert.equal(r.B.min, 197); assert.equal(r.B.max, 202); assert.equal(r.B.sum, 1197);

  // Welch: the same numbers model.welchT produces, and SAR 1.0's labels
  const w = welchT(HAND_A, HAND_B);
  assert.equal(r.test.enough, true);
  assert.equal(r.test.df, 10);
  assert.equal(r.test.p, w.p);
  assert.ok(r.test.p < 0.001);
  assert.equal(r.test.d, w.cohensD);
  assert.equal(r.test.sig, 'very strong');
  assert.equal(SIGNIFICANCE_LABELS[r.test.sig], 'Highly Significant');
  assert.equal(r.test.eff, 'large');
  assert.equal(EFFECT_LABELS[r.test.eff], 'Large');
});

test('the label thresholds are SAR 1.0\'s: d 0.2/0.5/0.8 and p 0.001/0.01/0.05/0.10', () => {
  assert.equal(EFFECT_LABELS[effectSize(0.19)], 'Negligible');
  assert.equal(EFFECT_LABELS[effectSize(0.2)], 'Small');
  assert.equal(EFFECT_LABELS[effectSize(0.5)], 'Medium');
  assert.equal(EFFECT_LABELS[effectSize(0.8)], 'Large');
  assert.equal(SIGNIFICANCE_LABELS[significance(0.0009)], 'Highly Significant');
  assert.equal(SIGNIFICANCE_LABELS[significance(0.009)], 'Very Significant');
  assert.equal(SIGNIFICANCE_LABELS[significance(0.049)], 'Significant');
  assert.equal(SIGNIFICANCE_LABELS[significance(0.099)], 'Marginally Significant');
  assert.equal(SIGNIFICANCE_LABELS[significance(0.1)], 'Not Significant');
});

test('percentage change is (meanA − meanB) / |meanB|, A relative to B, signed', () => {
  const A = cohortStats(HAND_A); const B = cohortStats(HAND_B);
  assert.equal(pctChange(A, B), (100.5 - 199.5) / 199.5);
  assert.ok(pctChange(A, B) < 0, 'A below B is negative');
  assert.ok(pctChange(B, A) > 0, 'A above B is positive');
  assert.equal(pctChange(cohortStats([-10, -30]), cohortStats([-20])), 0, 'equal means, negative base');
  assert.equal(pctChange(cohortStats([-10]), cohortStats([-20])), 0.5, 'divides by |meanB|');
  assert.equal(pctChange(A, cohortStats([])), null, 'no B: undefined');
  assert.equal(pctChange(A, cohortStats([0, 0])), null, 'zero B mean: undefined');

  const { node } = render(handChecked());
  const card = node.querySelector('.cmp-card[data-metric="attendance"]');
  const delta = card.querySelector('.cmp-delta');
  assert.equal(delta.textContent.trim(), '▼ -49.6%');
  assert.ok(delta.classList.contains('tone-neg'));
});

test('Total Payout carries no good/bad tone; the others do', () => {
  const { node } = render(handChecked());
  // revenue/payout are constant across the fixture, so payout delta is 0%
  const payout = node.querySelector('.cmp-card[data-metric="totalPayouts"] .cmp-delta');
  assert.ok(payout.classList.contains('tone-neutral'));
  const att = node.querySelector('.cmp-card[data-metric="attendance"] .cmp-delta');
  assert.ok(att.classList.contains('tone-neg'));
});

test('a verdict is withheld below the minimum sample, not shown with false confidence', () => {
  assert.equal(MIN_SESSIONS, 3);
  const data = handChecked();
  data.events = data.events.filter((e) => !['b2', 'b3', 'b4', 'b5'].includes(e.id));   // B has 2
  const cmp = compareCohorts(data, readState({}, data));
  const r = cmp.results.find((x) => x.metric.key === 'attendance');
  assert.equal(r.B.n, 2);
  assert.equal(r.test.enough, false);
  assert.equal(r.test.nB, 2);
  assert.notEqual(r.pct, null, 'the means and delta still show; only the test is withheld');

  const { node, inspector } = render(data);
  const text = inspect(node, 'compare (gate)');
  assert.ok(/Not enough sessions \(6 in A, 2 in B; need 3\)/.test(text), text);
  assert.ok(!/Significant/.test(text), 'no significance label below the gate');
  assert.ok(/withheld/.test(readableText(inspector)));
});

test('two flat cohorts report p = 1 and d = 0, as SAR 1.0 does — equal is not insufficient', () => {
  const t = testMetric(cohortStats([5, 5, 5]), cohortStats([5, 5, 5, 5]));
  assert.equal(t.enough, true);
  assert.equal(t.p, 1); assert.equal(t.d, 0); assert.equal(t.t, 0);
  assert.equal(SIGNIFICANCE_LABELS[t.sig], 'Not Significant');
});

test('two flat cohorts at different levels differ with certainty, not p = 1', () => {
  const t = testMetric(cohortStats([5, 5, 5]), cohortStats([7, 7, 7, 7]));
  assert.equal(t.enough, true);
  assert.equal(t.p, 0);
  assert.equal(t.d, null, 'Cohen\'s d is unbounded, shown as a dash');
  assert.equal(t.eff, 'large');
  assert.notEqual(SIGNIFICANCE_LABELS[t.sig], 'Not Significant');
});

test('a missing metric is left out of the cohort, not counted as zero', () => {
  const data = handChecked();
  delete data.metrics.a0[byKey.attendance];
  const cmp = compareCohorts(data, readState({}, data));
  const r = cmp.results.find((x) => x.metric.key === 'attendance');
  assert.equal(r.A.n, 5);
  const rpa = cmp.results.find((x) => x.metric.key === 'rpa');
  assert.equal(rpa.A.n, 5, 'RPA needs attendance, so it is missing too');
  const sales = cmp.results.find((x) => x.metric.key === 'totalSales');
  assert.equal(sales.A.n, 6);
});

/* ---------------------------------------------------------------------------
   Accordion cards
--------------------------------------------------------------------------- */

test('expanding one card expands all, and collapsing one collapses all', () => {
  const { node } = render(handChecked());
  const cards = [...node.querySelectorAll('.cmp-card')];
  assert.equal(cards.length, 6);
  assert.ok(cards.every((c) => c.querySelector('.cmp-expand').hidden));
  cards[2].querySelector('.cmp-card-head').click();
  assert.ok(cards.every((c) => c.classList.contains('is-open')));
  assert.ok(cards.every((c) => !c.querySelector('.cmp-expand').hidden));
  assert.ok(cards.every((c) => c.querySelector('.cmp-card-head').getAttribute('aria-expanded') === 'true'));
  cards[5].querySelector('.cmp-card-head').click();
  assert.ok(cards.every((c) => !c.classList.contains('is-open')));
});

test('the expanded card shows min, median, max, count, d and p with SAR 1.0 wording', () => {
  const { node } = render(handChecked());
  const card = node.querySelector('.cmp-card[data-metric="attendance"]');
  const text = readableText(card);
  assert.ok(/Min 98 197/.test(text), text);
  assert.ok(/Median 101 200/.test(text), text);        // int() rounds 100.5 / 199.5 for display
  assert.ok(/Max 103 202/.test(text), text);
  assert.ok(/Sessions 6 6/.test(text), text);
  assert.ok(/Cohen's d .* \(Large\)/.test(text), text);
  assert.ok(/p-value .* < 0\.001 \(Highly Significant\)/.test(text), text);
  // collapsed view: mean ± SD on both sides
  assert.ok(/Cohort A 101 ± 2/.test(text) || /Cohort A 101\s+± 2/.test(text), text);
  // the explanations are inline <details>, never a popup
  assert.equal(card.querySelectorAll('details.cmp-info').length, 2);
  assert.ok(!/alert\(/.test(readFileSync(fileURLToPath(new URL('../src/screens/compare.js', import.meta.url)), 'utf8')));
});

/* ---------------------------------------------------------------------------
   Charts
--------------------------------------------------------------------------- */

test('all four charts render an <svg>, built once, and chips switch without re-rendering', () => {
  const data = withMonths();
  const { node } = render(data);
  assert.deepEqual(CHARTS.map((c) => c.key), ['delta', 'days', 'dumbbell', 'box']);
  const holders = [...node.querySelectorAll('.cmp-chart-holder')];
  assert.equal(holders.length, 4);
  for (const hd of holders) {
    assert.ok(hd.querySelector('svg'), `${hd.dataset.chart} has an svg`);
  }
  assert.deepEqual(holders.map((hd) => hd.hidden), [false, true, true, true], 'delta is the default');
  const before = holders.map((hd) => hd.querySelector('svg'));
  node.querySelector('.cmp-chart-chips .chip[data-chart="box"]').click();
  assert.deepEqual(holders.map((hd) => hd.hidden), [true, true, true, false]);
  assert.ok(holders.every((hd, i) => hd.querySelector('svg') === before[i]), 'the cached SVGs stay');
  assert.ok(node.querySelector('.chip[data-chart="box"]').classList.contains('is-active'));
  // and the choice is remembered in the hash for a reload
  assert.equal(parseHash(dom.window.location.hash).params.chart, 'box');
});

test('delta chart: one bar per metric, positive and negative classes by sign', () => {
  const data = handChecked();
  const cmp = compareCohorts(data, readState({}, data));
  const svg = deltaChart(cmp.results);
  const bars = [...svg.querySelectorAll('rect.cmp-delta')];
  assert.equal(bars.length, 6);
  const att = bars[5];
  assert.ok(att.classList.contains('cmp-neg'), 'attendance fell, so the bar is negative');
  const payout = bars[2];
  assert.ok(payout.classList.contains('cmp-pos'), 'a 0% change draws as a non-negative bar');
  assert.ok(svg.querySelector('.ch-zero'), 'a zero line is drawn');
});

test('day breakdown: a group per weekday, four sub-metrics, A solid and B at 30%, normalised', () => {
  const data = withMonths();
  const cmp = compareCohorts(data, readState({}, data));
  const el = dayBreakdownChart(cmp.rowsA, cmp.rowsB, readState({}, data).opts);
  const svg = el.querySelector('svg');
  assert.ok(svg);
  const a = [...svg.querySelectorAll('rect.cmp-bar-a')];
  const b = [...svg.querySelectorAll('rect.cmp-bar-b')];
  assert.equal(a.length, b.length);
  assert.equal(a.length % 4, 0, 'four sub-metrics per day group');
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  assert.ok(/\.cmp-bar-a \{ opacity: 0\.9; \}/.test(css));
  assert.ok(/\.cmp-bar-b \{ opacity: 0\.3; \}/.test(css));
  // Normalised: the tallest bar of each sub-metric reaches the top of the plot.
  for (let mi = 0; mi < 4; mi += 1) {
    const heights = [...svg.querySelectorAll(`rect.cmp-dm-${mi}`)].map((r) => Number(r.getAttribute('height')));
    const max = Math.max(...heights);
    assert.ok(max > 0);
    const allMax = Math.max(...[...svg.querySelectorAll('rect.cmp-dm')].map((r) => Number(r.getAttribute('height'))));
    assert.ok(Math.abs(max - allMax) < 1e-6, `metric ${mi} is normalised to its own max`);
  }
  assert.ok(el.querySelector('.ch-legend'), 'a legend names the sub-metrics');
});

test('dumbbell: A and B dots per metric joined by a line, each row scaled on its own', () => {
  const data = handChecked();
  const cmp = compareCohorts(data, readState({}, data));
  const svg = dumbbellChart(cmp.results);
  assert.equal(svg.querySelectorAll('circle.cmp-dot-a').length, 7, '6 rows + legend');
  assert.equal(svg.querySelectorAll('circle.cmp-dot-b').length, 7);
  assert.equal(svg.querySelectorAll('line.cmp-dumbbell').length, 6);
  // Per-row scaling: a row whose A and B are equal puts both dots mid-row,
  // whatever the magnitude; the attendance row spreads them apart.
  const dots = (cls) => [...svg.querySelectorAll(`circle.${cls}`)].slice(1).map((c) => Number(c.getAttribute('cx')));
  const xa = dots('cmp-dot-a'); const xb = dots('cmp-dot-b');
  assert.ok(Math.abs(xa[0] - xb[0]) < 1e-6, 'Total Sales equal → same x');
  assert.ok(xb[5] - xa[5] > 100, 'Attendance differs → far apart');
});

test('box plot: quartiles by model.percentile and the median by model.median — ONE definition', () => {
  const data = handChecked();
  const cmp = compareCohorts(data, readState({}, data));
  const svg = boxPlotChart(cmp.results);
  const cell = [...svg.querySelectorAll('g.cmp-box-a')].at(-1);     // attendance, cohort A
  const med = Number(cell.querySelector('line.cmp-median').dataset.median);
  assert.equal(med, median(HAND_A));
  assert.equal(med, 100.5);
  // SAR 1.0's nearest-rank would have said vals[floor(6*0.5)] = 101. Not here.
  assert.notEqual(med, [...HAND_A].sort((a, b) => a - b)[3]);
  // the table's median is the same number
  const r = cmp.results.find((x) => x.metric.key === 'attendance');
  assert.equal(r.A.median, med);
  // whiskers are min and max
  const whisk = cell.querySelector('line.cmp-whisker');
  assert.ok(whisk, 'whisker drawn');
  const title = cell.querySelector('title').textContent;
  assert.ok(title.includes(`Q1 ${Math.round(percentile(HAND_A, 0.25))}`), title);
  assert.ok(title.includes('min 98') && title.includes('max 103'), title);
  assert.equal(svg.querySelectorAll('rect.cmp-cell').length, 6, 'one cell per metric');
});

/* ---------------------------------------------------------------------------
   State round-trips through the hash
--------------------------------------------------------------------------- */

test('cohort state round-trips through params and the hash', () => {
  const data = withMonths();
  const params = {
    hall: 'LR', a_from: '2026-03-01', a_to: '2026-06-30', a_days: 'thu,sat-late', a_type: 'late',
    b_from: '2025-03-01', b_to: '2025-06-30', b_days: '-', mdays: '0', mdates: '1', chart: 'dumbbell',
  };
  const st = readState(params, data);
  assert.equal(st.hall, 'LR');
  assert.deepEqual(st.a, { from: '2026-03-01', to: '2026-06-30', days: ['thu', 'sat-late'], type: 'late' });
  assert.deepEqual(st.b.days, [], '"-" means none');
  assert.equal(st.chart, 'dumbbell');
  const back = stateToParams(st);
  const again = readState(parseHash(buildHash('compare', back)).params, data);
  assert.deepEqual({ ...again, opts: null }, { ...st, opts: null });

  // defaults are omitted from the hash so it stays short
  const def = stateToParams(readState({}, data));
  for (const k of ['hall', 'a_days', 'a_type', 'b_days', 'b_type', 'mdates', 'mdays', 'chart']) {
    assert.equal(def[k], undefined, `${k} omitted at default`);
  }
  assert.ok(def.a_from && def.a_to && def.b_from && def.b_to, 'dates always carried');

  // the inputs show the params, and a change navigates with everything carried
  const { node, navs } = render(data, params);
  assert.equal(node.querySelector('input[name="a_from"]').value, '2026-03-01');
  const input = node.querySelector('input[name="a_to"]');
  input.value = '2026-07-31';
  input.dispatchEvent(new dom.window.Event('change'));
  const p = navs.at(-1).params;
  assert.equal(p.a_to, '2026-07-31');
  assert.equal(p.a_from, '2026-03-01');
  assert.equal(p.hall, 'LR');
  assert.equal(p.a_days, 'thu,sat-late');
  assert.equal(p.b_days, '-');
  assert.equal(p.mdates, '1'); assert.equal(p.mdays, '0');

  // unticking a day drops its key ("thu" is disabled here: A is late-only).
  // jsdom only fires `change` on a connected checkbox, so attach the screen.
  assert.ok(node.querySelector('.cmp-cohort-a .cmp-day input[value="thu"]').disabled);
  document.getElementById('app').replaceChildren(node);
  node.querySelector('.cmp-cohort-a .cmp-day input[value="sat-late"]').click();
  assert.equal(navs.at(-1).params.a_days, 'thu');
  node.remove();
});

test('bad params fall back to the defaults instead of breaking the screen', () => {
  const data = withMonths();
  const st = readState({ hall: 'nope', a_from: 'yesterday', a_type: 'brunch', chart: 'pie', a_days: 'xx,thu' }, data);
  assert.equal(st.hall, 'all');
  assert.equal(st.a.from, defaultCohorts(data.events).aFrom);
  assert.equal(st.a.type, 'both');
  assert.equal(st.chart, 'delta');
  assert.deepEqual(st.a.days, ['thu']);
  inspect(render(data, { hall: 'nope', chart: 'pie' }).node, 'compare (bad params)');
});

test('filterCohort honours dates inclusively, hall, days and type', () => {
  const data = fixture([
    { id: 'x1', date: '2026-08-08', type: 'regular', loc: 'LS' },   // Sat
    { id: 'x2', date: '2026-08-08', type: 'late', loc: 'LS' },
    { id: 'x3', date: '2026-08-06', type: 'regular', loc: 'LR' },   // Thu
    { id: 'x4', date: '2026-08-01', type: 'regular', loc: 'LR' },   // Sat
  ]);
  const opts = dayOptions(data.events);
  const all = opts.map((o) => o.key);
  const ids = (c, hall = 'all') => filterCohort(data.events, c, hall, opts).map((e) => e.id).sort();
  assert.deepEqual(ids({ from: '2026-08-06', to: '2026-08-08', days: all, type: 'both' }), ['x1', 'x2', 'x3']);
  assert.deepEqual(ids({ from: '2026-08-01', to: '2026-08-08', days: all, type: 'both' }, 'LR'), ['x3', 'x4']);
  assert.deepEqual(ids({ from: '2026-08-01', to: '2026-08-08', days: ['sat'], type: 'both' }), ['x1', 'x4']);
  assert.deepEqual(ids({ from: '2026-08-01', to: '2026-08-08', days: all, type: 'late' }), ['x2']);
  assert.deepEqual(ids({ from: '2026-08-01', to: '2026-08-08', days: [], type: 'both' }), []);
});

/* ---------------------------------------------------------------------------
   Inspector and tokens
--------------------------------------------------------------------------- */

test('the inspector names the cohorts, counts, shared location and the strongest difference', () => {
  const { inspector } = render(handChecked(), { hall: 'LS' });
  const text = readableText(inspector);
  assert.ok(text.includes('Santa Clara'), text);
  assert.ok(text.includes('(shared)'), text);
  assert.ok(/6 vs 6 sessions/.test(text), text);
  assert.ok(/clearest difference is Attendance/.test(text), text);
  assert.ok(/-49\.6%, lower/.test(text), text);
  assert.ok(/less than once in a thousand/.test(text), text);
  assert.ok(/One median/.test(text));
});

test('the inspector says so when nothing differs significantly', () => {
  const data = handChecked();
  // make B identical to A
  for (let i = 0; i < 6; i += 1) data.metrics[`b${i}`][byKey.attendance] = HAND_A[i];
  const { inspector } = render(data);
  assert.ok(/No metric differs significantly/.test(readableText(inspector)));
});

test('no colour literals in the compare screen or its stylesheet block', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/screens/compare.js', import.meta.url)), 'utf8');
  assert.ok(!/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/.test(src), 'hex in compare.js');
  assert.ok(!/\b(?:rgba?|hsla?)\s*\(/.test(src), 'colour function in compare.js');
  const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  const block = css.slice(css.indexOf('/* ---- compare — cohorts (U18)'));
  assert.ok(block.length > 100, 'the compare block exists');
  assert.ok(!/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/.test(block), 'hex in the compare CSS block');
  assert.ok(!/\b(?:rgba?|hsla?)\s*\(/.test(block), 'colour function in the compare CSS block');
  // every chart colour goes through a token
  assert.ok(/var\(--series-1\)/.test(block) && /var\(--series-2\)/.test(block));
  assert.ok(/var\(--pos\)/.test(block) && /var\(--neg\)/.test(block));
});
