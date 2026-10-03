/* ============================================================================
   SAR 2.0 — U17, Jackpots

   Every rule here was read out of SAR 1.0's implementation rather than
   inferred, after a first pass got two of three wrong:

     · "Max" is the largest payout ever, NOT the fill cap
     · the cap is P90, rounded up to a readable step
     · an org-wide pot dedupes balances by date (the same shared balance is
       recorded against both halls)

   SPEC §19.4 records that SAR 1.0 bands the same fill ratio three different
   ways in three places. **One set here**, the one its thermometer draws:
   33 / 66 / 90.

   The gremlin is not on this screen as a progressive. It is a payout that
   happens, with no balance and no carry-over, so it gets a payout history and
   nothing else.
   ========================================================================== */

import {
  metricsFor, sessionTotals, getMetric, jackpotHistory, jackpotCap,
  jackpotMaxPayout, jackpotFill, jackpotStatus, sinceLastHit,
  jackpotParticipation, mean,
} from '../lib/model.js';
import { usd, usdShort, pct, int, dateShort, dateLong, esc, DASH } from '../lib/fmt.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/** A sparkline of the balance over time, with hits marked. */
function balanceTrend(series, cap) {
  const W = 560; const H = 64; const P = 2;
  const vals = series.map((s) => s.balance);
  const top = Math.max(cap ?? 0, ...vals, 1);
  const x = (i) => (series.length < 2 ? 0 : (i / (series.length - 1)) * (W - P * 2) + P);
  const y = (v) => H - P - (v / top) * (H - P * 2);

  const path = series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.balance).toFixed(1)}`).join(' ');
  const hits = series.map((s, i) => (s.hit
    ? `<circle cx="${x(i).toFixed(1)}" cy="${y(s.balance).toFixed(1)}" r="3"
               fill="var(--neg)"><title>Hit — ${dateShort(s.date)}, ${usd(s.payout)}</title></circle>`
    : '')).join('');
  const capLine = cap
    ? `<line x1="${P}" y1="${y(cap).toFixed(1)}" x2="${W - P}" y2="${y(cap).toFixed(1)}"
             stroke="var(--hair)" stroke-dasharray="3 3"/>` : '';

  return `<svg viewBox="0 0 ${W} ${H}" class="jp-spark" role="img"
               aria-label="Balance over time with hits marked">
    ${capLine}
    <path d="${path}" fill="none" stroke="var(--gold)" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round"/>
    ${hits}
  </svg>`;
}

function jackpotCard(jp, ctx, hallId) {
  const metricsOf = (e) => metricsFor(e.id, ctx.metrics, ctx.idx);
  const chron = [...ctx.events].reverse();               // oldest first
  const scoped = jp.scope === 'org_wide'
    ? chron
    : chron.filter((e) => e.location_id === hallId);

  const { payouts, balances } = jackpotHistory(scoped, metricsOf, jp);
  // The config's cap is in DOLLARS (Hotball 5000, Mega 15000); metrics are cents.
  const cap = jackpotCap(payouts, balances, { fallback: jp.cap ? jp.cap * 100 : null });
  const max = jackpotMaxPayout(payouts);

  // One row per session; for an org-wide pot, one row per DATE, merged across
  // halls. Keeping only the first hall's row lost a hit recorded at the other.
  const byDate = new Map();
  const series = [];
  for (const e of scoped) {
    const m = metricsOf(e);
    const row = {
      date: e.event_date,
      balance: getMetric(m, jp.balanceKey) ?? 0,
      payout: Math.abs(getMetric(m, jp.paidKey) ?? 0),
    };
    if (jp.scope === 'org_wide') {
      const prev = byDate.get(e.event_date);
      if (prev) {
        // The same shared pot seen from both halls: the larger reading of each.
        prev.balance = Math.max(prev.balance, row.balance);
        prev.payout = Math.max(prev.payout, row.payout);
        continue;
      }
      byDate.set(e.event_date, row);
    }
    series.push(row);
  }

  // Mark hits, guarding against a payout recorded before any pot existed.
  let hadBalance = false;
  for (const s of series) {
    s.hit = s.payout > 0 && hadBalance;
    if (s.balance > 0) hadBalance = true;
  }

  const current = series.at(-1) ?? { balance: 0 };
  const fill = jackpotFill(current.balance, cap);
  const status = jackpotStatus(fill);
  const { since, lastPayout } = sinceLastHit(series);
  const hits = series.filter((s) => s.hit);
  const latest = ctx.events.find((e) => (jp.scope === 'org_wide' || e.location_id === hallId));
  const part = latest
    ? jackpotParticipation(metricsOf(latest), jp, getMetric(metricsOf(latest), 'attendance'))
    : { players: null, pctOfAttendance: null };

  const card = h('section', 'panel');
  card.innerHTML = `
    <div class="jp-head">
      <h3 class="panel-title" style="margin:0">${esc(jp.name)}</h3>
      <span class="jp-scope dim">${jp.scope === 'org_wide' ? 'shared across both halls' : 'this hall'}</span>
      ${status ? `<span class="jp-status jp-${status.toLowerCase()}">${status}</span>` : ''}
      <span class="jp-balance">${usd(current.balance)}</span>
    </div>
    <div class="jp-track"><div class="jp-fill" style="width:${((fill ?? 0) * 100).toFixed(1)}%"></div></div>
    <dl class="jp-stats">
      <dt>Fill</dt><dd>${cap ? `${pct(fill)} of ${usdShort(cap)}` : DASH}</dd>
      <dt>Max payout</dt><dd>${usd(max)}</dd>
      <dt>Sessions since hit</dt><dd>${since === null ? 'never hit' : int(since)}</dd>
      <dt>Last payout</dt><dd>${usd(lastPayout)}</dd>
      <dt>Players</dt><dd>${part.players === null ? DASH
        : `${int(part.players)}${part.pctOfAttendance !== null
            ? ` (${pct(part.pctOfAttendance, { decimals: 0 })})` : ''}`}</dd>
    </dl>
    ${series.length > 1 ? balanceTrend(series, cap) : ''}
    <p class="dim" style="font-size:var(--t-sm);margin-top:var(--s-2)">
      ${hits.length} hit${hits.length === 1 ? '' : 's'} in
      ${series.length} session${series.length === 1 ? '' : 's'}${
        hits.length ? ` · average payout ${usd(mean(hits.map((x) => x.payout)))}` : ''}.
      Cap is the 90th percentile of past ${payouts.length >= 3 ? 'payouts' : 'balances'},
      so a pot at 100% is high rather than impossible.
    </p>`;

  return { card, hits, series, cap, status, since };
}

/* ---------------------------------------------------------------------------
   Gremlin — a payout, never a pot
--------------------------------------------------------------------------- */
function gremlinPanel(ctx, hallId) {
  const rows = [];
  for (const e of ctx.events) {
    if (hallId !== 'all' && e.location_id !== hallId) continue;
    const v = getMetric(metricsFor(e.id, ctx.metrics, ctx.idx), 'gremlin_hotball');
    if (v > 0) rows.push({ e, v });
  }

  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Gremlin'));
  panel.append(h('p', 'muted',
    'A payout that happens, not a pot that builds — no balance, no carry-over, '
    + 'so no thermometer. Shown as a history of what it has paid.'));

  if (!rows.length) {
    panel.append(h('p', 'dim', 'No gremlin payouts in this range.'));
    return panel;
  }

  const table = h('table', 'cat-table');
  table.innerHTML = '<thead><tr><th class="name">Session</th><th>Hall</th><th>Payout</th></tr></thead><tbody></tbody>';
  const body = table.querySelector('tbody');
  for (const r of rows.slice(0, 20)) {
    const hall = ctx.locations.find((l) => l.id === r.e.location_id)?.name ?? DASH;
    body.insertAdjacentHTML('beforeend',
      `<tr><td class="name">${dateLong(r.e.event_date)}</td><td>${esc(hall)}</td>
           <td class="tone-neg">${usd(r.v)}</td></tr>`);
  }
  const total = rows.reduce((s, r) => s + r.v, 0);
  body.insertAdjacentHTML('beforeend',
    `<tr class="total-row"><td class="name">${rows.length} payouts</td><td></td>
         <td>${usd(total)}</td></tr>`);
  panel.append(table);
  return panel;
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderJackpots({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const hallId = params.hall && data.locations.some((l) => l.id === params.hall)
    ? params.hall
    : data.locations[0]?.id;

  const bar = h('div', 'filter-bar');
  for (const l of data.locations) {
    const b = h('button', `chip${l.id === hallId ? ' is-active' : ''}`);
    b.type = 'button';
    b.textContent = l.name;
    b.addEventListener('click', () => onNavigate('jackpots', { ...params, hall: l.id }));
    bar.append(b);
  }
  root.append(bar);

  const configured = data.config?.settings?.jackpots ?? [];
  if (!configured.length) {
    root.append(h('div', 'placeholder',
      '<p class="semi">No jackpots configured</p>'
      + '<p class="dim">Nothing in <code>analytics_config.settings.jackpots</code>.</p>'));
    return root;
  }

  const built = configured.map((jp) => jackpotCard(jp, data, hallId));
  for (const b of built) root.append(b.card);
  root.append(gremlinPanel(data, hallId));

  const hallName = data.locations.find((l) => l.id === hallId)?.name ?? DASH;
  setInspectorContent?.(`
    <p class="semi">Jackpots</p>
    <p class="muted">${esc(hallName)}</p>
    <p class="inspector-section-label">Configured</p>
    <dl class="inspector-filters">
      ${configured.map((jp, i) => `
        <dt>${esc(jp.name)}</dt>
        <dd>${built[i].status ?? DASH}${built[i].since === null
          ? ', never hit' : `, ${int(built[i].since)} since hit`}</dd>`).join('')}
    </dl>
    <p class="inspector-section-label">How the cap works</p>
    <p class="muted">The fill bar is scaled to the 90th percentile of past
      payouts — or of past balances where fewer than three payouts exist —
      rounded up. One enormous historic win would otherwise flatten every
      later reading to a sliver.</p>
    <p class="inspector-section-label">Bands</p>
    <p class="muted">LOW below 33%, BUILDING to 66%, HIGH to 90%, HOT above.
      One set of thresholds, used everywhere.</p>`);

  return root;
}
