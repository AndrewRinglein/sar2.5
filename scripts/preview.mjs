#!/usr/bin/env node
/* ============================================================================
   preview — render every built screen to one static HTML file

   WHY THIS EXISTS
   The build environment has no browser, so "look at the rendered result" —
   step 3 of the verification loop, and the step that has caught the most
   bugs on this project — cannot be done here. This renders every screen with
   the real stylesheet into a single file that can be opened and scrolled.

   It uses REPRESENTATIVE data, not production data: signing in needs
   credentials this process does not have. Shapes, spacing, density and
   interaction affordances are real. The numbers are not.

   Run:  npm run preview:html   ->   preview.html
   ============================================================================ */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* A DOM for the screens to build into. */
const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;

const { renderSession } = await import('../src/screens/session.js');
const { renderLeaderboard } = await import('../src/screens/leaderboard.js');
const { renderJackpots } = await import('../src/screens/jackpots.js');
const { renderMonthlyPL } = await import('../src/screens/monthly-pl.js');
const { renderCompare } = await import('../src/screens/compare.js');
const { renderVenues } = await import('../src/screens/venues.js');
const { renderAnomaly } = await import('../src/screens/anomaly.js');
const { renderReporting } = await import('../src/screens/reporting.js');
const { renderRunners } = await import('../src/screens/runners.js');
const { renderManagers, makeValuesOf } = await import('../src/screens/managers.js');
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
const { buildManagerModel } = await import('../src/lib/managers.js');
const { indexMetrics } = await import('../src/lib/model.js');
const { NAV } = await import('../src/lib/router.js');

/* ---- representative data, shaped exactly like production ---------------- */
const CATEGORIES = [
  { key: 'flash', display_name: 'Flash', show_rpa: true, show_margin: true,
    color_bg_from: '#b06a09',
    revenue_keys: ['flash'], payout_keys: ['flash_payout', 'special_game_5'] },
  { key: 'strip', display_name: 'Strip', show_rpa: true, show_margin: true,
    color_bg_from: '#a3306e',
    revenue_keys: ['strips'], payout_keys: ['strips_payout', 'gremlin_hotball'] },
  { key: 'paper', display_name: 'Paper', show_rpa: false, show_margin: true,
    color_bg_from: '#2f5fd0',
    revenue_keys: ['paper'], payout_keys: ['paper_payout', 'payout_rwb'] },
  { key: 'cherries', display_name: 'Cherries', show_rpa: true, show_margin: true,
    color_bg_from: '#0e7a6e',
    revenue_keys: ['cherries'], payout_keys: ['special_game_1'] },
  { key: 'other', display_name: 'Other', show_rpa: false, show_margin: false,
    color_bg_from: '#5b4bbd',
    revenue_keys: ['merch'], payout_keys: ['refund_other'] },
];

const KEYS = ['flash', 'strips', 'paper', 'cherries', 'merch',
  'flash_payout', 'special_game_5', 'strips_payout', 'gremlin_hotball',
  'paper_payout', 'payout_rwb', 'special_game_1', 'refund_other', 'attendance',
  'hotball_total', 'hotball_carryover', 'hotball_payout', 'hotball_participation_cost',
  'mega_hotball_total', 'mega_hotball_carryover', 'mega_hotball_payout'];
const METRIC_DEFS = KEYS.map((k, i) => ({ id: `m${i}`, key: k, canonical_key: k, is_active: true }));
const idx = indexMetrics(METRIC_DEFS);
const K = Object.fromEntries(METRIC_DEFS.map((d) => [d.key, d.id]));

const LOCS = [{ id: 'LR', name: 'Redwood City' }, { id: 'LS', name: 'Santa Clara' }];
const CONFIG = {
  name: 'Vanguard Charity Bingo',
  settings: {
    jackpots: [
      { name: 'Hotball', scope: 'per_location', cap: 5000, balanceKey: 'hotball_total',
        collectedKey: 'hotball_carryover', paidKey: 'hotball_payout',
        participationCost: 500, participationCostKey: 'hotball_participation_cost' },
      { name: 'Mega Hotball', scope: 'org_wide', cap: 15000, balanceKey: 'mega_hotball_total',
        collectedKey: 'mega_hotball_carryover', paidKey: 'mega_hotball_payout',
        participationCost: 1000 },
    ],
    expectedSchedules: {
      RWC: { tuesday: { count: 1, types: ['regular'] }, wednesday: { count: 1, types: ['regular'] },
             thursday: { count: 1, types: ['regular'] } },
      SC: { monday: { count: 1, types: ['regular'] }, friday: { count: 1, types: ['regular'] },
            saturday: { count: 2, types: ['regular', 'late'] },
            sunday: { count: 2, types: ['regular', 'late'] } },
    },
  },
};

const events = [];
const metrics = {};
let rnd = 42;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);

for (let i = 0; i < 120; i++) {
  const d = new Date(Date.UTC(2026, 7, 13) - i * 86400000);
  const dow = d.getUTCDay();
  const rwc = [2, 3, 4].includes(dow);
  const sc = [1, 5, 6, 0].includes(dow);
  const date = d.toISOString().slice(0, 10);

  const push = (loc, type, mult) => {
    const id = `e${events.length}`;
    events.push({ id, location_id: loc, event_date: date, event_type: type, customer_id: 'vanguard' });
    const s = mult * (0.82 + rand() * 0.42);
    const att = Math.round((loc === 'LR' ? 170 : 240) * (0.8 + rand() * 0.4));
    metrics[id] = {
      [K.flash]: Math.round(3300000 * s), [K.strips]: Math.round(5000000 * s),
      [K.paper]: Math.round(820000 * s), [K.cherries]: Math.round(180000 * s),
      [K.merch]: Math.round(7600 * s),
      [K.flash_payout]: Math.round(1590000 * s), [K.special_game_5]: Math.round(710000 * s),
      [K.strips_payout]: Math.round(3900000 * s), [K.paper_payout]: Math.round(300000 * s),
      [K.payout_rwb]: Math.round(50000 * s), [K.special_game_1]: Math.round(90000 * s),
      [K.gremlin_hotball]: i === 9 ? 134640 : 0,
      [K.refund_other]: Math.round(20400 * s),
      [K.attendance]: att,
      [K.hotball_total]: Math.round(400000 + (i % 21) * 90000),
      [K.hotball_carryover]: Math.round(380000 + (i % 21) * 84000),
      [K.hotball_payout]: (i % 21 === 0 && i) ? 1_640_000 : 0,
      [K.hotball_participation_cost]: 500,
      [K.mega_hotball_total]: Math.round(2_000_000 + (120 - i) * 48000),
      [K.mega_hotball_carryover]: Math.round(1_960_000 + (120 - i) * 47000),
      [K.mega_hotball_payout]: 0,
    };
    if (i === 6) delete metrics[id][K.attendance];   // one unmeasured night
  };

  if (rwc) push('LR', 'regular', 1);
  if (sc) push('LS', 'regular', 1.35);
  if ([6, 0].includes(dow)) push('LS', 'late', 0.95);
}

const RUNNER_NAMES = ['Nathan', 'Claudia', 'Raman', 'Thao', 'Abygail', 'Ruthie'];
const runners = RUNNER_NAMES.map((n, i) => ({ id: `r${i + 1}`, name: n, is_active: true }));
const runnerEvents = [];
events.slice(0, 60).forEach((e, i) => {
  runners.forEach((r, j) => {
    if ((i + j) % 3 === 0) return;
    const out = 3000 + ((i * 7 + j * 31) % 5000);
    const sold = Math.round(out * (0.78 + ((i + j) % 9) * 0.035));
    runnerEvents.push({
      id: `re${i}-${j}`, runner_id: r.id, event_id: i === 0 ? 'RE' : e.id,
      location_id: e.location_id, event_date: e.event_date, event_type: e.event_type,
      is_flash_desk: j % 4 === 0,
      tickets_checked_out: out, tickets_sold: sold,
      tickets_returned: Math.max(0, out - sold), tickets_unsold: Math.max(0, out - sold),
      cash_returned: sold * 90, credit_cards: sold * 25, revenue: sold * 115,
      restock_count: (i + j) % 4,
    });
  });
});
if (events[0]) events[0].id = 'RE';

METRIC_DEFS.forEach((d) => {
  d.display_name = d.display_name ?? d.key;
  d.metric_type = d.metric_type ?? (
    /payout|gremlin|refund|special/.test(d.key) ? 'payout'
    : d.key === 'attendance' ? 'attendance'
    : /hotball/.test(d.key) ? 'hotball' : 'sales');
});

const data = { events, metrics, idx, categories: CATEGORIES, locations: LOCS,
               config: CONFIG, metricDefs: METRIC_DEFS, runners, runnerEvents };

/* A roster over the same sessions, so the manager screens have something to
   show. Two managers, alternating, with the Flash Manager deliberately left
   unassigned on some nights to exercise the empty-role case. */
const opsSessions = events.map((e, i) => ({
  id: `os${i}`,
  hall_id: e.location_id === LOCS[0].id ? 'rwc' : 'sc',
  session_date: e.event_date,
  part: e.event_type === 'late' ? 'PM' : (
    events.some((o) => o.event_date === e.event_date
      && o.location_id === e.location_id && o.event_type === 'late') ? 'AM' : 'PM'),
}));
const mgRoles = [{ id: 'R1', name: 'MOD' }, { id: 'R2', name: 'Paymaster' },
                 { id: 'R3', name: 'Flash Manager' }];
const mgStaff = [{ id: 'S1', name: 'Sagit' }, { id: 'S2', name: 'Gina' },
                 { id: 'S3', name: 'Paolo' }];
const mgAssign = opsSessions.flatMap((o, i) => {
  const rows = [
    { session_id: o.id, role_id: 'R1', staff_id: i % 3 === 0 ? 'S2' : 'S1' },
    { session_id: o.id, role_id: 'R2', staff_id: i % 2 === 0 ? 'S3' : 'S1' },
  ];
  if (i % 4 !== 0) rows.push({ session_id: o.id, role_id: 'R3', staff_id: 'S3' });
  return rows;
});
data.promotions = [];
data.version = '2.0.0';
data.userId = 'u1';
data.notifications = [
  { id: 'n1', event_type: 'sar.jackpot_hit', severity: 'success', title: 'Hotball hit',
    body: '$815 paid at Santa Clara', created_at: '2026-08-14T07:15:00Z',
    entity_type: 'event', entity_id: events[0]?.id },
  { id: 'n2', event_type: 'sar.reconciliation_mismatch', severity: 'alert',
    title: 'Deposit does not match the expected figure',
    body: 'Out by $412.00', created_at: '2026-08-13T07:15:00Z' },
  { id: 'n3', event_type: 'sar.new_high_water', severity: 'info',
    title: 'Best Friday on record', created_at: '2026-08-12T07:15:00Z' },
  { id: 'n4', event_type: 'sar.ingestion_error', severity: 'warning',
    title: 'A sheet failed to import', created_at: '2026-08-10T07:15:00Z' },
  { id: 'n5', event_type: 'auth.role_granted', severity: 'info',
    title: 'Role granted', created_at: '2026-08-09T07:15:00Z' },
];
data.notificationReads = [{ user_id: 'u1', notification_id: 'n3', read_at: '2026-08-12T09:00:00Z' }];
data.schedule = {
  ok: true,
  staff: mgStaff.map((s) => ({ ...s, active: true })),
  roles: mgRoles,
  sessions: opsSessions,
  assignments: mgAssign,
  capability: mgStaff.flatMap((s) => mgRoles.map((r) => ({ staff_id: s.id, role_id: r.id, can_do: true }))),
  timeEntries: opsSessions.slice(0, 12).map((o, i) => ({
    staff_id: mgStaff[i % mgStaff.length].id, hall_id: i % 2 ? 'sc' : 'rwc',
    work_date: o.session_date, hours_worked: (5 + (i % 4)).toFixed(1),
  })),
  commissionPayouts: opsSessions.slice(0, 6).flatMap((o, i) => mgStaff.map((s) => ({
    session_id: o.id, staff_id: s.id, session_date: o.session_date,
    shares: '1.0', total_shares: '3.0', commission_pool: '540.00',
    payout_amount: '180.00', confirmed_at: '2026-08-02T00:00:00Z',
  }))),
  products: [
    { id: 'p1', name: 'Lucky 7s', type: 'flash', cost: '191.96', tickets: 1795,
      price_per_ticket: '1.00', active: true, vendor_id: 'v1' },
    { id: 'p2', name: 'Old Faithful', type: 'paper', cost: '64.60', tickets: 500,
      price_per_ticket: '0.50', active: true, vendor_id: 'v1' },
  ],
  boxes: Array.from({ length: 40 }, (_, i) => ({
    id: `b${i}`, hall_id: i % 3 ? 'sc' : 'rwc', product_id: i % 2 ? 'p1' : 'p2',
    state: ['in_inventory', 'in_inventory', 'opened', 'on_order', 'sold_out'][i % 5],
    cost: i % 2 ? '191.96' : '64.60',
    tickets_remaining: i % 5 === 2 ? 5751 : null,
    session_id: i % 4 === 0 ? events[0]?.id : null,
  })),
  gameUsage: opsSessions.slice(0, 30).map((o, i) => ({
    hall_id: i % 2 ? 'sc' : 'rwc', session_date: o.session_date,
    product_id: i % 3 ? 'p1' : 'p2', game: i % 3 ? 'Lucky 7s' : 'Old Faithful',
    category: i % 3 ? 'flash' : 'paper', still_stocked: i % 3 !== 0, qty: 1 + (i % 3),
  })),
  purchaseOrders: [{ id: 'o1', num: 'PO-1', hall_id: 'sc', vendor_id: 'v1',
    status: 'sent', subtotal: '1000.00', tax: '80.00', total: '1080.00',
    sent_at: '2026-08-01T00:00:00Z' }],
};

data.managers = buildManagerModel({
  events, locations: LOCS,
  schedule: { sessions: opsSessions, assignments: mgAssign, staff: mgStaff, roles: mgRoles },
  valuesOf: makeValuesOf(data),
});

/* ---- render ------------------------------------------------------------- */
const SCREENS = [
  ['Session detail', renderSession, {}],
  ['Leaderboard — sorted by Gross (click any card to re-sort)', renderLeaderboard,
    { aspect: 'totalSales', period: '90' }],
  ['Leaderboard — the same board, sorted by Flash', renderLeaderboard,
    { aspect: 'flash', period: '90' }],
  ['Jackpots', renderJackpots, { hall: 'LR' }],
  ['Monthly P&L', renderMonthlyPL, {}],
  ['Compare — hall vs hall', renderCompare, { dim: 'hall', aspect: 'rpa' }],
  ['Venues & capacity', renderVenues, { days: '90' }],
  ['Anomalies', renderAnomaly, { days: '90' }],
  ['Reporting — monthly (every box opens)', renderReporting, { mode: 'monthly' }],
  ['Reporting — quarterly', renderReporting, { mode: 'quarterly' }],
  ['Runners — comparison', renderRunners, { tab: 'comparison', type: 'all' }],
  ['Runners — profile', renderRunners, { tab: 'profile', runner: 'r1', type: 'all' }],
  ['Runners — event breakdown', renderRunners, { tab: 'breakdown', event: 'RE', type: 'all' }],
  ['Managers — overview', renderManagers, { tab: 'overview' }],
  ['Managers — person', renderManagers, { tab: 'person', staff: 'S1' }],
  ['Managers — day shape', renderManagers, { tab: 'dayshape' }],
  ...CHARTS.map((c) => [`Dashboard — ${c.label}`, renderDashboard, { chart: c.id }]),
  ...VIEWS.map((v) => [`Data — ${v.label}`, renderData, { view: v.id }]),
  ...INV_TABS.map((v) => [`Inventory — ${v.label}`, renderInventory, { tab: v.id }]),
  ...COM_TABS.map((v) => [`Commission — ${v.label}`, renderCommission, { tab: v.id }]),
  ...ST_TABS.map((v) => [`Staff — ${v.label}`, renderStaff, { tab: v.id }]),
  ...SRC_TABS.map((v) => [`Data sources — ${v.label}`, renderSources, { tab: v.id }]),
  ...PR_TABS.map((v) => [`Promotions — ${v.label}`, renderPromotions, { tab: v.id }]),
  ['Unit economics', renderUnitEconomics, {}],
  ['Forecast', renderForecast, {}],
  ['Ask SAR', renderAsk, {}],
  ['Notifications', renderNotifications, {}],
];

const css = (() => {
  const dist = join(ROOT, 'dist', 'assets');
  try {
    const f = readdirSync(dist).find((x) => x.endsWith('.css'));
    if (f) return readFileSync(join(dist, f), 'utf8');
  } catch { /* fall through */ }
  // Fall back to source, resolving the @import by hand.
  const base = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');
  const tokens = readFileSync(join(ROOT, 'src', 'tokens.css'), 'utf8');
  return tokens + base.replace(/@import[^;]+;/, '');
})();

const rail = NAV.map((g) => `
  <div class="rail-group">
    <div class="rail-group-label">${g.group}</div>
    ${g.items.map((i) => `<div class="rail-item">${i.label}</div>`).join('')}
  </div>`).join('');

let body = '';
for (const [title, fn, params] of SCREENS) {
  let inspector = '';
  const node = fn({ data, params, onNavigate: () => {},
                    setInspectorContent: (x) => { inspector = x; } });
  // Nothing in a static preview should be navigable. Anchors inside a
  // sandboxed file:// frame raise "unique security origin" errors on click,
  // and there is nowhere for them to go anyway — all screens are on this page.
  for (const a of node.querySelectorAll('a[href]')) a.removeAttribute('href');

  body += `
  <section class="pv-block" id="sec-${SCREENS.indexOf(SCREENS.find(([t2]) => t2 === title))}">
    <h2 class="pv-title">${title}</h2>
    <div class="pv-frame">
      <div class="shell">
        <nav class="rail">
          <div class="rail-head">
            <div><div class="rail-title">SAR</div>
                 <div class="rail-sub">Vanguard Charity Bingo</div></div>
          </div>
          ${rail}
        </nav>
        <main class="content">${node.outerHTML}</main>
        <aside class="inspector">
          <div class="inspector-bar"><span class="inspector-title">Inspector</span></div>
          <div class="inspector-body">${inspector}</div>
        </aside>
      </div>
    </div>
  </section>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>SAR 2.0 — screen preview</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Newsreader:opsz,wght@6..72,400&display=swap" rel="stylesheet">
<style>
${css}
body { background: var(--surface-2); }
.pv-note { max-width: 60rem; margin: var(--s-8) auto var(--s-6); padding: 0 var(--s-6); }
.pv-note h1 { font-family: var(--font-display); font-size: var(--t-xl); font-weight: 400; }
.pv-note p { color: var(--ink-3); margin-top: var(--s-3); line-height: 1.6; max-width: 62ch; }
.pv-block { margin: 0 auto var(--s-10); max-width: 96rem; padding: 0 var(--s-6); }
.pv-title { font-family: var(--font-display); font-size: var(--t-lg); font-weight: 400;
            margin-bottom: var(--s-3); }
.pv-frame { border: 1px solid var(--hair); border-radius: var(--r-lg); overflow: hidden;
            box-shadow: var(--sh-3); background: var(--canvas); }
.pv-frame .shell { min-height: 0; }
.pv-frame .content, .pv-frame .rail, .pv-frame .inspector { max-height: 46rem; }
.pv-toc { font-size: var(--t-sm); color: var(--ink-4); }
/* Static render: nothing here is interactive, so do not pretend otherwise. */
.pv-frame button, .pv-frame .rail-item { cursor: default; }
.pv-frame button { pointer-events: none; }
</style></head>
<body>
<div class="pv-note">
  <h1>SAR 2.0 — screen preview</h1>
  <p class="pv-toc">${SCREENS.map(([t2], i) => `${i + 1}. ${t2}`).join(' &nbsp;·&nbsp; ')}</p>
  <p>Built screens, rendered with the real stylesheet. The layout,
     spacing, density and controls are exactly what the application produces.</p>
  <p><strong>The numbers are representative, not real.</strong> This file is
     generated outside the browser and cannot sign in, so it uses a generated
     dataset shaped like production — two halls on their actual schedules,
     one night with attendance deliberately unrecorded, one gremlin payout,
     a hot-ball hit every three weeks. For real figures, run the app.</p>
</div>
${body}
</body></html>`;

writeFileSync(join(ROOT, 'preview.html'), html);
console.log(`✓ preview.html — ${SCREENS.length} screens, ${events.length} sessions`);
