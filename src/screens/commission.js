/* ============================================================================
   SAR 2.0 — Commission

   NEW. SAR 1.0 has no commission view; the scheduler owns this data and SAR
   reads it. Permitted explicitly: commission and hours are public, individual
   salary is not, and none is read here.

   TWO THINGS THE DATA TOLD ME THAT THE SPEC DID NOT.

   1. THE STORED POOL IS RATE x GROSS, NOT RATE x THE AMOUNT OVER TARGET.
      SPEC §16 defines pool = max(0, (rpa - target) x attendance x rate). On
      production `target_rpa` is NULL on every session that has a payout, and
      the stored pool equals `comm_rate x total_sales` to the penny —
      0.15 x 5,000,005.00 = 750,000.75. But the hall DOES have targets:
      `sched_rpa_defaults` holds one per hall, weekday and part (e.g. Redwood
      City Tuesday PM $459.38). The target is therefore
      `session.target_rpa ?? rpa_default(hall, weekday, part)`, and the pool is
      recomputed with model.js `commissionPool` (the §16 formula). Where the
      scheduler stored rate x gross although a default target exists, the
      Recomputed column shows the disagreement — that is the point of it.
      Only when no target can be found at all does the recomputation fall back
      to rate x gross, and the screen says so.

   2. SOME OF THIS IS TEST DATA. A session with attendance 5,555, sales
      5,000,005.00 and a per-person payout of 39,473.72 is not a bingo night.
      Presenting it as somebody's earnings would be worse than showing nothing,
      so implausible rows are flagged and excluded from totals by default.
   ========================================================================== */

import { usd, usd2, pct, int, dateShort, esc, DASH, dollarsToCents } from '../lib/fmt.js';
import { play } from '../lib/sound.js';
import { commissionPool } from '../lib/model.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const TABS = [
  { id: 'sessions', label: 'By session' },
  { id: 'people', label: 'By person' },
];

/** Dollars (numeric in Ops) to cents — the one shared conversion, in fmt.js. */
export const toCents = dollarsToCents;

/* ---------------------------------------------------------------------------
   Plausibility

   A guard, not a judgement. These bounds are deliberately wide — they exist to
   catch a seeded test row, not to second-guess a good night.
--------------------------------------------------------------------------- */

export const PLAUSIBLE = Object.freeze({
  maxAttendance: 1000,        // the halls run ~150-300
  maxSessionSales: 50000000,  // $500,000 in cents; a big night is ~$90,000
  maxPayout: 500000,          // $5,000 in cents for one person on one session
});

export function implausible(row) {
  const why = [];
  if (row.attendance !== null && row.attendance > PLAUSIBLE.maxAttendance) {
    why.push(`attendance ${int(row.attendance)}`);
  }
  if (row.sales !== null && row.sales > PLAUSIBLE.maxSessionSales) {
    why.push(`sales ${usd(row.sales)}`);
  }
  if (row.maxPayout !== null && row.maxPayout > PLAUSIBLE.maxPayout) {
    why.push(`a payout of ${usd(row.maxPayout)}`);
  }
  return why;
}

/* ---------------------------------------------------------------------------
   Model
--------------------------------------------------------------------------- */

/**
 * The pool, recomputed.
 *
 * With a target (cents per attendee) this is model.js `commissionPool` — the
 * SPEC §16 formula, max(0, (rpa − target) × attendance × rate) with rpa =
 * gross ÷ attendance — which is algebraically the same as the old
 * max(0, (sales − target × attendance) × rate). With NO target anywhere it is
 * rate × gross, which is what the scheduler stores, and the caller is told
 * (`aboveTarget: false`). A target with no attendance cannot be applied, and
 * the pool is null rather than a guess.
 *
 * Units: `sales` and `targetRpa` are both CENTS. Before this fix the target
 * arrived in dollars against sales in cents, so a $459.38 target would have
 * subtracted $4.59 per head.
 */
export function poolFor({ sales, attendance, targetRpa, rate }) {
  if (sales === null || sales === undefined || rate === null || rate === undefined) {
    return { pool: null, aboveTarget: false };
  }
  if (targetRpa === null || targetRpa === undefined) {
    return { pool: Math.round(sales * rate), aboveTarget: false };
  }
  if (!attendance) return { pool: null, aboveTarget: true };
  const pool = commissionPool({ rpa: sales / attendance, targetRpa, attendance, rate });
  return { pool: pool === null ? null : Math.round(pool), aboveTarget: true };
}

const weekdayOf = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getUTCDay();

/**
 * The RPA target for a session, in CENTS, and where it came from.
 * `session.target_rpa` first, then `sched_rpa_defaults` for the session's
 * hall, weekday and part. A blank part falls back to the only default for
 * that hall and weekday, if there is exactly one.
 */
export function targetFor(session = {}, rpaDefaults = []) {
  const own = toCents(session.target_rpa);
  if (own !== null) return { targetRpa: own, targetSource: 'session' };
  if (!session.session_date || !session.hall_id) return { targetRpa: null, targetSource: null };
  const dow = weekdayOf(session.session_date);
  const same = rpaDefaults.filter((r) => r.hall_id === session.hall_id && Number(r.dow) === dow);
  const hit = same.find((r) => r.part === session.part) ?? (!session.part && same.length === 1 ? same[0] : null);
  const t = hit ? toCents(hit.target_rpa) : null;
  return t === null ? { targetRpa: null, targetSource: null } : { targetRpa: t, targetSource: 'default' };
}

/** Group the raw payout rows into one row per session. */
export function sessionRows({ payouts = [], sessions = [], staff = [], rpaDefaults = [] }) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const nameOf = new Map(staff.map((s) => [s.id, s.name ?? s.first_name ?? 'Unknown']));
  const bySession = new Map();

  for (const p of payouts) {
    const s = byId.get(p.session_id) ?? {};
    const cur = bySession.get(p.session_id) ?? {
      id: p.session_id,
      date: p.session_date ?? s.session_date ?? null,
      hall: s.hall_id ?? null,
      part: s.part ?? null,
      sales: toCents(s.total_sales),
      attendance: s.attendance ?? null,
      rate: s.comm_rate === null || s.comm_rate === undefined ? null : Number(s.comm_rate),
      ...targetFor({ ...s, session_date: s.session_date ?? p.session_date }, rpaDefaults),
      storedPool: toCents(p.commission_pool),
      totalShares: p.total_shares === null ? null : Number(p.total_shares),
      people: [],
      confirmed: Boolean(p.confirmed_at),
    };
    cur.people.push({
      staffId: p.staff_id,
      name: nameOf.get(p.staff_id) ?? 'Unknown',
      shares: p.shares === null ? null : Number(p.shares),
      payout: toCents(p.payout_amount),
    });
    bySession.set(p.session_id, cur);
  }

  return [...bySession.values()].map((r) => {
    const { pool, aboveTarget } = poolFor(r);
    const paid = r.people.reduce((s, p) => s + (p.payout ?? 0), 0);
    r.maxPayout = r.people.reduce((m, p) => Math.max(m, p.payout ?? 0), 0);
    return {
      ...r,
      computedPool: pool,
      aboveTarget,
      paid,
      // Stored against recomputed. A gap means the rate or the sales figure
      // changed after the payout was confirmed.
      poolGap: r.storedPool === null || pool === null ? null : r.storedPool - pool,
      // What was actually handed out against the pool it came from. Should be
      // the whole pool; a shortfall means shares do not add up.
      unpaid: r.storedPool === null ? null : r.storedPool - paid,
      flags: implausible({ ...r, maxPayout: r.maxPayout }),
    };
  }).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

/** One row per person, over the sessions they were paid on. */
export function peopleRows(rows) {
  const by = new Map();
  for (const r of rows) {
    for (const p of r.people) {
      const cur = by.get(p.staffId) ?? { staffId: p.staffId, name: p.name, sessions: 0, shares: 0, total: 0 };
      cur.sessions += 1;
      cur.shares += p.shares ?? 0;
      cur.total += p.payout ?? 0;
      by.set(p.staffId, cur);
    }
  }
  return [...by.values()]
    .map((p) => ({ ...p, average: p.sessions ? Math.round(p.total / p.sessions) : null }))
    .sort((a, b) => b.total - a.total);
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderCommission({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const tab = TABS.find((t) => t.id === params.tab)?.id ?? 'sessions';
  const includeFlagged = params.flagged === 'on';

  const sched = data.schedule;
  if (!sched?.ok) {
    root.append(h('section', 'panel', `
      <h3 class="panel-title">Commission</h3>
      <div class="placeholder"><p class="semi">Scheduler not connected</p>
      <p class="dim">Operations data is temporarily unavailable. Please try again later.</p></div>`));
    return root;
  }

  const all = sessionRows({
    payouts: sched.commissionPayouts ?? [],
    sessions: sched.sessions ?? [],
    staff: sched.staff ?? [],
    rpaDefaults: sched.rpaDefaults ?? [],
  });
  const flagged = all.filter((r) => r.flags.length);
  const rows = includeFlagged ? all : all.filter((r) => !r.flags.length);

  const tabs = h('div', 'rn-tabs');
  for (const t of TABS) {
    const b = h('button', `rn-tab${t.id === tab ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label;
    b.addEventListener('click', () => { play('select'); onNavigate('commission', { ...params, tab: t.id }); });
    tabs.append(b);
  }
  root.append(tabs);

  const panel = h('section', 'panel');

  if (!all.length) {
    panel.append(h('h3', 'panel-title', 'Commission'));
    panel.append(h('div', 'placeholder', '<p class="semi">No commission recorded yet</p>'));
    root.append(panel);
    return root;
  }

  if (flagged.length) {
    const note = h('div', 'mg-notice');
    note.innerHTML = `<strong>${flagged.length} session${flagged.length === 1 ? '' : 's'}
      look like test data</strong> and ${includeFlagged ? 'are included below' : 'are hidden'} —
      ${flagged[0].flags.map(esc).join(', ')}. Showing these as somebody's earnings would
      be worse than showing nothing. `;
    const btn = h('button', 'mg-name');
    btn.type = 'button';
    btn.textContent = includeFlagged ? 'Hide them' : 'Show them anyway';
    btn.addEventListener('click', () => onNavigate('commission',
      { ...params, flagged: includeFlagged ? 'off' : 'on' }));
    note.append(btn);
    panel.append(note);
  }

  const anyTarget = rows.some((r) => r.aboveTarget);
  if (rows.length && !anyTarget) {
    panel.append(h('div', 'mg-notice', `
      <strong>No RPA target is set on any of these sessions</strong>, and no hall
      default target applies either. The pool is therefore the full commission
      rate applied to gross sales, not to the amount above a target. That is how
      the scheduler has it configured; it is worth knowing because it is not
      what the formula was designed to do.`));
  }
  const byDefault = rows.filter((r) => r.targetSource === 'default');
  const storedGross = byDefault.filter((r) => r.poolGap !== null && Math.abs(r.poolGap) > 1);
  if (storedGross.length) {
    panel.append(h('div', 'mg-notice', `
      <strong>${storedGross.length} session${storedGross.length === 1 ? ' has' : 's have'}
      no target of ${storedGross.length === 1 ? 'its' : 'their'} own, so the hall's
      default RPA target applies</strong> (from the scheduler's RPA defaults, by
      hall, weekday and part). The stored pool does not subtract it — it is the
      rate applied to all of gross. Recomputed shows the pool under the
      commission formula, max(0, (RPA − target) × attendance × rate).`));
  }

  if (tab === 'sessions') {
    panel.append(h('h3', 'panel-title', 'By session'));
    const t = h('table', 'rn-table');
    t.innerHTML = `<thead><tr><th>Date</th><th>Hall</th><th>Session</th>
      <th class="num">Sales</th><th class="num">Rate</th><th class="num">Target RPA</th>
      <th class="num">Pool</th><th class="num">Recomputed</th>
      <th class="num">Paid out</th><th class="num">People</th><th>Confirmed</th>
      </tr></thead><tbody></tbody>`;
    const body = t.querySelector('tbody');
    for (const r of rows) {
      const gap = r.poolGap !== null && Math.abs(r.poolGap) > 1;
      body.insertAdjacentHTML('beforeend', `<tr class="${r.flags.length ? 'is-flagged' : ''}">
        <td>${r.date ? dateShort(r.date) : DASH}</td>
        <td>${esc(r.hall ?? DASH)}</td>
        <td>${esc(r.part ?? DASH)}</td>
        <td class="num">${r.sales === null ? DASH : usd(r.sales)}</td>
        <td class="num">${r.rate === null ? DASH : pct(r.rate)}</td>
        <td class="num">${r.targetRpa === null ? DASH : usd2(r.targetRpa)}${
          r.targetSource === 'default' ? ' <span class="dim">(hall default)</span>' : ''}</td>
        <td class="num">${r.storedPool === null ? DASH : usd(r.storedPool)}</td>
        <td class="num ${gap ? 'st-poor' : 'dim'}">${
          r.computedPool === null ? DASH : gap ? usd(r.computedPool) : 'matches'}</td>
        <td class="num">${usd(r.paid)}${
          r.unpaid !== null && Math.abs(r.unpaid) > 1
            ? ` <span class="dim">(${usd(r.unpaid)} unallocated)</span>` : ''}</td>
        <td class="num">${r.people.length}</td>
        <td>${r.confirmed ? '<span class="st-good">yes</span>' : '<span class="dim">no</span>'}</td>
      </tr>`);
    }
    panel.append(t);
  } else {
    panel.append(h('h3', 'panel-title', 'By person'));
    const people = peopleRows(rows);
    if (!people.length) {
      panel.append(h('div', 'placeholder', '<p class="dim">Nothing to show with these filters</p>'));
    } else {
      const t = h('table', 'rn-table');
      t.innerHTML = `<thead><tr><th>Name</th><th class="num">Sessions</th>
        <th class="num">Shares</th><th class="num">Total</th>
        <th class="num">Average</th></tr></thead><tbody></tbody>`;
      const body = t.querySelector('tbody');
      for (const p of people) {
        body.insertAdjacentHTML('beforeend', `<tr>
          <td>${esc(p.name)}</td><td class="num">${esc(p.sessions)}</td>
          <td class="num">${esc(p.shares)}</td>
          <td class="num">${usd(p.total)}</td>
          <td class="num dim">${p.average === null ? DASH : usd(p.average)}</td></tr>`);
      }
      panel.append(t);
    }
  }

  panel.append(h('p', 'muted',
    `${rows.length} session${rows.length === 1 ? '' : 's'} shown`
    + `${flagged.length && !includeFlagged ? `, ${flagged.length} hidden as implausible` : ''}.`));
  root.append(panel);

  setInspectorContent?.(`
    <p class="semi">Commission</p>
    <p class="muted">${rows.length} sessions · ${peopleRows(rows).length} people</p>
    <p class="inspector-section-label">How the pool is worked out</p>
    <p class="muted">max(0, (RPA − target) × attendance × rate), with RPA as
      gross sales per attendee. The target is the session's own, or else the
      hall's default for that weekday and part. ${anyTarget
    ? `${byDefault.length} of ${rows.length} session${rows.length === 1 ? '' : 's'} shown use the hall default.`
    : 'No target applies to any session here, so the whole of gross is commissionable.'}</p>
    <p class="inspector-section-label">Recomputed</p>
    <p class="muted">The stored pool against the same sum done again from the
      session's own sales and rate. "Matches" means the two agree; a figure
      means they do not, which happens when the sales figure changed after the
      payout was confirmed.</p>
    <p class="inspector-section-label">What is not here</p>
    <p class="muted">Hourly pay, wage rates and premiums. Commission and hours
      are read; salary is not, anywhere in SAR.</p>`);

  return root;
}
