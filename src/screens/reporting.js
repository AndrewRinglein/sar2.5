/* ============================================================================
   SAR 2.0 — Reporting

   A horizontal strip of month columns. Built against SPEC §8a, which was read
   directly out of SAR 1.0's `createMonthColumn`, `calculateMonthMetrics`,
   `computeCategoryChanges` and `toggleReportingSection` rather than inferred.

   Each column: the month name, the SESSION COUNT, then eight coloured boxes —
   Total Sales, Total Payouts, Net Sales, Products, Margin, RPA, Profit/Event,
   Attendance. Every box expands in place to show its own breakdown, and
   plays a sound when it does.

   THE SESSION COUNT IS THE NUMBER THAT MATTERS. It is printed in the header
   and it is the denominator of five other figures. SAR 1.0 divides by it
   without a guard and renders `$NaN` for an empty month; here a zero count
   yields null and prints a dash.

   Colours come from tokens named for their box, so the palette is decided in
   one file while each box keeps the identity it has in SAR 1.0.
   ========================================================================== */

import { metricsFor, sessionTotals, getMetric, maxAttendanceFor } from '../lib/model.js';
import { usd, usd2, pct, int, monthLabel, esc, DASH, hallToday } from '../lib/fmt.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const MONTHS_PER_VIEW = 4;
export const COLUMN_STEP = 225;          // 200px column + 25px gap, as SAR 1.0

/* ---------------------------------------------------------------------------
   Metrics — SPEC §8a.7
--------------------------------------------------------------------------- */

/**
 * Roll a set of sessions into one period's figures.
 *
 * Money stays in integer cents. `eventCount` is `events.length` — a count of
 * SESSIONS, never of metric rows (IMPL §3.8).
 */
export function periodMetrics(events, ctx) {
  const m = {
    eventCount: events.length,
    totalSales: 0, totalPayouts: 0, attendance: 0, totalCapacity: 0,
    // Per-attendee figures use only sessions that recorded attendance, so a
    // session with sales but no head count cannot inflate them.
    attendedSales: 0, attendedNet: 0, attendedEvents: 0,
    categories: new Map(),
  };

  for (const e of events) {
    const t = sessionTotals(metricsFor(e.id, ctx.metrics, ctx.idx), ctx.categories);
    m.totalSales += t.revenue;
    m.totalPayouts += t.payout;
    if (t.attendance !== null && t.attendance > 0) {
      m.attendance += t.attendance;
      m.attendedSales += t.revenue;
      m.attendedNet += t.revenue - t.payout;
      m.attendedEvents += 1;
      m.totalCapacity += maxAttendanceFor(e.location_id, ctx.locations);
    }
    for (const c of t.categories) {
      const cur = m.categories.get(c.key)
        ?? { key: c.key, name: c.name, revenue: 0, payout: 0,
             showRpa: c.showRpa, showMargin: c.showMargin };
      cur.revenue += c.revenue;
      cur.payout += c.payout;          // already absolute, see model.categoryRollup
      m.categories.set(c.key, cur);
    }
  }

  m.netSales = m.totalSales - m.totalPayouts;
  // Every derived figure returns null rather than dividing by zero. SAR 1.0
  // renders $NaN for a month with no sessions; a dash is the honest answer.
  m.margin = m.totalSales > 0 ? m.netSales / m.totalSales : null;
  m.rpa = m.attendance > 0 ? m.attendedSales / m.attendance : null;
  m.attendancePercent = m.totalCapacity > 0 ? m.attendance / m.totalCapacity : null;
  m.salesPerEvent = m.eventCount > 0 ? m.totalSales / m.eventCount : null;
  m.payoutsPerEvent = m.eventCount > 0 ? m.totalPayouts / m.eventCount : null;
  m.profitPerEvent = m.eventCount > 0 ? m.netSales / m.eventCount : null;
  m.attendancePerEvent = m.attendedEvents > 0 ? m.attendance / m.attendedEvents : null;
  m.netPerAttendee = m.attendance > 0 ? m.attendedNet / m.attendance : null;
  m.payoutRatio = m.totalSales > 0 ? m.totalPayouts / m.totalSales : null;
  // "Daily average" in SAR 1.0 divides by a flat 30, not by days elapsed.
  m.dailyNet = m.netSales / 30;
  m.dailyAttendance = m.attendance / 30;
  m.categoryList = [...m.categories.values()];
  return m;
}

/** Group sessions into months or quarters, oldest first. */
export function buildPeriods(events, ctx, { hall = 'all', mode = 'monthly' } = {}) {
  const bucket = new Map();

  for (const e of events) {
    if (hall !== 'all' && e.location_id !== hall) continue;
    const y = e.event_date.slice(0, 4);
    const mo = Number(e.event_date.slice(5, 7));
    const key = mode === 'quarterly'
      ? `${y}-Q${Math.floor((mo - 1) / 3) + 1}`
      : e.event_date.slice(0, 7);
    const label = mode === 'quarterly'
      ? `Q${Math.floor((mo - 1) / 3) + 1} ${y}`
      : monthLabel(e.event_date.slice(0, 7));
    const b = bucket.get(key) ?? { key, label, events: [] };
    b.events.push(e);
    bucket.set(key, b);
  }

  const nowKey = (() => {
    const [y, mo] = hallToday().split('-').map(Number);
    return mode === 'quarterly'
      ? `${y}-Q${Math.floor((mo - 1) / 3) + 1}`
      : `${y}-${String(mo).padStart(2, '0')}`;
  })();

  return [...bucket.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))          // oldest first
    .map((b) => ({ ...b, inProgress: b.key === nowKey, metrics: periodMetrics(b.events, ctx) }));
}

/* ---------------------------------------------------------------------------
   Change indicators — SPEC §8a.4 and §8a.5
--------------------------------------------------------------------------- */

/**
 * Percentage change, or null when there is no usable baseline.
 *
 * A previous value of zero yields null — not an infinite gain. SAR 1.0 does
 * the same and omits the indicator entirely.
 */
export function percentChange(current, previous) {
  if (previous === null || previous === undefined || previous === 0) return null;
  if (current === null || current === undefined || !Number.isFinite(current)) return null;
  return (current - previous) / previous;
}

/** Difference in percentage POINTS, for figures that are already rates. */
export function pointChange(current, previous) {
  if (current === null || previous === null
      || current === undefined || previous === undefined) return null;
  return current - previous;
}

/**
 * Which comparisons a period may show.
 *
 * SPEC §8a.5: for a month still in progress, the ABSOLUTE totals are
 * suppressed — a third of a month against a whole one is meaningless. The
 * RATES stay, because they remain valid mid-month.
 */
export function changesFor(period, prior) {
  if (!prior) return {};
  const a = period.metrics; const b = prior.metrics;
  const c = {
    margin: pointChange(a.margin, b.margin),
    attendancePercent: pointChange(a.attendancePercent, b.attendancePercent),
    rpa: percentChange(a.rpa, b.rpa),
    attendance: percentChange(a.attendance, b.attendance),
    profitPerEvent: percentChange(a.profitPerEvent, b.profitPerEvent),
    totalSales: percentChange(a.totalSales, b.totalSales),
    totalPayouts: percentChange(a.totalPayouts, b.totalPayouts),
    netSales: percentChange(a.netSales, b.netSales),
  };
  // Per-category share of sales, in POINTS. SAR 1.0 computes this as
  // `percentOfSales` and shows it on each line of the collapsed Products box.
  // Guarded: a period built without categories must not throw. A missing
  // breakdown means no share comparison, not a broken screen.
  c.categoryShare = {};
  for (const cat of a.categoryList ?? []) {
    const now = a.totalSales > 0 ? cat.revenue / a.totalSales : null;
    const prev = b.categories?.get?.(cat.key);
    const was = (prev && b.totalSales > 0) ? prev.revenue / b.totalSales : null;
    c.categoryShare[cat.key] = pointChange(now, was);
  }

  if (period.inProgress) {
    c.totalSales = null;
    c.totalPayouts = null;
    c.netSales = null;
    c.attendance = null;
  }
  return c;
}

function changeTag(change, { points = false, invert = false } = {}) {
  if (change === null || change === undefined || !Number.isFinite(change)) return '';
  const dir = change > 0 ? 1 : change < 0 ? -1 : 0;
  const good = invert ? -dir : dir;
  const tone = dir === 0 ? 'flat' : (good > 0 ? 'up' : 'down');
  const glyph = dir > 0 ? '↑' : dir < 0 ? '↓' : '→';
  const shown = points
    ? `${Math.abs(change * 100).toFixed(1)}pp`
    : `${Math.abs(change * 100).toFixed(1)}%`;
  return `<span class="rp-change rp-${tone}">${glyph} ${shown}</span>`;
}

/* ---------------------------------------------------------------------------
   The eight boxes — SPEC §8a.3
--------------------------------------------------------------------------- */

function row(label, value) {
  return `<div class="rp-row"><span>${esc(label)}</span><span>${value}</span></div>`;
}

function boxes(p, changes) {
  const m = p.metrics;
  const cats = m.categoryList;

  return [
    {
      id: 'total-sales', tone: 'sales', label: 'Total Sales',
      value: usd(m.totalSales), change: changeTag(changes.totalSales),
      detail: [
        ...cats.map((c) => row(c.name, usd(c.revenue))),
        row('Avg/Session', usd(m.salesPerEvent)),
      ],
    },
    {
      id: 'total-payouts', tone: 'payouts', label: 'Total Payouts',
      value: usd(m.totalPayouts),
      change: changeTag(changes.totalPayouts, { invert: true }),
      detail: [
        ...cats.map((c) => row(c.name, usd(c.payout))),
        row('Payout %', pct(m.payoutRatio)),
        row('Avg/Session', usd(m.payoutsPerEvent)),
      ],
    },
    {
      id: 'net-sales', tone: 'net', label: 'Net Sales',
      value: usd(m.netSales), change: changeTag(changes.netSales),
      detail: [
        row('Total Sales', usd(m.totalSales)),
        row('Total Payouts', usd(m.totalPayouts)),
        row('Margin', pct(m.margin)),
        row('Avg/Session', usd(m.profitPerEvent)),
        row('Daily average', usd(m.dailyNet)),
      ],
    },
    {
      id: 'products', tone: 'products', label: 'Products',
      // Collapsed, this is a LIST — each category's share of sales with its
      // change in points. Not a count. Categories that show neither RPA nor
      // margin are omitted from the summary, exactly as SAR 1.0 filters on
      // `show_rpa || show_margin`; they still appear in the expansion.
      value: cats.filter((c) => c.showRpa || c.showMargin).map((c) => `
        <div class="rp-share">
          <span>${esc(c.name)}</span>
          <span>${pct(m.totalSales > 0 ? c.revenue / m.totalSales : null)}
            ${changeTag(changes.categoryShare?.[c.key], { points: true })}</span>
        </div>`).join(''),
      isList: true,
      detail: cats.map((c) => {
        const net = c.revenue - c.payout;
        const margin = c.revenue > 0 ? net / c.revenue : null;
        const share = m.totalSales > 0 ? c.revenue / m.totalSales : null;
        return `<div class="rp-prod">
          <div class="rp-prod-name">${esc(c.name)}</div>
          ${row('Sales', usd(c.revenue))}
          ${row('Payouts', usd(c.payout))}
          ${row('Net', usd(net))}
          ${row('Margin', pct(margin))}
          ${row('Share of sales', pct(share))}
        </div>`;
      }),
    },
    {
      id: 'margin', tone: 'margin', label: 'Margin',
      value: pct(m.margin), change: changeTag(changes.margin, { points: true }),
      detail: [
        row('Net Sales', usd(m.netSales)),
        row('Total Sales', usd(m.totalSales)),
        row('Total Payouts', usd(m.totalPayouts)),
        row('Payout %', pct(m.payoutRatio)),
        row('Net per session', usd(m.profitPerEvent)),
      ],
    },
    {
      id: 'rpa', tone: 'rpa', label: 'RPA',
      value: usd2(m.rpa), change: changeTag(changes.rpa),
      detail: [
        row('Total Sales', usd(m.totalSales)),
        row('Total Attendance', int(m.attendance)),
        ...cats.map((c) => row(`${c.name}/att`,
          m.attendance > 0 ? usd2(c.revenue / m.attendance) : DASH)),
        row('Net/att', usd2(m.netPerAttendee)),
      ],
    },
    {
      id: 'profit-event', tone: 'profit', label: 'Profit/Session',
      value: usd(m.profitPerEvent), change: changeTag(changes.profitPerEvent),
      detail: [
        row('Net Sales', usd(m.netSales)),
        row('Total sessions', int(m.eventCount)),
        row('Gross/session', usd(m.salesPerEvent)),
        row('Payouts/session', usd(m.payoutsPerEvent)),
        row('Avg attendance', m.attendancePerEvent === null
          ? DASH : int(m.attendancePerEvent)),
      ],
    },
    {
      id: 'attendance', tone: 'attendance', label: 'Attendance',
      value: pct(m.attendancePercent),
      change: changeTag(changes.attendancePercent, { points: true }),
      detail: [
        row('Total attendance', int(m.attendance)),
        row('Total capacity', int(m.totalCapacity)),
        row('Total sessions', int(m.eventCount)),
        row('Avg/session', m.attendancePerEvent === null ? DASH : int(m.attendancePerEvent)),
        row('Daily average', int(m.dailyAttendance)),
        // SAR 1.0 prints "RPA" and "Total Sales/Att" as separate rows. They
        // are the same quantity — gross over attendance — so one is shown and
        // the duplicate is dropped rather than reproduced.
        row('RPA', usd2(m.rpa)),
      ],
    },
  ];
}

function periodColumn(p, changes, expanded, onToggle) {
  const col = h('div', `rp-col${p.inProgress ? ' is-partial' : ''}`);

  const head = h('div', 'rp-head');
  head.innerHTML = `
    <div class="rp-month">${esc(p.label)}</div>
    <div class="rp-count">${int(p.metrics.eventCount)}
      session${p.metrics.eventCount === 1 ? '' : 's'}${
        p.inProgress ? ' <span class="rp-partial">in progress</span>' : ''}</div>`;
  col.append(head);

  for (const b of boxes(p, changes)) {
    const key = `${p.key}:${b.id}`;
    const open = expanded.has(key);
    const box = h('button', `rp-box rp-${b.tone}${open ? ' is-open' : ''}`);
    box.type = 'button';
    box.setAttribute('aria-expanded', String(open));
    box.innerHTML = `
      <div class="rp-box-label">${esc(b.label)}</div>
      <div class="${b.isList ? 'rp-box-list' : 'rp-box-value'}">${b.value}</div>
      ${b.change ?? ''}
      <div class="rp-detail"${open ? '' : ' hidden'}>${b.detail.join('')}</div>`;
    box.addEventListener('click', () => onToggle(key));
    col.append(box);
  }
  return col;
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

/** Expanded boxes persist across re-renders within a visit. */
const expanded = new Set();

export function renderReporting({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const mode = params.mode === 'quarterly' ? 'quarterly' : 'monthly';
  const hall = params.hall ?? 'all';

  /* ---- controls ---- */
  const bar = h('div', 'filter-bar');
  for (const m of [['monthly', 'Monthly'], ['quarterly', 'Quarterly']]) {
    const b = h('button', `chip${mode === m[0] ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = m[1];
    b.addEventListener('click', () => onNavigate('reporting', { ...params, mode: m[0] }));
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  for (const l of [{ id: 'all', name: 'Both halls' }, ...data.locations]) {
    const b = h('button', `chip${hall === l.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l.name;
    b.addEventListener('click', () => onNavigate('reporting', { ...params, hall: l.id }));
    bar.append(b);
  }
  root.append(bar);

  const periods = buildPeriods(data.events, data, { hall, mode });

  if (!periods.length) {
    root.append(h('div', 'placeholder',
      `<p class="semi">No sessions recorded</p>
       <p class="dim">Nothing to report for ${hall === 'all' ? 'either hall' : 'this hall'}.</p>`));
    return root;
  }

  /* ---- the scrolling strip ---- */
  const frame = h('div', 'rp-frame');
  const strip = h('div', 'rp-strip');

  // Start at the most recent, matching SAR 1.0: the last four columns with two
  // more visible to their left.
  let offset = Math.max(0, periods.length - MONTHS_PER_VIEW - 2);

  const paint = () => {
    strip.replaceChildren(...periods.map((p, i) =>
      periodColumn(p, changesFor(p, periods[i - 1] ?? null), expanded, (key) => {
        // Toggling re-renders only this column, so the strip does not jump.
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        play('expand');
        paint();
      })));
    strip.style.transform = `translateX(${-offset * COLUMN_STEP}px)`;
  };

  const nav = (dir) => {
    // SAR 1.0 allows scrolling right until only the last two columns remain
    // visible (`totalColumns - 2`), which is further than `total - perView`.
    // Matching it, or the newest months cannot be brought fully into view.
    // Its LEFT bound of -2 is deliberately not copied: that scrolls into empty
    // space beside the oldest column, which is a defect, not a feature.
    const max = Math.max(0, periods.length - 2);
    offset = Math.min(max, Math.max(0, offset + dir));
    strip.style.transform = `translateX(${-offset * COLUMN_STEP}px)`;
    play('scroll');
  };

  const header = h('div', 'rp-header');
  const left = h('button', 'rp-arrow', '←');
  left.type = 'button'; left.title = 'Earlier';
  left.addEventListener('click', () => nav(-1));
  const right = h('button', 'rp-arrow', '→');
  right.type = 'button'; right.title = 'Later';
  right.addEventListener('click', () => nav(1));
  header.append(left,
    h('h2', 'rp-title', mode === 'quarterly' ? 'Quarterly reporting' : 'Monthly reporting'),
    right);
  root.append(header);

  paint();
  frame.append(strip);
  root.append(frame);

  /* ---- inspector ---- */
  const latest = periods[periods.length - 1];
  const complete = periods.filter((p) => !p.inProgress);
  const totalSessions = periods.reduce((s, p) => s + p.metrics.eventCount, 0);

  setInspectorContent?.(`
    <p class="semi">${mode === 'quarterly' ? 'Quarterly' : 'Monthly'} reporting</p>
    <p class="muted">${esc(hall === 'all' ? 'Both halls'
      : data.locations.find((l) => l.id === hall)?.name ?? '')} ·
      ${periods.length} ${mode === 'quarterly' ? 'quarters' : 'months'}</p>
    <p class="inspector-section-label">Latest — ${esc(latest.label)}</p>
    <dl class="inspector-filters">
      <dt>Sessions</dt><dd>${int(latest.metrics.eventCount)}</dd>
      <dt>Total sales</dt><dd>${usd(latest.metrics.totalSales)}</dd>
      <dt>Net</dt><dd>${usd(latest.metrics.netSales)}</dd>
      <dt>Margin</dt><dd>${pct(latest.metrics.margin)}</dd>
      <dt>RPA</dt><dd>${usd2(latest.metrics.rpa)}</dd>
    </dl>
    <p class="inspector-section-label">All ${periods.length} periods</p>
    <dl class="inspector-filters">
      <dt>Sessions</dt><dd>${int(totalSessions)}</dd>
      <dt>Complete</dt><dd>${complete.length}</dd>
    </dl>
    ${latest.inProgress ? `<p class="dim">${esc(latest.label)} is still in progress.
      Its sales, payouts and net are shown but NOT compared against last
      ${mode === 'quarterly' ? 'quarter' : 'month'} — a partial period against a
      whole one is meaningless. Margin, RPA and attendance are rates, so those
      comparisons remain.</p>` : ''}
    <p class="inspector-section-label">Reading a column</p>
    <p class="muted">Every box opens. Sales and payouts break down by product
      category; the rest show what went into the figure. The session count in
      the header is the denominator of every per-session number below it.</p>`);

  return root;
}
