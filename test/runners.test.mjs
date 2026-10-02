/* ============================================================================
   Flash Runners — SPEC §9, checked against SAR 1.0 v2.5.24's RunnerManager

   Hand-checked arithmetic for the formulas in §9.4, and the behaviours the
   screen audit found missing: expected / over-short with a real ticket price
   (and NO price — §19.10), the breakdown's hall filter, the TOTAL row, the
   Floor default, the sort indicator and the drill-down back bar.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;

const RN = await import('../src/screens/runners.js');

/* ---------------------------------------------------------------------------
   A minimal fixture: two halls, four sessions, three runners, one inactive
--------------------------------------------------------------------------- */

const LOCS = [
  { id: 'LR', name: 'Redwood City', code: 'RWC', settings: {} },
  { id: 'LS', name: 'Santa Clara', code: 'SC', settings: {} },
];

const EVENTS = [
  { id: 'e0', location_id: 'LR', event_date: '2026-08-13', event_type: 'regular' },
  { id: 'e1', location_id: 'LS', event_date: '2026-08-12', event_type: 'regular' },
  { id: 'e2', location_id: 'LR', event_date: '2026-08-11', event_type: 'late' },
  { id: 'e3', location_id: 'LS', event_date: '2026-08-10', event_type: 'regular' },
];

const row = (id, runner, ev, extra = {}) => ({
  id, runner_id: runner, event_id: ev.id, location_id: ev.location_id,
  event_date: ev.event_date, event_type: ev.event_type, is_flash_desk: false,
  tickets_checked_out: 100, tickets_sold: 80, tickets_returned: 20, tickets_unsold: 0,
  cash_returned: 8000, credit_cards: 0, revenue: 8000, restock_count: 0,
  ...extra,
});

function makeData({ price } = {}) {
  const runners = [
    { id: 'r1', name: 'Alice', is_active: true },
    { id: 'r2', name: 'Bob', is_active: true },
  ];
  const runnerEvents = [
    // e0, Redwood: Alice floor, Bob desk
    row('x0', 'r1', EVENTS[0], { tickets_checked_out: 200, tickets_sold: 180, tickets_returned: 20,
      cash_returned: 17900, credit_cards: 500, revenue: 18400, restock_count: 2 }),
    row('x1', 'r2', EVENTS[0], { is_flash_desk: true, tickets_checked_out: 50, tickets_sold: 30,
      tickets_returned: 20, cash_returned: 3100, revenue: 3100 }),
    // e1, Santa Clara: Alice floor, Bob floor
    row('x2', 'r1', EVENTS[1], { tickets_checked_out: 300, tickets_sold: 150, tickets_returned: 150,
      cash_returned: 15000, revenue: 15000 }),
    row('x3', 'r2', EVENTS[1], { tickets_checked_out: 120, tickets_sold: 110, tickets_returned: 10,
      cash_returned: 11000, revenue: 11000 }),
    // e2, Redwood: Alice only
    row('x4', 'r1', EVENTS[2], { tickets_checked_out: 10, tickets_sold: 10, tickets_returned: 0,
      cash_returned: 1000, revenue: 1000 }),
    // e3, Santa Clara: Bob only
    row('x5', 'r2', EVENTS[3], { tickets_checked_out: 80, tickets_sold: 40, tickets_returned: 40,
      cash_returned: 4000, revenue: 4000 }),
  ];
  const config = { name: 'Test', settings: price === undefined ? {} : { flashTicketPrice: price } };
  return { events: EVENTS, locations: LOCS.map((l) => ({ ...l, settings: {} })),
           config, runners, runnerEvents, metrics: {}, categories: [], metricDefs: [] };
}

function render(data, params = {}) {
  let inspectorHtml = '';
  const navs = [];
  const node = RN.renderRunners({
    data, params,
    onNavigate: (screen, p) => navs.push({ screen, p }),
    setInspectorContent: (html) => { inspectorHtml = html; },
  });
  const inspector = document.createElement('div');
  inspector.innerHTML = inspectorHtml;
  return { node, inspector, navs };
}

const heads = (node) => [...node.querySelectorAll('.rn-table th')]
  .map((t) => t.textContent.replace(/[▲▼]/g, '').trim());
const col = (node, label) => heads(node).indexOf(label);
const bodyRows = (node) => [...node.querySelectorAll('.rn-table tbody tr:not(.rn-total)')];
const cells = (tr) => [...tr.children].map((c) => c.textContent.trim());

/* ---------------------------------------------------------------------------
   §9.4 formulas, by hand
--------------------------------------------------------------------------- */

test('per-row sell-through is sold / out', () => {
  assert.equal(RN.sellThrough(200, 180), 0.9);
  assert.equal(RN.sellThrough(300, 150), 0.5);
  assert.equal(RN.sellThrough(0, 0), null, '0/0 is unmeasured, not 0%');
});

test('fleet sell-through is a RATIO OF SUMS — hand-checked where the mean of ratios differs', () => {
  // Alice, all types: 200/180 (90%), 300/150 (50%), 10/10 (100%).
  //   ratio of sums: 340 / 510 = 66.67%
  //   mean of ratios: (90 + 50 + 100) / 3 = 80%
  const d = makeData();
  const alice = d.runnerEvents.filter((e) => e.runner_id === 'r1');
  const s = RN.runnerStats(alice);
  assert.equal(s.ticketsOut, 510);
  assert.equal(s.ticketsSold, 340);
  assert.ok(Math.abs(s.avgSellThrough - 340 / 510) < 1e-12, `got ${s.avgSellThrough}`);
  assert.ok(Math.abs(s.avgSellThrough - 0.8) > 0.1, 'the mean-of-ratios answer (80%) must not appear');
  // and it reaches the screen as 66.7%
  const { node } = render(d, { tab: 'comparison', type: 'all' });
  const alices = bodyRows(node).find((tr) => tr.textContent.includes('Alice'));
  assert.ok(cells(alices)[col(node, 'Avg Sell-Through')].startsWith('66.7%'));
});

test('avg revenue per event is total revenue / event count', () => {
  const d = makeData();
  const s = RN.runnerStats(d.runnerEvents.filter((e) => e.runner_id === 'r1'));
  assert.equal(s.revenue, 18400 + 15000 + 1000);
  assert.equal(s.avgRevPerEvent, 34400 / 3);
});

test('expected and over/short with a known price, by hand', () => {
  // $1.00 a ticket. x2: (300 out − 150 back) × $1 = $150 expected; cash $150 → $0.
  // x0: (200 − 20) × $1 = $180 expected; cash $179 → −$1.00 (short).
  // x1: (50 − 20) × $1 = $30 expected; cash $31 → +$1.00 (over).
  const price = 100;
  const d = makeData({ price: 1 });
  const [x0, x1, x2] = d.runnerEvents;
  assert.equal(RN.ticketPriceFor(d, 'LR'), price);
  assert.equal(RN.expectedCash(x2, price), 15000);
  assert.equal(RN.overShort(x2, price), 0);
  assert.equal(RN.expectedCash(x0, price), 18000);
  assert.equal(RN.overShort(x0, price), -100);
  assert.equal(RN.overShort(x1, price), 100);

  const { node } = render(d, { tab: 'breakdown', event: 'e0', type: 'all' });
  const alice = bodyRows(node).find((tr) => tr.textContent.includes('Alice'));
  const bob = bodyRows(node).find((tr) => tr.textContent.includes('Bob'));
  assert.equal(cells(alice)[col(node, 'Expected')], '$180', 'whole dollars, like Cash');
  assert.equal(cells(alice)[col(node, 'Over/Short')], '-$1.00');
  assert.equal(cells(bob)[col(node, 'Expected')], '$30');
  assert.equal(cells(bob)[col(node, 'Over/Short')], '+$1.00');
  // TOTAL: $210 expected, $0 over/short net
  const total = cells(node.querySelector('tr.rn-total'));
  assert.equal(total[col(node, 'Expected')], '$210');
  assert.equal(total[col(node, 'Over/Short')], '$0.00');
});

test('a fractional dollar price is converted once, to cents', () => {
  const d = makeData({ price: '0.50' });   // numeric columns arrive as strings
  assert.equal(RN.ticketPriceFor(d, 'LR'), 50);
  assert.equal(RN.expectedCash(d.runnerEvents[0], 50), 180 * 50);
});

test('a per-hall price overrides the tenant price', () => {
  const d = makeData({ price: 1 });
  d.locations[1].settings.flashTicketPrice = 2;
  assert.equal(RN.ticketPriceFor(d, 'LR'), 100);
  assert.equal(RN.ticketPriceFor(d, 'LS'), 200);
});

test('the tenant constant is the last resort and is named as the source', () => {
  const d = makeData();                      // no flashTicketPrice in the DB
  assert.equal(RN.ticketPriceFor(d, 'LR'), 100, '$1 per ticket, confirmed by the owner');
  const { inspector } = render(d, { tab: 'breakdown', event: 'e0', type: 'all' });
  assert.ok(inspector.textContent.includes('$1.00 per ticket from the app setting'));
});

test('NO price → null, "price unknown", and no number — never a silent fallback (§19.10)', () => {
  const d = makeData();
  const none = { fallback: null };
  assert.equal(RN.ticketPriceFor(d, 'LR', none), null);
  assert.equal(RN.expectedCash(d.runnerEvents[0], null), null);
  assert.equal(RN.overShort(d.runnerEvents[0], null), null);
  for (const bad of [0, -1, '', 'abc', null, undefined]) {
    assert.equal(RN.ticketPriceFor({ config: { settings: { flashTicketPrice: bad } }, locations: [] }, 'LR', none),
      null, `price ${JSON.stringify(bad)} must be unknown`);
  }
  // The rendered 'price unknown' path is unreachable while config.js holds a price;
  // the helper contract above is what §19.10 requires.

});

/* ---------------------------------------------------------------------------
   Breakdown: hall filter, TOTAL row, badge
--------------------------------------------------------------------------- */

test('the breakdown hall filter narrows both the session select and the rows', () => {
  const d = makeData();
  const all = render(d, { tab: 'breakdown', type: 'all' });
  const allOpts = [...all.node.querySelectorAll('select option')].map((o) => o.value).filter(Boolean);
  assert.deepEqual(allOpts.sort(), ['e0', 'e1', 'e2', 'e3']);

  const rwc = render(d, { tab: 'breakdown', hall: 'LR', type: 'all' });
  const rwcOpts = [...rwc.node.querySelectorAll('select option')].map((o) => o.value).filter(Boolean);
  assert.deepEqual(rwcOpts.sort(), ['e0', 'e2'], 'only Redwood sessions are listed');

  // Rows: a Santa Clara session viewed under the Redwood chip shows no rows.
  const wrong = render(d, { tab: 'breakdown', hall: 'LR', event: 'e1', type: 'all' });
  assert.equal(bodyRows(wrong.node).length, 0);
  assert.ok(wrong.node.textContent.includes('No flash runner data for this session'));
  const right = render(d, { tab: 'breakdown', hall: 'LS', event: 'e1', type: 'all' });
  assert.equal(bodyRows(right.node).length, 2);
});

test('changing the hall chip on the breakdown clears the chosen session', () => {
  const { node, navs } = render(makeData(), { tab: 'breakdown', hall: 'LR', event: 'e0', type: 'all' });
  const chip = [...node.querySelectorAll('.chip')].find((c) => c.textContent === 'Santa Clara');
  chip.click();
  assert.equal(navs.length, 1);
  assert.equal(navs[0].p.hall, 'LS');
  assert.equal(navs[0].p.event, undefined);
});

test('the TOTAL row sums every numeric column and counts the runners', () => {
  const d = makeData({ price: 1 });
  const { node } = render(d, { tab: 'breakdown', event: 'e1', type: 'all' });
  const t = cells(node.querySelector('tr.rn-total'));
  assert.equal(t[0], 'TOTAL');
  assert.equal(t[col(node, 'Type')], '2 runners');
  assert.equal(t[col(node, 'Tickets Out')], '420');
  assert.equal(t[col(node, 'Sold')], '260');
  assert.equal(t[col(node, 'Returned')], '160');
  assert.equal(t[col(node, 'Cash')], '$260');
  assert.equal(t[col(node, 'Expected')], '$260');
  assert.equal(t[col(node, 'Revenue')], '$260');
  // ratio of sums: 260 / 420 = 61.9%, not mean(50%, 91.7%) = 70.8%
  assert.ok(t[col(node, 'Sell-Through')].startsWith('61.9%'));
});

test('Floor and Desk are badges on the breakdown', () => {
  const { node } = render(makeData(), { tab: 'breakdown', event: 'e0', type: 'all' });
  const kinds = [...node.querySelectorAll('.rn-kind')].map((b) => b.textContent);
  assert.deepEqual(kinds.sort(), ['Desk', 'Floor']);
  assert.ok(node.querySelector('.rn-kind.rn-desk'));
});

test('the type filter empty state is distinct from "no data"', () => {
  // e3 has only a floor runner; under Desk there is data for the session but
  // none of this type.
  const { node } = render(makeData(), { tab: 'breakdown', event: 'e3', type: 'desk' });
  assert.ok(node.textContent.includes('No runners found for this type filter'));
});

/* ---------------------------------------------------------------------------
   Defaults — Floor, trailing 90 days, sort indicator
--------------------------------------------------------------------------- */

test('Type defaults to Floor on every tab, as SAR 1.0 does', () => {
  const d = makeData();
  for (const params of [{ tab: 'comparison' }, { tab: 'profile', runner: 'r2' }, { tab: 'breakdown', event: 'e0' }]) {
    const { node } = render(d, params);
    const active = [...node.querySelectorAll('.chip.is-active')].map((c) => c.textContent);
    assert.ok(active.includes('Floor'), `${params.tab}: Floor chip not active`);
  }
  // Bob's desk session on e0 is hidden under the default; his floor ones show.
  const { node } = render(d, { tab: 'breakdown', event: 'e0' });
  assert.equal(bodyRows(node).length, 1);
  assert.ok(node.textContent.includes('Alice') && !node.textContent.includes('Bob'));
});

test('the default date range is the trailing 90 days, visible in the inputs', () => {
  const r = RN.defaultRange([{ event_date: '2026-08-13' }, { event_date: '2026-06-01' }]);
  assert.deepEqual(r, { from: '2026-05-15', to: '2026-08-13' });
  const { node } = render(makeData(), { tab: 'comparison' });
  const [from, to] = [...node.querySelectorAll('input[type=date]')].map((i) => i.value);
  assert.equal(from, '2026-05-15');
  assert.equal(to, '2026-08-13');
  // and with no sessions, it ends today
  const today = new Date('2026-10-01T12:00:00Z');
  assert.deepEqual(RN.defaultRange([], today), { from: '2026-07-03', to: '2026-10-01' });
});

test('an explicit range filters the comparison and says so when empty', () => {
  const { node } = render(makeData(), { tab: 'comparison', from: '2026-08-13', to: '2026-08-13', type: 'all' });
  assert.equal(bodyRows(node).length, 2);
  const empty = render(makeData(), { tab: 'comparison', from: '2030-01-01', to: '2030-12-31' });
  assert.ok(empty.node.textContent.includes('No runner data found for this date range'));
});

test('a sort indicator sits on the active column, every column sorts, and clicking flips it', () => {
  const d = makeData({ price: 1 });
  const checks = [
    [{ tab: 'comparison', type: 'all' }, 'Total Revenue'],
    [{ tab: 'comparison', type: 'all', sort: 'tickets_out', dir: 'asc' }, 'Tickets Out'],
    [{ tab: 'profile', runner: 'r1', type: 'all' }, 'Date'],
    [{ tab: 'breakdown', event: 'e0', type: 'all' }, 'Revenue'],
    [{ tab: 'breakdown', event: 'e0', type: 'all', sort: 'over_short' }, 'Over/Short'],
  ];
  for (const [params, label] of checks) {
    const { node, navs } = render(d, params);
    const sorted = node.querySelectorAll('.rn-table th.is-sorted');
    assert.equal(sorted.length, 1, `${params.tab}: one sorted column`);
    assert.equal(sorted[0].textContent.replace(/[▲▼]/g, '').trim(), label);
    assert.ok(sorted[0].querySelector('.rn-dir'), 'arrow present');
    assert.equal(sorted[0].getAttribute('aria-sort'), params.dir === 'asc' ? 'ascending' : 'descending');
    // every header except the rank number is sortable
    const ths = [...node.querySelectorAll('.rn-table th')];
    assert.deepEqual(ths.filter((t) => !t.dataset.sort).map((t) => t.textContent.trim()),
      params.tab === 'comparison' ? ['#'] : []);
    sorted[0].click();
    assert.equal(navs.at(-1).p.dir, params.dir === 'asc' ? 'desc' : 'asc');
  }
});

test('comparison rows are ranked 1..n in sort order', () => {
  const { node } = render(makeData(), { tab: 'comparison', type: 'all' });
  const ranks = bodyRows(node).map((tr) => cells(tr)[0]);
  assert.deepEqual(ranks, ['1', '2']);
  // Alice has the higher revenue (34,400 vs 18,100) so is #1 under the default sort
  assert.ok(cells(bodyRows(node)[0])[1].includes('Alice'));
});

/* ---------------------------------------------------------------------------
   Inactive runners
--------------------------------------------------------------------------- */

test('an inactive runner is absent from all three tabs', () => {
  // The data layer (api.getRunners) drops inactive runners AND their sessions.
  // Model that here: Bob is gone. Nothing on the screen may resurrect him.
  const d = makeData({ price: 1 });
  d.runners = d.runners.filter((r) => r.id !== 'r2');
  d.runnerEvents = d.runnerEvents.filter((e) => e.runner_id !== 'r2');
  const comp = render(d, { tab: 'comparison', type: 'all' });
  assert.ok(!comp.node.textContent.includes('Bob'));
  assert.equal(bodyRows(comp.node).length, 1);
  const prof = render(d, { tab: 'profile', type: 'all' });
  const opts = [...prof.node.querySelectorAll('select option')].map((o) => o.textContent);
  assert.ok(!opts.includes('Bob'));
  const bd = render(d, { tab: 'breakdown', event: 'e0', type: 'all' });
  assert.ok(!bd.node.textContent.includes('Bob'));
  assert.equal(cells(bd.node.querySelector('tr.rn-total'))[1], '1 runners');
  // e3 had only Bob: it is no longer offered
  const sessions = [...bd.node.querySelectorAll('select option')].map((o) => o.value);
  assert.ok(!sessions.includes('e3'));
  // nor does he count in the fleet figures
  assert.ok(!comp.inspector.textContent.includes('Bob'));
});

/* ---------------------------------------------------------------------------
   Profile cards, drill-downs and the back bar
--------------------------------------------------------------------------- */

test('profile shows five cards plus the large sell-through, best and worst by revenue', () => {
  const { node } = render(makeData(), { tab: 'profile', runner: 'r1', type: 'all' });
  const labels = [...node.querySelectorAll('.rn-card-label')].map((l) => l.textContent);
  assert.deepEqual(labels, ['Events Worked', 'Avg Sell-Through', 'Total Revenue',
    'Avg Rev/Event', 'Best Event', 'Worst Event']);
  const values = [...node.querySelectorAll('.rn-card-value')].map((l) => l.textContent.trim());
  assert.equal(values[0], '3');
  assert.equal(values[4], '$184', 'best is the $184.00 night');
  assert.equal(values[5], '$10', 'worst is the $10.00 night');
  assert.deepEqual(heads(node), ['Date', 'Location', 'Type', 'Tickets Out', 'Sold',
    'Sell-Through', 'Revenue', 'Restocks']);
});

test('a runner name on the comparison drills to the profile with the range and a way back', () => {
  const { node, navs } = render(makeData(), { tab: 'comparison', type: 'all', from: '2026-08-01', to: '2026-08-13' });
  const btn = [...node.querySelectorAll('button.cell-link')].find((b) => b.textContent === 'Alice');
  btn.click();
  const p = navs.at(-1).p;
  assert.equal(p.tab, 'profile');
  assert.equal(p.runner, 'r1');
  assert.equal(p.from, '2026-08-01');
  assert.equal(p.to, '2026-08-13');
  assert.equal(p.back, 'comparison');
});

test('a session date on the profile drills to the breakdown with its hall selected', () => {
  const { node, navs } = render(makeData(), { tab: 'profile', runner: 'r1', type: 'all' });
  const btn = node.querySelectorAll('button.cell-link')[0];   // newest first: e0
  btn.click();
  const p = navs.at(-1).p;
  assert.equal(p.tab, 'breakdown');
  assert.equal(p.event, 'e0');
  assert.equal(p.hall, 'LR');
  assert.equal(p.back, 'profile');
});

test('the back bar appears only on a drill-down and returns to that tab', () => {
  const plain = render(makeData(), { tab: 'profile', runner: 'r1' });
  assert.equal(plain.node.querySelector('.rn-back-bar'), null);

  const drilled = render(makeData(), { tab: 'profile', runner: 'r1', back: 'comparison', from: '2026-08-01' });
  const bar = drilled.node.querySelector('.rn-back-bar');
  assert.ok(bar, 'back bar missing');
  assert.ok(bar.textContent.includes('Back to Runner Comparison'));
  bar.querySelector('button').click();
  const p = drilled.navs.at(-1).p;
  assert.equal(p.tab, 'comparison');
  assert.equal(p.from, '2026-08-01');
  assert.equal(p.back, undefined);

  // Picking a tab directly clears the trail, as SAR 1.0's switchTab does.
  const tabBtn = [...drilled.node.querySelectorAll('.rn-tab')].find((b) => b.textContent === 'Event Breakdown');
  tabBtn.click();
  assert.equal(drilled.navs.at(-1).p.back, undefined);
});

test('nothing on the screen renders NaN, undefined or null, with or without a price', () => {
  for (const d of [makeData(), makeData({ price: 1 })]) {
    for (const params of [{ tab: 'comparison' }, { tab: 'profile', runner: 'r1' },
                          { tab: 'breakdown', event: 'e0' }, { tab: 'breakdown' }, { tab: 'profile' }]) {
      const { node, inspector } = render(d, params);
      for (const text of [node.textContent, inspector.textContent]) {
        assert.ok(!/\b(NaN|undefined|null|Infinity)\b/.test(text), `${params.tab}: ${text.slice(0, 200)}`);
      }
    }
  }
});
