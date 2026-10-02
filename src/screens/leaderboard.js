/* ============================================================================
   SAR 2.0 — U9, Leaderboard

   THE STRUCTURE, TAKEN FROM SAR 1.0 RATHER THAN INVENTED.

   Every row is:

     [rank] [session name] [ Net | Gross | Margin | RPA | Att | …categories ] [notes]

   and **every one of those metric cards is the sort control**. Click a card
   and the whole board re-sorts by that metric; the active card fills solid,
   the rest stay tinted. That is the whole point of the screen: you read the
   numbers and re-rank by them in the same gesture, without moving your eyes
   to a control strip somewhere else.

   I built it twice with the aspects as chips ABOVE the table. That was wrong
   both times, and it is the third correction on this screen. The metrics live
   IN the rows. Verified against `LeaderboardManager.renderCompactCard()` in
   `sar/app.html`, which wires `onclick -> setAspect(key)` onto each card.

   Category cards are coloured from `analytics_product_categories.color_bg_from`
   — per-tenant data, applied inline. That is the one documented exception to
   the design-token rule: those colours are content, not design.
   ========================================================================== */

import { metricsFor, sessionTotals, mean, median } from '../lib/model.js';
import { usd, usd2, pct, int, dateShort, weekday, sessionType, esc, DASH } from '../lib/fmt.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

const PERIODS = [
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: '365', label: '1 year', days: 365 },
  { key: 'all', label: 'All time', days: null },
];

/**
 * The universal cards, in SAR 1.0's order. Category cards follow, built from
 * the tenant's own configuration.
 */
const UNIVERSAL = [
  { key: 'netSales', label: 'Net', get: (t) => t.net, fmt: usd, better: 1 },
  { key: 'totalSales', label: 'Gross', get: (t) => t.revenue, fmt: usd, better: 1 },
  { key: 'margin', label: 'Margin', get: (t) => t.margin, fmt: (v) => pct(v), better: 1 },
    // usd2, not usd: this is a per-head figure and Session detail, Venues and
  // Reporting all print it to the cent. Rounding here made the same session
  // read $481 on one screen and $481.23 on another.
  { key: 'rpa', label: 'RPA', get: (t) => t.rpa, fmt: usd2, better: 1 },
  { key: 'attendance', label: 'Att', get: (t) => t.attendance, fmt: int, better: 1 },
];

export function aspectsFor(categories = []) {
  return [
    ...UNIVERSAL,
    ...categories.map((c) => ({
      key: c.key,
      label: c.display_name,
      colour: c.color_bg_from || null,
      get: (t) => t.categories.find((x) => x.key === c.key)?.revenue ?? null,
      fmt: usd,
      better: 1,
    })),
  ];
}

export const DEFAULT_ASPECT = 'totalSales';

/**
 * Sort by an aspect. Unmeasured sessions go last in BOTH directions — a
 * session with no recorded attendance is not the worst-attended one, it is
 * unmeasured, and putting it at either end asserts something the data does
 * not support.
 */
export function sortRows(rows, aspect, descending) {
  const has = []; const missing = [];
  for (const r of rows) {
    const v = aspect.get(r.totals);
    if (v === null || v === undefined || !Number.isFinite(v)) missing.push(r);
    else has.push({ ...r, _v: v });
  }
  has.sort((a, b) => (descending ? b._v - a._v : a._v - b._v));
  return [...has, ...missing];
}

/** One metric card. This is both the readout AND the sort control. */
function card(aspect, value, active) {
  const c = h('button', `mcard${active ? ' is-active' : ''}`);
  c.type = 'button';
  c.dataset.aspect = aspect.key;
  c.title = `Click to sort by ${aspect.label}`;
  // Per-tenant category colour, from the database. Runtime data, not design.
  if (aspect.colour) {
    if (active) {
      c.style.background = aspect.colour;
      c.style.borderColor = aspect.colour;
    } else {
      c.style.borderColor = aspect.colour;
      c.style.color = aspect.colour;
    }
  }
  c.innerHTML = `<span class="mcard-label">${aspect.label}</span>
                 <span class="mcard-value">${aspect.fmt(value)}</span>`;
  return c;
}

export function renderLeaderboard({ data, params, onNavigate, setInspectorContent }) {
  const aspects = aspectsFor(data.categories);
  const aspect = aspects.find((a) => a.key === params.aspect)
    ?? aspects.find((a) => a.key === DEFAULT_ASPECT);
  const period = PERIODS.find((p) => p.key === params.period) ?? PERIODS[1];
  const hall = params.hall ?? 'all';
  const descending = params.dir ? params.dir === 'desc' : true;

  const root = h('div', 'screen');

  /* ---- filters: hall and period only. The metrics are in the rows. ---- */
  const bar = h('div', 'filter-bar');
  for (const l of [{ id: 'all', name: 'Both halls' }, ...data.locations]) {
    const b = h('button', `chip${hall === l.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l.name;
    b.addEventListener('click', () => onNavigate('leaderboard',
      { ...params, hall: l.id, aspect: aspect.key, period: period.key,
        dir: descending ? 'desc' : 'asc' }));
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  for (const p of PERIODS) {
    const b = h('button', `chip${p.key === period.key ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = p.label;
    b.addEventListener('click', () => onNavigate('leaderboard',
      { ...params, hall, aspect: aspect.key, period: p.key,
        dir: descending ? 'desc' : 'asc' }));
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  const dirBtn = h('button', 'chip');
  dirBtn.type = 'button';
  dirBtn.textContent = descending ? 'Highest first ▼' : 'Lowest first ▲';
  dirBtn.title = 'Reverse the order';
  dirBtn.addEventListener('click', () => onNavigate('leaderboard',
    { ...params, hall, aspect: aspect.key, period: period.key,
      dir: descending ? 'asc' : 'desc' }));
  bar.append(dirBtn);
  root.append(bar);

  /* ---- rows ---- */
  const cutoff = period.days
    ? new Date(Date.now() - period.days * 86400000).toISOString().slice(0, 10)
    : null;

  const rows = data.events
    .filter((e) => (hall === 'all' || e.location_id === hall))
    .filter((e) => (!cutoff || e.event_date >= cutoff))
    .map((e) => ({
      event: e,
      totals: sessionTotals(metricsFor(e.id, data.metrics, data.idx), data.categories),
    }));

  const sorted = sortRows(rows, aspect, descending);

  if (!sorted.length) {
    root.append(h('div', 'placeholder',
      `<p class="semi">No sessions in this period</p><p class="dim">${period.label}.</p>`));
    return root;
  }

  const board = h('div', 'board');

  sorted.forEach((r, i) => {
    const hallName = data.locations.find((l) => l.id === r.event.location_id)?.name ?? DASH;
    const row = h('div', `lb-row${i < 3 ? ` rank-${i + 1}` : ''}`);

    const rank = h('div', 'lb-rank', i < 3 ? ['①', '②', '③'][i] : String(i + 1));

    const name = h('button', 'lb-name');
    name.type = 'button';
    name.title = 'Open this session';
    name.innerHTML = `<span class="lb-hall">${hallName}</span>
      <span class="dim">${weekday(r.event.event_date).slice(0, 3)}
      ${dateShort(r.event.event_date)} · ${sessionType(r.event.event_type)}</span>`;
    name.addEventListener('click', () => onNavigate('session', { id: r.event.id }));

    const cards = h('div', 'lb-cards');
    // Equal columns, set from the number of metrics, so every card in a
    // column is the same width down the whole board.
    cards.style.gridTemplateColumns = `repeat(${aspects.length}, minmax(0, 1fr))`;
    for (const a of aspects) {
      const c = card(a, a.get(r.totals), a.key === aspect.key);
      c.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Clicking the active card reverses; another card switches to it.
        const dir = a.key === aspect.key ? (descending ? 'asc' : 'desc') : 'desc';
        onNavigate('leaderboard',
          { ...params, hall, aspect: a.key, period: period.key, dir });
      });
      cards.append(c);
    }

    // Escaped: these are free text a manager typed on the session.
    const notes = [r.event.notes, r.event.metadata?.promo_notes]
      .filter(Boolean).map(esc).join(' · ');
    const note = h('div', 'lb-note', notes || '<span class="dim">—</span>');
    if (notes) note.title = notes;

    row.append(rank, name, cards, note);
    board.append(row);
  });

  root.append(board);

  /* ---- inspector ---- */
  const values = sorted.map((r) => aspect.get(r.totals))
    .filter((v) => v !== null && Number.isFinite(v));
  const best = sorted[0];
  const bestHall = best ? data.locations.find((l) => l.id === best.event.location_id)?.name : null;

  setInspectorContent?.(`
    <p class="semi">Sorted by ${aspect.label}</p>
    <p class="muted">${descending ? 'Highest first' : 'Lowest first'} ·
      ${period.label} ·
      ${hall === 'all' ? 'both halls' : data.locations.find((l) => l.id === hall)?.name ?? ''}</p>
    <p class="inspector-section-label">Across ${sorted.length} session${sorted.length === 1 ? '' : 's'}</p>
    <dl class="inspector-filters">
      <dt>Mean</dt><dd>${values.length ? aspect.fmt(mean(values)) : DASH}</dd>
      <dt>Median</dt><dd>${values.length ? aspect.fmt(median(values)) : DASH}</dd>
      <dt>Top</dt><dd>${best ? aspect.fmt(aspect.get(best.totals)) : DASH}</dd>
      <dt>Held by</dt><dd>${best ? `${bestHall}, ${dateShort(best.event.event_date)}` : DASH}</dd>
      <dt>Unmeasured</dt><dd>${sorted.length - values.length}</dd>
    </dl>
    <p class="inspector-section-label">Sorting</p>
    <p class="muted">Every metric card in every row is clickable. Click one to
      rank the board by it; click the same card again to reverse. The card you
      sorted by is filled solid all the way down the column.</p>
    ${sorted.length - values.length > 0
      ? `<p class="dim">Sessions with no recorded value sort last in both
         directions — unmeasured is not the same as worst.</p>` : ''}`);

  return root;
}
