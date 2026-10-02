/* ============================================================================
   SAR 2.0 — Managers

   Performance by the person who ran the night, normalized so a Friday is
   judged against Fridays. Built against SAR2-MANAGERS-DESIGN.md.

   Three tabs:

     Overview    one block per role, one row per person, ranked when it can be
     Person      one person, every session, and the SHAPE OF THEIR ROSTER
     Day shape   the normalization itself, made inspectable

   WHY THE SCORE IS A Z AND NOT A PERCENTAGE. Measured on production: the
   within-slot coefficient of variation runs 0.144 on Saturday-late to 0.237 on
   Monday, a 1.6x range. So +10% on a steady Friday is a bigger achievement
   than +10% on a volatile Monday, and only dividing by each slot's own spread
   makes the two addable. DESIGN §4.3.

   WHY THE HEADLINE SCORE SUBTRACTS THE PERIOD. Verifying against production
   showed nineteen of twenty-two sessions in the roster fortnight scoring
   positive, with the all-session mean at +0.67 sigma — both halls were simply
   running hot. A raw score would have ranked whoever was on the roster during
   a good month. The Score column is the night MINUS how everything else was
   doing at the time; "vs typical" keeps the uncorrected figure beside it.

   WHY NOBODY IS RANKED YET. Sixteen sessions carry both a roster and a result.
   The largest single sample is nine. At n=9 the 95% interval is +/-0.65 sigma.
   The screen shows the scores, shows the intervals, and refuses to order them.
   That refusal is the feature, not a placeholder. DESIGN §5.
   ========================================================================== */

import { metricsFor, sessionTotals, getMetric } from '../lib/model.js';
import {
  buildManagerModel, daySlots, separable,
  METRICS, ROLE_METRIC, RATE_ROLES, metricByKey,
  MIN_RANK_SESSIONS, SLOT_WINDOW_DAYS, BALANCE_TOLERANCE_CENTS,
} from '../lib/managers.js';
import { usd, usd2, pct, int, dateShort, weekday, sessionType, esc, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';
import { nameMergePanel } from '../components/name-merge.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'person', label: 'Person' },
  { id: 'dayshape', label: 'Day shape' },
];

const ROLES = ['MOD', 'Paymaster', 'Flash Manager'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---------------------------------------------------------------------------
   Reading the metric store
--------------------------------------------------------------------------- */

/**
 * Everything a session is scored on, in one pass.
 *
 * Money stays in cents. `variance` is signed here and made absolute inside the
 * model — a till $500 over is as wrong as one $500 short, and the two must not
 * be allowed to cancel.
 */
export function makeValuesOf(data) {
  return (e) => {
    const m = metricsFor(e.id, data.metrics, data.idx);
    const t = sessionTotals(m, data.categories);
    const flash = t.categories.find((c) => /flash/i.test(c.key) || /flash/i.test(c.name ?? ''));
    return {
      net: t.net,
      gross: t.revenue,
      flash: flash ? flash.revenue : null,
      rpa: t.rpa,
      attendance: t.attendance,
      margin: t.margin,
      variance: getMetric(m, 'bingo_variance'),
      // The two inputs to the sales tie-out check. `sourceSales` is the total
      // the spreadsheet reported for itself; `lineSales` is what its own line
      // items add up to. They should agree, and on 8 sessions of 2026 they
      // did not.
      lineSales: t.revenue,
      sourceSales: getMetric(m, 'source_total_sales'),
    };
  };
}

/* ---------------------------------------------------------------------------
   Score formatting
--------------------------------------------------------------------------- */

/** Sigma, signed, two decimals. Null prints a dash, never 0.00. */
function sigma(z) {
  if (z === null || z === undefined || !Number.isFinite(z)) return DASH;
  return `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(2)}σ`;
}

function band(z) {
  if (z === null || z === undefined || !Number.isFinite(z)) return '';
  if (z >= 0.5) return 'st-good';
  if (z <= -0.5) return 'st-poor';
  return 'st-fair';
}

/** The interval, always shown. A score without it is how nine nights of noise
 *  gets somebody managed out. */
function interval(r) {
  if (!r || r.score === null) return DASH;
  return `${sigma(r.lo)} to ${sigma(r.hi)}`;
}

const fmtValue = (kind, v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  if (kind === 'money') return usd(v);
  if (kind === 'rate') return pct(v);
  return int(v);
};

/* ---------------------------------------------------------------------------
   Sparkline — session scores in date order
--------------------------------------------------------------------------- */

/** Hand-rolled, as everywhere else in this project. No charting library. */
function sparkline(zs) {
  const pts = zs.filter((z) => z !== null && Number.isFinite(z));
  if (pts.length < 2) return h('span', 'spark-empty', DASH);

  const W = 76; const H = 22; const pad = 2;
  const lim = Math.max(2, ...pts.map((z) => Math.abs(z)));
  const x = (i) => pad + (i * (W - 2 * pad)) / (pts.length - 1);
  const y = (z) => H / 2 - (z / lim) * (H / 2 - pad);

  const d = pts.map((z, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(z).toFixed(1)}`).join(' ');
  const el = h('span', 'spark');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="spark-zero"/>
    <path d="${d}" class="spark-line"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1])}" r="2" class="spark-dot"/>
  </svg>`;
  el.title = `${pts.length} sessions, most recent ${sigma(pts[pts.length - 1])}`;
  return el;
}

/* ---------------------------------------------------------------------------
   Balancing — the Paymaster's table
--------------------------------------------------------------------------- */

const rate = (r) => (r === null || r === undefined || !Number.isFinite(r)
  ? DASH : `${(r * 100).toFixed(0)}%`);

/** One check's own pass rate, with the counts behind it. */
const check = (b, key) => {
  const c = b.byCheck?.find((x) => x.key === key);
  return c ? `${rate(c.rate)} <span class="dim">(${c.passed}/${c.n})</span>` : DASH;
};

/**
 * How often the books balanced.
 *
 * Two checks per session where both are recordable: the deposit against what
 * was expected, and the line items against the sheet's own total. The
 * interval is Wilson, not the normal approximation — three passes out of three
 * would otherwise print an interval of zero width and claim certainty from
 * three nights.
 */
function balanceTable(people, onNavigate) {
  const wrap = h('div');
  wrap.append(h('p', 'muted',
    `Judged on how often the pieces balance: the deposit against what was
     expected, within $${(BALANCE_TOLERANCE_CENTS / 100).toFixed(0)}, and the
     line items against the sheet's own total.`));

  const sorted = [...people].sort((a, b) => {
    if (a.balance.rate === b.balance.rate) return b.balance.checks - a.balance.checks;
    return (b.balance.rate ?? -1) - (a.balance.rate ?? -1);
  });

  const anyRankable = sorted.some((p) => p.balance.rankable);
  if (!anyRankable) {
    const best = Math.max(...sorted.map((p) => p.balance.n));
    wrap.append(h('div', 'mg-notice',
      `<strong>Not enough sessions to rank.</strong> ${MIN_RANK_SESSIONS} are needed
       per person; the most anyone has is ${best}. The intervals below are wide
       for exactly that reason.`));
  }

  const table = h('table', 'rn-table');
  table.innerHTML = `<thead><tr>
    <th class="num"></th><th>Name</th>
    <th class="num">Sessions</th>
    <th class="num">Checks</th>
    <th class="num">Balanced</th>
    <th class="num">95% interval</th>
    <th class="num">Deposit</th>
    <th class="num">Sales tie</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector('tbody');

  sorted.forEach((p, i) => {
    const b = p.balance;
    const tone = b.rate === null ? '' : (b.rate >= 0.8 ? 'st-good' : b.rate >= 0.5 ? 'st-fair' : 'st-poor');
    const tr = h('tr');
    tr.innerHTML = `
      <td class="num dim">${anyRankable && b.rankable ? i + 1 : DASH}</td>
      <td><button type="button" class="mg-name">${esc(p.name)}</button></td>
      <td class="num">${b.n}</td>
      <td class="num dim">${b.passed} of ${b.checks}</td>
      <td class="num ${tone}"><strong>${rate(b.rate)}</strong></td>
      <td class="num dim">${b.rate === null ? DASH : `${rate(b.lo)} to ${rate(b.hi)}`}</td>
      <td class="num">${check(b, 'deposit')}</td>
      <td class="num dim">${check(b, 'sales')}</td>`;
    tr.querySelector('button').addEventListener('click', () => onNavigate('managers', {
      tab: 'person', staff: p.staffId, role: p.role,
    }));
    body.append(tr);
  });
  wrap.append(table);
  return wrap;
}

/* ---------------------------------------------------------------------------
   Tab 1 — Overview
--------------------------------------------------------------------------- */

function overview(model, params, onNavigate, rerender) {
  const wrap = h('div');
  const sortKey = params.metric ?? null;

  for (const role of ROLES) {
    const people = model.people.filter((p) => p.role === role);
    const block = h('section', 'panel');
    block.append(h('h3', 'panel-title', role));

    if (!people.length) {
      block.append(h('p', 'muted', 'No attributed sessions yet'));
      block.append(h('div', 'placeholder', '<p class="dim">Nothing to show</p>'));
      wrap.append(block);
      continue;
    }

    /* The Paymaster is judged on how often the books balance, which is a rate
       and not a sigma — a till reconciles or it does not, and that is no
       harder on a busy Friday than a quiet Tuesday. */
    if (RATE_ROLES.includes(role)) {
      block.append(balanceTable(people, onNavigate));
      wrap.append(block);
      continue;
    }

    const primaryKey = ROLE_METRIC[role];
    const primary = metricByKey(primaryKey);
    block.append(h('p', 'muted',
      `Scored on ${primary.label.toLowerCase()} against the same night in other weeks.`));

    const key = sortKey ?? primaryKey;
    const rankable = people.filter((p) => p.roll[key]?.rankable);
    const sorted = [...people].sort((a, b) => {
      const ar = a.roll[key]; const br = b.roll[key];
      // Unrankable people sort by evidence, not by score — ordering them by a
      // number the screen has just declared unreliable would be incoherent.
      if (rankable.length < 2) return br.n - ar.n;
      if (ar.rankable !== br.rankable) return ar.rankable ? -1 : 1;
      return (br.score ?? -Infinity) - (ar.score ?? -Infinity);
    });

    if (rankable.length < 2) {
      const best = Math.max(...people.map((p) => p.roll[key].n));
      block.append(h('div', 'mg-notice',
        `<strong>Not enough sessions to rank.</strong> ${MIN_RANK_SESSIONS} are needed
         per person; the most anyone has in this role is ${best}. Scores below are
         real but provisional — at ${best} sessions the 95% interval is roughly
         ±${(1.96 / Math.sqrt(Math.max(1, best))).toFixed(2)}σ.`));
    }

    const table = h('table', 'rn-table');
    const cols = [
      { label: '', cls: 'num' },
      { label: 'Name' },
      { label: 'Sessions', cls: 'num' },
      { label: 'Score', cls: 'num' },
      { label: '95% interval', cls: 'num' },
      { label: 'vs typical', cls: 'num' },
      { label: 'Period', cls: 'num' },
      { label: primary.label + ' avg', cls: 'num' },
      { label: 'Trend' },
    ];
    table.innerHTML = `<thead><tr>${cols.map((c) =>
      `<th class="${c.cls ?? ''}">${c.label}</th>`).join('')}</tr></thead><tbody></tbody>`;
    const body = table.querySelector('tbody');

    sorted.forEach((p, i) => {
      const r = p.roll[key];
      const tr = h('tr');
      const prev = i > 0 ? sorted[i - 1].roll[key] : null;
      // Only print a rank when the ordering means something AND this row is
      // actually distinguishable from the one above it.
      const showRank = rankable.length >= 2 && r.rankable;
      const tied = prev && showRank && !separable(r, prev);

      const avg = p.sessions
        .map((s) => s.scores[key])
        .filter((s) => s.z !== null);

      tr.innerHTML = `
        <td class="num dim">${showRank ? i + 1 : DASH}</td>
        <td><button type="button" class="mg-name">${esc(p.name)}</button></td>
        <td class="num">${r.n}</td>
        <td class="num ${band(r.score)}">${sigma(r.score)}${
          tied ? '<span class="dim" title="not distinguishable from the row above"> =</span>' : ''}</td>
        <td class="num dim">${interval(r)}</td>
        <td class="num dim">${sigma(r.raw)}</td>
        <td class="num dim" title="how the whole business was running on those nights">${sigma(r.trend)}</td>
        <td class="num">${avg.length
          ? fmtValue(primary.kind, meanOfSessionValues(p, key, model))
          : DASH}</td>
        <td class="spark-cell"></td>`;
      tr.querySelector('.spark-cell').append(
        sparkline(p.sessions.map((s) => {
          const sc = s.scores[key];
          return Number.isFinite(sc.adj) ? sc.adj : sc.z;
        })),
      );
      tr.querySelector('button').addEventListener('click', () => onNavigate('managers', {
        tab: 'person', staff: p.staffId, role: p.role,
      }));
      body.append(tr);
    });

    block.append(table);
    wrap.append(block);
  }

  /* Metric cards double as the sort control, as on the Leaderboard. */
  const bar = h('div', 'filter-bar');
  bar.append(h('span', 'picker-label', 'Score on'));
  const roleDefault = h('button', `chip${sortKey ? '' : ' is-active'}`);
  roleDefault.type = 'button';
  roleDefault.textContent = 'Each role’s own metric';
  roleDefault.addEventListener('click', () => { play('tick'); onNavigate('managers', { ...params, metric: null }); });
  bar.append(roleDefault, h('span', 'filter-sep'));
  for (const m of METRICS) {
    const b = h('button', `chip${sortKey === m.key ? ' is-active' : ''}`);
    b.type = 'button';
    b.textContent = m.label;
    b.addEventListener('click', () => { play('tick'); onNavigate('managers', { ...params, metric: m.key }); });
    bar.append(b);
  }
  wrap.prepend(bar);
  return wrap;
}

/** Mean of the raw metric across a person's sessions, for the readable column. */
function meanOfSessionValues(person, key, model) {
  const base = model.baselines.get(key);
  const vals = person.sessions
    .map((s) => base.get(s.eventId)?.value)
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/* ---------------------------------------------------------------------------
   Tab 2 — Person
--------------------------------------------------------------------------- */

function person(model, params, data, onNavigate) {
  const wrap = h('div');
  const held = model.people.filter((p) => p.staffId === params.staff);

  if (!held.length) {
    wrap.append(h('div', 'placeholder',
      '<p class="semi">Pick somebody from the Overview</p>'));
    return wrap;
  }

  wrap.append(h('div', 'screen-head', `<h2>${esc(held[0].name)}</h2>
    <p class="muted">${held.map((p) => p.role).join(' · ')}</p>`));

  for (const p of held) {
    const block = h('section', 'panel');
    block.append(h('h3', 'panel-title', p.role));

    if (p.isRate) {
      const b = p.balance;
      block.append(h('div', 'kpis', `
        <div class="kpi"><span class="kpi-label">Sessions</span>
          <span class="kpi-value">${b.n}</span></div>
        <div class="kpi"><span class="kpi-label">Balanced</span>
          <span class="kpi-value">${rate(b.rate)}</span>
          <span class="kpi-sub">${b.passed} of ${b.checks} checks</span></div>
        <div class="kpi"><span class="kpi-label">95% interval</span>
          <span class="kpi-value dim">${b.rate === null ? DASH : `${rate(b.lo)} to ${rate(b.hi)}`}</span></div>
        <div class="kpi"><span class="kpi-label">Clean nights</span>
          <span class="kpi-value">${rate(b.cleanRate)}</span></div>`));

      const bt = h('table', 'rn-table');
      bt.innerHTML = `<thead><tr><th>Date</th><th>Hall</th><th>Session</th>
        <th>Deposit</th><th>Sales tie</th><th class="num">Out by</th><th>Crew from</th>
        </tr></thead><tbody></tbody>`;
      const bb = bt.querySelector('tbody');
      const brows = p.sessions
        .map((s) => ({ s, e: data.events.find((x) => x.id === s.eventId) }))
        .filter((x) => x.e).sort((a, b2) => (a.e.event_date < b2.e.event_date ? 1 : -1));
      for (const { s, e } of brows) {
        const dep = s.checks.find((c) => c.key === 'deposit');
        const tie = s.checks.find((c) => c.key === 'sales');
        const mark = (c) => (c ? `<span class="${c.ok ? 'st-good' : 'st-poor'}">${
          c.ok ? 'balanced' : 'off'}</span>` : DASH);
        bb.insertAdjacentHTML('beforeend', `<tr>
          <td>${weekday(e.event_date).slice(0, 3)} ${dateShort(e.event_date)}</td>
          <td>${data.locations.find((l) => l.id === e.location_id)?.name ?? DASH}</td>
          <td>${sessionType(e.event_type)}</td>
          <td>${mark(dep)}</td><td>${mark(tie)}</td>
          <td class="num">${dep ? usd2(Math.abs(dep.off)) : DASH}</td>
          <td class="dim">${crewFrom(s)}</td></tr>`);
      }
      block.append(bt);
      wrap.append(block);
      continue;
    }

    const key = ROLE_METRIC[p.role];
    const primary = metricByKey(key);
    const r = p.roll[key];

    block.append(h('div', 'kpis', `
      <div class="kpi"><span class="kpi-label">Sessions</span>
        <span class="kpi-value">${r.n}</span></div>
      <div class="kpi"><span class="kpi-label">Score</span>
        <span class="kpi-value ${band(r.score)}">${sigma(r.score)}</span>
        <span class="kpi-sub">against the period</span></div>
      <div class="kpi"><span class="kpi-label">95% interval</span>
        <span class="kpi-value dim">${interval(r)}</span></div>
      <div class="kpi"><span class="kpi-label">vs typical night</span>
        <span class="kpi-value dim">${sigma(r.raw)}</span>
        <span class="kpi-sub">business ran ${sigma(r.trend)}</span></div>
      <div class="kpi"><span class="kpi-label">Ranked</span>
        <span class="kpi-value">${r.rankable ? 'Yes' : `${r.n} of ${MIN_RANK_SESSIONS}`}</span></div>`));

    /* The roster mix. THIS IS THE POINT OF THE SCREEN: it shows which nights
       this person is given, which is exactly what the normalization corrects
       for. Somebody who only ever works Mondays should be visibly so. */
    const mix = new Map();
    for (const s of p.sessions) {
      const e = data.events.find((x) => x.id === s.eventId);
      if (!e) continue;
      const k = `${DAY_NAMES[new Date(`${e.event_date}T00:00:00Z`).getUTCDay()]} ${sessionType(e.event_type)}`;
      mix.set(k, (mix.get(k) ?? 0) + 1);
    }
    const mixEl = h('p', 'muted');
    mixEl.innerHTML = `<span class="inspector-section-label">Nights worked</span> ${
      [...mix.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ×${n}`).join(' · ') || DASH}`;
    block.append(mixEl);

    const table = h('table', 'rn-table');
    table.innerHTML = `<thead><tr>
      <th>Date</th><th>Hall</th><th>Session</th>
      <th class="num">${primary.label}</th>
      <th class="num">Typical</th>
      <th class="num">vs typical</th>
      <th class="num">Score</th><th>Crew from</th></tr></thead><tbody></tbody>`;
    const body = table.querySelector('tbody');

    const rows = p.sessions.map((s) => ({
      s, e: data.events.find((x) => x.id === s.eventId),
      b: model.baselines.get(key).get(s.eventId),
    })).filter((x) => x.e).sort((a, b) => (a.e.event_date < b.e.event_date ? 1 : -1));

    for (const { s, e, b } of rows) {
      const sc = s.scores[key];
      const z = Number.isFinite(sc.adj) ? sc.adj : sc.z;
      const hall = data.locations.find((l) => l.id === e.location_id)?.name ?? DASH;
      body.insertAdjacentHTML('beforeend', `<tr>
        <td>${weekday(e.event_date).slice(0, 3)} ${dateShort(e.event_date)}</td>
        <td>${hall}</td>
        <td>${sessionType(e.event_type)}</td>
        <td class="num">${fmtValue(primary.kind, b?.value ?? null)}</td>
        <td class="num dim">${fmtValue(primary.kind, b?.usable ? b.mean : null)}</td>
        <td class="num dim">${sigma(sc.z)}</td>
        <td class="num ${band(z)}">${sigma(z)}</td>
        <td class="dim">${crewFrom(s)}</td></tr>`);
    }
    block.append(table);
    wrap.append(block);
  }
  return wrap;
}

/* ---------------------------------------------------------------------------
   Tab 3 — Day shape
--------------------------------------------------------------------------- */

function dayshape(model, data) {
  const wrap = h('div');
  const valuesOf = makeValuesOf(data);
  const slots = daySlots(data.events, (e) => valuesOf(e).gross);

  wrap.append(h('div', 'mg-notice', `
    <strong>This is the machinery, shown.</strong> Every score on this screen is a
    session measured against its own slot — same hall, same weekday, same session
    type — over a trailing ${SLOT_WINDOW_DAYS} days. Without this table the scores
    could not be checked.`));

  const table = h('table', 'rn-table');
  table.innerHTML = `<thead><tr>
    <th>Hall</th><th>Day</th><th>Session</th>
    <th class="num">Sessions</th>
    <th class="num">Typical gross</th>
    <th class="num">Index</th>
    <th class="num">Spread</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector('tbody');

  for (const s of slots) {
    const hall = data.locations.find((l) => l.id === s.locationId)?.name ?? DASH;
    body.insertAdjacentHTML('beforeend', `<tr>
      <td>${hall}</td>
      <td>${DAY_NAMES[s.weekday]}</td>
      <td>${sessionType(s.eventType)}</td>
      <td class="num">${s.n}</td>
      <td class="num">${usd(s.mean)}</td>
      <td class="num"><strong>${s.index === null ? DASH : s.index.toFixed(2)}×</strong></td>
      <td class="num dim">${s.cv === null ? DASH : pct(s.cv)}</td></tr>`);
  }
  wrap.append(table);

  const top = slots[0]; const bot = slots[slots.length - 1];
  if (top && bot && bot.index) {
    wrap.append(h('p', 'muted',
      `The busiest slot runs ${(top.index / bot.index).toFixed(1)}× the quietest.
       Ranking managers on raw takings would rank them by which shifts they were
       given.`));
  }
  return wrap;
}

/** Where a session's crew came from, in a word or two. */
function crewFrom(s) {
  if (s.source === 'validator') return s.approved ? 'validator' : 'validator, not yet approved';
  return s.source === 'scheduler' ? 'scheduler' : DASH;
}

/**
 * Where the crews came from: the data validator where it has the night, the
 * scheduler where it does not. Counted over the span of crewed nights, so
 * "no crew" means a night inside that span that neither source covers.
 */
export function sourcesLine(model) {
  const c = model.sources;
  const el = h('p', 'mg-sources');
  if (!c || !model.sourceSpan) {
    el.textContent = 'No session has a crew from either the validator or the scheduler yet.';
    return el;
  }
  const span = model.sourceSpan;
  const n = (v, one, many) => `<strong>${int(v)}</strong> ${v === 1 ? one : many}`;
  el.innerHTML = `${n(c.validator, 'session', 'sessions')} from the validator${c.validatorProgress
    ? ` (${int(c.validatorProgress)} not yet approved)` : ''},
    ${n(c.scheduler, 'session', 'sessions')} from the scheduler,
    ${n(c.none, 'session', 'sessions')} with no crew
    <span class="dim">· ${dateShort(span.start)} ${span.start.slice(0, 4)} – ${dateShort(span.end)} ${span.end.slice(0, 4)}</span>${
    model.validator?.ok ? '' : ' <span class="dim">· validator not connected, so crews are from the scheduler only</span>'}`;
  return el;
}

function unavailablePanel() {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Roster unavailable'));
  panel.append(h('p', 'muted', 'Operations data is temporarily unavailable. Please try again later.'));
  return panel;
}

export function renderManagers({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const tab = TABS.find((t) => t.id === params.tab)?.id ?? 'overview';

  const tabs = h('div', 'rn-tabs');
  for (const t of TABS) {
    const b = h('button', `rn-tab${t.id === tab ? ' is-active' : ''}`);
    b.type = 'button';
    b.textContent = t.label;
    b.addEventListener('click', () => { play('tick'); onNavigate('managers', { ...params, tab: t.id }); });
    tabs.append(b);
  }
  root.append(tabs);

  const model = data.managers;

  if (!model?.ok) {
    root.append(unavailablePanel());
    return root;
  }

  root.append(sourcesLine(model));
  // The owner's name rule: every merge and every ambiguous name, collapsed.
  const merged = nameMergePanel(model.names ?? data.crew?.names ?? null, { cls: 'mg-names' });
  if (merged) root.append(merged);

  if (tab === 'overview') root.append(overview(model, params, onNavigate));
  else if (tab === 'person') root.append(person(model, params, data, onNavigate));
  else root.append(dayshape(model, data));

  const r = model.report;
  const vr = model.validator?.ok ? model.validator.report : null;
  setInspectorContent?.(`
    <p class="semi">Managers</p>
    <p class="muted">${model.people.length} person-and-role records</p>
    <p class="inspector-section-label">Session matching</p>
    <dl class="inspector-filters">
      <dt>Matched</dt><dd>${r.matched}</dd>
      <dt>Roster only</dt><dd>${r.unmatchedOps}</dd>
      <dt>Results only</dt><dd>${r.unmatchedEvents}</dd>
      <dt>Count clash</dt><dd>${r.mismatched.length}</dd>
    </dl>
    ${vr ? `<p class="inspector-section-label">Validator matching</p>
    <dl class="inspector-filters">
      <dt>Matched</dt><dd>${int(vr.matched)}</dd>
      <dt>No results yet</dt><dd>${int(vr.unmatched.filter((u) => u.reason === 'no-results').length)}</dd>
      <dt>Count clash</dt><dd>${int(vr.mismatched.length)}</dd>
    </dl>` : ''}
    <p class="inspector-section-label">Where the crew comes from</p>
    <p class="muted">Crews are now entered in the data validator, the nightly
      reconciliation app. Where it has a night, its crew is used — approved
      lists first; one still in progress is used and marked. Otherwise the
      scheduler's deployed and planned assignments are used, as before; drafts
      never count. Validator names are tied to a scheduler person when they
      match one exactly. On top of that the owner's name rule (2 Oct 2026)
      treats spellings of one first name as one person in every role except
      Flash Runners — different initials stay different people, and a bare
      first name that could be either is left alone; every merge is listed
      under "Merged names". Where a role lists two people, the first listed is
      credited.</p>
    <p class="inspector-section-label">How sessions are matched</p>
    <p class="muted">The two databases name sessions differently — the roster says
      AM and PM, the analytics say regular and late. They are matched by position
      within the day, because on a weekday the single session is called PM by one
      and regular by the other.</p>
    <p class="inspector-section-label">What the score corrects for</p>
    <p class="muted">Checked against production: in the fortnight the roster
      covers, nineteen of twenty-two sessions beat their own trailing year and
      the average night was +0.67σ — the whole business was running hot. So the
      Score column subtracts how everything else was doing at the time, and
      "vs typical" keeps the uncorrected number beside it. Without that, the
      ranking would reward whoever worked during a good month.</p>
    <p class="inspector-section-label">Why a score is a sigma</p>
    <p class="muted">Each night is measured against its own slot over a trailing
      ${SLOT_WINDOW_DAYS} days. Slots differ in steadiness as well as size, so the
      distance is expressed in that slot's own spread. +1.00σ means a clearly
      good night of that kind; anything inside the interval shown is not
      distinguishable from an ordinary one.</p>`);

  return root;
}
