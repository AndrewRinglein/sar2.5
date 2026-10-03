/* ============================================================================
   SAR 2.0 — Flash Runners

   Built against SPEC §9, read out of SAR 1.0 v2.5.24's `RunnerManager` rather
   than inferred: `initialize`, `switchTab`, `loadComparison`,
   `renderComparisonTable`, `loadProfile`, `renderProfile`, `loadEventList`,
   `loadEventBreakdown`, `renderEventBreakdownTable`, `drillToProfile`,
   `drillToEvent`, `goBack`.

   Three tabs, matching SAR 1.0 exactly:

     Runner Comparison   who is selling, over a date range
     Runner Profile      one person, their sessions, best and worst
     Event Breakdown     one session, every runner on it, with a TOTAL row

   THREE THINGS THAT ARE EASY TO GET WRONG AND ARE GOT RIGHT HERE:

   1. `avgSellThrough` is a RATIO OF SUMS, not a mean of ratios. Averaging the
      per-session percentages weights a night where someone took out five
      tickets the same as one where they took out four hundred.

   2. Inactive runners are excluded from the DATA, not merely from the picker.
      SAR 1.0 hides them from the dropdown while still counting them in fleet
      totals (SPEC §19a), so its comparison figures include people who have
      left. The filtering happens in `api.getRunners`.

   3. The ticket price behind `expected` and `overShort` is NEVER invented.
      SAR 1.0's form template reads it from a hardcoded DOM id and silently
      falls back to 1 when the field is absent (SPEC §19.10), so an over/short
      of "-$1,240" can mean "we never knew the price". Here a missing price is
      null, the cells are a dash, and the screen says the price is unknown.

   STATE lives in the route params, as everywhere else:
     tab      comparison | profile | breakdown
     from, to ISO dates — the date range (defaults to the trailing 90 days)
     hall     location id or 'all'
     type     floor | desk | all           (SAR 1.0 defaults to Floor)
     runner   runner id                    (profile)
     event    session id                   (breakdown)
     sort, dir                             (per table)
     back     the tab a drill-down came from; shows the back bar
   ========================================================================== */

import { usd, pct, int, dateShort, dateLong, esc, DASH } from '../lib/fmt.js';
import { DEFAULT_WINDOW_DAYS } from '../lib/model.js';
import { play } from '../lib/sound.js';
import { FLASH_TICKET_PRICE } from '../lib/config.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const TABS = [
  { id: 'comparison', label: 'Runner Comparison' },
  { id: 'profile', label: 'Runner Profile' },
  { id: 'breakdown', label: 'Event Breakdown' },
];

/** Floor / Desk / All. SAR 1.0 defaults to Floor. */
export const TYPES = [
  { id: 'floor', label: 'Floor' },
  { id: 'desk', label: 'Desk' },
  { id: 'all', label: 'All' },
];

export const DEFAULT_TYPE = 'floor';

/* ---------------------------------------------------------------------------
   Metrics — SPEC §9.4
--------------------------------------------------------------------------- */

/** Per row. Null when nothing was taken out — 0/0 is not 0%. */
export function sellThrough(out, sold) {
  if (!out || out <= 0) return null;
  return sold / out;
}

/**
 * Fleet-wide sell-through: sum of sold over sum of checked out.
 *
 * NOT the mean of each session's percentage. A runner with one tiny night at
 * 100% and one large night at 60% is not at 80%.
 */
export function runnerStats(events) {
  const ticketsOut = events.reduce((s, e) => s + (e.tickets_checked_out ?? 0), 0);
  const ticketsSold = events.reduce((s, e) => s + (e.tickets_sold ?? 0), 0);
  const revenue = events.reduce((s, e) => s + (e.revenue ?? 0), 0);
  const cash = events.reduce((s, e) => s + (e.cash_returned ?? 0), 0);
  const credit = events.reduce((s, e) => s + (e.credit_cards ?? 0), 0);
  const restocks = events.reduce((s, e) => s + (e.restock_count ?? 0), 0);
  return {
    eventCount: events.length,
    ticketsOut,
    ticketsSold,
    ticketsReturned: events.reduce((s, e) => s + (e.tickets_returned ?? 0), 0),
    ticketsUnsold: events.reduce((s, e) => s + (e.tickets_unsold ?? 0), 0),
    revenue, cash, credit, restocks,
    avgSellThrough: sellThrough(ticketsOut, ticketsSold),
    avgRevPerEvent: events.length ? revenue / events.length : null,
  };
}

/**
 * ≥90 good, ≥70 fair, below that poor. SPEC §17.
 *
 * SELL-THROUGH ROUTINELY EXCEEDS 100%, and that is not an error. Verified on
 * production: Nathan 103.9%, Claudia 100.3% across 196 and 164 sessions.
 * `tickets_checked_out` is the INITIAL issue; mid-session restocks are counted
 * only in `restock_count` and never added to it, so more is sold than was
 * signed out. Anything above 100% is read as good, and the screen says why
 * rather than leaving the reader to assume a bug.
 */
export function sellThroughBand(v) {
  if (v === null || v === undefined) return null;
  if (v >= 0.9) return 'good';
  if (v >= 0.7) return 'fair';
  return 'poor';
}

/* ---------------------------------------------------------------------------
   Ticket price, expected cash and over/short — SPEC §9.4 and §19.10

   WHERE SAR 1.0 GETS THE PRICE. Not from the analytics app at all: v2.5.24's
   `RunnerManager` never computes expected or over/short. The formula lives in
   the data-entry form's `runner` row template, which reads the literal DOM id
   `#flash_ticket_price` in the same section and defaults to 1 when it is
   missing. The documented `ticketPriceRef` config key was never implemented.
   Nothing in `flash_runner_events` carries the price, and no analytics metric
   does either.

   SO THE PRICE IS CONFIGURATION. Per-hall `locations[].settings.flashTicketPrice`
   first, then `analytics_config.settings.flashTicketPrice` (dollars, as every
   price in this project's databases is), then the tenant constant
   `FLASH_TICKET_PRICE` in config.js — $1, confirmed by the owner 1 Oct 2026,
   and shown as the source in the inspector. The §19.10 defect was a SILENT
   fallback with no source; a stated, documented price is not that. With no
   price from any of the three, the derived figures are null — never 0.
--------------------------------------------------------------------------- */

export const TICKET_PRICE_KEY = 'flashTicketPrice';

/**
 * Dollars → integer cents, or null.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain
 * `Number.isFinite(Number(v))` guard turns a missing price into a free
 * ticket. Same trap as the inventory cost; same fix.
 */
function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/**
 * The ticket price in cents for a session at `locationId`, or null.
 * Per-hall setting, then the tenant setting, then the config.js constant.
 */
export function ticketPriceFor(data, locationId, { fallback = FLASH_TICKET_PRICE } = {}) {
  const loc = (data?.locations ?? []).find((l) => l.id === locationId);
  const perHall = toCents(loc?.settings?.[TICKET_PRICE_KEY]);
  if (perHall !== null) return perHall;
  const tenant = toCents(data?.config?.settings?.[TICKET_PRICE_KEY]);
  if (tenant !== null) return tenant;
  return toCents(fallback);
}

/** Where the price in use comes from, for the inspector. */
export function ticketPriceSource(data) {
  if (toCents(data?.config?.settings?.[TICKET_PRICE_KEY]) !== null) return 'tenant settings';
  if (toCents(FLASH_TICKET_PRICE) !== null) return 'the app setting (config.js)';
  return null;
}

/** (out − returned) × price, in cents. Null without a price or an issue. */
export function expectedCash(e, priceCents) {
  if (priceCents === null || priceCents === undefined) return null;
  const out = e?.tickets_checked_out;
  if (out === null || out === undefined) return null;
  return (out - (e.tickets_returned ?? 0)) * priceCents;
}

/** cashReturned − expected, in cents. Null when either side is unknown. */
export function overShort(e, priceCents) {
  const exp = expectedCash(e, priceCents);
  if (exp === null) return null;
  const cash = e?.cash_returned;
  if (cash === null || cash === undefined) return null;
  return cash - exp;
}

/* ---------------------------------------------------------------------------
   Rendering helpers
--------------------------------------------------------------------------- */

/**
 * Sell-through with its band.
 *
 * The WORD is printed as well as the colour. Colour alone is unreadable to
 * anyone colour-blind and invisible to a screen reader, and this project's own
 * formatting rule says colour never carries meaning by itself.
 */
const st = (v) => {
  const band = sellThroughBand(v);
  if (!band) return DASH;
  const word = { good: 'good', fair: 'fair', poor: 'low' }[band];
  return `<span class="st-${band}">${pct(v)}<span class="band-word"> ${word}</span></span>`;
};

/** Floor/Desk comes from `is_flash_desk`. */
const kindOf = (e) => (e.is_flash_desk ? 'desk' : 'floor');
const kindBadge = (e) => `<span class="rn-kind rn-${kindOf(e)}">${
  e.is_flash_desk ? 'Desk' : 'Floor'}</span>`;

/** Signed money, so an over/short reads "-$12.40" and "+$3.00", never "$0" for short. */
const signed = (cents) => {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return DASH;
  const s = usd(Math.abs(cents), { decimals: 2 });
  return cents < 0 ? `-${s}` : cents > 0 ? `+${s}` : s;
};

export function applyFilters(events, { from, to, hall, type }) {
  return events.filter((e) => {
    if (from && e.event_date < from) return false;
    if (to && e.event_date > to) return false;
    if (hall && hall !== 'all' && e.location_id !== hall) return false;
    if (type && type !== 'all' && kindOf(e) !== type) return false;
    return true;
  });
}

const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * The default date range: the trailing 90 days (SPEC §9.1; `RunnerManager
 * .initialize` sets "today − 90 → today", in a variable misnamed
 * `thirtyDaysAgo`).
 *
 * Anchored on the NEWEST SESSION rather than the clock. SAR 1.0 anchors on the
 * clock, which turns the screen into "No runner data found" the moment
 * ingestion lags by three months; a window ending at the last session always
 * has something in it, and the inputs show exactly which window is applied.
 * Falls back to the clock when there are no sessions at all.
 */
export function defaultRange(events = [], today = new Date()) {
  const latest = events.reduce((m, e) => (e.event_date > m ? e.event_date : m), '');
  const end = latest ? new Date(`${latest}T00:00:00Z`) : today;
  const start = new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 86400000);
  return { from: isoDay(start), to: isoDay(end) };
}

/* ---------------------------------------------------------------------------
   Sortable table
--------------------------------------------------------------------------- */

function sortable(cols, rows, sortKey, desc, onSort) {
  const table = h('table', 'rn-table');
  // `c.key === sortKey` is TRUE when both are undefined, which put a sort
  // arrow on every header of the tables that pass no sort key. Caught by a
  // test comparing the rendered headers to SAR 1.0's. A column is only marked
  // when there IS a sort key and it matches.
  const isSorted = (c) => Boolean(sortKey) && c.key === sortKey;
  table.innerHTML = `<thead><tr>${cols.map((c) => `
    <th class="${c.cls ?? ''}${isSorted(c) ? ' is-sorted' : ''}"
        ${c.key && onSort ? `data-sort="${c.key}"` : ''}
        ${isSorted(c) ? `aria-sort="${desc ? 'descending' : 'ascending'}"` : ''}>
      ${c.label}${isSorted(c) ? `<span class="rn-dir">${desc ? '▼' : '▲'}</span>` : ''}
    </th>`).join('')}</tr></thead><tbody></tbody>`;

  const body = table.querySelector('tbody');
  for (const r of rows) {
    body.insertAdjacentHTML('beforeend',
      `<tr>${cols.map((c) => `<td class="${c.cls ?? ''}">${c.cell(r)}</td>`).join('')}</tr>`);
  }

  if (onSort) {
    for (const th of table.querySelectorAll('[data-sort]')) {
      // Reachable and operable by keyboard, not only by mouse.
      th.tabIndex = 0;
      th.addEventListener('click', () => onSort(th.dataset.sort));
      th.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSort(th.dataset.sort); }
      });
    }
  }
  return table;
}

/** Nulls last in both directions — unmeasured is not worst. */
function sortRows(rows, get, desc) {
  const has = []; const missing = [];
  for (const r of rows) {
    const v = get(r);
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) missing.push(r);
    else has.push({ r, v });
  }
  has.sort((a, b) => (typeof a.v === 'string'
    ? (desc ? b.v.localeCompare(a.v) : a.v.localeCompare(b.v))
    : (desc ? b.v - a.v : a.v - b.v)));
  return [...has.map((x) => x.r), ...missing];
}

/** Wire every `button.cell-link[data-go]` in a table to a navigation. */
function wireLinks(table, onClick) {
  for (const b of table.querySelectorAll('button.cell-link[data-go]')) {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); play('select'); onClick(b.dataset.go); });
  }
}

const link = (id, label) => `<button type="button" class="cell-link" data-go="${esc(id)}">${label}</button>`;

/* ---------------------------------------------------------------------------
   Tab 1 — Runner Comparison
--------------------------------------------------------------------------- */

function comparison(data, params, onNavigate) {
  const wrap = h('div');
  const events = applyFilters(data.runnerEvents ?? [], {
    from: params.from, to: params.to, hall: params.hall, type: params.type,
  });

  if (!events.length) {
    wrap.append(h('div', 'placeholder',
      '<p class="semi">No runner data found for this date range</p>'));
    return wrap;
  }

  const byRunner = new Map();
  for (const e of events) {
    const list = byRunner.get(e.runner_id) ?? [];
    list.push(e);
    byRunner.set(e.runner_id, list);
  }

  let rows = [...byRunner.entries()].map(([id, evs]) => ({
    id,
    name: data.runners?.find((r) => r.id === id)?.name ?? 'Unknown',
    ...runnerStats(evs),
  }));

  const GET = {
    name: (r) => r.name, events: (r) => r.eventCount,
    tickets_sold: (r) => r.ticketsSold, tickets_out: (r) => r.ticketsOut,
    sell_through: (r) => r.avgSellThrough, revenue: (r) => r.revenue,
    avg_revenue: (r) => r.avgRevPerEvent,
  };
  const key = GET[params.sort] ? params.sort : 'revenue';
  const desc = params.dir ? params.dir === 'desc' : true;
  rows = sortRows(rows, GET[key], desc);

  const cols = [
    { label: '#', cls: 'rank', cell: (r) => String(rows.indexOf(r) + 1) },
    { label: 'Runner', key: 'name', cls: 'name', cell: (r) => link(r.id, esc(r.name)) },
    { label: 'Events', key: 'events', cell: (r) => int(r.eventCount) },
    { label: 'Tickets Sold', key: 'tickets_sold', cell: (r) => int(r.ticketsSold) },
    { label: 'Tickets Out', key: 'tickets_out', cell: (r) => int(r.ticketsOut) },
    { label: 'Avg Sell-Through', key: 'sell_through', cell: (r) => st(r.avgSellThrough) },
    { label: 'Total Revenue', key: 'revenue', cell: (r) => usd(r.revenue) },
    { label: 'Avg Revenue/Event', key: 'avg_revenue', cell: (r) => usd(r.avgRevPerEvent) },
  ];

  const table = sortable(cols, rows, key, desc, (k) => {
    play('select');
    onNavigate('runners', { ...params, tab: 'comparison', sort: k,
      dir: k === key && desc ? 'asc' : 'desc' });
  });
  // A runner's name opens their profile over the same date range, with a way
  // back — SAR 1.0's `drillToProfile`.
  wireLinks(table, (runnerId) => onNavigate('runners', {
    ...params, tab: 'profile', runner: runnerId, back: 'comparison', sort: undefined, dir: undefined,
  }));
  wrap.append(table);
  return wrap;
}

/* ---------------------------------------------------------------------------
   Tab 2 — Runner Profile
--------------------------------------------------------------------------- */

function profile(data, params, onNavigate) {
  const wrap = h('div');
  const runnerId = params.runner;
  if (!runnerId) {
    wrap.append(h('div', 'placeholder',
      '<p class="semi">Select a runner to view their performance history</p>'));
    return wrap;
  }

  const runner = data.runners?.find((r) => r.id === runnerId);
  const events = applyFilters((data.runnerEvents ?? []).filter((e) => e.runner_id === runnerId),
    { from: params.from, to: params.to, type: params.type });

  if (!events.length) {
    wrap.append(h('div', 'placeholder',
      '<p class="semi">No data found for this runner in the selected date range</p>'));
    return wrap;
  }

  const s = runnerStats(events);
  const byRevenue = [...events].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));
  const best = byRevenue[0];
  const worst = byRevenue[byRevenue.length - 1];
  const hallName = (e) => data.locations?.find((l) => l.id === e.location_id)?.name ?? '';

  const cards = h('div', 'rn-cards');
  cards.innerHTML = [
    ['Events Worked', int(s.eventCount), ''],
    ['Avg Sell-Through', st(s.avgSellThrough), 'fleet-wide'],
    ['Total Revenue', usd(s.revenue), ''],
    ['Avg Rev/Event', usd(s.avgRevPerEvent), ''],
    ['Best Event', usd(best?.revenue), best ? `${dateShort(best.event_date)} · ${esc(hallName(best))}` : ''],
    ['Worst Event', usd(worst?.revenue), worst ? `${dateShort(worst.event_date)} · ${esc(hallName(worst))}` : ''],
  ].map(([label, value, sub]) => `
    <div class="rn-card">
      <div class="rn-card-value">${value}</div>
      <div class="rn-card-label">${label}</div>
      ${sub ? `<div class="dim" style="font-size:var(--t-xs)">${sub}</div>` : ''}
    </div>`).join('');
  wrap.append(cards);

  const GET = {
    date: (e) => e.event_date,
    location: (e) => hallName(e),
    type: (e) => kindOf(e),
    tickets_out: (e) => e.tickets_checked_out,
    sold: (e) => e.tickets_sold,
    sell_through: (e) => sellThrough(e.tickets_checked_out, e.tickets_sold),
    revenue: (e) => e.revenue,
    restocks: (e) => e.restock_count,
  };
  const key = GET[params.sort] ? params.sort : 'date';
  const desc = params.dir ? params.dir === 'desc' : true;
  const rows = sortRows(events, GET[key], desc);

  const table = sortable([
    { label: 'Date', key: 'date', cls: 'name', cell: (e) => link(e.id, dateLong(e.event_date)) },
    { label: 'Location', key: 'location', cls: 'name', cell: (e) => esc(hallName(e)) || DASH },
    { label: 'Type', key: 'type', cls: 'name', cell: kindBadge },
    { label: 'Tickets Out', key: 'tickets_out', cell: (e) => int(e.tickets_checked_out) },
    { label: 'Sold', key: 'sold', cell: (e) => int(e.tickets_sold) },
    { label: 'Sell-Through', key: 'sell_through',
      cell: (e) => st(sellThrough(e.tickets_checked_out, e.tickets_sold)) },
    { label: 'Revenue', key: 'revenue', cell: (e) => usd(e.revenue) },
    { label: 'Restocks', key: 'restocks', cell: (e) => int(e.restock_count) },
  ], rows, key, desc, (k) => {
    play('select');
    onNavigate('runners', { ...params, tab: 'profile', sort: k,
      dir: k === key && desc ? 'asc' : 'desc' });
  });
  // A session's date opens its breakdown, hall pre-selected — SAR 1.0's
  // `drillToEvent`.
  wireLinks(table, (rowId) => {
    const e = events.find((x) => x.id === rowId);
    if (!e) return;
    onNavigate('runners', { ...params, tab: 'breakdown', event: e.event_id,
      hall: e.location_id, back: 'profile', sort: undefined, dir: undefined });
  });
  wrap.append(table);

  return wrap;
}

/* ---------------------------------------------------------------------------
   Tab 3 — Event Breakdown
--------------------------------------------------------------------------- */

function breakdown(data, params, onNavigate) {
  const wrap = h('div');
  const eventId = params.event;
  if (!eventId) {
    wrap.append(h('div', 'placeholder',
      '<p class="semi">Select a location and session to view runner performance</p>'));
    return wrap;
  }

  const onSession = (data.runnerEvents ?? []).filter((e) => e.event_id === eventId);
  // The hall filter applies here too, so a session picked under one hall and a
  // chip changed to another does not show the wrong hall's rows.
  const inHall = applyFilters(onSession, { hall: params.hall });
  const rows = applyFilters(inHall, { type: params.type });

  if (!rows.length) {
    wrap.append(h('div', 'placeholder', `<p class="semi">${
      inHall.length ? 'No runners found for this type filter' : 'No flash runner data for this session'}</p>`));
    return wrap;
  }

  // One price per session: every runner on it sold the same tickets.
  const price = ticketPriceFor(data, rows[0].location_id);

  const named = rows.map((e) => ({
    ...e, name: data.runners?.find((r) => r.id === e.runner_id)?.name ?? 'Unknown',
    expected: expectedCash(e, price), overShort: overShort(e, price),
  }));

  const GET = {
    name: (e) => e.name, type: (e) => kindOf(e),
    tickets_out: (e) => e.tickets_checked_out, sold: (e) => e.tickets_sold,
    returned: (e) => e.tickets_returned, unsold: (e) => e.tickets_unsold,
    cash: (e) => e.cash_returned, expected: (e) => e.expected,
    over_short: (e) => e.overShort, credit: (e) => e.credit_cards,
    revenue: (e) => e.revenue,
    sell_through: (e) => sellThrough(e.tickets_checked_out, e.tickets_sold),
    restocks: (e) => e.restock_count,
  };
  const key = GET[params.sort] ? params.sort : 'revenue';
  const desc = params.dir ? params.dir === 'desc' : true;
  const sorted = sortRows(named, GET[key], desc);

  const table = sortable([
    { label: 'Runner', key: 'name', cls: 'name', cell: (e) => esc(e.name) },
    { label: 'Type', key: 'type', cls: 'name', cell: kindBadge },
    { label: 'Tickets Out', key: 'tickets_out', cell: (e) => int(e.tickets_checked_out) },
    { label: 'Sold', key: 'sold', cell: (e) => int(e.tickets_sold) },
    { label: 'Returned', key: 'returned', cell: (e) => int(e.tickets_returned) },
    { label: 'Unsold', key: 'unsold', cell: (e) => int(e.tickets_unsold) },
    { label: 'Cash', key: 'cash', cell: (e) => usd(e.cash_returned) },
    { label: 'Expected', key: 'expected', cls: 'rn-expected', cell: (e) => usd(e.expected) },
    { label: 'Over/Short', key: 'over_short', cls: 'rn-over-short', cell: (e) => signed(e.overShort) },
    { label: 'Credit', key: 'credit', cell: (e) => usd(e.credit_cards) },
    { label: 'Revenue', key: 'revenue', cell: (e) => usd(e.revenue) },
    { label: 'Sell-Through', key: 'sell_through',
      cell: (e) => st(sellThrough(e.tickets_checked_out, e.tickets_sold)) },
    { label: 'Restocks', key: 'restocks', cell: (e) => int(e.restock_count) },
  ], sorted, key, desc, (k) => {
    play('select');
    onNavigate('runners', { ...params, tab: 'breakdown', sort: k,
      dir: k === key && desc ? 'asc' : 'desc' });
  });

  // TOTAL row, as SAR 1.0 ends the breakdown with: "N runners" in the Type
  // column, sums everywhere else, sell-through as a ratio of sums.
  const t = runnerStats(sorted);
  const sum = (get) => (price === null ? null : sorted.reduce((s, e) => s + get(e), 0));
  table.querySelector('tbody').insertAdjacentHTML('beforeend', `
    <tr class="rn-total">
      <td class="name">TOTAL</td><td class="name">${int(sorted.length)} runners</td>
      <td>${int(t.ticketsOut)}</td><td>${int(t.ticketsSold)}</td>
      <td>${int(t.ticketsReturned)}</td><td>${int(t.ticketsUnsold)}</td>
      <td>${usd(t.cash)}</td>
      <td class="rn-expected">${usd(sum((e) => e.expected))}</td>
      <td class="rn-over-short">${signed(sum((e) => e.overShort))}</td>
      <td>${usd(t.credit)}</td><td>${usd(t.revenue)}</td>
      <td>${st(t.avgSellThrough)}</td><td>${int(t.restocks)}</td>
    </tr>`);

  wrap.append(table);

  if (price === null) {
    // SPEC §19.10. Said once, under the table, rather than in every cell.
    wrap.append(h('p', 'muted rn-price-note',
      'Expected and Over/Short are not computed: ticket price unknown. '
      + `Set <code>settings.${TICKET_PRICE_KEY}</code> (dollars) on the tenant or the hall. `
      + 'SAR 1.0 silently used $1 here; this screen does not guess.'));
  } else {
    wrap.append(h('p', 'muted rn-price-note',
      `Expected = (tickets out − returned) × ${usd(price, { decimals: 2 })} ticket price. `
      + 'Over/Short = cash returned − expected.'));
  }
  return wrap;
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderRunners({ data, params: raw, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const tab = TABS.find((t) => t.id === raw.tab) ?? TABS[0];
  const type = TYPES.some((t) => t.id === raw.type) ? raw.type : DEFAULT_TYPE;
  const range = defaultRange(data.runnerEvents ?? []);
  // Effective params: the defaults SAR 1.0 fills in are visible in the
  // controls and applied to the tables, not silently assumed.
  const params = { ...raw, tab: tab.id, type,
    from: raw.from || range.from, to: raw.to || range.to };

  const head = h('div', 'screen-head');
  head.innerHTML = `<h2>Flash Runners</h2>
    <p class="muted">Track individual flash runner performance per session.</p>`;
  root.append(head);

  /* ---- tabs ---- */
  const tabs = h('div', 'rn-tabs');
  for (const t of TABS) {
    const b = h('button', `rn-tab${t.id === tab.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label;
    b.addEventListener('click', () => {
      play('select');
      // Choosing a tab directly clears the drill-down trail, as SAR 1.0's
      // `switchTab` does without `keepHistory`. The date range carries over.
      onNavigate('runners', { tab: t.id, type, from: params.from, to: params.to,
        runner: params.runner, hall: params.hall });
    });
    tabs.append(b);
  }
  root.append(tabs);

  /* ---- back bar, shown only on a drill-down ---- */
  const backTo = TABS.find((t) => t.id === params.back && t.id !== tab.id);
  if (backTo) {
    const bar = h('div', 'rn-back-bar');
    const b = h('button', 'link');
    b.type = 'button'; b.textContent = `← Back to ${backTo.label}`;
    b.addEventListener('click', () => {
      play('select');
      const { back, sort, dir, ...rest } = params;
      onNavigate('runners', { ...rest, tab: backTo.id });
    });
    bar.append(b);
    root.append(bar);
  }

  /* ---- filters, per tab ---- */
  const bar = h('div', 'filter-bar');
  const go = (patch) => onNavigate('runners', { ...params, ...patch });

  if (tab.id === 'profile') {
    const sel = h('select');
    sel.setAttribute('aria-label', 'Runner');
    sel.innerHTML = '<option value="">Select a runner…</option>'
      + (data.runners ?? []).map((r) =>
        `<option value="${esc(r.id)}"${r.id === params.runner ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
    sel.addEventListener('change', () => go({ runner: sel.value }));
    bar.append(sel);
  }

  if (tab.id === 'breakdown') {
    // Sessions with runner data, in the chosen hall — SAR 1.0's
    // `loadEventList` filters by the Location select before listing.
    const hall = params.hall ?? 'all';
    const withRunners = new Set((data.runnerEvents ?? []).map((e) => e.event_id));
    const sel = h('select');
    sel.setAttribute('aria-label', 'Session');
    sel.innerHTML = '<option value="">Select a session…</option>'
      + (data.events ?? [])
        .filter((e) => withRunners.has(e.id) && (hall === 'all' || e.location_id === hall))
        .slice(0, 200).map((e) => {
          const hallName = data.locations?.find((l) => l.id === e.location_id)?.name ?? '';
          return `<option value="${esc(e.id)}"${e.id === params.event ? ' selected' : ''}>${
            esc(hallName)} — ${dateLong(e.event_date)}</option>`;
        }).join('');
    sel.addEventListener('change', () => go({ event: sel.value }));
    bar.append(sel);
  }

  if (tab.id !== 'breakdown') {
    for (const [k, label] of [['from', 'From'], ['to', 'To']]) {
      const wrap = h('label', 'rn-field');
      wrap.innerHTML = `<span class="dim">${label}</span>`;
      const inp = h('input');
      inp.type = 'date';
      inp.value = params[k] ?? '';
      inp.addEventListener('change', () => go({ [k]: inp.value }));
      wrap.append(inp);
      bar.append(wrap);
    }
  }

  if (tab.id !== 'profile') {
    bar.append(h('span', 'filter-sep'));
    for (const l of [{ id: 'all', name: 'All locations' }, ...(data.locations ?? [])]) {
      const b = h('button', `chip${(params.hall ?? 'all') === l.id ? ' is-active' : ''}`);
      b.type = 'button'; b.textContent = l.name;
      // Changing hall on the breakdown clears the session, as SAR 1.0's
      // `loadEventList` clears the breakdown: the old session is not in the
      // new list.
      b.addEventListener('click', () => go(tab.id === 'breakdown'
        ? { hall: l.id, event: undefined } : { hall: l.id }));
      bar.append(b);
    }
  }

  bar.append(h('span', 'filter-sep'));
  for (const t of TYPES) {
    const b = h('button', `chip${type === t.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label;
    b.addEventListener('click', () => go({ type: t.id }));
    bar.append(b);
  }
  root.append(bar);

  /* ---- body ---- */
  const panel = h('section', 'panel');
  panel.append(
    tab.id === 'comparison' ? comparison(data, params, onNavigate)
    : tab.id === 'profile' ? profile(data, params, onNavigate)
    : breakdown(data, params, onNavigate));
  root.append(panel);

  /* ---- inspector ---- */
  const all = data.runnerEvents ?? [];
  const fleet = runnerStats(applyFilters(all, { type }));
  const typeLabel = TYPES.find((t) => t.id === type)?.label;
  const tenantPrice = ticketPriceFor(data, null);
  const priceSource = ticketPriceSource(data);
  const hallPrices = (data.locations ?? [])
    .map((l) => [l.name, toCents(l.settings?.[TICKET_PRICE_KEY])])
    .filter(([, p]) => p !== null);
  setInspectorContent?.(`
    <p class="semi">Flash Runners</p>
    <p class="muted">${tab.label} · ${typeLabel}</p>
    <p class="inspector-section-label">Fleet, ${typeLabel.toLowerCase()}</p>
    <dl class="inspector-filters">
      <dt>Runners</dt><dd>${int((data.runners ?? []).length)}</dd>
      <dt>Sessions worked</dt><dd>${int(fleet.eventCount)}</dd>
      <dt>Tickets out</dt><dd>${int(fleet.ticketsOut)}</dd>
      <dt>Tickets sold</dt><dd>${int(fleet.ticketsSold)}</dd>
      <dt>Sell-through</dt><dd>${st(fleet.avgSellThrough)}</dd>
      <dt>Revenue</dt><dd>${usd(fleet.revenue)}</dd>
    </dl>
    <p class="inspector-section-label">How sell-through is averaged</p>
    <p class="muted">Total sold divided by total taken out — a ratio of sums,
      not an average of percentages. On real data the two differ by up to three
      points: one runner reads 85.0% one way and 81.8% the other.</p>
    <p class="inspector-section-label">Why it can exceed 100%</p>
    <p class="muted">Tickets out records the initial issue. Mid-session restocks
      are counted separately and never added to it, so a busy runner sells more
      than they signed out. Above 100% is normal, not an error.</p>
    <p class="inspector-section-label">Ticket price</p>
    <p class="muted">${tenantPrice !== null
      ? `${usd(tenantPrice, { decimals: 2 })} per ticket from ${priceSource}`
      : 'Not configured — ticket price unknown'}${
      hallPrices.length ? `; per hall: ${hallPrices.map(([n, p]) => `${esc(n)} ${usd(p, { decimals: 2 })}`).join(', ')}` : ''}.
      Expected cash is (out − returned) × price and over/short is cash returned
      − expected. Without a price both are left blank. SAR 1.0 used $1 when the
      price was missing and reported the difference as a real shortfall.</p>
    <p class="inspector-section-label">Who is counted</p>
    <p class="muted">Active runners only. Sessions worked by someone since
      deactivated are excluded from every figure here, not just from the
      picker.</p>`);

  return root;
}
