/* ============================================================================
   SAR 2.0 — U21, Anomalies

   Sessions that do not look like their own history.

   SEASONALITY-AWARE AND SAMPLE-GATED, which is the whole point. A Saturday is
   compared against Saturdays, and nothing is flagged from a pool below the
   documented floor. Flagging a quiet Tuesday because it earned less than a
   busy Saturday is noise that trains people to ignore the screen.

   Findings are ranked by how far from normal, and every one states the
   comparison it used — so a reader can disagree with the basis rather than
   just the conclusion.
   ========================================================================== */

import {
  metricsFor, sessionTotals, comparisonPool, standing, getMetric, MIN_POOL,
} from '../lib/model.js';
import { usd, pct, int, dateLong, weekday, sessionType, esc, DASH } from '../lib/fmt.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/** |z| above which a session is worth a person's attention. */
const Z_FLAG = 2;

const CHECKS = [
  { key: 'revenue', label: 'Gross sales', get: (t) => t.revenue, fmt: usd, invert: false },
  { key: 'attendance', label: 'Attendance', get: (t) => t.attendance, fmt: int, invert: false },
  { key: 'rpa', label: 'Per head', get: (t) => t.rpa, fmt: usd, invert: false },
  { key: 'payoutRatio', label: 'Payout ratio',
    get: (t) => (t.revenue ? t.payout / t.revenue : null),
    fmt: (v) => pct(v), invert: true },
];

/**
 * Structural problems — not statistical, just wrong.
 *
 * These are reported separately and always, regardless of pool size: a
 * negative revenue or a session with payouts and no sales is a data fault,
 * not an unusual night.
 */
function structural(t, m) {
  const out = [];
  if (t.revenue < 0) out.push('Negative gross sales');
  if (t.payout < 0) out.push('Negative payouts');
  if (t.revenue === 0 && t.payout > 0) out.push('Payouts recorded with no sales');
  if (getMetric(m, 'attendance') === null) out.push('Attendance not recorded');
  else if (t.attendance === 0 && t.revenue > 0) out.push('Sales recorded with zero attendance');
  if (t.margin !== null && t.margin < -0.5) out.push('Paid out more than 150% of sales');
  return out;
}

export function findAnomalies(data, { days = 90 } = {}) {
  if (!data.events.length) return [];
  const latest = data.events[0].event_date;
  const from = new Date(new Date(`${latest}T00:00:00Z`).getTime() - days * 86400000)
    .toISOString().slice(0, 10);

  const findings = [];
  for (const e of data.events) {
    if (e.event_date < from) continue;
    const m = metricsFor(e.id, data.metrics, data.idx);
    const t = sessionTotals(m, data.categories);

    for (const problem of structural(t, m)) {
      findings.push({ event: e, kind: 'structural', label: problem, score: Infinity });
    }

    const pool = comparisonPool(e, data.events);
    for (const c of CHECKS) {
      const value = c.get(t);
      if (value === null || !Number.isFinite(value)) continue;
      const values = pool
        .map((p) => c.get(sessionTotals(metricsFor(p.id, data.metrics, data.idx), data.categories)))
        .filter((v) => v !== null && Number.isFinite(v));
      const st = standing(value, values);
      if (!st.enough || st.z === null) continue;
      if (Math.abs(st.z) < Z_FLAG) continue;

      const worse = c.invert ? st.z > 0 : st.z < 0;
      findings.push({
        event: e, kind: 'statistical', check: c, value, standing: st,
        label: `${c.label} ${st.z > 0 ? 'far above' : 'far below'} normal`,
        worse, score: Math.abs(st.z),
      });
    }
  }

  return findings.sort((a, b) => b.score - a.score);
}

export function renderAnomaly({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const days = Number(params.days) || 90;

  const bar = h('div', 'filter-bar');
  for (const d of [30, 90, 365]) {
    const b = h('button', `chip${d === days ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = d === 365 ? '1 year' : `${d} days`;
    b.addEventListener('click', () => onNavigate('anomaly', { ...params, days: String(d) }));
    bar.append(b);
  }
  root.append(bar);

  const findings = findAnomalies(data, { days });

  if (!findings.length) {
    root.append(h('div', 'placeholder', `
      <p class="semi">Nothing unusual in the last ${days} days</p>
      <p class="dim">Every session sits within two standard deviations of its
        own weekday and session type, and no structural faults were found.
        That is a result, not an empty screen.</p>`));
  } else {
    const panel = h('section', 'panel');
    panel.append(h('h3', 'panel-title',
      `${findings.length} finding${findings.length === 1 ? '' : 's'}`));

    for (const f of findings.slice(0, 40)) {
      const hall = data.locations.find((l) => l.id === f.event.location_id)?.name ?? DASH;
      const item = h('div', 'finding');
      const tone = f.kind === 'structural' ? 'neg' : (f.worse ? 'neg' : 'pos');
      item.innerHTML = `
        <div class="finding-head">
          <span class="jp-status jp-${tone === 'neg' ? 'hot' : 'building'}">${
            f.kind === 'structural' ? 'DATA' : (f.worse ? 'LOW' : 'HIGH')}</span>
          <button class="link" data-open="${esc(f.event.id)}">${esc(hall)}</button>
          <span class="dim">${dateLong(f.event.event_date)} ·
            ${esc(sessionType(f.event.event_type))}</span>
        </div>
        <p class="semi">${esc(f.label)}</p>
        ${f.kind === 'statistical' ? `
          <p class="muted">${f.check.fmt(f.value)} against a typical
            ${f.check.fmt(f.standing.mean)} — ${Math.abs(f.standing.z).toFixed(1)}
            standard deviations out, measured over ${f.standing.n} other
            ${weekday(f.event.event_date)} ${esc(sessionType(f.event.event_type).toLowerCase())}
            session${f.standing.n === 1 ? '' : 's'} at ${esc(hall)}.</p>`
        : '<p class="muted">A data fault rather than an unusual night. Worth checking the source.</p>'}`;
      panel.append(item);
    }
    for (const b of panel.querySelectorAll('[data-open]')) {
      b.addEventListener('click', () => onNavigate('session', { id: b.dataset.open }));
    }
    root.append(panel);
  }

  const structuralCount = findings.filter((f) => f.kind === 'structural').length;
  setInspectorContent?.(`
    <p class="semi">Anomalies</p>
    <p class="muted">Last ${days} days</p>
    <p class="inspector-section-label">What is flagged</p>
    <p class="muted">A session more than ${Z_FLAG} standard deviations from the
      mean of its <em>own</em> weekday and session type at the same hall.
      Nothing is flagged from a pool smaller than ${MIN_POOL}.</p>
    <p class="inspector-section-label">Why it is scoped that way</p>
    <p class="muted">Flagging a quiet Tuesday for earning less than a busy
      Saturday is noise, and noise teaches people to ignore the screen.</p>
    <p class="inspector-section-label">Found</p>
    <dl class="inspector-filters">
      <dt>Statistical</dt><dd>${findings.length - structuralCount}</dd>
      <dt>Data faults</dt><dd>${structuralCount}</dd>
    </dl>`);

  return root;
}
