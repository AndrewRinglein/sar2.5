/* ============================================================================
   SAR 2.0 — Inventory

   READS THE OPERATIONAL DATABASE. Corrected: I first built this against
   `flash_games` / `flash_runner_inventory` in the analytics project, because I
   searched for tables with "inventory" in the name and those were the only
   matches. The real system is in Ops and none of its tables are named that:

     products              517 rows — the catalogue, with cost per box
     boxes               4,206 rows — every physical box, with cost and state
     game_usage          9,360 rows — what was actually played, per session
     purchase_orders / po_lines / deliveries / vendors — procurement
     stock_adjustments / stock_adjustment_lines — write-offs and corrections

   THE STATE MACHINE IS THE WHOLE SCREEN. `boxes.state` is one of
   `on_order`, `in_inventory`, `opened`, `sold_out`, `missing`.

     ON HAND  = in_inventory + opened.
     NOT ON HAND = on_order (not arrived) and sold_out (consumed).

   Counting `on_order` as stock overstates Santa Clara by $21,727 and Redwood
   City by $24,684. Counting `sold_out` overstates them by another $71,328.
   Production, 17 Aug 2026: 3,104 boxes on hand at $285,998.72 cost.

   COST, NOT RETAIL. `boxes.cost` and `products.cost` are what was PAID.
   `tickets x price_per_ticket` is what a box would take at the counter — about
   nine times cost, because most of that goes straight back out as prizes.
   The two are never added together and the retail figure is always labelled.
   ========================================================================== */

import { usd, usd2, int, pct, dateShort, esc, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const TABS = [
  { id: 'onhand', label: 'On hand' },
  { id: 'usage', label: 'Usage' },
  { id: 'order', label: 'On order' },
];

/** States that mean the box is physically in the building. */
export const ON_HAND_STATES = Object.freeze(['in_inventory', 'opened']);
export const STATES = Object.freeze(
  ['on_order', 'in_inventory', 'opened', 'sold_out', 'missing'],
);

export const onHand = (box) => ON_HAND_STATES.includes(box.state);

/**
 * Ops stores money as numeric DOLLARS. Converted here, once.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain
 * `Number.isFinite(Number(v))` guard turns a missing cost into a free box.
 * Same trap as the ticket price; same fix.
 */
export function cents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ---------------------------------------------------------------------------
   On hand
--------------------------------------------------------------------------- */

/** Cost value of a set of boxes, in cents. Missing costs are counted as such. */
export function valueOf(boxes) {
  let value = 0; let unpriced = 0;
  for (const b of boxes) {
    const c = cents(b.cost);
    if (c === null) unpriced += 1; else value += c;
  }
  return { value, unpriced, count: boxes.length };
}

/** Boxes summarised by hall and state — the shape the top of the screen shows. */
export function stockByHall(boxes = []) {
  const halls = new Map();
  for (const b of boxes) {
    const hall = b.hall_id ?? 'unknown';
    const cur = halls.get(hall) ?? { hall, states: new Map(), onHand: [], all: [] };
    const list = cur.states.get(b.state) ?? [];
    list.push(b);
    cur.states.set(b.state, list);
    cur.all.push(b);
    if (onHand(b)) cur.onHand.push(b);
    halls.set(hall, cur);
  }
  return [...halls.values()].map((hHall) => ({
    hall: hHall.hall,
    onHand: valueOf(hHall.onHand),
    byState: STATES.map((s) => ({ state: s, ...valueOf(hHall.states.get(s) ?? []) }))
      .filter((s) => s.count),
    ticketsRemaining: hHall.onHand.reduce((s, b) => s + (num(b.tickets_remaining) ?? 0), 0),
  })).sort((a, b) => b.onHand.value - a.onHand.value);
}

/** On-hand boxes grouped by product, for the detail table. */
export function stockByProduct(boxes = [], products = [], { hall = 'all' } = {}) {
  const p = new Map(products.map((x) => [x.id, x]));
  const by = new Map();
  for (const b of boxes) {
    if (!onHand(b)) continue;
    if (hall !== 'all' && b.hall_id !== hall) continue;
    const prod = p.get(b.product_id);
    const cur = by.get(b.product_id) ?? {
      productId: b.product_id,
      name: prod?.name ?? b.product_id ?? 'Unknown product',
      type: prod?.type ?? null,
      vendor: prod?.vendor_id ?? null,
      active: prod?.active !== false,
      tickets: num(prod?.tickets),
      pricePerTicket: num(prod?.price_per_ticket),
      boxes: [],
    };
    cur.boxes.push(b);
    by.set(b.product_id, cur);
  }
  return [...by.values()].map((r) => {
    const v = valueOf(r.boxes);
    // Retail face value: what the boxes would take at the counter. NOT revenue
    // and NOT comparable with cost — most of it goes back out as prizes.
    const face = r.tickets !== null && r.pricePerTicket !== null
      ? Math.round(r.tickets * r.pricePerTicket * 100) * r.boxes.length : null;
    return { ...r, count: v.count, value: v.value, unpriced: v.unpriced, face };
  }).sort((a, b) => b.value - a.value);
}

/* ---------------------------------------------------------------------------
   Usage
--------------------------------------------------------------------------- */

/**
 * What is actually being played, from `game_usage`.
 *
 * `still_stocked` is the column that matters: a game played regularly that can
 * no longer be ordered is a problem somebody needs to know about before the
 * last box is opened, not after.
 */
export function usageByProduct(usage = [], { hall = 'all', since = null } = {}) {
  const by = new Map();
  for (const u of usage) {
    if (hall !== 'all' && u.hall_id !== hall) continue;
    if (since && u.session_date < since) continue;
    const key = u.product_id ?? u.game ?? u.name_raw;
    const cur = by.get(key) ?? {
      productId: u.product_id ?? null,
      name: u.game ?? u.name_raw ?? 'Unknown',
      category: u.category ?? null,
      type: u.game_type ?? null,
      vendor: u.distributor ?? u.vendor_id ?? null,
      stillStocked: u.still_stocked !== false,
      sessions: 0,
      qty: 0,
      lastUsed: null,
    };
    cur.sessions += 1;
    cur.qty += num(u.qty) ?? 0;
    if (!cur.lastUsed || u.session_date > cur.lastUsed) cur.lastUsed = u.session_date;
    // Any row saying it is no longer stocked settles it.
    if (u.still_stocked === false) cur.stillStocked = false;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.sessions - a.sessions);
}

/** Games in regular use that can no longer be ordered. */
export const atRisk = (rows) => rows.filter((r) => !r.stillStocked && r.sessions >= 3);

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

function table(cols, rows, cls = '') {
  const t = h('table', `rn-table ${cls}`);
  t.innerHTML = `<thead><tr>${cols.map((c) =>
    `<th class="${c.cls ?? ''}">${c.label}</th>`).join('')}</tr></thead><tbody></tbody>`;
  const body = t.querySelector('tbody');
  for (const r of rows) {
    body.insertAdjacentHTML('beforeend',
      `<tr class="${r._cls ?? ''}">${cols.map((c) =>
        `<td class="${c.cls ?? ''}">${c.cell(r)}</td>`).join('')}</tr>`);
  }
  return t;
}

export function renderInventory({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const tab = TABS.find((t) => t.id === params.tab)?.id ?? 'onhand';
  const hall = params.hall ?? 'all';

  const sched = data.schedule;
  if (!sched?.ok) {
    root.append(h('section', 'panel', `
      <h3 class="panel-title">Inventory</h3>
      <div class="placeholder"><p class="semi">Scheduler not connected</p>
      <p class="dim">Operations data is temporarily unavailable. Please try again later.</p></div>`));
    return root;
  }

  const boxes = sched.boxes ?? [];
  const products = sched.products ?? [];
  const usage = sched.gameUsage ?? [];
  const pos = sched.purchaseOrders ?? [];

  const halls = [...new Set(boxes.map((b) => b.hall_id).filter(Boolean))];

  const tabs = h('div', 'rn-tabs');
  for (const t of TABS) {
    const b = h('button', `rn-tab${t.id === tab ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label;
    b.addEventListener('click', () => { play('select'); onNavigate('inventory', { ...params, tab: t.id }); });
    tabs.append(b);
  }
  root.append(tabs);

  const bar = h('div', 'filter-bar');
  for (const l of ['all', ...halls]) {
    const b = h('button', `chip${hall === l ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l === 'all' ? 'Both halls' : l.toUpperCase();
    b.addEventListener('click', () => onNavigate('inventory', { ...params, hall: l }));
    bar.append(b);
  }
  root.append(bar);

  const panel = h('section', 'panel');

  if (tab === 'onhand') {
    const scoped = hall === 'all' ? boxes : boxes.filter((b) => b.hall_id === hall);
    const summary = stockByHall(scoped);
    const total = valueOf(scoped.filter(onHand));

    panel.append(h('h3', 'panel-title', 'On hand'));
    panel.append(h('p', 'muted',
      'Boxes physically in the building — in inventory or opened. '
      + 'Value is what was paid for them, not what they will take.'));

    if (!scoped.length) {
      panel.append(h('div', 'placeholder', '<p class="semi">No boxes recorded</p>'));
    } else {
      panel.append(h('div', 'kpis', `
        <div class="kpi"><span class="kpi-label">Boxes on hand</span>
          <span class="kpi-value">${int(total.count)}</span></div>
        <div class="kpi"><span class="kpi-label">Value at cost</span>
          <span class="kpi-value">${usd(total.value)}</span>
          ${total.unpriced ? `<span class="kpi-sub">${int(total.unpriced)} with no cost recorded</span>` : ''}</div>
        <div class="kpi"><span class="kpi-label">On order</span>
          <span class="kpi-value">${usd(valueOf(scoped.filter((b) => b.state === 'on_order')).value)}</span>
          <span class="kpi-sub">not counted as stock</span></div>`));

      panel.append(table([
        { label: 'Hall', cell: (r) => esc(String(r.hall).toUpperCase()) },
        { label: 'Boxes on hand', cls: 'num', cell: (r) => int(r.onHand.count) },
        { label: 'Value at cost', cls: 'num', cell: (r) => usd(r.onHand.value) },
        { label: 'By state', cell: (r) => r.byState.map((s) =>
          `<span class="inv-state inv-${esc(s.state)}">${esc(String(s.state).replace('_', ' '))} ${int(s.count)}</span>`).join(' ') },
      ], summary));

      const byProduct = stockByProduct(scoped, products, { hall });
      panel.append(h('h3', 'panel-title', 'By product'));
      panel.append(table([
        { label: 'Product', cell: (r) => `${esc(r.name)}${r.active ? '' : ' <span class="dim">(inactive)</span>'}` },
        { label: 'Type', cell: (r) => esc(r.type ?? DASH) },
        { label: 'Boxes', cls: 'num', cell: (r) => int(r.count) },
        { label: 'Value at cost', cls: 'num', cell: (r) => usd(r.value) },
        { label: 'Retail face', cls: 'num',
          cell: (r) => (r.face === null ? DASH : `<span class="dim">${usd(r.face)}</span>`) },
      ], byProduct.slice(0, 60)));
      if (byProduct.length > 60) {
        panel.append(h('p', 'muted', `Showing the 60 most valuable of ${byProduct.length} products.`));
      }
    }
  } else if (tab === 'usage') {
    const rows = usageByProduct(usage, { hall });
    const risk = atRisk(rows);
    panel.append(h('h3', 'panel-title', 'Usage'));
    panel.append(h('p', 'muted', 'What has actually been played, from the session log.'));

    if (!rows.length) {
      panel.append(h('div', 'placeholder', '<p class="semi">No session usage recorded</p>'));
    } else {
      if (risk.length) {
        panel.append(h('div', 'mg-notice',
          `<strong>${risk.length} game${risk.length === 1 ? '' : 's'} in regular use `
          + 'can no longer be ordered.</strong> Worth knowing before the last box is '
          + `opened rather than after: ${risk.slice(0, 4).map((r) => esc(r.name)).join(', ')}`
          + `${risk.length > 4 ? '…' : ''}.`));
      }
      panel.append(table([
        { label: 'Game', cell: (r) => esc(r.name) },
        { label: 'Category', cell: (r) => esc(r.category ?? DASH) },
        { label: 'Sessions', cls: 'num', cell: (r) => int(r.sessions) },
        { label: 'Units', cls: 'num', cell: (r) => int(r.qty) },
        { label: 'Last played', cell: (r) => (r.lastUsed ? dateShort(r.lastUsed) : DASH) },
        { label: 'Stocked', cell: (r) => (r.stillStocked
          ? '<span class="st-good">yes</span>' : '<span class="st-poor">no longer</span>') },
      ], rows.slice(0, 80)));
      panel.append(h('p', 'muted',
        `${rows.length} distinct games played${rows.length > 80 ? ', showing the 80 most used' : ''}.`));
    }
  } else {
    panel.append(h('h3', 'panel-title', 'On order'));
    const scoped = hall === 'all' ? pos : pos.filter((p) => p.hall_id === hall);
    if (!scoped.length) {
      panel.append(h('div', 'placeholder', '<p class="semi">No purchase orders</p>'));
    } else {
      const open = scoped.filter((p) => !p.archived_at);
      panel.append(h('div', 'kpis', `
        <div class="kpi"><span class="kpi-label">Orders</span>
          <span class="kpi-value">${int(scoped.length)}</span>
          <span class="kpi-sub">${open.length} not archived</span></div>
        <div class="kpi"><span class="kpi-label">Total ordered</span>
          <span class="kpi-value">${usd(scoped.reduce((s, p) => s + (cents(p.total) ?? 0), 0))}</span></div>`));
      panel.append(table([
        { label: 'Order', cell: (r) => esc(r.num ?? DASH) },
        { label: 'Hall', cell: (r) => esc(String(r.hall_id ?? DASH).toUpperCase()) },
        { label: 'Vendor', cell: (r) => esc(r.vendor_id ?? DASH) },
        { label: 'Status', cell: (r) => esc(r.status ?? DASH) },
        { label: 'Subtotal', cls: 'num', cell: (r) => (cents(r.subtotal) === null ? DASH : usd(cents(r.subtotal))) },
        { label: 'Tax', cls: 'num', cell: (r) => (cents(r.tax) === null ? DASH : usd(cents(r.tax))) },
        { label: 'Total', cls: 'num', cell: (r) => (cents(r.total) === null ? DASH : usd(cents(r.total))) },
        { label: 'Sent', cell: (r) => (r.sent_at ? dateShort(String(r.sent_at).slice(0, 10)) : DASH) },
      ], [...scoped].sort((a, b) => String(b.sent_at ?? '').localeCompare(String(a.sent_at ?? '')))));
    }
  }

  root.append(panel);

  const onHandNow = valueOf(boxes.filter(onHand));
  setInspectorContent?.(`
    <p class="semi">Inventory</p>
    <p class="muted">${int(onHandNow.count)} boxes on hand · ${usd(onHandNow.value)} at cost</p>
    <p class="inspector-section-label">What counts as on hand</p>
    <p class="muted">In inventory and opened. Boxes on order have not arrived and
      sold-out boxes are gone; counting either would overstate the stock by tens
      of thousands of dollars.</p>
    <p class="inspector-section-label">Cost against retail</p>
    <p class="muted">Value is what was paid. Retail face is what the tickets would
      take at the counter — roughly nine times cost, because most of it goes back
      out as prizes. They are never added together.</p>
    <p class="inspector-section-label">Where this comes from</p>
    <p class="muted">The Operational database: <code>boxes</code>,
      <code>products</code> and <code>game_usage</code>. Not the analytics
      project, which has a separate and much smaller flash-ticket tracker.</p>`);

  return root;
}
