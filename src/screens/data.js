/* ============================================================================
   SAR 2.0 — Data view

   The sheet. Rows are metrics, columns are sessions — transposed, which is
   unusual for a web table and right here, because it is how the original
   spreadsheet reads and how the people using it think.

   Three sub-views: Daily, Monthly, Reconcile. See SAR2-DATA-DESIGN.md.

   RECONCILE IS NOT SAR 1.0's "DATA TEST". SAR 1.0 compares "Manual" against
   "Calc", but both sides are the same arithmetic over the same event metrics,
   so every money row shows a difference of exactly zero, always. A check that
   cannot fail is worse than no check. Ours compares the monthly summary's OWN
   STORED columns against the metric store, which is the comparison that
   matters and the one that currently fails. DESIGN §5.
   ========================================================================== */

import { metricsFor, sessionTotals, getMetric } from '../lib/model.js';
import { monthSeries, monthFull, monthKey, hallMatches } from '../lib/charts.js';
import { toCsv, csvMoney, csvPct, csvFilename, download } from '../lib/csv.js';
import { usd, int, pct, weekday, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const VIEWS = [
  { id: 'daily', label: 'Daily' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'reconcile', label: 'Reconcile' },
];

/**
 * Spreadsheet column letters: A…Z, AA, AB…
 *
 * SAR 1.0 uses `String.fromCharCode(65 + i)`, which emits `[`, `\`, `]` past
 * column 26. Santa Clara has 558 sessions, so that is nearly every column.
 */
export function columnLetter(i) {
  let n = i; let s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/* ---------------------------------------------------------------------------
   Rows — DESIGN §2
--------------------------------------------------------------------------- */

const SPACER = { key: null, label: '', format: 'blank' };

/** Metric defs of a type, in display order. */
const defsOf = (defs, type) => defs
  .filter((d) => d.metric_type === type && d.is_active !== false)
  .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

/**
 * The row list.
 *
 * Sales and payout rows are limited to metrics assigned to a product category;
 * attendance and hotball are not. That asymmetry is SAR 1.0's and it is
 * deliberate — it means Total Sales is exactly the sum of the sales rows on
 * screen, so a reader can add the column up and get the total.
 */
export function sheetRows(ctx, view = 'daily') {
  const defs = ctx.metricDefs ?? [];
  const cats = ctx.categories ?? [];
  const inCategory = new Set(cats.flatMap((c) => [...(c.revenue_keys ?? []), ...(c.payout_keys ?? [])]));
  const money = (d) => ({ key: d.key, label: d.display_name ?? d.key, format: 'money' });

  const rows = [{ key: '_location', label: 'Location', format: 'text' }];

  if (view === 'daily') {
    rows.push({ key: '_date', label: 'Date', format: 'text' },
              { key: '_day', label: 'Day', format: 'text' });
  } else {
    rows.push({ key: '_date', label: 'Month', format: 'text' },
              { key: '_events', label: 'Events', format: 'integer' });
  }

  for (const d of defsOf(defs, 'attendance')) {
    rows.push({ key: d.key, label: d.display_name ?? d.key, format: 'integer' });
  }
  rows.push(SPACER);

  for (const d of defsOf(defs, 'sales')) if (inCategory.has(d.key)) rows.push(money(d));
  rows.push({ key: '_totalSales', label: 'Total Sales', format: 'money', bold: true }, SPACER);

  for (const d of defsOf(defs, 'payout')) if (inCategory.has(d.key)) rows.push(money(d));
  rows.push({ key: '_totalPayouts', label: 'Total Payouts', format: 'money', bold: true }, SPACER);

  rows.push({ key: '_net', label: 'Net Sales', format: 'money', bold: true },
            { key: '_margin', label: 'Margin %', format: 'percent' }, SPACER);

  for (const d of defsOf(defs, 'hotball')) rows.push(money(d));

  if (view !== 'daily') {
    rows.push({ key: '_rpa', label: 'RPA', format: 'money' },
              { key: '_payoutPct', label: 'Payout %', format: 'percent' });
    for (const c of cats) {
      rows.push({ key: `_cat_${c.key}`, label: `${c.display_name} %`, format: 'percent' },
                { key: `_catpay_${c.key}`, label: `${c.display_name} Payout %`, format: 'percent' });
    }
  }
  return rows;
}

/* ---------------------------------------------------------------------------
   Columns — DESIGN §3
--------------------------------------------------------------------------- */

/** `8/6/2026`, unpadded, as SAR 1.0 — people read these against paper sheets. */
export function dayHeader(date, type) {
  const [y, m, d] = date.split('-').map(Number);
  const base = `${m}/${d}/${y}`;
  // SAR 1.0 suffixes only `late`, so an `early` session gets a header identical
  // to the regular session on the same date — two indistinguishable columns.
  if (type === 'late') return `${base} PM`;
  if (type === 'early') return `${base} AM`;
  return base;
}

export function dailyColumns(data, { hall = 'all', from = null, to = null } = {}) {
  return data.events
    .filter((e) => hallMatches(hall, e.location_id)
      && (!from || e.event_date >= from) && (!to || e.event_date <= to))
    .sort((a, b) => (a.event_date === b.event_date
      ? String(a.event_type).localeCompare(String(b.event_type))
      : (a.event_date < b.event_date ? 1 : -1)))          // newest first
    .map((e) => {
      const m = metricsFor(e.id, data.metrics, data.idx);
      const t = sessionTotals(m, data.categories);
      return {
        key: e.id, header: dayHeader(e.event_date, e.event_type), event: e,
        metrics: m, totals: t,
        location: data.locations.find((l) => l.id === e.location_id)?.name ?? '',
        // The spreadsheet's own reported total against its line items. Fails on
        // 8 of 285 sessions in 2026 — the same check the Paymaster is scored on.
        sourceSales: getMetric(m, 'source_total_sales'),
      };
    });
}

export function monthlyColumns(data, { hall = 'all', from = null, to = null } = {}) {
  const rows = monthSeries(data.events, data, { hall });
  return rows
    .filter((r) => (!from || r.key >= from.slice(0, 7)) && (!to || r.key <= to.slice(0, 7)))
    .reverse()                                            // newest first, as Daily
    .map((r) => ({ key: r.key, header: monthFull(r.key), month: r }));
}

/* ---------------------------------------------------------------------------
   Cells
--------------------------------------------------------------------------- */

/** Raw value for a row/column pair. Money stays in CENTS; nulls stay null. */
export function cellValue(row, col, view) {
  if (!row.key) return null;
  if (view === 'daily') {
    const { totals: t, event: e, metrics: m } = col;
    switch (row.key) {
      case '_location': return col.location;
      case '_date': return col.header;
      case '_day': return weekday(e.event_date) + (e.event_type !== 'regular' ? ` (${e.event_type})` : '');
      case '_totalSales': return t.revenue;
      case '_totalPayouts': return t.payout;
      case '_net': return t.net;
      case '_margin': return t.margin;
      default: return getMetric(m, row.key);
    }
  }
  const m = col.month;
  if (row.key.startsWith('_cat_')) {
    const c = m.categories.get(row.key.slice(5));
    return c && m.gross > 0 ? c.revenue / m.gross : null;
  }
  if (row.key.startsWith('_catpay_')) {
    const c = m.categories.get(row.key.slice(8));
    return c && m.gross > 0 ? c.payout / m.gross : null;
  }
  switch (row.key) {
    case '_location': return col.location ?? '';
    case '_date': return col.header;
    case '_events': return m.eventCount;
    case '_totalSales': return m.gross;
    case '_totalPayouts': return m.payout;
    case '_net': return m.net;
    case '_margin': return m.margin;
    case '_rpa': return m.rpa;
    case '_payoutPct': return m.gross > 0 ? m.payout / m.gross : null;
    default: return m.metricTotals?.[row.key] ?? null;
  }
}

/**
 * Display string. DESIGN §4.
 *
 * MISSING IS BLANK, not an em dash — the only screen in the project where that
 * rule is relaxed. Sixty rows by five hundred columns of dashes is unreadable;
 * blank is what a spreadsheet does.
 *
 * Zero renders as `$0` for money but BLANK for a percentage. That looks like an
 * inconsistency and is SAR 1.0's behaviour, kept: takings of zero can be real,
 * whereas a margin of exactly zero is almost always a missing input.
 */
export function formatCell(v, row) {
  if (v === null || v === undefined || v === '') return '';
  if (row.format === 'text' || typeof v === 'string') return String(v);
  if (!Number.isFinite(v)) return '';
  if (row.format === 'integer') return int(v);
  if (row.format === 'percent') return v === 0 ? '' : pct(v);
  // SAR 1.0 builds '$' + (-50) and renders "$-50". The sign belongs outside.
  return usd(v);
}

/* ---------------------------------------------------------------------------
   Reconcile — DESIGN §5
--------------------------------------------------------------------------- */

/**
 * The monthly summary's STORED columns against the metric store.
 *
 * `data.monthlySummary` is optional; without it the view says so rather than
 * printing a grid of zeroes.
 */
export function reconcile(data, { hall = 'all' } = {}) {
  const computed = monthSeries(data.events, data, { hall });
  const stored = data.monthlySummary ?? [];
  const byMonth = new Map();
  for (const s of stored) {
    if (!hallMatches(hall, s.location_id)) continue;
    const k = monthKey(s.month);
    const cur = byMonth.get(k) ?? { gross: 0, net: 0, events: 0, attendance: 0 };
    cur.gross += s.total_sales ?? 0;
    cur.net += s.net_sales ?? 0;
    cur.events += s.event_count ?? 0;
    cur.attendance += s.total_attendance ?? 0;
    byMonth.set(k, cur);
  }

  return computed.slice().reverse().map((m) => {
    const s = byMonth.get(m.key);
    const line = (label, storedV, computedV, format = 'money') => ({
      label, stored: storedV, computed: computedV, format,
      diff: storedV === null || storedV === undefined ? null : storedV - computedV,
    });
    return {
      key: m.key,
      header: monthFull(m.key),
      available: Boolean(s),
      lines: [
        line('Events', s?.events ?? null, m.eventCount, 'integer'),
        line('Attendance', s?.attendance ?? null, m.attendance, 'integer'),
        line('Total Sales', s?.gross ?? null, m.gross),
        line('Net Sales', s?.net ?? null, m.net),
      ],
    };
  });
}

/** More than a cent apart. */
export const differs = (d) => d !== null && d !== undefined && Math.abs(d) > 1;

/* ---------------------------------------------------------------------------
   Export — DESIGN §8
--------------------------------------------------------------------------- */

const exportValue = (v, row) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (row.format === 'percent') return csvPct(v);
  if (row.format === 'integer') return String(v);
  return csvMoney(v);
};

/** The sheet as shown: one row per metric. Values raw, money in dollars. */
export function sheetCsv(rows, cols, view) {
  const out = [['Row', 'Metric', ...cols.map((c) => c.header)]];
  rows.forEach((row, i) => {
    if (!row.key) { out.push([String(i + 1), '']); return; }
    out.push([String(i + 1), row.label,
      ...cols.map((c) => exportValue(cellValue(row, c, view), row))]);
  });
  return toCsv(out);
}

/**
 * The transpose: one row per session.
 *
 * SAR 1.0 contains this, fully written, wired to no button and marked "old
 * function - kept for compatibility". It is the more useful of the two for
 * anything downstream, so it gets a button. DESIGN §8.3.
 */
export function tableCsv(cols, categories, view) {
  const head = view === 'daily'
    ? ['Date', 'Day', 'Location', 'Session', 'Attendance',
       'Total Sales', 'Total Payouts', 'Net Sales', 'Margin %', 'RPA',
       ...categories.map((c) => `${c.display_name} Net`)]
    : ['Month', 'Events', 'Attendance', 'Total Sales', 'Total Payouts',
       'Net Sales', 'Margin %', 'RPA', ...categories.map((c) => `${c.display_name} Net`)];
  const out = [head];

  for (const c of cols) {
    if (view === 'daily') {
      const t = c.totals; const e = c.event;
      out.push([e.event_date, weekday(e.event_date), c.location, e.event_type,
        t.attendance ?? '', csvMoney(t.revenue), csvMoney(t.payout), csvMoney(t.net),
        csvPct(t.margin), csvMoney(t.rpa),
        ...categories.map((k) => csvMoney(t.categories.find((x) => x.key === k.key)?.revenue
          - (t.categories.find((x) => x.key === k.key)?.payout ?? 0)))]);
    } else {
      const m = c.month;
      out.push([m.key, m.eventCount, m.attendance, csvMoney(m.gross), csvMoney(m.payout),
        csvMoney(m.net), csvPct(m.margin), csvMoney(m.rpa),
        ...categories.map((k) => csvMoney(m.categories.get(k.key)?.net ?? null))]);
    }
  }
  return toCsv(out);
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderData({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const view = VIEWS.find((v) => v.id === params.view)?.id ?? 'daily';
  const hall = params.hall ?? 'all';
  const from = params.from ?? null;
  const to = params.to ?? null;
  const hallName = hall === 'all' ? 'All halls'
    : data.locations.find((l) => l.id === hall)?.name ?? hall;

  const bar = h('div', 'filter-bar');
  for (const v of VIEWS) {
    const b = h('button', `chip${v.id === view ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = v.label;
    b.addEventListener('click', () => { play('select'); onNavigate('data', { ...params, view: v.id }); });
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  for (const l of [{ id: 'all', name: 'All halls' }, ...data.locations]) {
    const b = h('button', `chip${hall === l.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l.name;
    b.addEventListener('click', () => onNavigate('data', { ...params, hall: l.id }));
    bar.append(b);
  }
  if (view !== 'reconcile') {
    // DATA-DESIGN §6: a date range. Read from params already; now it has inputs.
    bar.append(h('span', 'filter-sep'));
    const range = h('span', 'date-range');
    range.innerHTML = '<label>From <input type="date" data-k="from"></label>'
      + '<label>To <input type="date" data-k="to"></label>';
    for (const input of range.querySelectorAll('input')) {
      const k = input.dataset.k;
      input.value = (k === 'from' ? from : to) ?? '';
      if (input.value) input.setAttribute('value', input.value);
      input.addEventListener('change', () => onNavigate('data', { ...params, [k]: input.value || undefined }));
    }
    bar.append(range);
    if (from || to) {
      const clear = h('button', 'chip');
      clear.type = 'button'; clear.textContent = 'All dates';
      clear.addEventListener('click', () => onNavigate('data', { ...params, from: undefined, to: undefined }));
      bar.append(clear);
    }
  }
  root.append(bar);

  const panel = h('section', 'panel');

  if (view === 'reconcile') {
    panel.append(h('h3', 'panel-title', 'Reconcile'));
    panel.append(h('div', 'mg-notice', `
      <strong>Stored against computed.</strong> The left figure is what
      <code>analytics_monthly_summary</code> holds; the right is the metric store
      rolled up through the product categories. SAR 1.0's version compares the
      metric store against itself, so it can only ever show zero.`));
    const rec = reconcile(data, { hall });
    if (!rec.length || !rec.some((r) => r.available)) {
      panel.append(h('div', 'placeholder',
        '<p class="semi">The monthly summary is not loaded</p>'
        + '<p class="dim">Nothing to compare against.</p>'));
    } else {
      const t = h('table', 'rn-table sheet');
      t.innerHTML = `<thead><tr><th>Month</th><th>Figure</th>
        <th class="num">Stored</th><th class="num">Computed</th>
        <th class="num">Difference</th></tr></thead><tbody></tbody>`;
      const body = t.querySelector('tbody');
      for (const r of rec) {
        for (const l of r.lines) {
          const bad = differs(l.diff);
          const f = (v) => (v === null || v === undefined ? ''
            : l.format === 'integer' ? int(v) : usd(v));
          body.insertAdjacentHTML('beforeend', `<tr>
            <td>${l === r.lines[0] ? r.header : ''}</td>
            <td>${l.label}</td>
            <td class="num">${f(l.stored)}</td>
            <td class="num">${f(l.computed)}</td>
            <td class="num ${bad ? 'st-poor' : 'dim'}">${
              l.diff === null ? '' : bad ? f(l.diff) : 'matches'}</td></tr>`);
        }
      }
      panel.append(t);
    }
    root.append(panel);
    setInspectorContent?.('<p class="semi">Reconcile</p><p class="muted">Stored monthly'
      + ' summary against the metric store.</p>');
    return root;
  }

  const rows = sheetRows(data, view);
  const cols = view === 'daily'
    ? dailyColumns(data, { hall, from, to })
    : monthlyColumns(data, { hall, from, to });

  panel.append(h('h3', 'panel-title',
    `${VIEWS.find((v) => v.id === view).label} · ${hallName}`));

  const tools = h('div', 'filter-bar');
  const sheetBtn = h('button', 'chip');
  sheetBtn.type = 'button';
  sheetBtn.textContent = 'Export sheet (rows are metrics)';
  sheetBtn.addEventListener('click', () => download(
    csvFilename({ view, hall: hallName }), sheetCsv(rows, cols, view)));
  const tableBtn = h('button', 'chip');
  tableBtn.type = 'button';
  tableBtn.textContent = 'Export table (rows are sessions)';
  tableBtn.addEventListener('click', () => download(
    csvFilename({ view: `${view}-table`, hall: hallName }),
    tableCsv(cols, data.categories, view)));
  tools.append(sheetBtn, tableBtn);
  panel.append(tools);

  if (!cols.length) {
    panel.append(h('div', 'placeholder', '<p class="semi">No sessions match these filters</p>'));
    root.append(panel);
    return root;
  }

  const scroll = h('div', 'sheet-scroll');
  const table = h('table', 'sheet');
  table.innerHTML = `<thead>
    <tr><th class="sheet-num"></th><th class="sheet-label"></th>${
      cols.map((_, i) => `<th class="num">${columnLetter(i)}</th>`).join('')}</tr>
    <tr><th class="sheet-num">#</th><th class="sheet-label">Metric</th>${
      cols.map((c) => `<th class="num sheet-head">${c.header}</th>`).join('')}</tr>
    </thead><tbody></tbody>`;

  const body = table.querySelector('tbody');
  rows.forEach((row, i) => {
    const tr = h('tr', row.bold ? 'is-bold' : (row.key ? '' : 'is-spacer'));
    tr.innerHTML = `<td class="sheet-num">${i + 1}</td>
      <td class="sheet-label">${row.label}</td>${
      cols.map((c) => {
        const v = cellValue(row, c, view);
        // The spreadsheet's own total against its line items — a real check
        // that fails on 8 of 285 sessions in 2026.
        const flag = view === 'daily' && row.key === '_totalSales'
          && c.sourceSales !== null && Math.abs(c.sourceSales - c.totals.revenue) > 100;
        return `<td class="num${flag ? ' sheet-flag' : ''}"${
          flag ? ` title="Sheet total ${usd(c.sourceSales)}, line items ${usd(c.totals.revenue)}"` : ''
        }>${formatCell(v, row)}${flag ? ' ⚠' : ''}</td>`;
      }).join('')}`;
    body.append(tr);
  });

  // The header names the session; clicking it opens that night. SAR 1.0 has a
  // console.log stub where this was intended and never wired.
  if (view === 'daily') {
    table.querySelectorAll('thead tr:last-child th.sheet-head').forEach((th, i) => {
      // Focusable and operable by keyboard. A bare click handler on a <th> is
      // invisible to anyone not using a mouse.
      th.classList.add('is-clickable');
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      th.setAttribute('aria-label', `Open the session on ${cols[i].header}`);
      const go = () => onNavigate('session', { id: cols[i].key });
      th.addEventListener('click', go);
      th.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
      });
    });
  }

  scroll.append(table);
  panel.append(scroll);
  panel.append(h('p', 'muted', `${rows.filter((r) => r.key).length} metrics × ${cols.length} ${
    view === 'daily' ? 'sessions' : 'months'}. Newest first.`));
  root.append(panel);

  setInspectorContent?.(`
    <p class="semi">${VIEWS.find((v) => v.id === view).label}</p>
    <p class="muted">${hallName} · ${cols.length} columns</p>
    <p class="inspector-section-label">Reading the sheet</p>
    <p class="muted">Rows are metrics and columns are sessions, as the original
      spreadsheet reads. Total Sales is exactly the sum of the sales rows shown,
      so a column adds up.</p>
    <p class="inspector-section-label">Blank cells</p>
    <p class="muted">A blank means the metric was not recorded. Zero is printed
      as $0, because takings of nothing can be real. A margin of exactly zero
      prints blank, because it almost never is.</p>
    <p class="inspector-section-label">Export</p>
    <p class="muted">Both exports carry the filters on screen and write raw
      numbers, in dollars, for a spreadsheet to sum.</p>`);

  return root;
}
