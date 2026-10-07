import { play, isEnabled, setEnabled } from '../lib/sound.js';
import { shuffleThen } from '../lib/leaderboard-motion.js';
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
      textColour: c.color_text || null,
      borderColour: c.color_border || null,
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
  c.title = `${aspect.label}: ${aspect.fmt(value)} — click to sort`;
  // Per-tenant category colour, from the database. Runtime data, not design.
  if (aspect.colour) {
    if (active) {
      c.style.background = aspect.colour;
      c.style.borderColor = aspect.borderColour || aspect.colour;
      c.style.color = aspect.textColour || 'var(--ink)';
      c.dataset.category = 'true';
    } else {
      c.style.borderLeftColor = aspect.borderColour || aspect.colour;
      c.style.color = 'var(--ink)';
    }
  }
  c.innerHTML = `<span class="mcard-label">${esc(aspect.label)}</span>
                 <span class="mcard-value">${aspect.fmt(value)}</span>`;
  return c;
}

/* ---------------------------------------------------------------------------
   Day slots — SAR 1.0's "Days" filter (Mon … Sat Early, Sat Late …)
--------------------------------------------------------------------------- */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const slotOf = (e) => `${new Date(`${e.event_date}T00:00:00Z`).getUTCDay()}-${e.event_type}`;

/**
 * Every weekday-and-type slot present in the sessions, Monday first. A day
 * with one type is just "Thu"; a day with two is "Sat Early" and "Sat Late",
 * as SAR 1.0 labels them.
 */
export function daySlots(events = []) {
  const types = new Map();
  for (const e of events) {
    const d = new Date(`${e.event_date}T00:00:00Z`).getUTCDay();
    types.set(d, new Set([...(types.get(d) ?? []), e.event_type]));
  }
  const out = [];
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const ts = [...(types.get(d) ?? [])].sort((a, b) => (a === 'late') - (b === 'late') || a.localeCompare(b));
    for (const t of ts) {
      const label = ts.length === 1 ? DOW[d] : `${DOW[d]} ${t === 'late' ? 'Late' : 'Early'}`;
      out.push({ key: `${d}-${t}`, label });
    }
  }
  return out;
}

/** The slots a `days` parameter selects; absent or empty means every slot. */
export function selectedSlots(param, slots) {
  if (param === undefined || param === null || param === '') return new Set(slots.map((s) => s.key));
  if (param === 'none') return new Set();
  const known = new Set(slots.map((s) => s.key));
  const picked = new Set(String(param).split(',').filter((k) => known.has(k)));
  // A pick that names no slot this hall has (switching halls) means all.
  return picked.size ? picked : new Set(known);
}

export function renderLeaderboard({ data, params, onNavigate: navigate, setInspectorContent }) {
  const aspects = aspectsFor(data.categories);
  const aspect = aspects.find((a) => a.key === params.aspect)
    ?? aspects.find((a) => a.key === DEFAULT_ASPECT);
  const period = PERIODS.find((p) => p.key === params.period) ?? PERIODS[1];
  const hall = params.hall ?? 'all';
  const descending = params.dir ? params.dir === 'desc' : true;

  const root = h('div', 'screen leaderboard');
  const shuffle = shuffleThen(root);
  root.dispose = shuffle.dispose;
  const onNavigate = (screen, next) => {
    if (screen === 'leaderboard') { shuffle.run(() => navigate(screen, next)); }
    else { play('event'); navigate(screen, next); }
  };

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
  const sound = h('button', 'chip'); sound.type = 'button';
  const soundLabel = () => { sound.textContent = isEnabled() ? 'Sound on' : 'Sound off'; sound.setAttribute('aria-pressed', String(isEnabled())); };
  soundLabel(); sound.addEventListener('click', () => { setEnabled(!isEnabled()); soundLabel(); if (isEnabled()) play('click'); });
  bar.append(sound);
  root.append(bar);

  /* ---- days: which weekday-and-type slots are in the pool ---- */
  const slots = daySlots(data.events.filter((e) => hall === 'all' || e.location_id === hall));
  const picked = selectedSlots(params.days, slots);
  const daysParam = (set) => (set.size === slots.length ? undefined
    : set.size === 0 ? 'none' : slots.filter((x) => set.has(x.key)).map((x) => x.key).join(','));
  const go = (set) => onNavigate('leaderboard', { ...params, hall, aspect: aspect.key,
    period: period.key, dir: descending ? 'desc' : 'asc', days: daysParam(set) });
  const dayBar = h('div', 'filter-bar lb-days');
  dayBar.append(h('span', 'dim', 'Days'));
  const all = h('button', 'chip'); all.type = 'button'; all.textContent = 'All';
  all.addEventListener('click', () => go(new Set(slots.map((x) => x.key))));
  const none = h('button', 'chip'); none.type = 'button'; none.textContent = 'None';
  none.addEventListener('click', () => go(new Set()));
  dayBar.append(all, none, h('span', 'filter-sep'));
  for (const sl of slots) {
    const b = h('button', `chip${picked.has(sl.key) ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = sl.label;
    b.setAttribute('aria-pressed', String(picked.has(sl.key)));
    b.addEventListener('click', () => {
      const next = new Set(picked);
      if (next.has(sl.key)) next.delete(sl.key); else next.add(sl.key);
      go(next);
    });
    dayBar.append(b);
  }
  root.append(dayBar);

  /* ---- rows ---- */
  // Counted back from the latest session on record, not the wall clock, so a
  // period always means the same sessions for the same data (and the tests
  // do not start failing as the calendar moves on).
  const latest = data.events.reduce((m, e) => (e.event_date > m ? e.event_date : m), '');
  const cutoff = period.days && latest
    ? new Date(Date.parse(`${latest}T00:00:00Z`) - period.days * 86400000).toISOString().slice(0, 10)
    : null;

  const rows = data.events
    .filter((e) => (hall === 'all' || e.location_id === hall))
    .filter((e) => (!cutoff || e.event_date >= cutoff))
    .filter((e) => picked.has(slotOf(e)))
    .map((e) => ({
      event: e,
      totals: sessionTotals(metricsFor(e.id, data.metrics, data.idx), data.categories),
    }));

  const sorted = sortRows(rows, aspect, descending);
  dayBar.append(h('span', 'lb-pool dim', `Pool: ${rows.length.toLocaleString()} session${rows.length === 1 ? '' : 's'}`));

  if (!sorted.length) {
    root.append(h('div', 'placeholder',
      `<p class="semi">No sessions in this period</p><p class="dim">${esc(period.label)}${
        picked.size < slots.length ? ', on the days picked' : ''}.</p>`));
    return root;
  }

  const board = h('div', 'board');

  sorted.forEach((r, i) => {
    const hallName = data.locations.find((l) => l.id === r.event.location_id)?.name ?? DASH;
    const row = h('div', `lb-row${i < 3 ? ` rank-${i + 1}` : ''}`);

    row.style.setProperty('--row-delay', `${Math.min(i, 12) * 18}ms`);
    const rank = h('div', 'lb-rank', i < 3 ? ['①', '②', '③'][i] : String(i + 1));

    const name = h('button', 'lb-name');
    name.type = 'button';
    name.title = 'Open this session';
    name.innerHTML = `<span class="lb-hall">${esc(hallName)}</span>
      <span class="dim">${weekday(r.event.event_date).slice(0, 3)}
      ${dateShort(r.event.event_date)} ${r.event.event_date.slice(0, 4)} · ${esc(sessionType(r.event.event_type))}</span>`;
    name.addEventListener('click', () => onNavigate('session', { id: r.event.id }));

    const cards = h('div', 'lb-cards');
    // Equal columns, set from the number of metrics, so every card in a
    // column is the same width down the whole board.
    // Card minimum width keeps every number readable; the grid wraps as needed.
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
    const note = h(notes ? 'details' : 'span', 'lb-note');
    if (notes) {
      note.innerHTML = '<summary aria-label="Expand session notes" title="Expand session notes">Notes</summary><div class="lb-note-body">' + notes + '</div>';
    } else { note.textContent = '—'; note.title = 'No session notes'; }

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
    <p class="semi">Sorted by ${esc(aspect.label)}</p>
    <p class="muted">${descending ? 'Highest first' : 'Lowest first'} ·
      ${esc(period.label)} ·
      ${esc(hall === 'all' ? 'both halls' : data.locations.find((l) => l.id === hall)?.name ?? '')}</p>
    <p class="inspector-section-label">Across ${sorted.length} session${sorted.length === 1 ? '' : 's'}</p>
    <dl class="inspector-filters">
      <dt>Mean</dt><dd>${values.length ? aspect.fmt(mean(values)) : DASH}</dd>
      <dt>Median</dt><dd>${values.length ? aspect.fmt(median(values)) : DASH}</dd>
      <dt>Top</dt><dd>${best ? aspect.fmt(aspect.get(best.totals)) : DASH}</dd>
      <dt>Held by</dt><dd>${best ? `${esc(bestHall)}, ${dateShort(best.event.event_date)}` : DASH}</dd>
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
