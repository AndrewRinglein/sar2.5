/* ============================================================================
   SAR 2.0 — Forecast (U12)

   The rest of this month, the next quarter, the rest of the year — what the
   halls will take if the nights still to come behave like the same nights
   have lately, and what changes if they do not.

   All of the arithmetic is in `lib/forecast-model.js` (pure, unit-tested,
   with a hand-computed fixture in test/forecast.test.mjs). This file draws it.

   SCOPE DECISIONS (also in SAR2-REMAINING-DESIGN.md, "Forecast (U12)"):
   · The SLOT MODEL is the model: each expected session is valued at its own
     slot's trailing 13-week mean (hall, weekday, session type), the slot model
     the Managers screen already proved. SAR 1.0's projection (SPEC §8.3) is
     not followed, per the plan; its guardrails are kept — no invented past
     sessions, a visible unprojectable bucket, the averages and counts shown.
   · Drivers (attendance, spend per player, payout ratio, slots on/off) are
     multipliers on those slot baselines, not a second model.
   · Two modes: "Bingo only" stops at net; "With expenses" continues to
     profit using Unit Economics' assumptions (the same stored values — one
     set of assumptions for both screens). Every assumed line says so.
   · The range is night-to-night noise in quadrature, WIDENED by the level
     drift the backtest actually observed. If there are too few backtested
     months to estimate it, the screen says the range is noise only.

   Live recompute: sliders and toggles redraw the results on `input` without
   re-navigating, and commit to the URL on `change`, so a scenario is a link.
   ========================================================================== */

import { MIN_SLOT_SESSIONS, Z_95, dayNumber } from '../lib/managers.js';
import { monthFull, monthAxisLabel, bandedTrendChart, legend } from '../lib/charts.js';
import { usd, usdShort, pct, pctDelta, int, dateShort, dateLong, esc, sessionType, DASH }
  from '../lib/fmt.js';
import { play } from '../lib/sound.js';
import { loadAssumptions, costOfGoods } from './unit-economics.js';
import {
  HORIZONS, DRIVER_LIMITS, BASELINE_DRIVERS, RUNNING_WINDOW_WEEKS, RUNNING_MIN_SESSIONS, FORECAST_WINDOW_DAYS,
  MISSING_GRACE_DAYS, BACKTEST_MONTHS, MIN_BACKTEST_FOR_WIDENING,
  todayIso, horizonMonths, monthStartDay, monthEndDay, isoOfDay,
  sessionRows, prepare, hallMapFromLocations, rosterSessions, buildForecast, backtest,
  cogsPerSession, parseForecastParams, forecastParams, isBaseline, normaliseDrivers,
  loadScenarios, saveScenario, deleteScenario, browserStore, openKey, resolveOwnerClosures,
} from '../lib/forecast-model.js';
import { OWNER_CLOSURES } from '../lib/config.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

const ROUTE = 'forecast';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HISTORY_MONTHS = 12;
const MAX_SESSION_ROWS = 400;

const DRIVERS = [
  { key: 'att', label: 'Attendance', unit: '%', note: 'players per session' },
  { key: 'spend', label: 'Spend per player', unit: '%', note: 'gross per head' },
  { key: 'payout', label: 'Payout ratio', unit: 'pp', note: 'percentage points of gross' },
];

const signed = (v, unit) => `${v > 0 ? '+' : ''}${v}${unit === 'pp' ? ' pp' : '%'}`;
const signedUsd = (v) => (v === null || !Number.isFinite(v) ? DASH
  : `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(Math.abs(Math.round(v)))}`);
const money = (v) => usd(Math.round(v));
const toneOf = (v) => (v > 0 ? 'tone-pos' : v < 0 ? 'tone-neg' : 'tone-neutral');
const assumedTag = '<span class="assumed">assumed</span>';

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderForecast({
  data, params = {}, onNavigate, setInspectorContent,
  now = new Date(), store = browserStore(),
}) {
  const root = h('div', 'screen fc');
  const parsed = parseForecastParams(params);
  const state = {
    hall: parsed.hall, horizon: parsed.horizon, mode: parsed.mode,
    drivers: { ...parsed.drivers }, off: new Set(parsed.off), open: new Set(parsed.open),
  };
  const go = (patch = {}) => {
    play('select');
    onNavigate?.(ROUTE, forecastParams({ ...state, ...patch }));
  };

  /* ---- filters ---- */
  const locations = data.locations ?? [];
  const hallName = (id) => esc(locations.find((l) => l.id === id)?.name ?? DASH);
  const bar = h('div', 'filter-bar');
  for (const l of [{ id: 'all', name: 'Both halls' }, ...locations]) {
    const b = h('button', `chip${state.hall === l.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l.name;
    b.addEventListener('click', () => go({ hall: l.id }));
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  for (const hz of HORIZONS) {
    const b = h('button', `chip${state.horizon === hz.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = hz.label;
    b.addEventListener('click', () => go({ horizon: hz.id }));
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  for (const [id, label] of [['bingo', 'Bingo only'], ['expenses', 'With expenses']]) {
    const b = h('button', `chip${state.mode === id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = label;
    b.setAttribute('aria-pressed', String(state.mode === id));
    b.addEventListener('click', () => go({ mode: id }));
    bar.append(b);
  }
  root.append(bar);

  const today = todayIso(now, data.config?.timezone ?? null);
  const todayDay = dayNumber(today);
  const rows = sessionRows(data.events ?? [], data).filter((r) => r.day <= todayDay);

  if (!rows.length) {
    root.append(h('section', 'panel',
      '<h3 class="panel-title">Forecast</h3>'
      + '<div class="placeholder"><p class="semi">No sessions to forecast from</p>'
      + '<p class="dim">The forecast values each night at what the same slot has taken before, '
      + 'so it needs session history.</p></div>'));
    setInspectorContent?.(inspectorHtml(null));
    return root;
  }

  /* ---- the model, once per render ---- */
  const months = horizonMonths(state.horizon, today);
  const prep = prepare(rows, { today: todayDay });
  const sched = data.schedule;
  const halls = hallMapFromLocations(locations);
  const roster = rosterSessions(sched?.ok ? sched.sessions ?? [] : [], {
    hallMap: halls.map, fromDay: monthStartDay(months[0]), toDay: monthEndDay(months[months.length - 1]),
    rows, cutoff: prep.cutoff,
  });
  const bt = backtest(rows, { today, hall: state.hall });
  const assumptions = loadAssumptions(store);
  const cogs = cogsPerSession(costOfGoods(sched?.boxes ?? []));
  const lastData = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);

  const ownerClosed = resolveOwnerClosures(OWNER_CLOSURES, locations).map;
  const run = (drivers, off, open = new Set()) => buildForecast({
    rows, prep, months, roster: roster.sessions, hall: state.hall,
    drivers, off, open, assumptions, cogs, drift: bt.drift, ownerClosed,
  });
  // The baseline keeps holiday closures: they are evidence, not a scenario.
  const base = run(BASELINE_DRIVERS, new Set());

  /* ---- heading, facts and notices (do not change with the drivers) ---- */
  const head = h('section', 'panel fc-head');
  const hz = HORIZONS.find((x) => x.id === state.horizon);
  head.append(h('h3', 'panel-title', `Forecast · ${hz.label}`));
  head.append(h('p', 'fc-facts', `
    <span><strong>Today</strong> ${dateLong(today)}</span>
    <span><strong>Period</strong> ${dateShort(isoOfDay(monthStartDay(months[0])))} – ${dateLong(isoOfDay(monthEndDay(months[months.length - 1])))}</span>
    <span><strong>Data through</strong> ${dateLong(lastData)}</span>
    <span><strong>Halls</strong> ${state.hall === 'all' ? 'Both' : hallName(state.hall)}</span>`));
  head.append(h('p', 'muted', `Each night still to come is valued at what its own slot — same hall,
    same weekday, same session type — has averaged over the last ${FORECAST_WINDOW_DAYS / 7} weeks.
    A slot is projected only while it is running: at least ${RUNNING_MIN_SESSIONS} sessions in the
    last ${RUNNING_WINDOW_WEEKS} weeks. ${slotSpreadSentence(prep, state.hall, hallName)}`));
  for (const n of headNotices({ base, roster, sched, lastData, todayDay, hallName })) {
    head.append(h('div', 'mg-notice', n));
  }
  root.append(head);

  /* ---- drivers ---- */
  const live = h('div', 'fc-live');
  const drv = driversPanel({ state, prep, hallName, onLive: () => draw(), onCommit: () => go(), go });
  root.append(drv.panel);
  root.append(live);

  /* ---- scenarios ---- */
  const scen = h('section', 'panel');
  root.append(scen);

  /* ---- backtest (fixed — always the baseline model) ---- */
  root.append(backtestPanel(bt, state.hall));

  /* ---- slots: the baselines behind every projection ---- */
  root.append(slotsPanel({ prep, state, hallName, onLive: () => draw(), onCommit: () => go() }));

  /* ---- live parts ---- */
  let scenarioNote = '';
  function draw() {
    const f = run(state.drivers, state.off, state.open);
    drv.refresh();
    live.replaceChildren(
      kpiStrip(f, base, state, bt),
      holidayPanel({ f, state, hallName, onLive: () => draw(), onCommit: () => go() }),
      chartPanel({ rows, f, bt, months, state, today }),
      monthsPanel(f, state, assumptions, cogs),
      sessionsPanel(f, base, hallName),
    );
    drawScenarios(f);
  }

  function drawScenarios(f) {
    const saved = loadScenarios(store);
    scen.replaceChildren(h('h3', 'panel-title', 'Saved scenarios'));
    const form = h('form', 'fc-save');
    form.innerHTML = `<input type="text" name="name" maxlength="80" placeholder="Name this scenario"
      aria-label="Scenario name"><button type="submit" class="chip">Save current settings</button>`;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = form.querySelector('input').value.trim();
      if (!name) return;
      const { persisted } = saveScenario({
        name, drivers: state.drivers, off: [...state.off], open: [...state.open],
        mode: state.mode, horizon: state.horizon, hall: state.hall,
      }, store, { now });
      scenarioNote = persisted ? '' : 'Browser storage is not available here, so saved scenarios '
        + 'last until this tab is closed.';
      play('select');
      drawScenarios(run(state.drivers, state.off, state.open));
    });
    scen.append(form);
    if (scenarioNote) scen.append(h('div', 'mg-notice', scenarioNote));

    // The comparison: baseline, the current settings, each saved scenario —
    // all run on THIS hall and horizon so the columns are comparable.
    const lines = [{ name: 'Baseline', note: 'no drivers, every running slot', f: base, kind: 'base' }];
    if (!isBaseline(state.drivers, state.off, state.open)) {
      lines.push({ name: 'Current settings', note: driverSummary(state.drivers, state.off, state.open), f, kind: 'current' });
    }
    for (const s of saved) {
      lines.push({
        name: esc(s.name), note: driverSummary(s.drivers, new Set(s.off), new Set(s.open)), scenario: s,
        f: run(s.drivers, new Set(s.off), new Set(s.open)), kind: 'saved',
      });
    }
    const t = h('table', 'rn-table fc-compare');
    t.innerHTML = `<thead><tr><th class="name">Scenario</th><th class="name">Drivers</th>
      <th>Gross</th><th>Net</th><th>Expenses</th><th>Profit</th><th>Attendance</th>
      <th>Net vs baseline</th><th>Profit vs baseline</th><th class="name"></th></tr></thead><tbody></tbody>`;
    const body = t.querySelector('tbody');
    for (const l of lines) {
      const tr = h('tr', l.kind === 'base' ? 'rn-total' : '');
      const dn = l.f.totals.net - base.totals.net;
      const dp = l.f.totals.profit - base.totals.profit;
      tr.innerHTML = `<td class="name">${l.name}${l.scenario && l.scenario.hall !== state.hall
          ? ` <span class="dim">(saved for ${l.scenario.hall === 'all' ? 'both halls' : hallName(l.scenario.hall)})</span>` : ''}</td>
        <td class="name dim">${esc(l.note)}</td>
        <td>${money(l.f.totals.gross)}</td>
        <td>${money(l.f.totals.net)}</td>
        <td>${money(l.f.totals.expenses.total)} ${assumedTag}</td>
        <td>${money(l.f.totals.profit)}</td>
        <td>${int(l.f.totals.attendance)}</td>
        <td class="${toneOf(dn)}">${l.kind === 'base' ? DASH : signedUsd(dn)}</td>
        <td class="${toneOf(dp)}">${l.kind === 'base' ? DASH : signedUsd(dp)}</td>
        <td class="name"></td>`;
      if (l.scenario) {
        const cell = tr.lastElementChild;
        const load = h('button', 'chip'); load.type = 'button'; load.textContent = 'Load';
        load.addEventListener('click', () => {
          play('select');
          onNavigate?.(ROUTE, forecastParams({ ...l.scenario, off: new Set(l.scenario.off), open: new Set(l.scenario.open) }));
        });
        const del = h('button', 'chip'); del.type = 'button'; del.textContent = 'Delete';
        del.setAttribute('aria-label', `Delete scenario ${l.scenario.name}`);
        del.addEventListener('click', () => {
          const { persisted } = deleteScenario(l.scenario.id, store);
          if (!persisted) scenarioNote = 'Browser storage is not available here, so the change lasts until this tab is closed.';
          drawScenarios(run(state.drivers, state.off, state.open));
        });
        cell.append(load, del);
      }
      body.append(tr);
    }
    const wrap = h('div', 'so-scroll'); wrap.append(t);
    scen.append(wrap);
    scen.append(h('p', 'muted so-small', `${hz.label}, ${state.hall === 'all' ? 'both halls' : hallName(state.hall)}.
      Every row re-runs the same slot model with that row's drivers and switched-off slots. Expenses
      and profit use the Unit Economics assumptions in every row, whichever mode is showing.
      ${saved.length ? '' : 'Nothing saved yet — set the drivers, name it, and save.'}
      Scenarios are kept in this browser only.`));
  }

  draw();
  setInspectorContent?.(inspectorHtml({ prep, bt, months, hz, cogs }));
  return root;
}

/* ---------------------------------------------------------------------------
   Pieces
--------------------------------------------------------------------------- */

/** "Right now X averages N times Y" — computed, never typed in. */
function slotSpreadSentence(prep, hall, hallName) {
  const usable = [...prep.baselines.values()]
    .filter((b) => b.usable && prep.running.has(b.slot) && b.meanGross > 0
      && (hall === 'all' || b.locationId === hall));
  if (usable.length < 2) return '';
  usable.sort((a, b) => b.meanGross - a.meanGross);
  const hi = usable[0]; const lo = usable[usable.length - 1];
  const label = (b) => `${hallName(b.locationId)} ${DOW[b.weekday]} ${esc(sessionType(b.type).toLowerCase())}`;
  return `Right now ${label(hi)} averages ${(hi.meanGross / lo.meanGross).toFixed(1)} times
    ${label(lo)}, which is why the nights left matter more than the days left.`;
}

function headNotices({ base, roster, sched, lastData, todayDay, hallName }) {
  const out = [];
  const lag = todayDay - dayNumber(lastData);
  if (lag > MISSING_GRACE_DAYS) {
    out.push(`<strong>Nothing has been entered since ${dateLong(lastData)}</strong>
      (${lag} days ago). Sessions expected before yesterday with no data are listed as missing, not
      projected — a session that did not happen must not be invented.`);
  }
  if (base.missing.length) {
    out.push(`<strong>${base.missing.length} expected session${base.missing.length === 1 ? ' is' : 's are'}
      missing or not yet entered</strong> — more than a day in the past with no data. They are not
      in the totals. The list is under "Every session in this forecast".`);
  }
  if (base.unprojectable.length) {
    const by = new Map();
    for (const s of base.unprojectable) by.set(s.slot, { ...s, count: (by.get(s.slot)?.count ?? 0) + 1 });
    const list = [...by.values()].map((s) => `${hallName(s.locationId)} ${DOW[s.dow]} ${esc(sessionType(s.type).toLowerCase())}
      (${s.count} night${s.count === 1 ? '' : 's'}, ${s.n} past session${s.n === 1 ? '' : 's'})`).join('; ');
    out.push(`<strong>${base.unprojectable.length} expected session${base.unprojectable.length === 1 ? ' has' : 's have'}
      too little history to value</strong> and ${base.unprojectable.length === 1 ? 'is' : 'are'} not in the totals:
      ${list}. A slot needs ${MIN_SLOT_SESSIONS} sessions in the last ${FORECAST_WINDOW_DAYS / 7} weeks. The totals lean low by that much.`);
  }
  const ex = Object.entries(roster.excluded);
  const exN = ex.reduce((s, [, v]) => s + v, 0);
  if (!sched?.ok) {
    out.push('<strong>The scheduler is not connected</strong>, so every projected session comes from the '
      + 'usual pattern of slots that are currently running.');
  } else if (!roster.sessions.length) {
    out.push(`<strong>The scheduler has no deployed or planned sessions in this period</strong>${
      exN ? ` (only ${ex.map(([s, v]) => `${int(v)} ${esc(s)}`).join(', ')}, which are not counted)` : ''},
      so every projected session comes from the usual pattern of slots that are currently running.`);
  } else {
    out.push(`The scheduler reaches ${dateLong(roster.lastDate)}: <strong>${base.sources.roster}</strong> projected
      session${base.sources.roster === 1 ? '' : 's'} come from it and <strong>${base.sources.pattern}</strong> from the
      usual pattern.${exN ? ` ${ex.map(([s, v]) => `${int(v)} ${esc(s)}`).join(', ')} session${exN === 1 ? ' is' : 's are'}
      excluded — only deployed and planned are counted, the same rule as Staff overview.` : ''}`);
  }
  if (roster.unmapped) {
    out.push(`${roster.unmapped} scheduled session${roster.unmapped === 1 ? '' : 's'} could not be matched to an
      analytics hall and ${roster.unmapped === 1 ? 'is' : 'are'} left out.`);
  }
  return out;
}

function driverSummary(d, off, open) {
  const n = normaliseDrivers(d);
  const parts = [];
  if (n.att) parts.push(`attendance ${signed(n.att, '%')}`);
  if (n.spend) parts.push(`spend ${signed(n.spend, '%')}`);
  if (n.payout) parts.push(`payout ${signed(n.payout, 'pp')}`);
  if (off?.size) parts.push(`${off.size} slot${off.size === 1 ? '' : 's'} off`);
  if (open?.size) parts.push(`${open.size} holiday night${open.size === 1 ? '' : 's'} re-opened`);
  return parts.length ? parts.join(' · ') : 'none';
}

function driversPanel({ state, onLive, onCommit, go }) {
  const panel = h('section', 'panel fc-drivers');
  panel.append(h('h3', 'panel-title', 'Drivers'));
  panel.append(h('p', 'muted so-small', `Multipliers on every slot's baseline. Attendance and spend
    per player scale gross; the payout shift moves each slot's payout ratio by percentage points
    (kept between 0 and 100%). Drag to see the effect; release to keep it in the link.`));
  const labels = new Map();
  for (const d of DRIVERS) {
    const lim = DRIVER_LIMITS[d.key];
    const row = h('label', 'fc-drv');
    row.innerHTML = `<span class="fc-drv-l">${esc(d.label)}<small>${esc(d.note)}</small></span>
      <input type="range" min="${lim.min}" max="${lim.max}" step="${lim.step}"
        value="${esc(state.drivers[d.key])}" data-key="${esc(d.key)}" aria-label="${esc(d.label)} change">
      <span class="fc-drv-v"></span>`;
    const input = row.querySelector('input');
    labels.set(d.key, row.querySelector('.fc-drv-v'));
    input.addEventListener('input', () => {
      state.drivers = normaliseDrivers({ ...state.drivers, [d.key]: Number(input.value) });
      onLive();
    });
    input.addEventListener('change', () => onCommit());
    panel.append(row);
  }
  const reset = h('button', 'chip'); reset.type = 'button'; reset.textContent = 'Reset to baseline';
  reset.addEventListener('click', () => {
    state.drivers = { ...BASELINE_DRIVERS };
    state.off = new Set();
    state.open = new Set();
    go({ drivers: BASELINE_DRIVERS, off: new Set(), open: new Set() });
  });
  const foot = h('div', 'fc-drv-foot'); foot.append(reset);
  panel.append(foot);
  return {
    panel,
    refresh() {
      for (const d of DRIVERS) {
        const v = state.drivers[d.key];
        labels.get(d.key).textContent = v ? signed(v, d.unit) : 'baseline';
      }
    },
  };
}

function kpiStrip(f, base, state, bt) {
  const t = f.totals; const b = base.totals;
  const widened = Boolean(bt.drift);
  const rangeNote = widened ? '95% range, noise and drift' : '95% range, night-to-night only';
  const scenario = !isBaseline(state.drivers, state.off, state.open);
  const deltaKey = state.mode === 'expenses' ? 'profit' : 'net';
  const delta = t[deltaKey] - b[deltaKey];
  const cells = [
    `<div class="kpi"><span class="kpi-label">Gross</span>
      <span class="kpi-value">${money(t.gross)}</span>
      <span class="kpi-sub muted">${money(t.range.gross.low)} to ${money(t.range.gross.high)}<br>${rangeNote}</span></div>`,
    `<div class="kpi"><span class="kpi-label">Net</span>
      <span class="kpi-value">${money(t.net)}</span>
      <span class="kpi-sub muted">${money(t.range.net.low)} to ${money(t.range.net.high)}</span></div>`,
    `<div class="kpi"><span class="kpi-label">Sessions</span>
      <span class="kpi-value">${int(t.sessions)}</span>
      <span class="kpi-sub muted">${int(t.actual.sessions)} done · ${int(t.projected.sessions)} projected${
        t.closed ? ` · ${int(t.closed)} closed for holidays` : ''}</span></div>`,
    `<div class="kpi"><span class="kpi-label">Attendance</span>
      <span class="kpi-value">${int(t.attendance)}</span>
      <span class="kpi-sub muted">${int(t.actual.attendance)} so far</span></div>`,
  ];
  if (state.mode === 'expenses') {
    cells.push(`<div class="kpi"><span class="kpi-label">Expenses</span>
      <span class="kpi-value">${money(t.expenses.total)}</span>
      <span class="kpi-sub">${assumedTag} <a href="#/unit-economics" class="dim">edit on Unit economics</a></span></div>`,
    `<div class="kpi"><span class="kpi-label">Profit</span>
      <span class="kpi-value ${t.profit < 0 ? 'tone-neg' : ''}">${money(t.profit)}</span>
      <span class="kpi-sub">${assumedTag} <span class="muted">margin ${pct(t.margin)}</span></span></div>`);
  }
  cells.push(`<div class="kpi fc-delta${scenario ? ' is-on' : ''}"><span class="kpi-label">Scenario vs baseline</span>
    <span class="kpi-value ${scenario ? toneOf(delta) : ''}">${scenario ? signedUsd(delta) : 'Baseline'}</span>
    <span class="kpi-sub muted">${scenario
      ? `${deltaKey} · ${pctDelta(b[deltaKey] ? delta / Math.abs(b[deltaKey]) : null)} · gross ${signedUsd(t.gross - b.gross)}`
      : 'no drivers applied'}</span></div>`);
  return h('div', 'kpis fc-kpis', cells.join(''));
}

function chartPanel({ rows, f, bt, months, state, today }) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'By month — actual, backtest and projection'));
  const current = String(today).slice(0, 7);
  const hallRows = rows.filter((r) => state.hall === 'all' || r.locationId === state.hall);
  const actual = new Map();
  for (const r of hallRows) {
    const k = r.date.slice(0, 7);
    if (k >= current) continue;
    const a = actual.get(k) ?? { gross: 0, net: 0 };
    a.gross += r.gross; a.net += r.net;
    actual.set(k, a);
  }
  const history = [...actual.keys()].sort().slice(-HISTORY_MONTHS);
  const btBy = new Map(bt.months.map((m) => [m.month, m]));
  const grid = h('div', 'so-grid');
  for (const key of ['gross', 'net']) {
    const pts = [
      ...history.map((k, i) => {
        const b = btBy.get(k);
        return {
          label: monthAxisLabel(k, i),
          value: actual.get(k)[key],
          expected: b ? b.projected[key] : null,
          lo: b ? b.range[key].low : null,
          hi: b ? b.range[key].high : null,
          title: `${monthFull(k)}: ${money(actual.get(k)[key])}${b ? ` · backtest ${money(b.projected[key])}` : ''}`,
        };
      }),
      ...f.months.map((m, i) => ({
        label: monthAxisLabel(m.key, history.length + i),
        value: null,
        expected: m.total[key],
        lo: m.range[key].low,
        hi: m.range[key].high,
        highlight: m.key === current,
        title: `${monthFull(m.key)}: ${money(m.total[key])} (${money(m.range[key].low)} to ${money(m.range[key].high)})`,
      })),
    ];
    const cell = h('div', 'fc-chart');
    cell.append(h('p', 'semi', key === 'gross' ? 'Gross' : 'Net'));
    if (pts.some((p) => Number.isFinite(p.value) || Number.isFinite(p.expected))) {
      cell.append(bandedTrendChart(pts, { width: 520, height: 220, fmtY: usdShort,
        labelEvery: pts.length > 14 ? 2 : 1 }));
    } else {
      cell.append(h('div', 'placeholder', '<p class="dim">Nothing to draw.</p>'));
    }
    grid.append(cell);
  }
  panel.append(grid);
  panel.append(legend([
    { key: 'a', label: 'Actual (completed months)', colour: 'var(--accent)' },
    { key: 'e', label: 'Backtest, then projection', dashed: true },
    { key: 'r', label: '95% range', colour: 'var(--accent-soft)' },
  ]));
  panel.append(h('p', 'muted so-small', `The shaded band over past months is the range the backtest
    stated as of the 1st of that month; a red point is a month that landed outside it. The current
    month (${monthFull(months[0])}) combines what is done with what is projected.`));
  return panel;
}

function monthsPanel(f, state, assumptions, cogs) {
  const panel = h('section', 'panel');
  const exp = state.mode === 'expenses';
  panel.append(h('h3', 'panel-title', exp ? 'Month by month — with expenses' : 'Month by month — bingo only'));
  const t = h('table', 'rn-table fc-months');
  t.innerHTML = `<thead><tr><th class="name">Month</th>
    <th>Done</th><th>Done gross</th><th>Projected</th><th>Projected gross</th>
    <th>Gross</th><th>Range</th><th>Payouts</th><th>Net</th><th>Attendance</th>
    ${exp ? `<th>Staff ${assumedTag}</th><th>Fixed ${assumedTag}</th>${cogs ? '<th>Goods <span class="assumed">estimated</span></th>' : ''}<th>Profit</th><th>Margin</th>` : ''}
    </tr></thead><tbody></tbody>`;
  const body = t.querySelector('tbody');
  const line = (label, m, cls = '') => {
    const tr = h('tr', cls);
    tr.innerHTML = `<td class="name">${label}</td>
      <td>${int(m.actual.sessions)}</td><td>${money(m.actual.gross)}</td>
      <td class="fc-proj">${int(m.projected.sessions)}${m.missing || m.unprojectable || m.switchedOff || m.closed
        ? ` <span class="dim" title="missing · unprojectable · closed for a holiday · switched off">(+${m.missing + m.unprojectable + m.closed + m.switchedOff})</span>` : ''}</td>
      <td class="fc-proj">${money(m.projected.gross)}</td>
      <td class="semi">${money(m.total.gross)}</td>
      <td class="dim">${usdShort(m.range.gross.low)}–${usdShort(m.range.gross.high)}</td>
      <td>${money(m.total.payout)}</td>
      <td class="semi">${money(m.total.net)}</td>
      <td>${int(m.total.attendance)}</td>
      ${exp ? `<td>${money(m.expenses.staff)}</td><td>${money(m.expenses.fixed)}</td>
        ${cogs ? `<td>${money(m.expenses.cogs)}</td>` : ''}
        <td class="semi ${m.profit < 0 ? 'tone-neg' : ''}">${money(m.profit)}</td>
        <td>${pct(m.margin)}</td>` : ''}`;
    body.append(tr);
  };
  for (const m of f.months) line(monthFull(m.key), m);
  if (f.months.length > 1) {
    const T = f.totals;
    line('Total', {
      actual: T.actual, projected: T.projected, missing: T.missing, unprojectable: T.unprojectable,
      switchedOff: T.switchedOff, closed: T.closed, total: { gross: T.gross, payout: T.payout, net: T.net, attendance: T.attendance },
      range: T.range, expenses: T.expenses, profit: T.profit, margin: T.margin,
    }, 'rn-total');
  }
  const wrap = h('div', 'so-scroll'); wrap.append(t);
  panel.append(wrap);
  const notes = [`"Done" is what the metric store holds for that month to date; "Projected" is valued
    at slot baselines under the drivers. Numbers in brackets are expected sessions that are not in the
    totals — missing (past, no data), unprojectable (too little history), closed for a holiday
    (the hall closed on the same holiday last time) or switched off.`];
  if (exp) {
    notes.push(`Expenses are ${assumedTag}: every session, done or projected, carries
      ${assumptions.staffPerSession} staff hours at a blended ${usd(assumptions.staffCostPerHour, { decimals: 2 })}
      an hour and ${usd(assumptions.fixedPerSession)} of fixed cost — the assumptions set on
      <a href="#/unit-economics">Unit economics</a>, shared with that screen. No person's pay is used.
      ${cogs ? `Goods are estimated at the average of ${cogs.n} session${cogs.n === 1 ? '' : 's'} with linked boxes.`
        : 'No cost-of-goods line: no boxes are linked to sessions in the stock system.'}`);
  }
  panel.append(h('p', 'muted so-small', notes.join(' ')));
  return panel;
}

/**
 * What happened last time, in words, per session where the evidence is per
 * session ("Late session not held last Mother's Day"), per hall where it fell
 * back to the hall ("Hall closed last Thanksgiving").
 */
function lastTime(s) {
  const hol = s.holiday;
  if (hol.owner) {
    return `Closed — confirmed by owner${hol.owner.confirmed
      ? ` (${dateShort(hol.owner.confirmed)} ${esc(hol.owner.confirmed.slice(0, 4))})` : ''}`;
  }
  if (hol.history === 'none') return `${esc(hol.name)} — holiday, no history`;
  const when = `${dateShort(hol.lastDate)} ${esc(hol.lastDate.slice(0, 4))}`;
  if (hol.level === 'session') {
    return `${esc(sessionType(s.type))} session ${hol.history === 'closed' ? 'not held' : 'held'} last ${esc(hol.name)} (${when})`;
  }
  return `Hall ${hol.history === 'closed' ? 'closed' : 'open'} last ${esc(hol.name)} (${when})`;
}

/** The basis note for a projected holiday session. */
function holidayNote(s) {
  return s.holiday.reopened ? `re-opened — ${lastTime(s)}` : lastTime(s);
}

/**
 * Every holiday night in the forecast, with what the hall did last time and a
 * switch to open a closed one anyway. Closures are evidence, so the default
 * follows the evidence; the switch is the same kind of override as a slot.
 */
function holidayPanel({ f, state, hallName, onLive, onCommit }) {
  const nights = [
    ...f.closed.map((s) => ({ ...s, projectedHere: false })),
    ...f.projected.filter((s) => s.holiday).map((s) => ({ ...s, projectedHere: true })),
    ...f.switchedOff.filter((s) => s.holiday).map((s) => ({ ...s, projectedHere: false, off: true })),
  ].sort((a, b) => a.day - b.day || (a.slot < b.slot ? -1 : 1));
  if (!nights.length) return document.createDocumentFragment();
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Holidays in this period'));
  panel.append(h('p', 'muted so-small', `What each session did on the same holiday last time it was
    running that weekday — the same session type at the same hall, or the hall as a whole when that
    session has no record. Not held then: taken as closed and not projected. Held: projected as usual.
    No history: projected and marked. A closure the owner has confirmed is closed whatever the
    history says. Tick "Open" to project a closed session anyway.`));
  const t = h('table', 'rn-table');
  t.innerHTML = `<thead><tr><th class="name">Open</th><th class="name">Date</th><th class="name">Holiday</th>
    <th class="name">Hall</th><th class="name">Session</th><th class="name">Last time</th>
    <th class="name">In this forecast</th></tr></thead><tbody></tbody>`;
  const body = t.querySelector('tbody');
  const seen = new Set();
  for (const s of nights) {
    const key = openKey(s);
    const last = s.holiday.owner ? lastTime(s)
      : s.holiday.history === 'none' ? '<span class="dim">no history</span>' : lastTime(s);
    const status = s.off ? '<span class="dim">slot switched off</span>'
      : s.projectedHere ? (s.holiday.reopened ? 'projected — re-opened' : 'projected')
        : '<span class="tone-neg">not projected</span>';
    const tr = h('tr', s.projectedHere || s.off ? '' : 'is-flagged');
    const canToggle = (s.holiday.history === 'closed' || s.holiday.owner) && s.source !== 'roster' && !seen.has(key);
    seen.add(key);
    tr.innerHTML = `<td class="name">${canToggle ? `<input type="checkbox" ${state.open.has(key) ? 'checked' : ''}
        aria-label="Open ${esc(s.holiday.name)} ${s.date} ${esc(s.type)} session anyway">` : ''}</td>
      <td class="name">${DOW[s.dow]} ${dateShort(s.date)} ${s.date.slice(0, 4)}</td>
      <td class="name">${esc(s.holiday.name)}</td><td class="name">${hallName(s.locationId)}</td>
      <td class="name">${esc(sessionType(s.type))}</td><td class="name">${last}</td><td class="name">${status}</td>`;
    const box = tr.querySelector('input');
    box?.addEventListener('change', () => {
      if (box.checked) state.open.add(key); else state.open.delete(key);
      onLive();
      onCommit();
    });
    body.append(tr);
  }
  const wrap = h('div', 'so-scroll'); wrap.append(t);
  panel.append(wrap);
  return panel;
}

function sessionsPanel(f, base, hallName) {
  const panel = h('section', 'panel');
  const det = h('details', 'fc-details');
  const total = f.projected.length + f.missing.length + f.switchedOff.length + f.unprojectable.length
    + f.closed.length;
  det.append(h('summary', 'semi', `Every session in this forecast (${int(total)})`));
  const all = [
    ...f.projected.map((s) => ({ ...s, state: 'projected' })),
    ...f.missing.map((s) => ({ ...s, state: 'missing' })),
    ...f.unprojectable.map((s) => ({ ...s, state: 'unprojectable' })),
    ...f.switchedOff.map((s) => ({ ...s, state: 'off' })),
    ...f.closed.map((s) => ({ ...s, state: 'closed' })),
  ].sort((a, b) => a.day - b.day || (a.slot < b.slot ? -1 : 1));
  const STATE = {
    projected: (s) => `${s.source === 'roster' ? `scheduled (${esc(s.status)})` : 'usual pattern'}${
      s.holiday ? ` · <span class="assumed">${holidayNote(s)}</span>` : ''}`,
    closed: (s) => `<span class="dim">${lastTime(s)} — not projected</span>`,
    missing: () => '<span class="tone-neg">missing / not yet entered</span>',
    unprojectable: (s) => `<span class="dim">unprojectable — ${s.n} past session${s.n === 1 ? '' : 's'}</span>`,
    off: () => '<span class="dim">switched off</span>',
  };
  const t = h('table', 'rn-table');
  t.innerHTML = `<thead><tr><th class="name">Date</th><th class="name">Hall</th><th class="name">Session</th>
    <th>Expected gross</th><th>Spread</th><th>Expected net</th><th>From</th><th class="name">Basis</th></tr></thead><tbody></tbody>`;
  const body = t.querySelector('tbody');
  for (const s of all.slice(0, MAX_SESSION_ROWS)) {
    const p = s.state === 'projected';
    body.insertAdjacentHTML('beforeend', `<tr class="${s.state === 'missing' ? 'is-flagged' : ''}">
      <td class="name">${DOW[s.dow]} ${dateShort(s.date)}</td>
      <td class="name">${hallName(s.locationId)}</td>
      <td class="name">${esc(sessionType(s.type))}</td>
      <td>${p ? money(s.gross) : DASH}</td>
      <td class="dim">${p && s.sdGross ? `± ${usdShort(s.sdGross)}` : DASH}</td>
      <td>${p ? money(s.net) : DASH}</td>
      <td class="dim">${p ? `${s.baseline.n} sessions` : DASH}</td>
      <td class="name">${STATE[s.state](s)}</td></tr>`);
  }
  const wrap = h('div', 'so-scroll'); wrap.append(t);
  det.append(wrap);
  if (all.length > MAX_SESSION_ROWS) {
    det.append(h('p', 'muted so-small', `First ${MAX_SESSION_ROWS} of ${int(all.length)} shown.`));
  }
  panel.append(det);
  return panel;
}

function slotsPanel({ prep, state, hallName, onLive, onCommit }) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Slots and their baselines'));
  const inHall = (s) => state.hall === 'all' || s.locationId === state.hall;
  const running = [...prep.running.values()].filter(inHall)
    .sort((a, b) => (a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0)
      || a.weekday - b.weekday || (a.type < b.type ? -1 : 1));
  if (!running.length) {
    panel.append(h('div', 'placeholder', `<p class="semi">No slot is currently running</p>
      <p class="dim">No slot has ${RUNNING_MIN_SESSIONS} or more sessions in the last
      ${RUNNING_WINDOW_WEEKS} weeks, so nothing is projected from the usual pattern.</p>`));
  } else {
    panel.append(h('p', 'muted so-small', `The averages every projection uses: last
      ${FORECAST_WINDOW_DAYS / 7} weeks, ${MIN_SLOT_SESSIONS} sessions needed. Untick a slot to see the
      forecast without it — closing a night, say.`));
    const t = h('table', 'rn-table');
    t.innerHTML = `<thead><tr><th class="name">On</th><th class="name">Hall</th><th class="name">Day</th>
      <th class="name">Session</th><th>Sessions (${FORECAST_WINDOW_DAYS / 7} wks)</th><th>Last ${RUNNING_WINDOW_WEEKS} wks</th>
      <th>Mean gross</th><th>Spread</th><th>Payout ratio</th><th>Mean net</th><th>Mean attendance</th>
      <th class="name">Last ran</th></tr></thead><tbody></tbody>`;
    const body = t.querySelector('tbody');
    for (const s of running) {
      const b = prep.baselines.get(s.slot);
      const tr = h('tr', b?.usable ? '' : 'is-flagged');
      tr.innerHTML = `<td class="name"><input type="checkbox" ${state.off.has(s.slot) ? '' : 'checked'}
          aria-label="Include ${DOW[s.weekday]} ${esc(s.type)} at this hall"></td>
        <td class="name">${hallName(s.locationId)}</td><td class="name">${DOW[s.weekday]}</td>
        <td class="name">${esc(sessionType(s.type))}</td>
        <td>${int(b?.n)}${b?.usable ? '' : ' <span class="dim">too few</span>'}</td>
        <td>${int(s.runs)}</td>
        <td>${b ? money(b.meanGross) : DASH}</td>
        <td class="dim">${b?.sdGross ? `± ${usdShort(b.sdGross)}` : DASH}</td>
        <td>${b ? pct(b.payoutRatio) : DASH}</td>
        <td>${b ? money(b.meanNet) : DASH}</td>
        <td>${b?.meanAttendance === null || !b ? DASH : int(b.meanAttendance)}</td>
        <td class="name dim">${dateShort(s.lastDate)}</td>`;
      const box = tr.querySelector('input');
      box.addEventListener('change', () => {
        if (box.checked) state.off.delete(s.slot); else state.off.add(s.slot);
        onLive();
        onCommit();
      });
      body.append(tr);
    }
    const wrap = h('div', 'so-scroll'); wrap.append(t);
    panel.append(wrap);
  }
  const stopped = prep.stopped.filter(inHall);
  if (stopped.length) {
    panel.append(h('p', 'muted so-small', `<strong>Not projected — stopped running:</strong> ${
      stopped.map((s) => `${hallName(s.locationId)} ${DOW[s.weekday]} ${esc(sessionType(s.type).toLowerCase())}
        (last ${dateShort(s.lastDate)} ${s.lastDate.slice(0, 4)}, ${s.runs} in the last ${RUNNING_WINDOW_WEEKS} weeks)`).join('; ')}.`));
  }
  return panel;
}

function backtestPanel(bt, hall) {
  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'How accurate has this been?'));
  if (!bt.months.length) {
    panel.append(h('div', 'placeholder', `<p class="semi">Not enough history to backtest</p>
      <p class="dim">The backtest replays the model as of the 1st of each of the last
      ${BACKTEST_MONTHS} completed months, using only data from before that date.</p>`));
    return panel;
  }
  panel.append(h('p', 'muted', `The same model, run as of the 1st of each of the last
    ${bt.months.length} completed months — baselines, running slots and session types from data
    strictly before that date, nothing from the month itself — and compared with what the month
    actually took. ${hall === 'all' ? 'Both halls.' : ''}`));
  const k = h('div', 'kpis fc-kpis');
  k.innerHTML = `
    <div class="kpi"><span class="kpi-label">Mean error, gross</span>
      <span class="kpi-value">${pct(bt.maeGross)}</span>
      <span class="kpi-sub muted">average miss, either way · bias ${pctDelta(bt.biasGross)}</span></div>
    <div class="kpi"><span class="kpi-label">Mean error, net</span>
      <span class="kpi-value">${pct(bt.maeNet)}</span>
      <span class="kpi-sub muted">bias ${pctDelta(bt.biasNet)}</span></div>
    <div class="kpi"><span class="kpi-label">Inside the stated range</span>
      <span class="kpi-value">${bt.insideGross} of ${bt.scored}</span>
      <span class="kpi-sub muted">gross, night-to-night range as stated at the time</span></div>
    <div class="kpi"><span class="kpi-label">Inside the widened range</span>
      <span class="kpi-value">${bt.insideWidenedGross === null ? DASH : `${bt.insideWidenedGross} of ${bt.scored}`}</span>
      <span class="kpi-sub muted">${bt.drift ? 'in-sample — fitted on these months' : `needs ${MIN_BACKTEST_FOR_WIDENING} months`}</span></div>`;
  panel.append(k);
  const scored = bt.months.filter((m) => Number.isFinite(m.errGross) && m.projected.sessions);
  if (scored.length >= MIN_BACKTEST_FOR_WIDENING
      && (scored.every((m) => m.errGross < 0) || scored.every((m) => m.errGross > 0))) {
    const low = scored[0].errGross < 0;
    panel.append(h('div', 'mg-notice', `<strong>Every one of the ${scored.length} months came in
      ${low ? 'above' : 'below'} its projection</strong> (on average ${pct(Math.abs(bt.biasGross))}).
      A trailing average ${low ? 'lags a business that is growing' : 'overstates a business that is shrinking'},
      so the central figure ${low ? 'leans low' : 'leans high'}. The widened range allows for it; the
      central figure does not. The attendance and spend drivers are the place to apply a view on that.`));
  }
  const t = h('table', 'rn-table');
  t.innerHTML = `<thead><tr><th class="name">Month</th><th>Sessions proj. / actual</th>
    <th>Projected gross</th><th>Actual gross</th><th>Error</th><th>In range</th>
    <th>Projected net</th><th>Actual net</th><th>Error</th><th>In range</th></tr></thead><tbody></tbody>`;
  const body = t.querySelector('tbody');
  for (const m of bt.months) {
    body.insertAdjacentHTML('beforeend', `<tr>
      <td class="name">${monthFull(m.month)}</td>
      <td>${int(m.projected.sessions)} / ${int(m.actual.sessions)}${m.projected.unprojectable
        ? ` <span class="dim">(+${m.projected.unprojectable} unvalued)</span>` : ''}${m.projected.closed
        ? ` <span class="dim" title="${esc(m.projected.closedNights.map((c) => `${c.date} ${c.holiday}`).join(', '))}">(${m.projected.closed} closed for a holiday)</span>` : ''}</td>
      <td>${money(m.projected.gross)}</td><td>${money(m.actual.gross)}</td>
      <td class="${Math.abs(m.errGross ?? 0) > 0.1 ? 'tone-neg' : ''}">${pctDelta(m.errGross)}</td>
      <td>${m.inRange.gross ? 'yes' : '<span class="tone-neg">no</span>'}</td>
      <td>${money(m.projected.net)}</td><td>${money(m.actual.net)}</td>
      <td class="${Math.abs(m.errNet ?? 0) > 0.1 ? 'tone-neg' : ''}">${pctDelta(m.errNet)}</td>
      <td>${m.inRange.net ? 'yes' : '<span class="tone-neg">no</span>'}</td></tr>`);
  }
  const wrap = h('div', 'so-scroll'); wrap.append(t);
  panel.append(wrap);
  panel.append(h('p', 'muted so-small', bt.drift
    ? `Error is (projected − actual) ÷ actual. The night-to-night range assumes the level holds; the
       backtest shows how far it does not. The part of the error that noise does not explain —
       ${pct(bt.drift.gross)} of a month's projected gross, ${pct(bt.drift.net)} of net — is added to
       every range on this screen, growing with the square root of how many months ahead.`
    : `Error is (projected − actual) ÷ actual. Fewer than ${MIN_BACKTEST_FOR_WIDENING} months could be
       backtested, so the ranges on this screen cover night-to-night noise only, not a change in level.`));
  return panel;
}

function inspectorHtml(ctx) {
  if (!ctx) {
    return `<p class="semi">Forecast</p>
      <p class="muted">No session history, so nothing to project.</p>`;
  }
  const { prep, bt, months, hz, cogs } = ctx;
  const usable = [...prep.baselines.values()].filter((b) => b.usable).length;
  return `
    <p class="semi">Forecast</p>
    <p class="muted">${hz.label} · ${monthFull(months[0])}${months.length > 1 ? ` to ${monthFull(months[months.length - 1])}` : ''}
      · ${prep.running.size} running slot${prep.running.size === 1 ? '' : 's'}, ${usable} with a usable baseline</p>
    <p class="inspector-section-label">How each night is valued</p>
    <p class="muted">At its own slot's average over the last ${FORECAST_WINDOW_DAYS / 7} weeks — same hall,
      weekday and session type — once the slot has ${MIN_SLOT_SESSIONS} sessions. Gross is the sum of every
      product category's sales; net is gross less payouts. The month to date is what is recorded.</p>
    <p class="inspector-section-label">Which nights are still to come</p>
    <p class="muted">Deployed and planned sessions from the scheduler where it reaches; otherwise every
      slot that ran at least ${RUNNING_MIN_SESSIONS} times in the last ${RUNNING_WINDOW_WEEKS} weeks, on
      its weekday. A day more than ${MISSING_GRACE_DAYS} day in the past with no data is missing, not
      projected. Yesterday and today are still projected, because data arrives a day late.</p>
    <p class="inspector-section-label">Drivers</p>
    <p class="muted">Attendance and spend per player multiply each slot's gross; the payout shift moves
      its payout ratio. Switching a slot off removes its nights. The baseline is always shown beside.</p>
    <p class="inspector-section-label">The range</p>
    <p class="muted">Two parts. Night-to-night: each slot's spread, combined in quadrature at
      ${Z_95} standard deviations. Level drift: ${bt.drift
        ? `the backtest error that noise does not explain (${pct(bt.drift.gross)} of projected gross a month),
           growing with the square root of months ahead and added linearly across months, because a
           change in level persists.`
        : 'not estimated — too few months backtested — so the range covers noise only and understates a long horizon.'}</p>
    <p class="inspector-section-label">Holidays</p>
    <p class="muted">New Year's Day and Eve, Easter Sunday, Mother's, Memorial, Independence,
      Father's and Labor Day, Thanksgiving, Christmas Eve and Day. Nothing is assumed closed: for each
      session the forecast looks at the same holiday the last time that session type at that hall was
      running on that weekday, and at the hall as a whole if the session has no record. Not held then —
      not projected, listed, and can be re-opened. Held — projected as usual. No history — projected
      and marked. The one exception is a closure the owner has confirmed (Santa Clara on Christmas
      Day, confirmed 1 Oct 2026): closed whatever the history says, and still re-openable. A scheduled
      session always counts. The backtest applies the history rule using only what was known before
      each month, and leaves owner confirmations out, since they were not known then.</p>
    <p class="inspector-section-label">With expenses</p>
    <p class="muted">Staff, at a blended cost per hour times hours per session, and fixed cost per
      session — both assumptions owned by Unit economics and marked wherever they appear.
      ${cogs ? 'Goods at the average of the sessions with linked boxes.' : 'No goods line: nothing is linked.'}
      No individual pay is read anywhere.</p>`;
}
