/* ============================================================================
   SAR 2.0 — Unit economics

   What one session is worth, from takings down to something like profit.

   WHAT IS REAL AND WHAT IS AN ASSUMPTION, KEPT VISIBLY APART.

   Real, from the databases:
     gross, payouts, net      the metric store, through the product categories
     attendance, RPA          the metric store
     cost of goods            Operational `boxes` — actual purchase cost of the
                              boxes consumed, when the session is linked
     hours worked             Operational `sched_time_entries`
     commission               Operational `sched_commission_payouts`

   NOT in any database, and therefore entered here as an assumption:
     staff cost per hour      no wage data is read, by standing instruction
     rent, utilities, admin   no expense table exists in any of the three
                              databases; I checked all three

   The assumptions are set on screen, stored in the browser only, and every
   figure derived from one is marked. A number that depends on a guess is
   labelled as such, every time it appears — otherwise it gets quoted in a
   meeting as though it came out of the books.
   ========================================================================== */

import { metricsFor, sessionTotals } from '../lib/model.js';
import { monthSeries, hallMatches } from '../lib/charts.js';
import { usd, usd2, pct, int, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

const STORE_KEY = 'sar2-assumptions';

/**
 * The assumptions, with their defaults.
 *
 * Deliberately few. Every one is a number somebody has to own, and a long list
 * of guesses dressed as a model is worse than a short list of honest ones.
 */
export const ASSUMPTIONS = Object.freeze([
  { key: 'staffCostPerHour', label: 'Staff cost per hour', unit: 'money', default: 2500,
    note: 'Fully loaded, including tax and cover. No wage data is read from any database.' },
  { key: 'fixedPerSession', label: 'Fixed cost per session', unit: 'money', default: 80000,
    note: 'Rent, utilities, licences and admin, apportioned to one session.' },
  { key: 'staffPerSession', label: 'Staff hours per session', unit: 'hours', default: 60,
    note: 'Used only when the time clock has no entry for that session.' },
]);

export function loadAssumptions(store = globalThis.localStorage) {
  const out = Object.fromEntries(ASSUMPTIONS.map((a) => [a.key, a.default]));
  try {
    const raw = store?.getItem(STORE_KEY);
    if (raw) Object.assign(out, JSON.parse(raw));
  } catch { /* private mode, or corrupt — defaults are fine */ }
  return out;
}

export function saveAssumptions(values, store = globalThis.localStorage) {
  try { store?.setItem(STORE_KEY, JSON.stringify(values)); } catch { /* ignore */ }
  return values;
}

/* ---------------------------------------------------------------------------
   Cost of goods — REAL, from Ops
--------------------------------------------------------------------------- */

const centsOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * What the boxes opened for a session actually cost.
 *
 * Only boxes that name a session count. A box with no `session_id` cannot be
 * attributed and is left out rather than spread across sessions — a smeared
 * cost looks precise and is not.
 *
 * Returns null when nothing can be attributed, which the screen shows as "not
 * linked" rather than as a cost of zero.
 */
export function costOfGoods(boxes = []) {
  const by = new Map();
  for (const b of boxes) {
    if (!b.session_id) continue;
    const c = centsOf(b.cost);
    if (c === null) continue;
    const cur = by.get(b.session_id) ?? { cost: 0, boxes: 0 };
    cur.cost += c;
    cur.boxes += 1;
    by.set(b.session_id, cur);
  }
  return by;
}

/* ---------------------------------------------------------------------------
   The bridge
--------------------------------------------------------------------------- */

/**
 * Takings down to profit for one session.
 *
 * `assumed: true` on any line that leans on a guess. The caller renders those
 * differently and the totals below them inherit the flag.
 */
export function sessionEconomics(event, ctx, { assumptions, cogs = new Map(), hours = null }) {
  const t = sessionTotals(metricsFor(event.id, ctx.metrics, ctx.idx), ctx.categories);
  const goods = cogs.get(event.id) ?? null;

  const staffHours = hours ?? assumptions.staffPerSession;
  const staffCost = Math.round(staffHours * assumptions.staffCostPerHour);

  const lines = [
    { key: 'gross', label: 'Gross sales', value: t.revenue, assumed: false, sign: 1 },
    { key: 'payouts', label: 'Prize payouts', value: -t.payout, assumed: false, sign: -1 },
    { key: 'net', label: 'Net sales', value: t.net, assumed: false, total: true },
    { key: 'cogs', label: 'Cost of goods', value: goods ? -goods.cost : null,
      assumed: false, sign: -1,
      note: goods ? `${goods.boxes} boxes` : 'no boxes linked to this session' },
    { key: 'staff', label: 'Staff cost', value: -staffCost, assumed: hours === null,
      sign: -1, note: hours === null
        ? `${staffHours} hours assumed` : `${staffHours.toFixed(1)} hours from the time clock` },
    { key: 'fixed', label: 'Fixed cost', value: -assumptions.fixedPerSession,
      assumed: true, sign: -1 },
  ];

  const contribution = t.net - (goods?.cost ?? 0);
  const profit = contribution - staffCost - assumptions.fixedPerSession;

  lines.push(
    { key: 'contribution', label: 'Contribution', value: contribution,
      assumed: false, total: true,
      note: goods ? 'net less the cost of what was sold' : 'no goods cost linked' },
    { key: 'profit', label: 'Profit', value: profit, assumed: true, total: true },
  );

  return {
    event,
    lines,
    net: t.net,
    contribution,
    profit,
    attendance: t.attendance,
    perHead: t.attendance > 0 ? Math.round(profit / t.attendance) : null,
    goodsLinked: Boolean(goods),
    hoursReal: hours !== null,
  };
}

/** Hours per session from the time clock, where the entry names a session. */
export function hoursBySession(timeEntries = [], sessions = []) {
  const dateOf = new Map(sessions.map((s) => [s.id, s.session_date]));
  const by = new Map();
  for (const e of timeEntries) {
    // `Number(null)` is 0 and passes `Number.isFinite`, so an unrecorded shift
    // used to arrive as a real zero — which then bypassed the `hours ?? default`
    // fallback (0 ?? x is 0), priced the staff line at $0, and labelled it
    // "0.0 hours from the time clock" as though it were verified. Third time
    // this trap has appeared; guarded explicitly.
    if (e.hours_worked === null || e.hours_worked === undefined || e.hours_worked === '') continue;
    const n = Number(e.hours_worked);
    if (!Number.isFinite(n)) continue;
    const key = e.work_date ?? dateOf.get(e.session_id) ?? null;
    if (!key) continue;
    by.set(key, (by.get(key) ?? 0) + n);
  }
  return by;
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderUnitEconomics({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const hall = params.hall ?? 'all';
  const assumptions = loadAssumptions();
  const sched = data.schedule;
  const cogs = costOfGoods(sched?.boxes ?? []);
  const hoursByDate = hoursBySession(sched?.timeEntries ?? [], sched?.sessions ?? []);

  const bar = h('div', 'filter-bar');
  for (const l of [{ id: 'all', name: 'Both halls' }, ...data.locations]) {
    const b = h('button', `chip${hall === l.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l.name;
    b.addEventListener('click', () => { play('select'); onNavigate('unit-economics', { ...params, hall: l.id }); });
    bar.append(b);
  }
  root.append(bar);

  const events = data.events.filter((e) => hallMatches(hall === 'all' ? 'all' : hall, e.location_id));
  const selected = events.find((e) => e.id === params.id) ?? events[0];

  if (!selected) {
    root.append(h('section', 'panel',
      '<h3 class="panel-title">Unit economics</h3>'
      + '<div class="placeholder"><p class="semi">No sessions</p></div>'));
    return root;
  }

  const econ = sessionEconomics(selected, data, {
    assumptions, cogs, hours: hoursByDate.get(selected.event_date) ?? null,
  });

  /* ---- assumptions panel ---- */
  const ap = h('section', 'panel');
  ap.append(h('h3', 'panel-title', 'Assumptions'));
  ap.append(h('p', 'muted',
    'These are not in any database — I checked all three. They are yours to set, '
    + 'they stay in this browser, and every figure that depends on one is marked.'));
  const form = h('div', 'assump');
  for (const a of ASSUMPTIONS) {
    const wrap = h('label', 'assump-row');
    const value = a.unit === 'money' ? (assumptions[a.key] / 100).toFixed(2) : assumptions[a.key];
    wrap.innerHTML = `<span class="assump-label">${a.label}</span>
      <input type="number" step="${a.unit === 'money' ? '0.01' : '0.5'}" value="${value}"
             data-key="${a.key}" data-unit="${a.unit}">
      <span class="dim assump-note">${a.note}</span>`;
    wrap.querySelector('input').addEventListener('change', (ev) => {
      const raw = Number(ev.target.value);
      if (!Number.isFinite(raw)) return;
      saveAssumptions({ ...assumptions,
        [a.key]: a.unit === 'money' ? Math.round(raw * 100) : raw });
      onNavigate('unit-economics', { ...params });
    });
    form.append(wrap);
  }
  ap.append(form);
  root.append(ap);

  /* ---- the bridge ---- */
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title',
    `${data.locations.find((l) => l.id === selected.location_id)?.name ?? ''} · ${selected.event_date}`));

  const picker = h('div', 'filter-bar');
  for (const e of events.slice(0, 10)) {
    const b = h('button', `chip${e.id === selected.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = e.event_date;
    b.addEventListener('click', () => onNavigate('unit-economics', { ...params, id: e.id }));
    picker.append(b);
  }
  panel.append(picker);

  const t = h('table', 'rn-table bridge');
  t.innerHTML = '<thead><tr><th>Line</th><th class="num">Amount</th><th>Basis</th>'
    + '</tr></thead><tbody></tbody>';
  const body = t.querySelector('tbody');
  for (const l of econ.lines) {
    body.insertAdjacentHTML('beforeend', `<tr class="${l.total ? 'is-bold' : ''}">
      <td>${l.label}</td>
      <td class="num ${l.value !== null && l.value < 0 ? 'tone-neg' : ''}">${
        l.value === null ? DASH : usd(l.value)}</td>
      <td class="dim">${l.assumed ? '<span class="assumed">assumed</span> ' : ''}${l.note ?? ''}</td>
    </tr>`);
  }
  panel.append(t);

  panel.append(h('div', 'kpis', `
    <div class="kpi"><span class="kpi-label">Contribution</span>
      <span class="kpi-value">${usd(econ.contribution)}</span>
      <span class="kpi-sub">${econ.goodsLinked ? 'real, including goods' : 'no goods linked'}</span></div>
    <div class="kpi"><span class="kpi-label">Profit</span>
      <span class="kpi-value">${usd(econ.profit)}</span>
      <span class="kpi-sub"><span class="assumed">depends on assumptions</span></span></div>
    <div class="kpi"><span class="kpi-label">Per head</span>
      <span class="kpi-value">${econ.perHead === null ? DASH : usd2(econ.perHead)}</span>
      <span class="kpi-sub">${int(econ.attendance)} in</span></div>`));

  if (!econ.goodsLinked) {
    panel.append(h('div', 'mg-notice',
      '<strong>No boxes are linked to this session.</strong> Cost of goods is '
      + 'real when the stock system records which session a box was opened for; '
      + 'here it does not, so the line is blank rather than zero.'));
  }
  root.append(panel);

  setInspectorContent?.(`
    <p class="semi">Unit economics</p>
    <p class="muted">${selected.event_date}</p>
    <p class="inspector-section-label">Real against assumed</p>
    <p class="muted">Gross, payouts, net and attendance come from the metric
      store. Cost of goods is the actual purchase cost of the boxes opened, from
      the stock system. Staff hours come from the time clock when recorded.
      Staff cost per hour and fixed costs are yours to set — no wage data is read
      and no expense table exists in any database.</p>
    <p class="inspector-section-label">Contribution against profit</p>
    <p class="muted">Contribution is net less the cost of what was sold, and is
      real. Profit subtracts staff and fixed costs and therefore inherits your
      assumptions — it is marked wherever it appears.</p>`);

  return root;
}
