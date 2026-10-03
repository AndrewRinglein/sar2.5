/* ============================================================================
   SAR 2.0 — U10, Monthly P&L

   A month-by-month ladder from gross sales down to bingo contribution.

   IT STOPS AT CONTRIBUTION, DELIBERATELY.
   There is no expense data in production — `monthly_expenses` does not exist
   in `bms-production`; the figures live in a spreadsheet outside the system.
   So the ladder shows what the database can actually support, and says
   plainly where it stops. Rendering an expense ladder full of zeros would
   read as "we spent nothing", which is worse than an empty row.

   Partial months are excluded from trend comparison and marked.
   A month one third elapsed looks like a collapse otherwise — SPEC §19
   records a fake −67% that came from exactly this.
   ========================================================================== */

import { metricsFor, sessionTotals, delta } from '../lib/model.js';
import { usd, usdShort, pct, pctDelta, int, arrow, monthLabel, esc, DASH } from '../lib/fmt.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/** Group sessions into months, flagging the one still in progress. */
export function monthlyRollup(events, metrics, idx, categories, { hall = 'all', today = null } = {}) {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const currentMonth = now.slice(0, 7);
  const byMonth = new Map();

  for (const e of events) {
    if (hall !== 'all' && e.location_id !== hall) continue;
    const key = e.event_date.slice(0, 7);
    const t = sessionTotals(metricsFor(e.id, metrics, idx), categories);
    const m = byMonth.get(key) ?? {
      month: key, sessions: 0, revenue: 0, payout: 0, net: 0, attendance: 0,
      byCategory: new Map(), partial: key === currentMonth,
    };
    m.sessions += 1;
    m.revenue += t.revenue;
    m.payout += t.payout;
    m.net += t.net;
    m.attendance += t.attendance ?? 0;
    for (const c of t.categories) {
      const cur = m.byCategory.get(c.key) ?? { key: c.key, name: c.name, revenue: 0, payout: 0, net: 0 };
      cur.revenue += c.revenue; cur.payout += c.payout; cur.net += c.net;
      m.byCategory.set(c.key, cur);
    }
    byMonth.set(key, m);
  }

  return [...byMonth.values()]
    .map((m) => ({
      ...m,
      categories: [...m.byCategory.values()],
      margin: m.revenue > 0 ? m.net / m.revenue : null,
      rpa: m.attendance > 0 ? m.revenue / m.attendance : null,
    }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));      // newest first
}

export function renderMonthlyPL({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const hall = params.hall ?? 'all';

  const bar = h('div', 'filter-bar');
  for (const l of [{ id: 'all', name: 'Both halls' }, ...data.locations]) {
    const b = h('button', `chip${hall === l.id ? ' is-active' : ''}`);
    b.type = 'button';
    b.textContent = l.name;
    b.addEventListener('click', () => onNavigate('monthly-pl', { ...params, hall: l.id }));
    bar.append(b);
  }
  root.append(bar);

  const months = monthlyRollup(data.events, data.metrics, data.idx, data.categories, { hall });

  if (!months.length) {
    root.append(h('div', 'placeholder', '<p class="semi">No sessions recorded</p>'));
    return root;
  }

  /* ---- the ladder, newest complete month ---- */
  const complete = months.filter((m) => !m.partial);
  const latest = complete[0] ?? months[0];
  const prior = complete[1] ?? null;

  const ladder = h('section', 'panel');
  ladder.append(h('h3', 'panel-title',
    `${monthLabel(latest.month)}${latest.partial ? ' (in progress)' : ''}`));

  const rung = (label, value, note, tone) => `
    <tr>
      <td class="name">${esc(label)}</td>
      <td class="${tone ?? ''}">${usd(value)}</td>
      <td class="dim">${esc(note)}</td>
    </tr>`;

  const table = h('table', 'cat-table');
  table.innerHTML = `
    <thead><tr><th class="name">Line</th><th>Amount</th><th class="name">Note</th></tr></thead>
    <tbody>
      ${rung('Gross sales', latest.revenue, `${int(latest.sessions)} sessions`)}
      ${latest.categories.map((c) => `
        <tr><td class="name" style="padding-left:var(--s-5)">${esc(c.name)}</td>
            <td class="dim">${usd(c.revenue)}</td>
            <td class="dim">${pct(latest.revenue ? c.revenue / latest.revenue : null)} of gross</td></tr>`).join('')}
      ${rung('Payouts', -latest.payout,
             `${pct(latest.revenue ? latest.payout / latest.revenue : null)} of gross`, 'tone-neg')}
      ${rung('Bingo contribution', latest.net, `margin ${pct(latest.margin)}`)}
      <tr class="total-row">
        <td class="name">Operating expenses</td>
        <td class="dim">${DASH}</td>
        <td class="dim">not held in this database</td>
      </tr>
      <tr>
        <td class="name">Net profit</td>
        <td class="dim">${DASH}</td>
        <td class="dim">needs expenses</td>
      </tr>
    </tbody>`;
  ladder.append(table);
  ladder.append(h('p', 'dim',
    'The ladder stops at contribution. Operating expenses are not stored in '
    + 'this database — they live in the monthly workbook — so the rows below '
    + 'are shown empty rather than as zero. A zero would read as "nothing was spent".'));
  root.append(ladder);

  /* ---- month by month ---- */
  const hist = h('section', 'panel');
  hist.append(h('h3', 'panel-title', 'Month by month'));

  const t2 = h('table', 'cat-table');
  t2.innerHTML = `
    <thead><tr>
      <th class="name">Month</th><th>Sessions</th><th>Gross</th><th>Payouts</th>
      <th>Contribution</th><th>Margin</th><th>Attendance</th><th>Per head</th><th>vs prior</th>
    </tr></thead><tbody></tbody>`;
  const body = t2.querySelector('tbody');

  months.forEach((m, i) => {
    // Compare only complete month to complete month.
    const prevComplete = months.slice(i + 1).find((x) => !x.partial);
    const d = (!m.partial && prevComplete) ? delta(m.revenue, prevComplete.revenue) : null;
    body.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="name">${monthLabel(m.month)}${
          m.partial ? ' <span class="chip-inline">in progress</span>' : ''}</td>
        <td>${int(m.sessions)}</td>
        <td>${usd(m.revenue)}</td>
        <td>${usd(m.payout)}</td>
        <td class="${m.net < 0 ? 'tone-neg' : ''}">${usd(m.net)}</td>
        <td>${pct(m.margin)}</td>
        <td>${int(m.attendance)}</td>
        <td>${m.rpa === null ? DASH : usd(m.rpa)}</td>
        <td class="${d ? `tone-${d.tone}` : 'dim'}">${
          d ? `${arrow(d.dir)} ${pctDelta(d.relative)}`
            : (m.partial ? 'withheld' : DASH)}</td>
      </tr>`);
  });
  hist.append(t2);
  hist.append(h('p', 'dim',
    'A month still in progress is never compared against a complete one — '
    + 'a third of a month reads as a collapse otherwise.'));
  root.append(hist);

  /* ---- inspector ---- */
  const completeCount = complete.length;
  const avgMargin = completeCount
    ? complete.reduce((s, m) => s + (m.margin ?? 0), 0) / completeCount : null;

  setInspectorContent?.(`
    <p class="semi">Monthly P&amp;L</p>
    <p class="muted">${esc(hall === 'all' ? 'Both halls' : data.locations.find((l) => l.id === hall)?.name)}</p>
    <p class="inspector-section-label">${completeCount} complete months</p>
    <dl class="inspector-filters">
      <dt>Latest</dt><dd>${monthLabel(latest.month)}</dd>
      <dt>Gross</dt><dd>${usd(latest.revenue)}</dd>
      <dt>Contribution</dt><dd>${usd(latest.net)}</dd>
      <dt>Margin</dt><dd>${pct(latest.margin)}</dd>
      <dt>Mean margin</dt><dd>${pct(avgMargin)}</dd>
      ${prior ? `<dt>Prior month</dt><dd>${usdShort(prior.revenue)}</dd>` : ''}
    </dl>
    <p class="inspector-section-label">Why it stops at contribution</p>
    <p class="muted">Operating expenses are not in this database. They are
      kept in the monthly workbook, so the profit line cannot be computed here
      without importing them. Empty is honest; zero would not be.</p>`);

  return root;
}
