/* ============================================================================
   SAR 2.0 — U16, Venues & capacity

   The two halls side by side, and the schedule they are supposed to run
   against the sessions actually recorded.

   The expected schedule comes from `analytics_config.settings.expectedSchedules`
   — the tenant's own configuration — so a hall that quietly stops reporting is
   visible as a shortfall rather than as a smaller number nobody questions.
   ========================================================================== */

import { metricsFor, sessionTotals, mean, maxAttendanceFor } from '../lib/model.js';
import { usd, usd2, pct, int, monthLabel, esc, DASH } from '../lib/fmt.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dowOf = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getUTCDay();

/** Config keys halls by short code (SC / RWC); the database keys by UUID. */
function scheduleFor(config, hallName) {
  const s = config?.settings?.expectedSchedules ?? {};
  const code = hallName === 'Redwood City' ? 'RWC' : hallName === 'Santa Clara' ? 'SC' : null;
  return code ? s[code] ?? null : null;
}

/** Sessions a schedule implies across a date range. */
function expectedCount(schedule, from, to) {
  if (!schedule) return null;
  let n = 0;
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = schedule[DOW[d.getUTCDay()]];
    if (day) n += day.count ?? 1;
  }
  return n;
}

export function renderVenues({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');

  if (!data.events.length) {
    root.append(h('div', 'placeholder', '<p class="semi">No sessions recorded</p>'));
    return root;
  }

  const days = Number(params.days) || 90;
  const bar = h('div', 'filter-bar');
  for (const d of [30, 90, 365]) {
    const b = h('button', `chip${d === days ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = d === 365 ? '1 year' : `${d} days`;
    b.addEventListener('click', () => onNavigate('venues', { ...params, days: String(d) }));
    bar.append(b);
  }
  root.append(bar);

  const latest = data.events[0].event_date;
  const to = new Date(`${latest}T00:00:00Z`);
  const from = new Date(to.getTime() - days * 86400000);
  const fromStr = from.toISOString().slice(0, 10);

  const rows = data.locations.map((loc) => {
    const evs = data.events.filter((e) => e.location_id === loc.id
      && e.event_date >= fromStr && e.event_date <= latest);
    const totals = evs.map((e) => sessionTotals(metricsFor(e.id, data.metrics, data.idx), data.categories));
    const revenue = totals.reduce((s, t) => s + t.revenue, 0);
    const net = totals.reduce((s, t) => s + t.net, 0);
    const attendance = totals.reduce((s, t) => s + (t.attendance ?? 0), 0);
    const withAtt = totals.filter((t) => t.attendance > 0);
    const schedule = scheduleFor(data.config, loc.name);
    const expected = expectedCount(schedule, new Date(from), to);
    const seats = maxAttendanceFor(loc.id, data.locations);

    return {
      loc, sessions: evs.length, expected, schedule,
      revenue, net, attendance,
      margin: revenue > 0 ? net / revenue : null,
      rpa: attendance > 0 ? revenue / attendance : null,
      perSession: evs.length ? revenue / evs.length : null,
      meanAttendance: withAtt.length ? mean(withAtt.map((t) => t.attendance)) : null,
      // Revenue per available seat — the hotel metric, applied to a hall.
      seats,
      revpas: (evs.length && seats) ? revenue / (evs.length * seats) : null,
      utilisation: withAtt.length ? mean(withAtt.map((t) => t.attendance)) / seats : null,
    };
  });

  /* ---- side by side ---- */
  const grid = h('div', 'venue-grid');
  for (const r of rows) {
    const shortfall = r.expected !== null ? r.expected - r.sessions : null;
    const card = h('section', 'panel');
    card.innerHTML = `
      <h3 class="panel-title">${esc(r.loc.name)}</h3>
      <dl class="jp-stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <dt>Gross</dt><dd>${usd(r.revenue)}</dd>
        <dt>Contribution</dt><dd>${usd(r.net)}</dd>
        <dt>Margin</dt><dd>${pct(r.margin)}</dd>
        <dt>Sessions</dt><dd>${int(r.sessions)}${
          r.expected !== null ? ` <span class="dim">of ${int(r.expected)} scheduled</span>` : ''}</dd>
        <dt>Per session</dt><dd>${usd(r.perSession)}</dd>
        <dt>Per head</dt><dd>${usd2(r.rpa)}</dd>
        <dt>Mean attendance</dt><dd>${r.meanAttendance === null ? DASH : int(r.meanAttendance)}</dd>
        <dt>Capacity used</dt><dd>${pct(r.utilisation)}</dd>
        <dt>Per seat</dt><dd>${usd2(r.revpas)}</dd>
      </dl>
      ${shortfall !== null && shortfall > 0
        ? `<p class="tone-neg" style="font-size:var(--t-sm);margin-top:var(--s-3)">
             ${int(shortfall)} scheduled session${shortfall === 1 ? '' : 's'} not recorded.
             Either they did not run, or they were never ingested.</p>`
        : (shortfall !== null
          ? '<p class="dim" style="font-size:var(--t-sm);margin-top:var(--s-3)">All scheduled sessions recorded.</p>'
          : '<p class="dim" style="font-size:var(--t-sm);margin-top:var(--s-3)">No expected schedule configured for this hall.</p>')}`;
    grid.append(card);
  }
  root.append(grid);

  /* ---- the schedule itself ---- */
  const sched = h('section', 'panel');
  sched.append(h('h3', 'panel-title', 'Expected schedule'));
  const st = h('table', 'cat-table');
  st.innerHTML = `<thead><tr><th class="name">Hall</th>${
    DOW.map((d) => `<th>${d.slice(0, 3).replace(/^./, (c) => c.toUpperCase())}</th>`).join('')
  }</tr></thead><tbody></tbody>`;
  const sbody = st.querySelector('tbody');
  for (const r of rows) {
    sbody.insertAdjacentHTML('beforeend', `<tr><td class="name">${esc(r.loc.name)}</td>${
      DOW.map((d) => {
        const cfg = r.schedule?.[d];
        return `<td class="${cfg ? '' : 'dim'}">${cfg
          ? `${esc(cfg.count)}<span class="dim" style="font-size:var(--t-xs)"> ${
              esc((cfg.types ?? []).join('+'))}</span>`
          : DASH}</td>`;
      }).join('')
    }</tr>`);
  }
  sched.append(st);
  sched.append(h('p', 'dim',
    'From the tenant configuration, not inferred from the data — so a hall '
    + 'that quietly stops reporting shows as a shortfall rather than as a '
    + 'smaller number nobody questions.'));
  root.append(sched);

  const totalRev = rows.reduce((s, r) => s + r.revenue, 0);
  setInspectorContent?.(`
    <p class="semi">Venues</p>
    <p class="muted">Last ${int(days)} days, to ${esc(latest)}</p>
    <p class="inspector-section-label">Share of gross</p>
    <dl class="inspector-filters">
      ${rows.map((r) => `<dt>${esc(r.loc.name)}</dt><dd>${
        pct(totalRev ? r.revenue / totalRev : null)} · ${usd(r.revenue)}</dd>`).join('')}
    </dl>
    <p class="inspector-section-label">Capacity</p>
    <p class="muted">Seats per session: ${rows.map((r) => `${esc(r.loc.name)} ${int(r.seats)}`).join(', ')}
      (from each hall's max attendance setting). "Per seat" divides gross by every seat that could
      have been sold, not by the seats that were.</p>`);

  return root;
}
