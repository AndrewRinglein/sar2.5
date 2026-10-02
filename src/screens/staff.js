/* ============================================================================
   SAR 2.0 — Staff Overview (SPEC §22.1, U15)

   Reads the scheduler's `sched_*` tables; writes nothing. All of the logic is
   in `lib/staff-model.js` (pure, unit-tested); this file only draws it.

   THE LINE (§22.1.8). Never a base rate, a regular rate, or anything computed
   from one. Commission, hours, OT hours, rateAdj (commission ÷ hours), otAdj
   (rateAdj × 0.5 × OT1.5 + rateAdj × OT2) and break premium HOURS are shown.

   WORKWEEK. Monday, confirmed (§22.1.4). The scheduler still uses Sunday, so
   its overtime will differ from this screen's; the screen says so on its face.

   WHERE THE SPEC IS STALE. A time clock now exists, but every recorded
   `hours_worked` is 0 or null, so actual hours are "not yet recorded" — a
   state, never a zero. End times now exist on almost every shift; those that
   lack one are still counted out loud.

   The legacy helpers below (rosterRows, coverage, hoursByPerson,
   neverScheduled) back the "Who can cover" tab and are kept exported.
   ========================================================================== */

import { int, pct, usd, usd2, dateShort, esc, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';
import { resolveHalls } from '../lib/managers.js';
import { sessionRows } from './commission.js';
import { nameMergePanel } from '../components/name-merge.js';
import {
  buildStaffOverview, payPeriod, COUNTED_STATUSES,
} from '../lib/staff-model.js';
import {
  buildWorked, scheduledVsWorked, latestValidatorPeriod, VALIDATOR_ROLES,
} from '../lib/crew-model.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'worked', label: 'Worked' },
  { id: 'capability', label: 'Who can cover' },
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ROUTE = 'staff-overview';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Hours to one decimal; null is a dash, and -0.0 never appears. */
const ONE = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hrs = (v) => (v === null || v === undefined || !Number.isFinite(v) ? DASH
  : ONE.format(Math.abs(v) < 0.05 ? 0 : v));

/* ---------------------------------------------------------------------------
   Legacy helpers — capability roster (the "Who can cover" tab)
--------------------------------------------------------------------------- */

/**
 * One row per person: what they can do, when they last worked, how much.
 * `lastWorked` is null for somebody never scheduled — "never", not an old date.
 */
export function rosterRows({ staff = [], assignments = [], sessions = [], roles = [],
                             capability = [], timeEntries = [] } = {}) {
  const sessionOf = new Map(sessions.map((s) => [s.id, s]));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));

  const shifts = new Map();
  for (const a of assignments) {
    const s = sessionOf.get(a.session_id);
    const cur = shifts.get(a.staff_id) ?? { count: 0, last: null, roles: new Map() };
    cur.count += 1;
    const d = s?.session_date ?? null;
    if (d && (!cur.last || d > cur.last)) cur.last = d;
    const rn = roleName.get(a.role_id);
    if (rn) cur.roles.set(rn, (cur.roles.get(rn) ?? 0) + 1);
    shifts.set(a.staff_id, cur);
  }

  const can = new Map();
  for (const c of capability) {
    if (c.can_do === false) continue;
    const set = can.get(c.staff_id) ?? new Set();
    const rn = roleName.get(c.role_id);
    if (rn) set.add(rn + (c.is_deputy ? ' (deputy)' : ''));
    can.set(c.staff_id, set);
  }

  const hours = new Map();
  for (const e of timeEntries) {
    const v = num(e.hours_worked);
    if (v === null) continue;
    hours.set(e.staff_id, (hours.get(e.staff_id) ?? 0) + v);
  }

  return staff.map((p) => {
    const sh = shifts.get(p.id) ?? { count: 0, last: null, roles: new Map() };
    return {
      id: p.id,
      name: p.name ?? p.first_name ?? 'Unknown',
      active: p.active !== false,
      onRoster: p.on_roster !== false,
      shifts: sh.count,
      lastWorked: sh.last,
      roles: [...sh.roles.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r),
      canDo: [...(can.get(p.id) ?? [])].sort(),
      hours: hours.get(p.id) ?? null,
    };
  }).sort((a, b) => b.shifts - a.shifts || a.name.localeCompare(b.name));
}

/** Active, on the roster, and never scheduled — worth a look, not an alarm. */
export const neverScheduled = (rows) => rows.filter((r) => r.active && !r.shifts);

/** How many active people can do each role, and how many actually have. */
export function coverage(rows, roles = []) {
  return roles.map((r) => {
    const capable = rows.filter((p) => p.active
      && p.canDo.some((c) => c === r.name || c === `${r.name} (deputy)`));
    const worked = rows.filter((p) => p.roles.includes(r.name));
    return {
      role: r.name,
      capable: capable.length,
      worked: worked.length,
      people: worked.map((p) => p.name),
      thin: capable.length > 0 && capable.length <= 1,
      undeclared: capable.length === 0 && worked.length > 0,
    };
  }).sort((a, b) => a.capable - b.capable);
}

/** Recorded hours per person. Null hours are counted as unrecorded, never 0. */
export function hoursByPerson(timeEntries = [], staff = []) {
  const nameOf = new Map(staff.map((s) => [s.id, s.name ?? s.first_name ?? 'Unknown']));
  const by = new Map();
  for (const e of timeEntries) {
    const v = num(e.hours_worked);
    const cur = by.get(e.staff_id) ?? {
      staffId: e.staff_id, name: nameOf.get(e.staff_id) ?? 'Unknown',
      shifts: 0, hours: 0, unrecorded: 0, walkUps: 0, halls: new Set(),
    };
    cur.shifts += 1;
    if (v === null) cur.unrecorded += 1; else cur.hours += v;
    if (e.is_walk_up) cur.walkUps += 1;
    if (e.hall_id) cur.halls.add(e.hall_id);
    by.set(e.staff_id, cur);
  }
  return [...by.values()]
    .map((p) => ({ ...p, halls: [...p.halls],
                   average: p.shifts > p.unrecorded ? p.hours / (p.shifts - p.unrecorded) : null }))
    .sort((a, b) => b.hours - a.hours);
}

/* ---------------------------------------------------------------------------
   Small drawing helpers
--------------------------------------------------------------------------- */

function table(cols, rows) {
  const t = h('table', 'rn-table');
  t.innerHTML = `<thead><tr>${cols.map((c) =>
    `<th class="${c.cls ?? ''}">${c.label}</th>`).join('')}</tr></thead><tbody></tbody>`;
  const body = t.querySelector('tbody');
  for (const r of rows) {
    body.insertAdjacentHTML('beforeend',
      `<tr class="${r._cls ?? ''}">${cols.map((c) =>
        `<td class="${c.cls ?? ''}">${c.cell(r)}</td>`).join('')}</tr>`);
  }
  return t;
}

/** Nulls last in both directions — unmeasured is not worst. */
function sortRows(rows, get, desc) {
  const has = []; const missing = [];
  for (const r of rows) {
    const v = get(r);
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) missing.push(r);
    else has.push({ r, v });
  }
  has.sort((a, b) => (typeof a.v === 'string'
    ? (desc ? b.v.localeCompare(a.v) : a.v.localeCompare(b.v))
    : (desc ? b.v - a.v : a.v - b.v)));
  return [...has.map((x) => x.r), ...missing];
}

/** Weekly-hours mini bars. Every row is drawn against the SAME y maximum. */
function sparkBars(values, weeks, yMax) {
  const W = 78; const H = 20; const n = values.length;
  if (!n) return `<span class="dim">${DASH}</span>`;
  const bw = W / n;
  const bars = values.map((v, i) => {
    const bh = yMax > 0 ? (v / yMax) * (H - 2) : 0;
    const label = `Week of ${dateShort(weeks[i])}: ${hrs(v)} h`;
    return bh > 0
      ? `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" class="so-spark-bar"><title>${label}</title></rect>`
      : `<rect x="${(i * bw + 1).toFixed(1)}" y="${H - 1}" width="${Math.max(1, bw - 2).toFixed(1)}" height="1" class="so-spark-zero"><title>${label}</title></rect>`;
  }).join('');
  return `<svg class="so-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
    aria-label="Hours by week">${bars}</svg>`;
}

const CAUSES = [
  { key: 'daily', label: 'Daily', note: 'long single shifts' },
  { key: 'weekly', label: 'Weekly', note: 'too many shifts' },
  { key: 'seventh', label: 'Seventh day', note: 'no rest day' },
];

/** Horizontal stacked bars, one per Monday workweek, shared x scale. */
function causeChart(weeks) {
  const W = 420; const rowH = 22; const left = 78; const right = 44;
  const max = Math.max(1, ...weeks.map((w) => w.daily + w.weekly + w.seventh));
  const plot = W - left - right;
  const Hh = weeks.length * rowH + 4;
  let body = '';
  weeks.forEach((w, i) => {
    const y = i * rowH + 4;
    let x = left;
    body += `<text x="${left - 8}" y="${y + 12}" class="so-axis" text-anchor="end">wk ${dateShort(w.weekStart)}</text>`;
    for (const c of CAUSES) {
      const v = w[c.key];
      if (v <= 0) continue;
      const wd = (v / max) * plot;
      body += `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(1, wd - 2).toFixed(1)}" height="${rowH - 8}"
        rx="2" class="so-c-${c.key}"><title>Week of ${dateShort(w.weekStart)} · ${c.label}: ${hrs(v)} h</title></rect>`;
      x += wd;
    }
    const tot = w.daily + w.weekly + w.seventh;
    body += `<text x="${x + 6}" y="${y + 12}" class="so-val">${tot > 0 ? `${hrs(tot)} h` : '0'}</text>`;
  });
  return `<svg class="so-chart" viewBox="0 0 ${W} ${Hh}" role="img"
    aria-label="Overtime hours by cause, per workweek">${body}</svg>`;
}

/** Needed vs filled, with the shortfall and the excess drawn separately. */
function meter(needed, filled) {
  const W = 120; const H = 10;
  const max = Math.max(needed, filled, 1);
  const sx = (v) => (v / max) * W;
  const ok = Math.min(needed, filled);
  let s = `<rect x="0" y="2" width="${sx(needed).toFixed(1)}" height="${H - 4}" class="so-m-need"/>`;
  s += `<rect x="0" y="2" width="${sx(ok).toFixed(1)}" height="${H - 4}" class="so-m-fill"/>`;
  if (needed > filled) s += `<rect x="${sx(filled).toFixed(1)}" y="2" width="${sx(needed - filled).toFixed(1)}" height="${H - 4}" class="so-m-short"/>`;
  if (filled > needed) s += `<rect x="${sx(needed).toFixed(1)}" y="2" width="${sx(filled - needed).toFixed(1)}" height="${H - 4}" class="so-m-over"/>`;
  return `<svg class="so-meter" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${s}</svg>`;
}

/** Scheduled (hollow) to actual (filled), one row per person. */
function dumbbell(rows) {
  const W = 520; const rowH = 22; const left = 130; const right = 60;
  const max = Math.max(1, ...rows.flatMap((r) => [r.scheduled, r.actual]));
  const sx = (v) => left + (v / max) * (W - left - right);
  let body = '';
  rows.forEach((r, i) => {
    const y = i * rowH + 12;
    const a = sx(r.scheduled); const b = sx(r.actual);
    body += `<text x="${left - 8}" y="${y + 4}" class="so-axis" text-anchor="end">${esc(r.name)}</text>
      <line x1="${a}" x2="${b}" y1="${y}" y2="${y}" class="so-db-line"/>
      <circle cx="${a}" cy="${y}" r="4" class="so-db-sched"><title>Scheduled ${hrs(r.scheduled)} h</title></circle>
      <circle cx="${b}" cy="${y}" r="4" class="so-db-act"><title>Actual ${hrs(r.actual)} h</title></circle>
      <text x="${W - right + 8}" y="${y + 4}" class="so-val">${r.variance > 0 ? '+' : ''}${hrs(r.variance)} h</text>`;
  });
  return `<svg class="so-chart" viewBox="0 0 ${W} ${rows.length * rowH + 8}" role="img"
    aria-label="Scheduled versus actual hours per person">${body}</svg>`;
}

const KIND = { meal: 'Meal', second_meal: 'Second meal', rest: 'Rest' };
const TYPE = { not_taken: 'Not taken', taken_late: 'Taken late', waived_not_waivable: 'Waived when not waivable' };

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderStaff({ data, params = {}, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const tab = TABS.find((t) => t.id === params.tab)?.id ?? 'overview';
  const sched = data.schedule;

  if (!sched?.ok) {
    root.append(h('section', 'panel', `
      <h3 class="panel-title">Staff overview</h3>
      <div class="placeholder"><p class="semi">Scheduler not connected</p>
      <p class="dim">Operations data is temporarily unavailable. Please try again later.</p></div>`));
    return root;
  }

  const go = (patch) => { play('select'); onNavigate?.(ROUTE, { ...params, ...patch }); };

  const tabs = h('div', 'rn-tabs');
  for (const t of TABS) {
    const b = h('button', `rn-tab${t.id === tab ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label;
    b.addEventListener('click', () => go({ tab: t.id }));
    tabs.append(b);
  }
  root.append(tabs);

  if (tab === 'capability') {
    renderCapability(root, sched, params, go);
  } else if (tab === 'worked') {
    renderWorked(root, data, sched, params, go);
  } else {
    renderOverview(root, data, sched, params, go);
  }

  setInspectorContent?.(`
    <p class="semi">Staff overview</p>
    <p class="muted">Read-only from the scheduler. Nothing here is written back.</p>
    <p class="inspector-section-label">Workweek</p>
    <p class="muted">Monday to Sunday. Daily overtime past 8 and 12 hours, weekly past
      40 (excluding hours already paid as daily overtime), and the seventh
      consecutive worked day of a Monday week. The scheduler itself still uses
      Sunday, so its overtime figures will differ from these.</p>
    <p class="inspector-section-label">Which sessions count</p>
    <p class="muted">Deployed and planned. What draft, planned and deployed mean is not
      defined anywhere in the scheduler (open question 26); drafts are reported
      separately and left out of every total.</p>
    <p class="inspector-section-label">Actual or scheduled</p>
    <p class="muted">Overtime is worked out on actual hours for any day that has them,
      and on scheduled hours otherwise. Each row says which.</p>
    <p class="inspector-section-label">Worked</p>
    <p class="muted">Who was on each night's crew, from the data validator — the
      nightly reconciliation app where crews are now entered. It records people
      and roles, not times, so every hour and overtime figure on this screen still
      comes from the scheduler. Validator names are tied to a scheduler person
      when they match one exactly. The owner's name rule (2 Oct 2026) treats
      spellings of one first name as one person in every role except Flash
      Runners; each merge, and each bare first name left ambiguous, is listed
      under "Merged names". Likely Flash Runner duplicates are listed, never
      merged.</p>
    <p class="inspector-section-label">What is not here</p>
    <p class="muted">Base rates, regular rates and anything computed from one. Break
      premiums are shown as hours owed, never dollars. Commission, hours, the
      commission-per-hour rate and its overtime uplift are shown because they
      are derived from public figures only.</p>`);
  return root;
}

/* ---- Who can cover -------------------------------------------------------- */

function renderCapability(root, sched, params, go) {
  const panel = h('section', 'panel');
  const rows = rosterRows(sched);
  if (!rows.length) {
    panel.append(h('h3', 'panel-title', 'Who can cover'));
    panel.append(h('div', 'placeholder', '<p class="semi">No staff recorded</p>'));
    root.append(panel);
    return;
  }
  const showInactive = params.inactive === 'on';
  const visible = showInactive ? rows : rows.filter((r) => r.active);
  const cov = coverage(rows, sched.roles ?? []);
  const thin = cov.filter((c) => c.thin);
  const never = neverScheduled(visible);

  panel.append(h('h3', 'panel-title', 'Who can cover'));
  panel.append(h('p', 'muted', 'How many people can cover each role, and who has. No pay information is read.'));
  if (thin.length) {
    panel.append(h('div', 'mg-notice',
      `<strong>${thin.length} role${thin.length === 1 ? '' : 's'} can be covered by
       only one person:</strong> ${thin.map((c) => esc(c.role)).join(', ')}.`));
  }
  panel.append(table([
    { label: 'Role', cell: (r) => esc(r.role) },
    { label: 'Can cover', cls: 'num', cell: (r) => (r.undeclared
      ? '<span class="dim">not recorded</span>' : int(r.capable)) },
    { label: 'Have worked it', cls: 'num', cell: (r) => int(r.worked) },
    { label: 'Who', cell: (r) => (r.people.length
      ? `<span class="dim">${r.people.slice(0, 6).map(esc).join(', ')}${r.people.length > 6 ? '…' : ''}</span>` : DASH) },
  ], cov.map((c) => ({ ...c, _cls: c.thin ? 'is-flagged' : '' }))));
  if (cov.some((c) => c.undeclared)) {
    panel.append(h('p', 'muted',
      'Where "can cover" is not recorded, people have still worked the role — '
      + 'the capability list is behind the roster, not a gap in staffing.'));
  }

  const bar = h('div', 'filter-bar so-gap-top');
  const inact = h('button', `chip${showInactive ? ' is-active' : ''}`);
  inact.type = 'button'; inact.textContent = 'Include inactive';
  inact.addEventListener('click', () => go({ inactive: showInactive ? 'off' : 'on' }));
  bar.append(inact);
  panel.append(bar);
  if (never.length) {
    panel.append(h('div', 'mg-notice',
      `<strong>${never.length} active ${never.length === 1 ? 'person has' : 'people have'}
       no scheduled shift on record.</strong> That may mean they are new, or that
       they have left and the roster has not caught up — the data does not say which.`));
  }
  panel.append(table([
    { label: 'Name', cell: (r) => `${esc(r.name)}${r.active ? '' : ' <span class="dim">(inactive)</span>'}` },
    { label: 'Shifts', cls: 'num', cell: (r) => int(r.shifts) },
    { label: 'Last worked', cell: (r) => (r.lastWorked ? dateShort(r.lastWorked) : '<span class="dim">never</span>') },
    { label: 'Roles worked', cell: (r) => (r.roles.length ? r.roles.map(esc).join(', ') : DASH) },
    { label: 'Can also do', cell: (r) => (r.canDo.length ? `<span class="dim">${r.canDo.map(esc).join(', ')}</span>` : DASH) },
  ], visible));
  panel.append(h('p', 'muted', `${visible.length} shown of ${rows.length} on the books.`));
  root.append(panel);
}

/* ---- Overview ------------------------------------------------------------- */

const SORTS = {
  name: (r) => r.name, role: (r) => r.primaryRole, hall: (r) => r.homeHall,
  shifts: (r) => r.shifts, scheduled: (r) => r.scheduled, actual: (r) => r.actual,
  regular: (r) => r.regular, ot1_5: (r) => r.ot1_5, ot2_0: (r) => r.ot2_0,
  premiumHours: (r) => r.premiumHours, daysOut: (r) => r.daysOut,
  commission: (r) => r.commission, rateAdj: (r) => r.rateAdj, otAdj: (r) => r.otAdj,
};

function hallNames(data) {
  const map = resolveHalls(data.locations ?? []);
  const name = (slug) => {
    if (!slug) return DASH;
    const id = map.get(slug);
    return (data.locations ?? []).find((l) => l.id === id)?.name ?? String(slug).toUpperCase();
  };
  return name;
}

function renderOverview(root, data, sched, params, go) {
  const hallName = hallNames(data);
  const flagged = new Set(sessionRows({
    payouts: sched.commissionPayouts ?? [], sessions: sched.sessions ?? [],
    staff: sched.staff ?? [], rpaDefaults: sched.rpaDefaults ?? [],
  }).filter((r) => r.flags.length).map((r) => r.id));

  const m = buildStaffOverview(sched, {
    period: params.period || null,
    hall: params.hall || 'all',
    role: params.role || 'all',
    activeOnly: params.activity !== 'off',
    complianceOnly: params.compliance === 'on',
    excludedPayoutSessions: flagged,
  });

  /* ---- heading and data window ---- */
  const head = h('section', 'panel so-head');
  head.append(h('h3', 'panel-title', 'Staff overview'));
  if (!m.window) {
    head.append(h('div', 'placeholder', `<p class="semi">No scheduled shifts</p>
      <p class="dim">The scheduler has no assignments to measure yet.</p>`));
    root.append(head);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const todays = payPeriod(today);
  const usingDefault = !params.period;
  head.append(h('p', 'so-facts', `
    <span><strong>Scheduler data:</strong> ${dateShort(m.window.start)} – ${dateShort(m.window.end)} ${m.window.end.slice(0, 4)}</span>
    <span><strong>Workweek:</strong> Monday–Sunday</span>
    <span><strong>Counted:</strong> ${COUNTED_STATUSES.join(' and ')} sessions</span>`));
  head.append(h('p', 'muted so-small',
    'The scheduler computes overtime on a Sunday workweek. This screen uses Monday, '
    + 'which is the confirmed workweek, so overtime here will not match the scheduler '
    + 'for anyone who works across a weekend — that difference is the scheduler being '
    + 'on the wrong boundary.'));
  if (usingDefault && todays.key !== m.period.key) {
    head.append(h('p', 'muted so-small',
      `Showing ${m.period.label}, the latest pay period with any assignment — not today's
       (${todays.label}). The scheduler's data ends ${dateShort(m.window.end)}.`));
  }

  /* ---- filters ---- */
  const bar = h('div', 'filter-bar so-filters');
  const prev = h('button', 'chip'); prev.type = 'button'; prev.textContent = '‹ Previous';
  prev.setAttribute('aria-label', `Previous pay period, ${m.periods.prev.label}`);
  prev.addEventListener('click', () => go({ period: m.periods.prev.start }));
  const next = h('button', 'chip'); next.type = 'button'; next.textContent = 'Next ›';
  next.setAttribute('aria-label', `Next pay period, ${m.periods.next.label}`);
  next.addEventListener('click', () => go({ period: m.periods.next.start }));
  const label = h('span', 'so-period', `<span class="dim">Pay period</span> ${m.period.label}`);
  bar.append(prev, label, next);

  const select = (name, value, options, aria) => {
    const s = h('select', 'so-select');
    s.setAttribute('aria-label', aria);
    for (const [v, t] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t; if (v === value) o.selected = true;
      s.append(o);
    }
    s.addEventListener('change', () => go({ [name]: s.value }));
    return s;
  };
  const halls = [...new Set((sched.sessions ?? []).map((s) => s.hall_id).filter(Boolean))].sort();
  bar.append(select('hall', params.hall || 'all',
    [['all', 'All venues'], ...halls.map((x) => [x, hallName(x)])], 'Venue'));
  bar.append(select('role', params.role || 'all',
    [['all', 'All roles'], ...(sched.roles ?? []).map((r) => [r.id, r.name ?? 'Unnamed role'])], 'Role'));
  const chip = (text, on, patch) => {
    const b = h('button', `chip${on ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = text;
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => go(patch));
    return b;
  };
  const activity = params.activity !== 'off';
  const compliance = params.compliance === 'on';
  bar.append(chip('Only people with activity', activity, { activity: activity ? 'off' : 'on' }));
  bar.append(chip('Compliance issues only', compliance, { compliance: compliance ? 'off' : 'on' }));
  head.append(bar);
  root.append(head);

  /* ---- KPI strip (§22.1.3) ---- */
  const k = m.kpis;
  const covTone = k.coverage === null ? '' : k.coverage < 0.9 ? 'so-tone-bad'
    : k.coverage < 1 ? 'so-tone-warn' : '';
  const kpis = h('div', 'so-kpis');
  kpis.innerHTML = `
    <div class="kpi"><span class="kpi-label">Scheduled hours</span>
      <span class="kpi-value">${hrs(k.scheduled)}</span>
      <span class="kpi-sub muted">${k.noEnd
        ? `${int(k.noEnd)} shift${k.noEnd === 1 ? '' : 's'} had no end time and ${k.noEnd === 1 ? 'is' : 'are'} not in this total`
        : 'every shift had an end time'}</span></div>
    <div class="kpi"><span class="kpi-label">Actual hours</span>
      ${k.actual === null
        ? `<span class="kpi-value so-dormant">Not yet recorded</span>
           <span class="kpi-sub muted">${m.entriesInPeriod
             ? `${int(m.entriesInPeriod)} time entr${m.entriesInPeriod === 1 ? 'y' : 'ies'}, none with hours above zero`
             : 'no time entries in this period'}</span>`
        : `<span class="kpi-value">${hrs(k.actual)}</span>
           <span class="kpi-sub muted">from time entries with hours recorded</span>`}</div>
    <div class="kpi"><span class="kpi-label">Overtime hours</span>
      <span class="kpi-value">${hrs(k.ot)}</span>
      <span class="kpi-sub muted">${hrs(k.ot1_5)} at 1.5× · ${hrs(k.ot2_0)} at 2×</span></div>
    <div class="kpi"><span class="kpi-label">Break premium hours</span>
      <span class="kpi-value">${k.actual === null ? `<span class="so-dormant">${DASH}</span>` : hrs(k.premiumHours)}</span>
      <span class="kpi-sub muted">${k.actual === null ? 'needs recorded hours' : 'hours owed, not dollars'}</span></div>
    <div class="kpi"><span class="kpi-label">Days out of compliance</span>
      <span class="kpi-value">${k.actual === null ? `<span class="so-dormant">${DASH}</span>` : int(k.daysOut)}</span>
      <span class="kpi-sub muted">${k.actual === null ? 'needs recorded hours' : 'any meal or rest violation'}</span></div>
    <div class="kpi"><span class="kpi-label">Coverage</span>
      <span class="kpi-value ${covTone}">${k.coverage === null ? DASH : pct(k.coverage, { decimals: 0 })}</span>
      <span class="kpi-sub muted">${k.needed ? `${int(k.filledCapped)} of ${int(k.needed)} needed places filled` : 'no staffing needs for these sessions'}</span></div>`;
  root.append(kpis);

  /* ---- what is not counted ---- */
  const notes = [];
  const nc = Object.entries(m.notCounted);
  if (nc.length) {
    const n = nc.reduce((t, [, v]) => t + v, 0);
    const what = nc.length === 1
      ? `${int(n)} shift${n === 1 ? '' : 's'} on ${esc(nc[0][0])} sessions ${n === 1 ? 'is' : 'are'} not counted.`
      : `${int(n)} shifts are not counted (${nc.map(([st, v]) => `${esc(st)} ${int(v)}`).join(', ')}).`;
    notes.push(`<strong>${what}</strong> What draft, planned and
      deployed mean is not defined anywhere in the scheduler (Q26); this screen treats deployed and
      planned as scheduled and leaves drafts out of every figure.`);
  }
  if (m.unstaffedSessions) {
    notes.push(`${int(m.unstaffedSessions)} counted session${m.unstaffedSessions === 1 ? ' has' : 's have'} no
      assignments at all and ${m.unstaffedSessions === 1 ? 'is' : 'are'} left out of coverage — the scheduler
      was not used to staff ${m.unstaffedSessions === 1 ? 'it' : 'them'}, which is not the same as nobody turning up.`);
  }
  if (flagged.size) {
    notes.push(`Commission leaves out ${flagged.size} session${flagged.size === 1 ? '' : 's'} flagged as test
      data on the Commission screen.`);
  }
  if (m.hall) {
    notes.push(`Venue filter: hours and shifts are for ${esc(hallName(m.hall))} only. Overtime is still
      classified on each person's whole week across both venues — the law counts the employer, not
      the hall — and shown for the days they worked here.`);
  }
  if (m.role) {
    notes.push('Role filter: shifts, scheduled hours and coverage are for that role only. Overtime and '
      + 'compliance are per person, so they stay whole for the people shown.');
  }
  if (notes.length) root.append(h('div', 'mg-notice so-notes', notes.map((n) => `<p>${n}</p>`).join('')));

  /* ---- roster (§22.1.6) ---- */
  root.append(rosterPanel(m, params, go, hallName));

  /* ---- OT by cause + coverage ---- */
  const grid = h('div', 'so-grid');
  grid.append(causePanel(m), coveragePanel(m, hallName));
  root.append(grid);

  /* ---- compliance detail ---- */
  root.append(compliancePanel(m, hallName));

  /* ---- scheduled vs actual, seventh day ---- */
  const grid2 = h('div', 'so-grid');
  grid2.append(dumbbellPanel(m), seventhPanel(m));
  root.append(grid2);
}

function rosterPanel(m, params, go, hallName) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Roster'));
  if (!m.rows.length) {
    panel.append(h('div', 'placeholder', `<p class="semi">Nobody to show</p>
      <p class="dim">No one matches these filters in ${m.period.label}.</p>`));
    return panel;
  }
  const sortKey = SORTS[params.sort] ? params.sort : 'scheduled';
  const desc = params.dir ? params.dir !== 'asc' : !['name', 'role', 'hall'].includes(sortKey);
  const rows = sortRows(m.rows, SORTS[sortKey], desc);
  const yMax = Math.max(0, ...rows.flatMap((r) => r.weekly));

  const basisCell = (r) => {
    if (!r.basis) return `<span class="dim">${DASH}</span>`;
    if (r.basis === 'mixed') return `<span class="so-basis">mixed</span> <span class="dim">${r.basisDays.actual} actual, ${r.basisDays.scheduled} sched.</span>`;
    return `<span class="so-basis">${r.basis}</span>`;
  };
  const cols = [
    { key: 'name', label: 'Name', cls: 'name', cell: (r) => `${esc(r.name)}${r.known ? (r.active ? '' : ' <span class="dim">(inactive)</span>') : ' <span class="dim">(not on roster)</span>'}` },
    { key: 'role', label: 'Role', cls: 'name', cell: (r) => (r.primaryRole ? esc(r.primaryRole) : DASH) },
    { key: 'hall', label: 'Home venue', cls: 'name', cell: (r) => (r.homeHall ? esc(hallName(r.homeHall)) : DASH) },
    { key: 'shifts', label: 'Shifts', cls: 'num', cell: (r) => int(r.shifts) },
    { key: 'scheduled', label: 'Sched. h', cls: 'num', cell: (r) => `${hrs(r.scheduled)}${r.unmeasured ? ` <span class="dim" title="shifts with no end time">+${r.unmeasured}?</span>` : ''}` },
    { key: 'actual', label: 'Actual h', cls: 'num', cell: (r) => (r.actual === null ? '<span class="dim">not recorded</span>' : hrs(r.actual)) },
    { label: 'OT basis', cls: 'name', cell: basisCell },
    { key: 'regular', label: 'Regular', cls: 'num', cell: (r) => hrs(r.regular) },
    { key: 'ot1_5', label: '1.5×', cls: 'num', cell: (r) => hrs(r.ot1_5) },
    { key: 'ot2_0', label: '2×', cls: 'num', cell: (r) => hrs(r.ot2_0) },
    { key: 'premiumHours', label: 'Premium h', cls: 'num', cell: (r) => (r.actual === null ? DASH : hrs(r.premiumHours)) },
    { key: 'daysOut', label: 'Days out', cls: 'num', cell: (r) => (r.actual === null ? DASH : int(r.daysOut)) },
    { key: 'commission', label: 'Commission', cls: 'num', cell: (r) => (r.commission === null ? DASH : usd(r.commission)) },
    { key: 'rateAdj', label: 'rateAdj', cls: 'num', cell: (r) => (r.rateAdj === null ? DASH : `${usd2(r.rateAdj)}/h`) },
    { key: 'otAdj', label: 'otAdj', cls: 'num', cell: (r) => (r.otAdj === null ? DASH : usd2(r.otAdj)) },
    { label: 'Hours by week', cls: 'so-spark-cell', cell: (r) => sparkBars(r.weekly, m.weeks, yMax) },
  ];
  const t = h('table', 'rn-table so-roster');
  const isSorted = (c) => c.key === sortKey;
  t.innerHTML = `<thead><tr>${cols.map((c) => `<th class="${c.cls ?? ''}${isSorted(c) ? ' is-sorted' : ''}"
      ${c.key ? `data-sort="${c.key}"` : ''}
      ${isSorted(c) ? `aria-sort="${desc ? 'descending' : 'ascending'}"` : ''}>${c.label}${
      isSorted(c) ? `<span class="rn-dir">${desc ? '▼' : '▲'}</span>` : ''}</th>`).join('')}</tr></thead><tbody></tbody>`;
  const body = t.querySelector('tbody');
  for (const r of rows) {
    body.insertAdjacentHTML('beforeend', `<tr class="${r.daysOut ? 'is-flagged' : ''}">${
      cols.map((c) => `<td class="${c.cls ?? ''}">${c.cell(r)}</td>`).join('')}</tr>`);
  }
  for (const th of t.querySelectorAll('[data-sort]')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const nextDesc = key === sortKey ? !desc : !['name', 'role', 'hall'].includes(key);
      go({ sort: key, dir: nextDesc ? 'desc' : 'asc' });
    });
  }
  const wrap = h('div', 'so-scroll'); wrap.append(t);
  panel.append(wrap);
  panel.append(h('p', 'muted so-small', `${rows.length} ${rows.length === 1 ? 'person' : 'people'} ·
    hours by week share one scale (0–${hrs(yMax)} h) across every row, Monday weeks over the whole
    scheduler window · rateAdj is commission ÷ hours; otAdj is the overtime uplift on that rate.
    No base or regular rate exists in the scheduler, and none is used.`));
  return panel;
}

function causePanel(m) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Overtime by cause'));
  const tot = { daily: 0, weekly: 0, seventh: 0 };
  for (const w of m.causeWeeks) for (const c of CAUSES) tot[c.key] += w[c.key];
  const all = tot.daily + tot.weekly + tot.seventh;
  panel.append(h('div', 'so-legend', CAUSES.map((c) =>
    `<span class="so-key"><span class="so-swatch so-c-${c.key}"></span>${c.label}
      <strong>${hrs(tot[c.key])} h</strong> <span class="dim">${c.note}</span></span>`).join('')));
  if (!all) {
    panel.append(h('div', 'placeholder', `<p class="dim">No overtime in ${m.period.label} for the people shown.</p>`));
  } else {
    panel.append(h('div', 'so-chart-wrap', causeChart(m.causeWeeks)));
  }
  panel.append(h('p', 'muted so-small', 'Daily: a single day past 8 or 12 hours. Weekly: past 40 in a Monday '
    + 'week, not counting hours already paid as daily overtime. Seventh day: the seventh consecutive worked '
    + 'day of the week, all of it overtime.'));
  return panel;
}

function coveragePanel(m, hallName) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Coverage by role and slot'));
  const slots = [...m.coverage.bySlot].sort((a, b) => b.short - a.short || b.over - a.over
    || String(a.hall).localeCompare(String(b.hall)) || (a.dow ?? 0) - (b.dow ?? 0));
  if (!slots.length) {
    panel.append(h('div', 'placeholder', `<p class="dim">No staffed sessions in ${m.period.label}.</p>`));
    return panel;
  }
  panel.append(table([
    { label: 'Slot', cls: 'name', cell: (r) => `${esc(hallName(r.hall))} · ${r.dow === null ? DASH : DOW[r.dow]} ${esc(r.part ?? '')}` },
    { label: 'Role', cls: 'name', cell: (r) => esc(r.role) },
    { label: 'Sessions', cls: 'num', cell: (r) => int(r.sessions) },
    { label: 'Needed', cls: 'num', cell: (r) => int(r.needed) },
    { label: 'Filled', cls: 'num', cell: (r) => int(r.filled) },
    { label: 'Short', cls: 'num', cell: (r) => (r.short ? `<span class="tone-neg">${int(r.short)}</span>` : '<span class="dim">0</span>') },
    { label: 'Over', cls: 'num', cell: (r) => (r.over ? `<span class="so-over">+${int(r.over)}</span>` : '<span class="dim">0</span>') },
    { label: '', cls: 'so-meter-cell', cell: (r) => meter(r.needed, r.filled) },
  ], slots));
  panel.append(h('p', 'muted so-small', `Needed comes from the hall's staffing template for that weekday and
    part, overridden per session where the scheduler has one. Filled counts people, not trainees
    (${int(m.coverage.totals.training)} training place${m.coverage.totals.training === 1 ? '' : 's'} not counted).
    Over-staffing is shown on its own and never offsets a shortfall in the overall figure.`));
  return panel;
}

function compliancePanel(m, hallName) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Break compliance detail'));
  if (m.kpis.actual === null) {
    panel.append(h('div', 'placeholder', `<p class="semi">Dormant until hours are recorded</p>
      <p class="dim">Meal and rest rules depend on hours worked. ${m.entriesInPeriod
        ? `${int(m.entriesInPeriod)} time entr${m.entriesInPeriod === 1 ? 'y exists' : 'ies exist'} in this period, but none
           records hours above zero — the clocked rows are zero-length test punches, and a zero is
           treated as not recorded.`
        : 'There are no time entries in this period.'}</p>`));
    return panel;
  }
  if (!m.violations.length) {
    panel.append(h('div', 'placeholder', `<p class="dim">No meal or rest violations in ${m.period.label}.</p>`));
  } else {
    panel.append(table([
      { label: 'Person', cls: 'name', cell: (r) => esc(r.name) },
      { label: 'Date', cls: 'name', cell: (r) => dateShort(r.date) },
      { label: 'Session', cls: 'name', cell: (r) => `${esc(hallName(r.hall))}${r.part ? ` · ${esc(r.part)}` : ''}` },
      { label: 'Rule', cls: 'name', cell: (r) => KIND[r.kind] },
      { label: 'Type', cls: 'name', cell: (r) => TYPE[r.type] },
      { label: 'Premium h', cls: 'num', cell: (r) => (r.premiumHours ? hrs(r.premiumHours) : '<span class="dim">0 (capped)</span>') },
    ], m.violations));
  }
  const unk = [];
  if (m.mealTimingUnknown) unk.push(`${int(m.mealTimingUnknown)} meal${m.mealTimingUnknown === 1 ? ' was' : 's were'} taken with no recorded start time, so lateness could not be tested — counted as taken, timing unknown`);
  if (m.restUnknown) unk.push(`${int(m.restUnknown)} entr${m.restUnknown === 1 ? 'y has' : 'ies have'} no rest-break count and ${m.restUnknown === 1 ? 'was' : 'were'} not tested for rest`);
  unk.push('a second meal has no start-time column, so it can never be found late');
  panel.append(h('p', 'muted so-small', `${unk.join('; ')}. One premium hour per day for any meal violation and one for any rest violation, at most two.`));
  return panel;
}

function dumbbellPanel(m) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Scheduled versus actual'));
  if (!m.dumbbell.length) {
    panel.append(h('div', 'placeholder', `<p class="semi">Dormant</p>
      <p class="dim">Needs people with both scheduled hours and recorded actual hours in the
      period. ${m.kpis.actual === null ? 'No actual hours are recorded yet.' : 'Nobody shown has both.'}
      The scheduler never computes this variance; this panel will, once there is something to compare.</p>`));
    return panel;
  }
  const rows = [...m.dumbbell].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  panel.append(h('div', 'so-legend', `<span class="so-key"><span class="so-dot so-db-sched"></span>Scheduled</span>
    <span class="so-key"><span class="so-dot so-db-act"></span>Actual</span>`));
  panel.append(h('div', 'so-chart-wrap', dumbbell(rows)));
  return panel;
}

function seventhPanel(m) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Seventh consecutive day scheduled'));
  if (!m.seventh.length) {
    panel.append(h('p', 'muted', `Nobody is scheduled all seven days of a Monday–Sunday week overlapping
      ${m.period.label}.`));
  } else {
    panel.append(table([
      { label: 'Person', cls: 'name', cell: (r) => esc(r.name) },
      { label: 'Week', cls: 'name', cell: (r) => `${dateShort(r.weekStart)} – ${dateShort(r.weekEnd)}` },
    ], m.seventh.map((r) => ({ ...r, _cls: 'is-flagged' }))));
  }
  panel.append(h('p', 'muted so-small', 'The scheduler has a guard for this but never calls it when an '
    + 'assignment is saved (open question 28), so it is reported here after the fact.'));
  return panel;
}


/* ---- Worked (from the data validator) ------------------------------------- */

const HALL_ORDER = ['sc', 'rwc'];

/** "12 Aug – 1 Oct 2026", or one date. */
const spanText = (a, b) => (a === b ? `${dateShort(a)} ${a.slice(0, 4)}`
  : `${dateShort(a)}${a.slice(0, 4) === b.slice(0, 4) ? '' : ` ${a.slice(0, 4)}`} – ${dateShort(b)} ${b.slice(0, 4)}`);

const MATCH_NOTE = {
  none: 'not matched to the scheduler',
  ambiguous: 'more than one scheduler person has this name',
};

function renderWorked(root, data, sched, params, go) {
  const crew = data.crew;
  const head = h('section', 'panel so-head');
  head.append(h('h3', 'panel-title', 'Worked — from the data validator'));
  if (!crew?.ok) {
    head.append(h('div', 'placeholder', `<p class="semi">Validator not connected</p>
      <p class="dim">The data validator could not be read, so who worked each night is not shown.
      The scheduler's figures on the Overview tab are unaffected.</p>`));
    root.append(head);
    return;
  }
  const cov = crew.coverage;
  if (!crew.sessions.length) {
    head.append(h('div', 'placeholder', `<p class="semi">No validator sessions yet</p>
      <p class="dim">Nothing has been entered in the data validator.</p>`));
    root.append(head);
    return;
  }
  const hallName = hallNames(data);
  const roleNameOf = new Map((sched.roles ?? []).map((r) => [r.id, r.name]));
  const roleName = params.role && params.role !== 'all' ? (roleNameOf.get(params.role) ?? null) : null;
  const latest = latestValidatorPeriod(crew);
  const w = buildWorked(crew, { period: params.period || latest.start, hall: params.hall || 'all', role: roleName ?? 'all' });

  head.append(h('p', 'so-facts', `
    <span><strong>Validator data:</strong> ${spanText(cov.first, cov.last)}</span>
    <span><strong>Sessions:</strong> ${int(cov.rows)} (${int(cov.closed)} closed, ${int(cov.open)} open)</span>
    <span><strong>Crew lists approved:</strong> ${int(cov.approved)} of ${int(cov.rows)}</span>`));
  head.append(h('div', 'mg-notice', `<strong>Hours and overtime still come from the scheduler only.</strong>
    The validator records who was on each night's crew and in which role — not when anyone started or
    finished — so this tab counts sessions, never hours.`));
  if (!params.period) {
    head.append(h('p', 'muted so-small', `Showing ${w.period.label}, the latest pay period with an approved crew list.`));
  }

  const bar = h('div', 'filter-bar so-filters');
  const nav = (text, p, aria) => {
    const b = h('button', 'chip'); b.type = 'button'; b.textContent = text;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', () => go({ period: p.start }));
    return b;
  };
  bar.append(nav('‹ Previous', w.periods.prev, `Previous pay period, ${w.periods.prev.label}`),
    h('span', 'so-period', `<span class="dim">Pay period</span> ${w.period.label}`),
    nav('Next ›', w.periods.next, `Next pay period, ${w.periods.next.label}`));
  const select = (name, value, options, aria) => {
    const sel = h('select', 'so-select');
    sel.setAttribute('aria-label', aria);
    for (const [v, t] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t; if (v === value) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => go({ [name]: sel.value }));
    return sel;
  };
  const rank = (x) => (HALL_ORDER.includes(x) ? HALL_ORDER.indexOf(x) : HALL_ORDER.length);
  const halls = [...new Set(crew.sessions.map((x) => x.hall))]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  bar.append(select('hall', params.hall || 'all', [['all', 'All venues'], ...halls.map((x) => [x, hallName(x)])], 'Venue'));
  bar.append(select('role', params.role || 'all',
    [['all', 'All roles'], ...(sched.roles ?? []).map((r) => [r.id, r.name ?? 'Unnamed role'])], 'Role'));
  head.append(bar);
  root.append(head);

  /* ---- KPIs ---- */
  const t = w.totals;
  const kpis = h('div', 'so-kpis wk-top');
  kpis.innerHTML = `
    <div class="kpi"><span class="kpi-label">People</span>
      <span class="kpi-value">${int(t.people)}</span>
      <span class="kpi-sub muted">${int(t.unmatchedPeople)} not matched to the scheduler</span></div>
    <div class="kpi"><span class="kpi-label">Sessions</span>
      <span class="kpi-value">${int(t.sessions)}</span>
      <span class="kpi-sub muted">${t.notApproved ? `${int(t.notApproved)} crew list${t.notApproved === 1 ? '' : 's'} not yet approved` : 'every crew list approved'}</span></div>
    <div class="kpi"><span class="kpi-label">Places worked</span>
      <span class="kpi-value">${int(t.places)}</span>
      <span class="kpi-sub muted">one person in one role on one night</span></div>`;
  root.append(kpis);

  /* ---- per person ---- */
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Sessions worked'));
  if (!w.rows.length) {
    panel.append(h('div', 'placeholder', `<p class="semi">Nobody to show</p>
      <p class="dim">No validator crew matches these filters in ${w.period.label}.</p>`));
  } else {
    panel.append(h('p', 'wk-roles muted so-small', w.roles.map((r) =>
      `<span><strong>${int(t.byRole[r])}</strong> ${esc(r)}</span>`).join('')));
    const roles = [...VALIDATOR_ROLES.filter((r) => w.roles.includes(r)), ...w.roles.filter((r) => !VALIDATOR_ROLES.includes(r))];
    const cols = [
      { label: 'Name', cls: 'name', cell: (r) => `${esc(r.name)}${MATCH_NOTE[r.match]
        ? ` <span class="dim">(${MATCH_NOTE[r.match]})</span>` : ''}` },
      { label: 'Sessions', cls: 'num', cell: (r) => `${int(r.sessions)}${r.notApproved
        ? ` <span class="dim" title="crew lists not yet approved">(${int(r.notApproved)} pending)</span>` : ''}` },
      ...roles.map((role) => ({ label: esc(role), cls: 'num',
        cell: (r) => (r.byRole[role] ? int(r.byRole[role]) : '<span class="dim">·</span>') })),
      ...w.halls.map((hl) => ({ label: esc(hallName(hl)), cls: 'num',
        cell: (r) => (r.byHall[hl] ? int(r.byHall[hl]) : '<span class="dim">·</span>') })),
      { label: 'First', cls: 'name', cell: (r) => dateShort(r.first) },
      { label: 'Last', cls: 'name', cell: (r) => dateShort(r.last) },
    ];
    const wrap = h('div', 'so-scroll'); wrap.append(table(cols, w.rows));
    panel.append(wrap);
    panel.append(h('p', 'muted so-small', `${int(w.rows.length)} ${w.rows.length === 1 ? 'person' : 'people'} ·
      a role column counts the sessions worked in that role, so someone on two roles in one night counts
      once under each and once in Sessions.`));
  }
  root.append(panel);

  /* ---- scheduled vs worked ---- */
  root.append(scheduledVsWorkedPanel(crew, sched, w, hallName, go));

  /* ---- the owner's name rule, then the Flash Runner hints it leaves alone ---- */
  const merged = nameMergePanel(crew.names);
  if (merged) root.append(merged);
  root.append(duplicatesPanel(crew, hallName));
}

function scheduledVsWorkedPanel(crew, sched, w, hallName, go) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Scheduled versus worked'));
  const all = scheduledVsWorked({ crew, schedule: sched });
  if (!all.span) {
    panel.append(h('div', 'placeholder', `<p class="dim">The scheduler and the validator do not cover any of
      the same sessions, so there is nothing to compare.</p>`));
    return panel;
  }
  const c = scheduledVsWorked({ crew, schedule: sched, period: w.period, hall: w.hall });
  panel.append(h('p', 'muted so-small', `Both sources cover ${spanText(all.span.start, all.span.end)}. People are
    compared only where a validator name matches exactly one scheduler name; a name that matches nobody is
    listed separately and counted in neither direction, since it may be a scheduled person under another
    spelling. Draft sessions and training places are left out.`));
  if (!c.compared && !c.clashes.length) {
    const box = h('div', 'placeholder', `<p class="dim">No session in ${w.period.label} is covered by both.</p>`);
    const b = h('button', 'chip'); b.type = 'button';
    b.textContent = `Show ${payPeriod(all.span.end).label}`;
    b.addEventListener('click', () => go({ period: payPeriod(all.span.end).start }));
    box.append(b);
    panel.append(box);
    return panel;
  }
  const kpis = h('div', 'so-kpis wk-kpis');
  kpis.innerHTML = `
    <div class="kpi"><span class="kpi-label">Sessions compared</span><span class="kpi-value">${int(c.compared)}</span>
      <span class="kpi-sub muted">${c.clashes.length ? `${int(c.clashes.length)} day${c.clashes.length === 1 ? '' : 's'} not compared: session counts differ` : 'every shared day compared'}</span></div>
    <div class="kpi"><span class="kpi-label">On both</span><span class="kpi-value">${int(c.both)}</span>
      <span class="kpi-sub muted">scheduled and on the crew</span></div>
    <div class="kpi"><span class="kpi-label">Scheduled, not on crew</span><span class="kpi-value">${int(c.scheduledOnly.length)}</span>
      <span class="kpi-sub muted">${c.scheduledOnly.some((x) => x.maybeUnmatched) ? 'on nights with unmatched names' : 'by exact name match'}</span></div>
    <div class="kpi"><span class="kpi-label">On crew, not scheduled</span><span class="kpi-value">${int(c.workedOnly.length)}</span>
      <span class="kpi-sub muted">matched names only</span></div>
    <div class="kpi"><span class="kpi-label">Unmatched names</span><span class="kpi-value">${int(c.unmatched.length)}</span>
      <span class="kpi-sub muted">${c.possiblePairs ? `${int(c.possiblePairs)} with a likely scheduled person` : 'not counted either way'}</span></div>`;
  panel.append(kpis);
  const when = (r) => `${DOW[new Date(`${r.date}T00:00:00Z`).getUTCDay()]} ${dateShort(r.date)}`;
  const where = (r) => `${esc(hallName(r.hall))}${r.time ? ` · ${esc(r.time)}` : ''}`;
  const list = (title, rows, cols) => {
    if (!rows.length) return;
    const d = h('details', 'fc-details');
    d.append(h('summary', 'semi', `${title} (${int(rows.length)})`));
    const wrap = h('div', 'so-scroll'); wrap.append(table(cols, rows));
    d.append(wrap);
    panel.append(d);
  };
  list('Scheduled, not on the validator crew', c.scheduledOnly, [
    { label: 'Date', cls: 'name', cell: when }, { label: 'Session', cls: 'name', cell: where },
    { label: 'Person', cls: 'name', cell: (r) => esc(r.name) },
    { label: 'Scheduled as', cls: 'name', cell: (r) => r.roles.map(esc).join(', ') },
    { label: 'Possibly on the crew as', cls: 'name', cell: (r) => (r.possibly ? esc(r.possibly) : DASH) },
  ]);
  list('On the validator crew, not scheduled', c.workedOnly, [
    { label: 'Date', cls: 'name', cell: when }, { label: 'Session', cls: 'name', cell: where },
    { label: 'Person', cls: 'name', cell: (r) => esc(r.name) },
    { label: 'Worked as', cls: 'name', cell: (r) => r.roles.map(esc).join(', ') },
  ]);
  list('Validator names that match no scheduler person', c.unmatched, [
    { label: 'Date', cls: 'name', cell: when }, { label: 'Session', cls: 'name', cell: where },
    { label: 'Name on crew', cls: 'name', cell: (r) => esc(r.name) },
    { label: 'Role', cls: 'name', cell: (r) => esc(r.role) },
    { label: 'Possibly', cls: 'name', cell: (r) => (r.possibly ? `${esc(r.possibly)} <span class="dim">(scheduled that night)</span>` : DASH) },
  ]);
  list('Days not compared', c.clashes, [
    { label: 'Date', cls: 'name', cell: when },
    { label: 'Venue', cls: 'name', cell: (r) => esc(hallName(r.hall)) },
    { label: 'Scheduler sessions', cls: 'num', cell: (r) => int(r.scheduled) },
    { label: 'Validator sessions', cls: 'num', cell: (r) => int(r.validator) },
  ]);
  return panel;
}

function duplicatesPanel(crew, hallName) {
  const panel = h('section', 'panel');
  const except = crew.names?.rule?.mergeByFirstName ? (crew.names.except ?? []) : [];
  const only = except.length ? ` — ${except.join(', ')}` : '';
  panel.append(h('h3', 'panel-title', `Possible duplicate names${esc(only)}`));
  const d = crew.duplicates;
  if (!d.length) {
    panel.append(h('p', 'muted', `No likely duplicates among the ${except.length
      ? `${esc(except.join(', '))} names` : 'names'} typed into the validator.`));
    return panel;
  }
  panel.append(h('p', 'muted so-small', `A one-word name that is the first word of exactly one longer name at the
    same venue in the same role. ${except.length ? `Only ${esc(except.join(', '))} are listed: the owner's name
    rule merges every other role (see Merged names above) but not these. ` : ''}These are shown for review and
    are NOT merged: each still counts as its own person everywhere in SAR until the names are corrected in the
    validator.`));
  const wrap = h('div', 'so-scroll');
  wrap.append(table([
    { label: 'Short name', cls: 'name', cell: (r) => esc(r.short.name) },
    { label: 'Longer name', cls: 'name', cell: (r) => esc(r.long.name) },
    { label: 'Where', cls: 'name', cell: (r) => r.where.map((x) => `${esc(hallName(x.hall))} · ${esc(x.role)}
      <span class="dim">(${int(x.shortEntries)} and ${int(x.longEntries)})</span>`).join('<br>') },
  ], d));
  panel.append(wrap);
  panel.append(h('p', 'muted so-small', `${int(d.length)} pair${d.length === 1 ? '' : 's'} · the counts are crew
    entries under each spelling.`));
  return panel;
}
