/* ============================================================================
   SAR 2.0 — Promotions

   THE TABLE IS EMPTY. `promotions` in the analytics project has 22 columns and
   ZERO rows — not zero for Vanguard, zero for every customer. Nothing has ever
   been written to it.

   SAR 1.0 has no promotions screen either; its only related code is a
   `promotionNotes` field on a session, which is free text a manager types.

   So this screen does two honest things rather than one dishonest one:

     1. Shows the session promotion NOTES, which are real and are being written
        today. That is what people actually record about promotions.
     2. Shows the promotions table's shape, empty, so it is obvious the feature
        exists in the schema and is unused — rather than rendering a blank grid
        that looks broken.

   It is built against the real columns, so the day somebody starts using it the
   screen fills in by itself.
   ========================================================================== */

import { usd, pct, int, dateShort, weekday, sessionType, esc, DASH } from '../lib/fmt.js';
import { metricsFor, sessionTotals } from '../lib/model.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const TABS = [
  { id: 'notes', label: 'Session notes' },
  { id: 'catalogue', label: 'Promotion catalogue' },
];

/** The columns the table would show, in the order they matter. */
export const COLUMNS = Object.freeze([
  { key: 'code', label: 'Code' },
  { key: 'name', label: 'Name' },
  { key: 'promo_type', label: 'Type' },
  { key: 'discount_type', label: 'Discount' },
  { key: 'discount_value', label: 'Value' },
  { key: 'valid_from', label: 'From' },
  { key: 'valid_to', label: 'To' },
  { key: 'max_uses', label: 'Max uses' },
  { key: 'current_uses', label: 'Used' },
  { key: 'is_active', label: 'Active' },
]);

/**
 * Sessions carrying a note, newest first.
 *
 * The note is `analytics_events.notes` — the only note field `api.getEvents`
 * selects. An earlier version read `promotion_notes`, which is never fetched,
 * so the tab was empty by construction. `metadata.promo_notes` is accepted too
 * (the Leaderboard reads it). Checked against production 1 Oct 2026: none of
 * the 400 most recent sessions carries either, so this tab is honestly empty
 * until someone records one.
 */
const noteOf = (e) => {
  const n = e.notes ?? e.metadata?.promo_notes ?? e.promotion_notes ?? null;
  return n && String(n).trim() ? String(n).trim() : null;
};

export function noteRows(data, { hall = 'all' } = {}) {
  return data.events
    .filter((e) => {
      const n = noteOf(e);
      return n && String(n).trim() && (hall === 'all' || e.location_id === hall);
    })
    .map((e) => {
      const t = sessionTotals(metricsFor(e.id, data.metrics, data.idx), data.categories);
      return {
        event: e,
        note: noteOf(e),
        hall: data.locations.find((l) => l.id === e.location_id)?.name ?? DASH,
        gross: t.revenue,
        net: t.net,
        attendance: t.attendance,
      };
    })
    .sort((a, b) => (a.event.event_date < b.event.event_date ? 1 : -1));
}

/** Rows for the catalogue tab. Empty on production, and that is the point. */
export function catalogueRows(promotions = []) {
  return [...promotions].sort((a, b) =>
    String(b.valid_from ?? '').localeCompare(String(a.valid_from ?? '')));
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderPromotions({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const tab = TABS.find((t) => t.id === params.tab)?.id ?? 'notes';
  const hall = params.hall ?? 'all';
  const promotions = data.promotions ?? [];

  const tabs = h('div', 'rn-tabs');
  for (const t of TABS) {
    const b = h('button', `rn-tab${t.id === tab ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label;
    b.addEventListener('click', () => { play('select'); onNavigate('promotions', { ...params, tab: t.id }); });
    tabs.append(b);
  }
  root.append(tabs);

  const panel = h('section', 'panel');

  if (tab === 'notes') {
    const bar = h('div', 'filter-bar');
    for (const l of [{ id: 'all', name: 'Both halls' }, ...data.locations]) {
      const b = h('button', `chip${hall === l.id ? ' is-active' : ''}`);
      b.type = 'button'; b.textContent = l.name;
      b.addEventListener('click', () => onNavigate('promotions', { ...params, hall: l.id }));
      bar.append(b);
    }
    root.append(bar);

    const rows = noteRows(data, { hall });
    panel.append(h('h3', 'panel-title', 'Session notes'));
    panel.append(h('p', 'muted',
      'What managers actually recorded about promotions, session by session. '
      + 'This is free text, so it is shown as written and not parsed.'));

    if (!rows.length) {
      panel.append(h('div', 'placeholder',
        '<p class="semi">No promotion notes recorded</p>'
        + '<p class="dim">Notes are written per session; none of the loaded '
        + 'sessions has one.</p>'));
    } else {
      const t = h('table', 'rn-table');
      t.innerHTML = `<thead><tr><th>Date</th><th>Hall</th><th>Session</th>
        <th>Note</th><th class="num">Attendance</th><th class="num">Gross</th>
        <th class="num">Net</th></tr></thead><tbody></tbody>`;
      const body = t.querySelector('tbody');
      for (const r of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${weekday(r.event.event_date).slice(0, 3)} ${dateShort(r.event.event_date)}</td>
          <td>${r.hall}</td>
          <td>${sessionType(r.event.event_type)}</td>
          <td class="promo-note"><button type="button" class="cell-link">${esc(r.note)}</button></td>
          <td class="num">${int(r.attendance)}</td>
          <td class="num">${usd(r.gross)}</td>
          <td class="num">${usd(r.net)}</td>`;
        // A real button, not a click handler on a <td>: a table cell is not
        // focusable, is not announced as interactive, and cannot be reached by
        // keyboard at all.
        const open = tr.querySelector('button.cell-link');
        open.title = 'Open this session';
        open.addEventListener('click', () => onNavigate('session', { id: r.event.id }));
        body.append(tr);
      }
      panel.append(t);
      panel.append(h('p', 'muted',
        `${rows.length} session${rows.length === 1 ? '' : 's'} with a note. `
        + 'Takings are shown beside each so a promotion can be judged, but no '
        + 'comparison is drawn — one night is not evidence.'));
    }
  } else {
    panel.append(h('h3', 'panel-title', 'Promotion catalogue'));
    const rows = catalogueRows(promotions);

    if (!rows.length) {
      panel.append(h('div', 'mg-notice',
        '<strong>The promotions table is empty.</strong> It exists in the '
        + 'database with 22 columns, and has never had a row written to it — '
        + 'not for this hall, not for any customer. Nothing is broken; the '
        + 'feature is simply unused.'));
      const t = h('table', 'rn-table');
      t.innerHTML = `<thead><tr>${COLUMNS.map((c) =>
        `<th>${c.label}</th>`).join('')}</tr></thead>
        <tbody><tr><td class="dim" colspan="${COLUMNS.length}">
        No promotions defined</td></tr></tbody>`;
      panel.append(t);
      panel.append(h('p', 'muted',
        'The columns above are the real ones. If somebody starts defining '
        + 'promotions, they appear here without any further work.'));
    } else {
      const t = h('table', 'rn-table');
      t.innerHTML = `<thead><tr>${COLUMNS.map((c) =>
        `<th>${c.label}</th>`).join('')}</tr></thead><tbody></tbody>`;
      const body = t.querySelector('tbody');
      for (const p of rows) {
        body.insertAdjacentHTML('beforeend', `<tr>${COLUMNS.map((c) => {
          const v = p[c.key];
          if (v === null || v === undefined || v === '') return `<td>${DASH}</td>`;
          if (c.key === 'is_active') return `<td>${v ? '<span class="st-good">yes</span>' : '<span class="dim">no</span>'}</td>`;
          if (c.key === 'valid_from' || c.key === 'valid_to') {
            return `<td>${dateShort(String(v).slice(0, 10))}</td>`;
          }
          if (c.key === 'discount_value') {
            return `<td class="num">${p.discount_type === 'percent' ? pct(Number(v) / 100) : usd(Math.round(Number(v) * 100))}</td>`;
          }
          return `<td>${esc(v)}</td>`;
        }).join('')}</tr>`);
      }
      panel.append(t);
      panel.append(h('p', 'muted', `${rows.length} promotions defined.`));
    }
  }

  root.append(panel);
  setInspectorContent?.(`
    <p class="semi">Promotions</p>
    <p class="muted">${noteRows(data).length} session notes · ${promotions.length} defined promotions</p>
    <p class="inspector-section-label">Why there are two tabs</p>
    <p class="muted">The promotions table is empty and always has been, so the
      only real record of what was run is the free-text note a manager writes on
      a session. Both are shown: the notes because they are real, the empty table
      because an unused feature should look unused rather than broken.</p>
    <p class="inspector-section-label">No comparison is drawn</p>
    <p class="muted">Takings sit beside each note so a night can be judged, but
      nothing is calculated from them. One promotion on one night is an anecdote,
      and the Managers screen already shows how wide the error bars are on a
      handful of sessions.</p>`);

  return root;
}
