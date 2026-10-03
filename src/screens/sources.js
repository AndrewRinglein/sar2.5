/* ============================================================================
   SAR 2.0 — Data sources

   NEW, and it exists because of how much trouble this project has had knowing
   which database it was reading.

   A whole working session went into building against the wrong Supabase
   project — one called "Vanguard SAR + Com + Finances", holding 771 plausible
   sessions for the right two halls with the right dates, which turned out to be
   an old demo. Later, Inventory was built against the wrong tables for the same
   reason. This screen makes the answer visible instead of tribal knowledge.

   It also carries the KNOWN HAZARDS — the things that are true, surprising, and
   will otherwise be rediscovered painfully. Each one is stated with the
   evidence, so a reader can check rather than take it on trust.
   ========================================================================== */

import { int, usd, esc, DASH } from '../lib/fmt.js';
import { SUPABASE_URL, OPS_URL, CUSTOMER_ID } from '../lib/config.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const TABS = [
  { id: 'sources', label: 'Sources' },
  { id: 'hazards', label: 'Known hazards' },
];

const ref = (url) => {
  try { return new URL(url).hostname.split('.')[0]; } catch { return String(url); }
};

/**
 * What SAR reads and where from.
 *
 * `count` is filled in at render from the data actually loaded, so this is a
 * live report and not a description that can drift out of date.
 */
export function sourceList(data) {
  const sched = data.schedule;
  const ok = Boolean(sched?.ok);
  const n = (a) => (Array.isArray(a) ? a.length : null);

  return [
    {
      group: 'Analytics', project: ref(SUPABASE_URL), url: SUPABASE_URL,
      state: 'connected',
      note: `Every money figure in SAR. Tenant "${CUSTOMER_ID}".`,
      items: [
        { name: 'analytics_events', what: 'one row per session', count: n(data.events) },
        { name: 'analytics_event_data', what: 'the metric store, in cents', count: n(data.metrics) ? Object.keys(data.metrics).length : null },
        { name: 'analytics_metric_definitions', what: 'what each metric means', count: n(data.metricDefs) },
        { name: 'analytics_product_categories', what: 'how metrics roll up', count: n(data.categories) },
        { name: 'flash_runner_events', what: 'the Runners screen', count: n(data.runnerEvents) },
      ],
    },
    {
      group: 'Operational', project: ref(OPS_URL), url: OPS_URL,
      state: ok ? 'connected' : 'not connected',
      note: ok
        ? 'Roster, commission, stock and hours are loaded automatically.'
        : 'Operations data is temporarily unavailable.',
      items: [
        { name: 'sched_staff', what: 'the roster', count: ok ? n(sched.staff) : null },
        { name: 'sched_assignments', what: 'who worked which session', count: ok ? n(sched.assignments) : null },
        { name: 'sched_commission_payouts', what: 'commission', count: ok ? n(sched.commissionPayouts) : null },
        { name: 'sched_time_entries', what: 'hours worked', count: ok ? n(sched.timeEntries) : null },
        { name: 'products', what: 'the stock catalogue, with cost', count: ok ? n(sched.products) : null },
        { name: 'boxes', what: 'every physical box', count: ok ? n(sched.boxes) : null },
        { name: 'game_usage', what: 'what was played', count: ok ? n(sched.gameUsage) : null },
        { name: 'purchase_orders', what: 'what is on order', count: ok ? n(sched.purchaseOrders) : null },
      ],
    },
    validatorSource(data),
  ];
}

const DAY = (d) => {
  const [y, m, dd] = String(d).split('-').map(Number);
  return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

/**
 * The data validator — the nightly reconciliation app where crews are now
 * entered. Its own source, because it can fail on its own: the rest of
 * Operations still loads when it does.
 */
export function validatorSource(data) {
  const crew = data.crew;
  const ok = Boolean(crew?.ok);
  const c = ok ? crew.coverage : null;
  const covered = c?.first
    ? ` Covers ${DAY(c.first)} to ${DAY(c.last)}: ${int(c.rows)} sessions (${int(c.closed)} closed, ${int(c.open)} open),
       ${int(c.approved)} crew lists approved and ${int(c.progress)} in progress, ${int(c.entries)} crew entries,
       ${int(c.people)} distinct names (${int(c.matched)} matched to a scheduler person).`
    : '';
  return {
    group: 'Data validator', project: ref(OPS_URL), url: OPS_URL,
    state: ok ? 'connected' : 'not connected',
    note: ok
      ? `Who worked each night, by role — crews are entered here now. Only the crew list, whether it was
         approved, and the session's commission rate and target are read; never cash counts, payouts or
         anything else the reconciliation holds. No times, so hours still come from the scheduler.${covered}`
      : 'Validator not connected. Crews come from the scheduler only until it is.',
    items: [
      { name: 'recon_sessions', what: 'one row per session reconciled', count: ok ? c.rows : null },
      { name: 'recon_sessions · crew', what: 'name, role and slot per person', count: ok ? c.entries : null },
      { name: 'linked to analytics', what: 'sessions matched to a result', count: ok ? crew.join.report.matched : null },
    ],
  };
}

/**
 * Things that are true, surprising, and expensive to rediscover.
 *
 * Every one of these cost real time on this project. They are written down so
 * the next person does not pay again.
 */
export const HAZARDS = Object.freeze([
  {
    title: 'There is more than one database with plausible-looking data',
    body: 'A Supabase project named "Vanguard SAR + Com + Finances" holds 771 '
      + 'sessions for the right two halls across the right dates. It is an old '
      + 'demo. The live analytics project is the one this screen names, and it '
      + 'was identified by tracing the client SAR itself constructs, not by '
      + 'reading a project name.',
    severity: 'high',
  },
  {
    title: 'analytics_monthly_summary has broken money columns',
    body: 'Its `total_sales` and `net_sales` sum denormalised columns on the '
      + 'events table that stopped being maintained in March 2026. August 2026 '
      + 'comes out at −2982% margin. Nothing in SAR 1.0 or SAR 2.0 reads them — '
      + 'both recompute from the metric store — but anything that starts to will '
      + 'get figures about 3% of the truth with no error.',
    severity: 'high',
  },
  {
    title: 'Summing every "sales" metric double counts',
    body: 'The metric store holds both `paper` and `paper_sales`. Totals must go '
      + 'through the product categories, which is what `sessionTotals` does. A '
      + 'naive sum of every sales-typed metric roughly doubles gross.',
    severity: 'high',
  },
  {
    title: 'The two databases name the same session differently',
    body: 'Operational says AM/PM; analytics says regular/late. On a weekday the '
      + 'single session is "PM" in one and "regular" in the other, so a static '
      + 'map loses half the roster. Sessions are matched by position within the '
      + 'day, and a day whose counts disagree is skipped rather than guessed.',
    severity: 'medium',
  },
  {
    title: 'There are two different flash-runner datasets',
    body: '`flash_runner_events` in analytics covers 825 sessions and reads about '
      + '100% sell-through. `flash_runner_inventory` is a newer live tracker '
      + 'covering a couple of sessions and reads about 5%. They are not '
      + 'comparable and are never shown together.',
    severity: 'medium',
  },
  {
    title: 'Commission is paid on gross, not on the amount above target',
    body: 'No session has an RPA target set, so the 15% applies to all of gross. '
      + 'Confirmed against the stored pools: 0.15 × $5,000,005.00 = $750,000.75 '
      + 'exactly. Some commission rows are also obvious test data and are hidden '
      + 'by default on that screen.',
    severity: 'medium',
  },
  {
    title: 'Sell-through above 100% is normal',
    body: '`tickets_checked_out` records the initial issue; mid-session restocks '
      + 'are counted separately and never added to it. So a busy runner sells '
      + 'more than they signed out. Nathan reads 103.9% across 196 sessions.',
    severity: 'low',
  },
  {
    title: 'Money is integer cents everywhere except two places',
    body: '`products.cost`, `boxes.cost` and `products.price_per_ticket` in the '
      + 'Operational database are numeric DOLLARS, as are the commission '
      + 'amounts. Each is converted once, on read. Everything else is cents '
      + 'until the formatter.',
    severity: 'low',
  },
]);

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderSources({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const tab = TABS.find((t) => t.id === params.tab)?.id ?? 'sources';

  const tabs = h('div', 'rn-tabs');
  for (const t of TABS) {
    const b = h('button', `rn-tab${t.id === tab ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label;
    b.addEventListener('click', () => { play('select'); onNavigate('sources', { ...params, tab: t.id }); });
    tabs.append(b);
  }
  root.append(tabs);

  if (tab === 'sources') {
    for (const s of sourceList(data)) {
      const panel = h('section', 'panel');
      panel.append(h('h3', 'panel-title', esc(s.group)));
      panel.innerHTML += `<p class="muted">${esc(s.note)}</p>
        <p class="dim src-project">Project <code>${esc(s.project)}</code>
        <span class="src-state src-${esc(s.state.replace(/\s/g, '-'))}">${esc(s.state)}</span></p>`;
      const t = h('table', 'rn-table');
      t.innerHTML = `<thead><tr><th>Table</th><th>What it is</th>
        <th class="num">Rows loaded</th></tr></thead><tbody></tbody>`;
      const body = t.querySelector('tbody');
      for (const it of s.items) {
        body.insertAdjacentHTML('beforeend', `<tr>
          <td><code>${esc(it.name)}</code></td>
          <td class="dim">${esc(it.what)}</td>
          <td class="num">${it.count === null ? DASH : int(it.count)}</td></tr>`);
      }
      panel.append(t);
      root.append(panel);
    }

    const dates = data.events?.length
      ? `${data.events[data.events.length - 1].event_date} to ${data.events[0].event_date}`
      : 'none';
    root.append(h('section', 'panel', `
      <h3 class="panel-title">Coverage</h3>
      <p class="muted">Sessions loaded span <strong>${esc(dates)}</strong>.
      Row counts above are what this browser currently holds, not what the
      database contains — a filtered or partial load will show fewer.</p>`));
  } else {
    const panel = h('section', 'panel');
    panel.append(h('h3', 'panel-title', 'Known hazards'));
    panel.append(h('p', 'muted',
      'Things that are true, surprising, and cost real time to discover. '
      + 'Each is stated with its evidence so it can be checked rather than believed.'));
    for (const hz of HAZARDS) {
      const box = h('div', `hazard hz-${hz.severity}`);
      box.innerHTML = `<p class="hazard-title">${hz.title}</p><p class="muted">${hz.body}</p>`;
      panel.append(box);
    }
    root.append(panel);
  }

  setInspectorContent?.(`
    <p class="semi">Data sources</p>
    <p class="muted">Two Supabase projects, read only — the data validator lives in
      the Operational one</p>
    <p class="inspector-section-label">Why this screen exists</p>
    <p class="muted">A working session was lost to building against a
      convincing-looking demo database. Naming what is read, live, is cheaper
      than rediscovering it.</p>
    <p class="inspector-section-label">Read only</p>
    <p class="muted">SAR writes to neither database. No table, function, policy
      or migration has been created or altered by this application.</p>`);

  return root;
}
