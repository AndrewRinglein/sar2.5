/* ============================================================================
   SAR 2.0 — U8, Session detail

   The biggest screen and the best test of the foundation: it exercises
   api.js, model.js, fmt.js, the rail and the inspector at once.

   Layout, following the v9 mockup and SPEC §4:
     · a row of lifted session cards — pick a night by what it did, not by its
       date — with a from-date filter and a "Previous" list for older nights;
     · the comparison pool's controls (period, Day Only, jackpot filter), the
       pool size and a "Compared to:" sentence. Every comparison on every
       sub-page runs against this ONE pool;
     · four sub-pages — Overview, Performance, Jackpots, Summary — rendered
       lazily: only the page in the URL is built.

   ALL STATE IS IN THE HASH (`id`, `from`, `period`, `dayOnly`, `jp`, `page`,
   `bridge`). SAR 1.0 kept all of it in memory and reset on reload (§4.2).

   Pure logic lives in lib/session-model.js; this file only draws.
   ========================================================================== */

import {
  metricsFor, sessionTotals, comparisonPool, standing,
  jackpotCap, jackpotFill, jackpotStatus, jackpotHistory, jackpotMaxPayout,
  sinceLastHit, jackpotParticipation, getMetric, delta, maxAttendanceFor, MIN_POOL,
} from '../lib/model.js';
import {
  usd, usd2, usdShort, pct, pctDelta, int, arrow,
  dateLong, dateShort, weekday, sessionType, esc, DASH,
} from '../lib/fmt.js';
import { donutChart, waterfallChart, bandedTrendChart } from '../lib/charts.js';
import { validatorClosureLabel } from '../lib/crew-model.js';
import {
  POOL_PERIODS, JACKPOT_FILTERS, PAGES, poolOptions, pageOf, filterJackpot, sessionPool,
  poolSentence, poolTotals, categoryComparison, distribution, netDrivers, bridgeItems,
  findings, expectedBand, slotSeries, bingoPerformance, pullTabPerformance, poolAvg,
  changeBadge, centreBadge, reconcile, jackpotTable, sideGames, cashIntegrity,
  varianceState, eventPL, bingoVsPullTab, plLadder, asNegative,
} from '../lib/session-model.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/** Like h(), but the content is TEXT. For anything typed by a person. */
const text = (tag, cls, value) => {
  const el = h(tag, cls);
  el.textContent = value ?? '';
  return el;
};

/** "+$1,234" / "-$1,234" / "$0". The sign leads the currency symbol. */
const signed = (v) => (v === null || v === undefined ? DASH : `${v > 0 ? '+' : ''}${usd(v || 0)}`);

/** A change chip: ▲ +4.2%, toned. Empty when there is no comparison. */
const chip = (d, { decimals = 1 } = {}) => (d
  ? `<span class="sd-delta tone-${d.tone}">${arrow(d.dir)} ${pctDelta(d.relative, { decimals })}</span>`
  : '<span class="sd-delta dim">–</span>');

/* ---------------------------------------------------------------------------
   Session picker
--------------------------------------------------------------------------- */

/**
 * Cards carry gross sales and the change against that slot's OWN baseline —
 * same hall, same weekday, same session type. Comparing a Saturday late
 * session to "the last session" would make every card look volatile for no
 * reason.
 */
function pickerCard(ev, ctx, selected) {
  const m = metricsFor(ev.id, ctx.metrics, ctx.idx);
  const t = sessionTotals(m, ctx.categories);
  const pool = comparisonPool(ev, ctx.events)
    .map((p) => sessionTotals(metricsFor(p.id, ctx.metrics, ctx.idx), ctx.categories).revenue);
  const st = standing(t.revenue, pool);
  const d = st.enough ? delta(t.revenue, st.mean) : null;

  const card = h('button', `sess-card${selected ? ' is-selected' : ''}`);
  card.type = 'button';
  card.dataset.id = ev.id;
  card.setAttribute('aria-pressed', String(selected));
  card.innerHTML = `
    <span class="sess-when">${weekday(ev.event_date).slice(0, 3)} ${dateShort(ev.event_date)}</span>
    <span class="sess-type">${esc(sessionType(ev.event_type))}</span>
    <span class="sess-gross">${usdShort(t.revenue)}</span>
    <span class="sess-delta ${d ? `tone-${d.tone}` : 'dim'}">
      ${d ? `${arrow(d.dir)} ${pctDelta(d.relative)}` : `pool ${st.n}/${MIN_POOL}`}
    </span>`;
  return card;
}

const PER_ROW = 6;
const PREVIOUS = 14;      // SAR 1.0's "Previous ▼" holds the next 14 older sessions

/**
 * Six cards (twelve with two rows), a from-date filter and a Previous list.
 * SPEC §4.1: the from-date is end-of-day — a session ON that date is kept.
 */
function renderPicker(ctx, { onPick, from, onFrom }) {
  const wrap = h('div', 'picker');
  const head = h('div', 'picker-head');
  head.append(h('span', 'picker-label', 'Recent sessions'));

  const tools = h('div', 'sd-picker-tools');
  const fromLabel = h('label', 'sd-from');
  fromLabel.append(h('span', 'dim', 'From'));
  const input = h('input', 'sd-from-input');
  input.type = 'date';
  input.value = from ?? '';
  input.setAttribute('aria-label', 'Show sessions on or before this date');
  input.addEventListener('change', () => onFrom(input.value || undefined));
  fromLabel.append(input);
  tools.append(fromLabel);
  if (from) {
    const clear = h('button', 'sd-from-clear', '×');
    clear.type = 'button';
    clear.title = 'Clear the from-date';
    clear.setAttribute('aria-label', 'Clear the from-date');
    clear.addEventListener('click', () => onFrom(undefined));
    tools.append(clear);
  }

  const prev = h('select', 'sd-previous');
  prev.setAttribute('aria-label', 'Previous sessions');
  tools.append(prev);

  const more = h('button', 'picker-more');
  more.type = 'button';
  tools.append(more);
  head.append(tools);

  const strip = h('div', 'picker-strip');
  let rows = 1;

  const paint = () => {
    const shown = ctx.visible.slice(0, PER_ROW * rows);
    strip.replaceChildren(...shown.map((ev) => pickerCard(ev, ctx, ev.id === ctx.selectedId)));
    for (const c of strip.querySelectorAll('.sess-card')) {
      c.addEventListener('click', () => onPick(c.dataset.id));
    }
    more.textContent = rows === 1 ? 'Show two rows' : 'Show one row';

    const older = ctx.visible.slice(PER_ROW * rows, PER_ROW * rows + PREVIOUS);
    const sel = ctx.events.find((e) => e.id === ctx.selectedId);
    const opts = [`<option value="">Previous ▼</option>`];
    const list = sel && !shown.includes(sel) && !older.includes(sel) ? [sel, ...older] : older;
    for (const e of list) {
      opts.push(`<option value="${esc(e.id)}"${e.id === ctx.selectedId && !shown.includes(e) ? ' selected' : ''}>
        ${weekday(e.event_date).slice(0, 3)} ${dateShort(e.event_date)} ${esc(e.event_date.slice(0, 4))} · ${esc(sessionType(e.event_type))}</option>`);
    }
    prev.innerHTML = opts.join('');
    prev.disabled = list.length === 0;
  };

  prev.addEventListener('change', () => { if (prev.value) onPick(prev.value); });
  more.addEventListener('click', () => { rows = rows === 1 ? 2 : 1; paint(); });
  paint();

  wrap.append(head, strip);
  if (!ctx.visible.length) {
    wrap.append(h('p', 'dim', `No sessions on or before ${dateLong(from)}.`));
  }
  return wrap;
}

/* ---------------------------------------------------------------------------
   Pool controls — SPEC §4.2. Real controls (SPEC §19.3: SAR 1.0's "Change"
   button only scrolled and flashed).
--------------------------------------------------------------------------- */

function renderPoolBar(ev, opts, n, ctx, go) {
  const bar = h('div', 'sd-pool');
  const controls = h('div', 'filter-bar sd-pool-controls');

  const periods = h('div', 'sd-seg');
  periods.setAttribute('role', 'group');
  periods.setAttribute('aria-label', 'Comparison period');
  for (const p of Object.keys(POOL_PERIODS)) {
    const b = h('button', `chip${opts.period === p ? ' is-active' : ''}`, p);
    b.type = 'button';
    b.dataset.period = p;
    b.setAttribute('aria-pressed', String(opts.period === p));
    b.title = `Compare against the ${POOL_PERIODS[p]} days before this session`;
    b.addEventListener('click', () => go({ period: p === '3M' ? undefined : p }));
    periods.append(b);
  }
  controls.append(periods, h('span', 'filter-sep'));

  const day = h('label', 'sd-check');
  const box = h('input');
  box.type = 'checkbox';
  box.className = 'sd-dayonly';
  box.checked = opts.dayOnly;
  if (opts.dayOnly) box.setAttribute('checked', '');
  box.addEventListener('change', () => go({ dayOnly: box.checked ? undefined : '0' }));
  day.append(box, document.createTextNode(' Day Only'));
  day.title = 'Same weekday and same session type. Off: any day at this hall.';
  controls.append(day, h('span', 'filter-sep'));

  const jpName = ctx.jackpotName;
  const sel = h('select', 'sd-jp-filter');
  sel.setAttribute('aria-label', `Filter the pool by ${jpName} balance`);
  const labels = { none: `${jpName}: any`, category: 'Same band', '10%': 'Within 10%', '20%': 'Within 20%' };
  sel.innerHTML = JACKPOT_FILTERS.map((f) =>
    `<option value="${f}"${opts.jackpot === f ? ' selected' : ''}>${labels[f]}</option>`).join('');
  sel.addEventListener('change', () => go({ jp: sel.value === 'none' ? undefined : sel.value }));
  controls.append(sel, h('span', 'filter-sep'));

  const count = h('span', `sd-pool-count${n < MIN_POOL ? ' is-small' : ''}`,
    `Pool: <strong>${int(n)}</strong>`);
  if (n < MIN_POOL) count.title = `Comparisons are withheld below ${MIN_POOL} sessions`;
  controls.append(count);

  bar.append(controls);
  bar.append(h('p', 'sd-compared', `<span class="dim">Compared to:</span> ${esc(
    poolSentence(ev, opts, n, { jackpotName: jpName, targetBalance: ctx.targetBalance }))}`));
  return bar;
}

function renderTabs(page, go) {
  const nav = h('div', 'sd-tabs');
  nav.setAttribute('role', 'tablist');
  const label = { overview: 'Overview', performance: 'Performance', jackpots: 'Jackpots', summary: 'Summary' };
  for (const p of PAGES) {
    const b = h('button', `sd-tab${p === page ? ' is-active' : ''}`, label[p]);
    b.type = 'button';
    b.dataset.page = p;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(p === page));
    b.addEventListener('click', () => go({ page: p === 'overview' ? undefined : p }));
    nav.append(b);
  }
  return nav;
}

/* ---------------------------------------------------------------------------
   KPI strip — gross sales leads, as agreed
--------------------------------------------------------------------------- */

function kpi(label, value, sub, tone, extra = '') {
  return h('div', 'kpi', `
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub ${tone ? `tone-${tone}` : 'dim'}">${sub ?? '&nbsp;'}</div>${extra}`);
}

function renderKpis(ev, t, ctx) {
  const pool = ctx.poolT;
  const poolOf = (fn) => pool.map(fn);

  const rev = standing(t.revenue, poolOf((x) => x.revenue));
  const att = standing(t.attendance, poolOf((x) => x.attendance));
  const net = standing(t.net, poolOf((x) => x.net));
  // RPA and margin against the POOL TOTALS, not the mean of per-session
  // ratios — SPEC §4.2, and what SAR 1.0 shows (verified 1 Oct 2026: +23.0%
  // from totals vs +22.8% from the mean of ratios on RWC 30 Sep).
  const sum = (fn) => pool.reduce((s, x) => s + (fn(x) ?? 0), 0);
  const poolAtt = sum((x) => x.attendance);
  const poolRev = sum((x) => x.revenue);
  const poolRpa = poolAtt > 0 ? poolRev / poolAtt : null;
  const poolMargin = poolRev > 0 ? (poolRev - sum((x) => x.payout)) / poolRev : null;
  const rpa = { ...standing(t.rpa, poolOf((x) => x.rpa)), mean: poolRpa };
  const margin = { ...standing(t.margin, poolOf((x) => x.margin)), mean: poolMargin };

  const label = ctx.opts.dayOnly
    ? `vs ${weekday(ev.event_date).slice(0, 3)} avg, ${ctx.opts.period}`
    : `vs hall avg, ${ctx.opts.period}`;
  const vs = (st, value, opts) => {
    if (!st.enough) return `<span class="dim">pool too small (${st.n} of ${MIN_POOL})</span>`;
    if (st.mean === null || value === null) return `<span class="dim">${label}</span>`;
    const d = delta(value, st.mean, opts);
    return `${arrow(d.dir)} ${pctDelta(d.relative)} ${label}`;
  };
  const tone = (st, value) => (st.enough && st.mean !== null && value !== null ? delta(value, st.mean).tone : null);

  // Margin: relative change AND the point difference, as SAR 1.0 prints both.
  const marginSub = margin.enough && margin.mean !== null && t.margin !== null
    ? `${vs(margin, t.margin)} · ${t.margin - margin.mean >= 0 ? '+' : ''}${((t.margin - margin.mean) * 100).toFixed(1)}pp`
    : vs(margin, t.margin);

  // Attendance as SAR 1.0 prints it: "{pct}%/{count}" of this hall's seats.
  const seats = maxAttendanceFor(ev.location_id, ctx.locations);
  const attValue = t.attendance === null ? DASH
    : `${Math.round((t.attendance / seats) * 100)}%/${int(t.attendance)}`;

  // Per-category RPA under the per-head card, for show_rpa categories.
  const cats = t.attendance > 0
    ? t.categories.filter((c) => c.showRpa)
      .map((c) => `<span>${esc(c.name)} <b>${usd2(c.revenue / t.attendance)}</b></span>`).join('')
    : '';

  const strip = h('div', 'kpis');
  strip.append(
    kpi('Gross sales', usd(t.revenue), vs(rev, t.revenue), tone(rev, t.revenue)),
    kpi('Net', usd(t.net), vs(net, t.net), tone(net, t.net)),
    kpi('Payouts', usd(t.payout),
        t.revenue ? `${pct(t.payout / t.revenue)} of gross` : DASH),
    kpi('Margin', pct(t.margin), marginSub, tone(margin, t.margin)),
    kpi('Attendance', attValue, vs(att, t.attendance), tone(att, t.attendance)),
    kpi('Per head', usd2(t.rpa), vs(rpa, t.rpa), tone(rpa, t.rpa),
        cats ? `<div class="sd-kpi-cats">${cats}</div>` : ''),
  );
  const attCard = strip.children[4];
  attCard.title = `${int(seats)} seats at this hall`;
  return strip;
}

/* ---------------------------------------------------------------------------
   Category table — each line against the pool. SPEC §4.8
--------------------------------------------------------------------------- */

function renderCategories(t, ctx) {
  const rows = categoryComparison(t, ctx.poolT);
  const wrap = h('section', 'panel sd-cats');
  const head = h('div', 'sd-panel-head');
  head.append(h('h3', 'panel-title', 'By category'));
  const toggle = h('button', 'picker-more sd-pool-toggle', 'Show pool averages');
  toggle.type = 'button';
  head.append(toggle);
  wrap.append(head);

  if (!rows.length) {
    wrap.append(h('p', 'dim', 'No product categories configured.'));
    return wrap;
  }

  const table = h('table', 'cat-table');
  table.innerHTML = `
    <thead><tr>
      <th class="name">Category</th><th>Revenue</th><th>Payouts</th>
      <th>Net</th><th>RPA</th><th>Margin</th><th>Share</th>
    </tr></thead><tbody></tbody>`;
  const body = table.querySelector('tbody');

  for (const c of rows) {
    const d = c.deltas;
    // Round to the displayed 0.1pp BEFORE choosing sign and tone, so a
    // −0.04pp change reads "· 0.0pp", not "▼ -0.0pp".
    const ppR = d.marginPP === null ? null : Math.round(d.marginPP * 1000) / 10;
    const pp = ppR === null ? '<span class="sd-delta dim">–</span>'
      : `<span class="sd-delta tone-${ppR > 0 ? 'pos' : ppR < 0 ? 'neg' : 'neutral'}">${
        arrow(Math.sign(ppR))} ${ppR > 0 ? '+' : ''}${(ppR === 0 ? 0 : ppR).toFixed(1)}pp</span>`;
    const margin = c.marginShown === null ? DASH
      : c.marginShown === 'N/A' ? '<span class="dim" title="Outside 0–50%: treated as unreliable">N/A</span>'
        : pct(c.marginShown);
    const tr = h('tr', 'sd-cat-row');
    tr.dataset.key = c.key;
    tr.innerHTML = `
      <td class="name">${esc(c.name)}</td>
      <td>${usd(c.revenue)} ${chip(d.revenue)}</td>
      <td>${usd(c.payout)} ${chip(d.payout)}</td>
      <td class="${c.net < 0 ? 'tone-neg' : ''}">${usd(c.net)} ${chip(d.net)}</td>
      <td>${c.showRpa ? `${usd2(c.rpa)} ${chip(d.rpa)}` : DASH}</td>
      <td class="sd-margin">${margin} ${c.showMargin ? pp : ''}</td>
      <td>${pct(c.share)}</td>`;
    body.append(tr);

    const p = c.pool;
    const pr = h('tr', 'sd-cat-pool is-hidden');
    pr.innerHTML = `
      <td class="name dim">pool of ${int(p.n)}</td>
      <td class="dim">${usd(p.avgRevenue)}</td>
      <td class="dim">${usd(p.avgPayout)}</td>
      <td class="dim">${usd(p.avgNet)}</td>
      <td class="dim">${c.showRpa ? usd2(p.rpa) : DASH}</td>
      <td class="dim">${c.showMargin ? (p.margin === null ? DASH : (p.margin >= 0 && p.margin <= 0.5 ? pct(p.margin) : 'N/A')) : DASH}</td>
      <td class="dim">${pct(p.share)}</td>`;
    body.append(pr);
  }

  const tr = h('tr', 'total-row');
  tr.innerHTML = `
    <td class="name">Total</td>
    <td>${usd(t.revenue)}</td><td>${usd(t.payout)}</td>
    <td>${usd(t.net)}</td><td>${usd2(t.rpa)}</td><td>${pct(t.margin)}</td><td>${t.revenue > 0 ? '100.0%' : DASH}</td>`;
  body.append(tr);

  // All rows open in lockstep, as SAR 1.0's boxes do (OPEN Q 20.4).
  toggle.addEventListener('click', () => {
    const hidden = !table.querySelector('.sd-cat-pool:not(.is-hidden)');
    for (const r of table.querySelectorAll('.sd-cat-pool')) r.classList.toggle('is-hidden', !hidden);
    toggle.textContent = hidden ? 'Hide pool averages' : 'Show pool averages';
  });

  wrap.append(table);
  wrap.append(h('p', 'sd-foot dim', ctx.poolT.length < MIN_POOL
    ? `Changes withheld: ${ctx.poolT.length} comparable session${ctx.poolT.length === 1 ? '' : 's'}, ${MIN_POOL} needed.`
    : 'Payout changes are shown without colour — a larger payout is not self-evidently bad. '
      + 'RPA is compared against pool revenue over pool attendance; margin outside 0–50% reads N/A.'));
  return wrap;
}

/* ---------------------------------------------------------------------------
   Distribution donuts — SPEC §4.7, with an explicit empty state (§19.2)
--------------------------------------------------------------------------- */

function renderDonut(title, items, emptyText) {
  const panel = h('section', 'panel sd-donut');
  panel.append(h('h3', 'panel-title', title));
  const total = items.filter((i) => i.value > 0).reduce((s, i) => s + i.value, 0);
  const svg = donutChart(items.map((i) => ({
    ...i, title: `${i.label}: ${usd(i.value)}${total > 0 ? ` (${pct(i.value / total)})` : ''}`,
  })), { centre: usdShort(total), centreSub: 'total' });
  if (!svg) {
    panel.append(h('div', 'sd-empty', `<p>${emptyText}</p>`));
    return panel;
  }
  const body = h('div', 'sd-donut-body');
  body.append(svg);
  const list = h('ul', 'sd-donut-legend');
  for (const i of items.filter((x) => x.value > 0)) {
    const li = h('li');
    const sw = h('span', 'sd-swatch');
    sw.style.background = i.colour;
    li.append(sw, h('span', 'sd-legend-name', esc(i.label)),
      h('span', 'sd-legend-val', `${usd(i.value)} <span class="dim">${pct(i.value / total, { decimals: 0 })}</span>`));
    list.append(li);
  }
  body.append(list);
  panel.append(body);
  return panel;
}

/* ---------------------------------------------------------------------------
   Bridge, drivers, findings — the v9 mockup's "why this night differed"
--------------------------------------------------------------------------- */

const withheld = (n) => `<p class="dim">Withheld: ${n} comparable session${n === 1 ? '' : 's'} in the pool, ${MIN_POOL} needed. Widen the period or clear a filter.</p>`;

function renderBridge(t, ctx, mode, go) {
  const panel = h('section', 'panel sd-bridge');
  const head = h('div', 'sd-panel-head');
  head.append(h('h3', 'panel-title', 'Why this night differed from a typical one'));
  const seg = h('div', 'sd-seg');
  for (const [m, lbl] of [['driver', 'By driver'], ['category', 'By category']]) {
    const b = h('button', `chip${mode === m ? ' is-active' : ''}`, lbl);
    b.type = 'button';
    b.dataset.bridge = m;
    b.setAttribute('aria-pressed', String(mode === m));
    b.addEventListener('click', () => go({ bridge: m === 'driver' ? undefined : m }));
    seg.append(b);
  }
  head.append(seg);
  panel.append(head);

  const n = ctx.poolT.length;
  if (n < MIN_POOL) {
    panel.append(h('div', 'sd-empty', withheld(n)));
    return panel;
  }
  const items = bridgeItems(t, ctx.poolT, mode);
  panel.append(waterfallChart(items, { fmt: usdShort, fmtDelta: (v) => `${v > 0 ? '+' : ''}${usdShort(v)}` }));
  const list = h('p', 'sd-foot dim', `Floating bridge from the pool's average net (${usd(items[0].value)}) to this night's
    (${usd(items[items.length - 1].value)}). Every bar is labelled; hover a bar for the exact figure.
    ${mode === 'category' ? 'By category the bars are exact — net is the sum of category nets.'
      : 'Attendance, spend per head and payout ratio, with the residual shown rather than hidden.'}`);
  panel.append(list);
  return panel;
}

function renderDrivers(t, ctx) {
  const panel = h('section', 'panel sd-drivers');
  const head = h('div', 'sd-panel-head');
  head.append(h('h3', 'panel-title', 'Ranked drivers'), h('span', 'dim sd-sub', 'candidates, not a verdict'));
  panel.append(head);
  const n = ctx.poolT.length;
  if (n < MIN_POOL) {
    panel.append(h('div', 'sd-empty', withheld(n)));
    return panel;
  }
  const d = netDrivers(t, ctx.poolT);
  const maxAbs = Math.max(1, ...d.rows.map((r) => Math.abs(r.impact)));
  const detail = (r) => {
    switch (r.key) {
      case 'attendance': return `${int(r.value)} vs ${int(r.base)} typical`;
      case 'spend': return `${usd2(r.value)} vs ${usd2(r.base)} typical`;
      case 'gross': return `${usd(r.value)} vs ${usd(r.base)} typical`;
      case 'payoutRatio': return `${pct(r.value)} vs ${pct(r.base)} typical`;
      default: return 'mix, rounding and everything else';
    }
  };
  for (const r of d.rows) {
    const pos = r.impact >= 0;
    const w = ((Math.abs(r.impact) / maxAbs) * 50).toFixed(1);
    const row = h('div', `sd-driver${r.residual ? ' is-residual' : ''}`);
    row.innerHTML = `
      <span class="sd-driver-name">${esc(r.label)}</span>
      <span class="sd-driver-detail dim">${detail(r)}</span>
      <span class="sd-driver-bar" aria-hidden="true"><span class="sd-driver-mid"></span>
        <i class="${r.residual ? 'is-residual' : pos ? 'is-pos' : 'is-neg'}" style="${pos ? 'left' : 'right'}:50%;width:${w}%"></i></span>
      <span class="sd-driver-val ${r.residual ? '' : pos ? 'tone-pos' : 'tone-neg'}">${signed(r.impact)}</span>`;
    panel.append(row);
  }
  panel.append(h('p', 'sd-foot dim', `Gap to the typical night: <b>${signed(d.gap)}</b>. Ranked by dollar impact.
    The residual is what attendance, spend and payout ratio together cannot account for.`));
  return panel;
}

function renderFindings(t, ctx, ev, m) {
  const panel = h('section', 'panel sd-findings');
  const list = findings(t, ctx.poolT, { ev, m, jackpots: ctx.jackpots });
  const flags = list.filter((f) => f.kind === 'flag').length;
  const head = h('div', 'sd-panel-head');
  head.append(h('h3', 'panel-title', 'Findings'),
    h('span', 'dim sd-sub', `${flags} flagged · ${list.length - flags} other`));
  panel.append(head);
  if (!list.length) {
    panel.append(h('p', 'dim', 'Nothing to report against this pool.'));
    return panel;
  }
  for (const f of list) {
    // A cash variance is OVER or SHORT, not above/below a baseline.
    const badge = f.kind === 'gate' ? 'SAMPLE' : f.kind === 'context' ? 'CONTEXT'
      : f.dir === 'over' ? 'OVER' : f.dir === 'short' ? 'SHORT'
      : f.dir === 'above' ? 'ABOVE' : 'BELOW';
    const row = h('div', `sd-finding is-${f.kind}`);
    row.innerHTML = `
      <span class="sd-fbadge tone-${f.tone}">${badge}</span>
      <span class="sd-ftext">${esc(f.text)}</span>
      <span class="sd-fconf dim">${f.z !== null ? `${f.z > 0 ? '+' : ''}${f.z.toFixed(1)}σ · ` : ''}${f.confidence}</span>`;
    panel.append(row);
  }
  return panel;
}

/* ---------------------------------------------------------------------------
   Expected-range band and P&L ladder
--------------------------------------------------------------------------- */

function renderBand(ev, ctx) {
  const panel = h('section', 'panel sd-band');
  const head = h('div', 'sd-panel-head');
  head.append(h('h3', 'panel-title', 'Net vs expected range'),
    h('span', 'dim sd-sub', `last 30 ${weekday(ev.event_date)} ${esc(sessionType(ev.event_type).toLowerCase())} sessions · band = 95% of the 12 before each`));
  panel.append(head);

  const rows = expectedBand(slotSeries(ev, ctx));
  if (rows.length < 2) {
    panel.append(h('div', 'sd-empty', '<p>Not enough sessions on this slot to draw a range.</p>'));
    return panel;
  }
  const chartRows = rows.map((r) => ({
    value: r.value, lo: r.lo, hi: r.hi, expected: r.expected,
    label: dateShort(r.date), highlight: r.id === ev.id,
    title: `${dateLong(r.date)}: net ${usd(r.value)}${r.lo === null
      ? ` · only ${r.n} earlier session${r.n === 1 ? '' : 's'}, no range`
      : ` · expected ${usd(r.expected)} · 95% range ${usd(r.lo)} to ${usd(r.hi)}${r.inside ? '' : ' · OUTSIDE the range'}`}`,
  }));
  panel.append(bandedTrendChart(chartRows, { fmtY: usdShort }));
  const me = rows[rows.length - 1];
  panel.append(h('p', 'sd-foot dim', me.lo === null
    ? `This session has only ${me.n} earlier sessions on its slot — too few for a range.`
    : `This session: ${usd(me.value)} against an expected ${usd(me.expected)} (range ${usd(me.lo)} to ${usd(me.hi)}) — <b>${me.inside ? 'inside' : 'outside'}</b> the range.
       The band is the 2.5th–97.5th percentile of the 12 sessions before each point; a point with fewer than ${MIN_POOL} has none.`));
  return panel;
}

function renderLadder(t) {
  const panel = h('section', 'panel sd-ladder');
  const head = h('div', 'sd-panel-head');
  head.append(h('h3', 'panel-title', 'What this session made'), h('span', 'dim sd-sub', 'gross down to profit'));
  panel.append(head);
  const table = h('table', 'cat-table sd-ladder-table');
  table.innerHTML = '<thead><tr><th class="name">Line</th><th>Amount</th><th class="name">Note</th></tr></thead>';
  const body = h('tbody');
  for (const r of plLadder(t)) {
    const tr = h('tr', `sd-rung is-${r.kind}`);
    tr.dataset.key = r.key;
    tr.innerHTML = `
      <td class="name">${esc(r.label)}</td>
      <td class="${r.kind === 'missing' ? 'dim' : (r.value < 0 ? 'tone-neg' : '')}">${r.kind === 'missing' ? DASH : usd(r.value)}</td>
      <td class="name dim">${esc(r.note)}</td>`;
    body.append(tr);
  }
  table.append(body);
  panel.append(table);
  panel.append(h('p', 'sd-foot dim', 'The ladder stops at contribution. Operating expenses are not stored in this '
    + 'database, so those rows are shown empty rather than as zero — a zero would read as "nothing was spent".'));
  return panel;
}

/* ---------------------------------------------------------------------------
   Jackpots (Overview panel)

   TWO progressives, not three. `analytics_config.settings.jackpots` defines
   Hotball and Mega Hotball, each with a balance, a carry-over and a
   participation cost. The gremlin has none of that — it is a payout that
   happens, confirmed by Angela — so it appears as an amount, never as a
   thermometer. Building it a fill bar would mean inventing a balance.

   Mega Hotball is `org_wide`: one pot shared across both halls. Showing it
   per-location would be wrong.
--------------------------------------------------------------------------- */

function renderJackpots(ev, m, ctx) {
  const wrap = h('section', 'panel');
  wrap.append(h('h3', 'panel-title', 'Jackpots'));

  const configured = ctx.config?.settings?.jackpots ?? [];
  const metricsOf = (e) => metricsFor(e.id, ctx.metrics, ctx.idx);

  // Oldest first, so "since last hit" counts forward through time.
  const chron = [...ctx.events].reverse();

  for (const j of configured) {
    const scoped = j.scope === 'org_wide'
      ? chron
      : chron.filter((e) => e.location_id === ev.location_id);

    const { payouts, balances } = jackpotHistory(scoped, metricsOf, j);
    // config `cap` is the documented fallback when there is no history at all.
    // Config caps are DOLLARS; jackpotCap works in cents.
    const cap = jackpotCap(payouts, balances, { fallback: j.cap ? j.cap * 100 : null });
    const maxPayout = jackpotMaxPayout(payouts);

    const balance = getMetric(m, j.balanceKey);
    const fill = jackpotFill(balance, cap);
    const status = jackpotStatus(fill);

    // History up to and including this session, for "since last hit".
    const upTo = [];
    for (const e of scoped) {
      const em = metricsOf(e);
      upTo.push({ balance: getMetric(em, j.balanceKey) ?? 0,
                  payout: Math.abs(getMetric(em, j.paidKey) ?? 0) });
      if (e.id === ev.id) break;
    }
    const { since, lastPayout } = sinceLastHit(upTo);
    const part = jackpotParticipation(m, j, getMetric(m, 'attendance'));

    const row = h('div', 'jp');
    row.innerHTML = `
      <div class="jp-head">
        <span class="jp-name">${esc(j.name)}</span>
        <span class="jp-scope dim">${j.scope === 'org_wide' ? 'both halls' : 'this hall'}</span>
        ${status ? `<span class="jp-status jp-${status.toLowerCase()}">${status}</span>` : ''}
        <span class="jp-balance">${usd(balance)}</span>
      </div>
      <div class="jp-track"><div class="jp-fill" style="width:${((fill ?? 0) * 100).toFixed(1)}%"></div></div>
      <dl class="jp-stats">
        <dt>Fill</dt><dd>${cap ? `${pct(fill)} of ${usdShort(cap)}` : DASH}</dd>
        <dt>Max payout</dt><dd>${usd(maxPayout)}</dd>
        <dt>Sessions since hit</dt><dd>${since === null ? 'never hit' : int(since)}</dd>
        <dt>Last payout</dt><dd>${usd(lastPayout)}</dd>
        <dt>Players</dt><dd>${part.players === null ? DASH
          : `${int(part.players)}${part.pctOfAttendance !== null ? ` (${pct(part.pctOfAttendance, { decimals: 0 })} of attendance)` : ''}`}</dd>
      </dl>`;
    wrap.append(row);
  }

  // The gremlin: an amount when it happens, never a thermometer.
  const grem = getMetric(m, 'gremlin_hotball');
  const line = h('div', 'jp-line');
  line.innerHTML = grem > 0
    ? `<span class="jp-name">Gremlin</span>
       <span class="dim">payout this session</span>
       <span class="jp-balance tone-neg">${usd(grem)}</span>`
    : `<span class="jp-name">Gremlin</span>
       <span class="dim">no payout this session</span>
       <span class="jp-balance dim">${DASH}</span>`;
  wrap.append(line);

  return wrap;
}

/* ---------------------------------------------------------------------------
   Performance — SPEC §4.9
--------------------------------------------------------------------------- */

const row = (label, value, { cls = '', indent = false, extra = '', key = '' } = {}) => `
  <div class="sd-row${indent ? ' is-indent' : ''}${cls ? ` ${cls}` : ''}"${key ? ` data-key="${key}"` : ''}>
    <span class="sd-row-label">${label}</span>
    <span class="sd-row-value">${value}${extra}</span>
  </div>`;

const money = (v, { negIsTone = true } = {}) => (v === null ? `<span class="dim">${DASH}</span>`
  : `<span class="${negIsTone && v < 0 ? 'tone-neg' : ''}">${usd(v)}</span>`);

function badgeHtml(b) {
  if (!b) return '';
  return ` <span class="sd-mini tone-${b.tone}">${arrow(b.dir)} ${Math.abs(b.rel * 100).toFixed(0)}%</span>
    <span class="sd-vs dim">avg ${usd(b.avg)}</span>`;
}

function centre(pl) {
  const c = centreBadge(pl);
  if (!c) return '';
  return `<span class="sd-centre ${pl >= 0 ? 'is-profit' : 'is-loss'}">${c}</span>`;
}

function renderPerformance(ev, t, m, ctx) {
  const root = h('div', 'sd-page sd-performance');
  const b = bingoPerformance(m);
  const p = pullTabPerformance(m);
  const enough = ctx.poolT.length >= MIN_POOL;
  const pm = ctx.poolT.map((x) => x.m);
  const avg = (k, o) => (enough ? poolAvg(pm, k, o) : null);

  // ONE headline P&L — the category rollup. SPEC §19.5.
  const rec = reconcile(t.net, b, p);
  const head = h('section', 'panel sd-headline');
  head.innerHTML = `
    <div class="sd-row is-total"><span class="sd-row-label">Session net (category rollup)</span>
      <span class="sd-row-value">${usd(t.net)}</span></div>
    ${rec.canonical !== null && !rec.agrees
    ? `<p class="sd-recon">Reconciliation: the canonical keys (bingo P&amp;L + pull-tab net) give
         ${usd(rec.canonical)}, ${signed(rec.diff)} from the category rollup. The headline uses the rollup;
         the panels below show the canonical figures as SAR 1.0 does.</p>`
    : (rec.canonical !== null ? '<p class="dim sd-foot">Canonical keys agree with the category rollup to within $1.</p>' : '')}`;
  root.append(head);

  const grid = h('div', 'sd-grid-2');

  /* ---- bingo ---- */
  const bp = h('section', 'panel sd-perf-bingo');
  const sub = (label, v, key) => (v === null ? '' : row(label, money(v), { indent: true, key, cls: 'is-muted' }));
  bp.innerHTML = `
    <div class="sd-panel-head"><h3 class="panel-title">Bingo performance</h3>${centre(b.pl)}</div>
    ${b.recorded ? `
    ${row('Bingo paper sales', money(b.paper), { key: 'paper' })}
    ${b.showStrips ? row('Bingo strip sales', money(b.strips), { key: 'strips' }) : ''}
    ${row('Supply sales', money(b.supply), { key: 'supply' })}
    ${sub('Daubers', b.daubers, 'daubers')}
    ${sub('Tape', b.tape, 'tape')}
    ${row('Discounts', money(asNegative(b.discounts)), { key: 'discounts' })}
    ${sub('Door prize ($10)', asNegative(b.door10), 'door10')}
    ${sub('Door prize ($30)', asNegative(b.door30), 'door30')}
    ${sub('Points redeemed', asNegative(b.points), 'points')}
    ${sub('Refunds / gift cert', b.refunds, 'refunds')}
    ${row('Net bingo sales', money(b.netBingoSales), { cls: 'is-subtotal', key: 'netBingoSales' })}
    ${row('Bingo payout', money(asNegative(b.payout)), { key: 'payout' })}
    <div class="sd-callout ${b.pl === null ? '' : b.pl >= 0 ? 'is-profit' : 'is-loss'}" data-key="bingoPL">
      <span>Bingo profit / loss</span><b>${b.pl === null ? DASH : signed(b.pl)}</b></div>
    ${row('Avg spend / player (paper only)', b.avgPaperOnly === null ? DASH : usd2(b.avgPaperOnly), { key: 'avgPaper' })}
    ${row('Avg spend / player (with supplies)', b.avgWithSupplies === null ? DASH : usd2(b.avgWithSupplies), { key: 'avgSupplies' })}
    ` : '<p class="dim">No bingo figures recorded for this session.</p>'}`;
  grid.append(bp);

  /* ---- pull tabs ---- */
  const pp = h('section', 'panel sd-perf-pulltab');
  const avgSales = avg('pulltab_sales');
  const avgPrizes = avg('pulltab_payouts', { abs: true });
  const avgNet = avg('pulltab_net');
  const avgYield = avgSales && avgNet !== null ? avgNet / avgSales : null;
  pp.innerHTML = `
    <div class="sd-panel-head"><h3 class="panel-title">Pull tab / instants</h3>${centre(p.net)}</div>
    ${p.recorded ? `
    ${row('Pull tab sales', money(p.sales), { key: 'ptSales', extra: badgeHtml(changeBadge(p.sales, avgSales)) })}
    ${row('Pull tab prizes', money(asNegative(p.prizes)), {
    key: 'ptPrizes', extra: badgeHtml(changeBadge(p.prizes === null ? null : Math.abs(p.prizes), avgPrizes, { neutral: true })) })}
    ${row('Pull tab net', money(p.net), { cls: 'is-subtotal', key: 'ptNet', extra: badgeHtml(changeBadge(p.net, avgNet)) })}
    ${row('Pull tab yield', pct(p.yield), { key: 'ptYield', extra: avgYield !== null ? ` <span class="sd-vs dim">avg ${pct(avgYield)}</span>` : '' })}
    ${row('Credit card sales', money(p.credit), { key: 'ptCredit' })}
    ${row('Cash sales (derived)', money(p.cash), { key: 'ptCash' })}
    ${p.cashShare !== null ? `
    <div class="sd-split" data-key="split">
      <div class="sd-split-legend"><span><i class="is-cash"></i>Cash ${Math.round(p.cashShare * 100)}%</span>
        <span><i class="is-credit"></i>Credit ${Math.round(p.creditShare * 100)}%</span></div>
      <div class="sd-split-bar" role="img" aria-label="Cash ${Math.round(p.cashShare * 100)}%, credit ${Math.round(p.creditShare * 100)}%">
        <span class="is-cash" style="width:${Math.max(0, Math.min(100, p.cashShare * 100)).toFixed(1)}%"></span>
        <span class="is-credit" style="width:${Math.max(0, Math.min(100, p.creditShare * 100)).toFixed(1)}%"></span></div>
    </div>` : ''}
    ${row('Avg spend / player', p.avgSpend === null ? DASH : usd2(p.avgSpend), { key: 'ptAvgSpend' })}
    ${row('Avg profit / player', p.avgProfit === null ? DASH : usd2(p.avgProfit), { key: 'ptAvgProfit' })}
    <div class="sd-callout ${p.net === null ? '' : p.net >= 0 ? 'is-profit' : 'is-loss'}" data-key="ptPL">
      <span>Pull tab profit</span><b>${p.net === null ? DASH : signed(p.net)}</b></div>
    ` : '<p class="dim">No pull-tab figures recorded for this session.</p>'}`;
  grid.append(pp);
  root.append(grid);

  root.append(h('p', 'sd-foot dim', enough
    ? `Change badges compare against the average of the ${ctx.poolT.length} pool sessions that recorded each figure; blank when that average is zero or missing.`
    : `Change badges withheld: ${ctx.poolT.length} comparable sessions, ${MIN_POOL} needed.`));
  return root;
}

/* ---------------------------------------------------------------------------
   Jackpots page — SPEC §4.10. The SAME 33/66/90 bands as Overview (§19.4).
--------------------------------------------------------------------------- */

function capsFor(ev, ctx, j) {
  const chron = [...ctx.events].reverse();
  const scoped = j.scope === 'org_wide' ? chron : chron.filter((e) => e.location_id === ev.location_id);
  const { payouts, balances } = jackpotHistory(scoped, (e) => metricsFor(e.id, ctx.metrics, ctx.idx), j);
  return {
    cap: jackpotCap(payouts, balances, { fallback: j.cap ? j.cap * 100 : null }),
    max: jackpotMaxPayout(payouts),
  };
}

function renderJackpotsPage(ev, t, m, ctx) {
  const root = h('div', 'sd-page sd-jackpots');
  const table = jackpotTable(m, ctx.jackpots, t.attendance);

  const panel = h('section', 'panel');
  const head = h('div', 'sd-panel-head');
  head.append(h('h3', 'panel-title', 'Jackpot balances & collections'),
    h('span', 'sd-count-badge', `${table.active} active jackpot${table.active === 1 ? '' : 's'}`));
  panel.append(head);

  if (!ctx.jackpots.length) {
    panel.append(h('p', 'dim', 'No jackpots configured.'));
    root.append(panel);
  } else {
    const grid = h('div', 'sd-jp-grid');
    for (const r of table.rows) {
      const { cap, max } = capsFor(ev, ctx, r.jp);
      const fill = jackpotFill(r.balance ?? 0, cap);
      const status = jackpotStatus(fill);
      const paid = r.paid !== null && r.paid > 0;
      const summary = paid
        ? `+${usd(r.collected ?? 0)} collected · ${usd(-Math.abs(r.paid))} paid out`
        : (r.collected > 0 ? `+${usd(r.collected)} collected this session` : (r.collected === null ? 'nothing recorded' : '+$0 collected'));
      const card = h('div', 'sd-jp-card');
      card.dataset.jackpot = r.name;
      card.innerHTML = `
        <div class="sd-jp-top"><span class="jp-name">${esc(r.name)}</span>
          ${status ? `<span class="jp-status jp-${status.toLowerCase()}">${status}</span>` : ''}</div>
        <div class="sd-jp-bal">${usd(r.balance)}</div>
        <div class="dim sd-jp-sum">${summary}</div>
        ${r.players !== null && r.players > 0 ? `<div class="sd-jp-part">${int(r.players)} players${r.pctAtt !== null ? ` (${pct(r.pctAtt, { decimals: 0 })} of attendance)` : ''}</div>` : ''}
        <div class="sd-jp-bar"><i class="jp-${(status ?? 'low').toLowerCase()}" style="width:${((fill ?? 0) * 100).toFixed(0)}%"></i></div>
        <div class="sd-jp-scale dim"><span>$0</span><span>${usd(max ?? cap)} max</span></div>`;
      grid.append(card);
    }
    panel.append(grid);

    const tbl = h('table', 'cat-table sd-jp-table');
    tbl.innerHTML = `<thead><tr><th class="name">Jackpot</th><th>Collected</th><th>Paid out</th><th>Net</th>
      <th>Balance</th><th>Players</th><th>% Att.</th><th class="name">Status</th></tr></thead>`;
    const body = h('tbody');
    for (const r of table.rows) {
      const tr = h('tr');
      tr.innerHTML = `
        <td class="name">${esc(r.name)}</td>
        <td>${usd(r.collected)}</td>
        <td class="${r.paid > 0 ? 'tone-neg' : 'dim'}">${r.paid === null ? DASH : (r.paid > 0 ? usd(-r.paid) : '$0')}</td>
        <td class="${r.net > 0 ? 'tone-pos' : r.net < 0 ? 'tone-neg' : 'dim'}">${signed(r.net)}</td>
        <td>${usd(r.balance)}</td>
        <td>${r.players === null ? DASH : int(r.players)}</td>
        <td>${r.pctAtt === null ? DASH : pct(r.pctAtt, { decimals: 0 })}</td>
        <td class="name"><span class="sd-status is-${esc(String(r.status).replace(' ', '-').toLowerCase())}">${esc(r.status)}</span></td>`;
      body.append(tr);
    }
    const T = table.total;
    const tot = h('tr', 'total-row');
    tot.innerHTML = `
      <td class="name">Total jackpots</td>
      <td>${usd(T.collected)}</td>
      <td class="${T.paid > 0 ? 'tone-neg' : ''}">${T.paid === null ? DASH : (T.paid > 0 ? usd(-T.paid) : '$0')}</td>
      <td>${signed(T.net)}</td>
      <td>${usd(T.balance)}</td>
      <td>${T.players === null ? DASH : int(T.players)}</td>
      <td>${T.pctAtt === null ? DASH : pct(T.pctAtt, { decimals: 0 })}</td>
      <td></td>`;
    body.append(tot);
    tbl.append(body);
    panel.append(tbl);
    panel.append(h('p', 'sd-foot dim', 'Fill and status use the same 33 / 66 / 90% bands as the Overview panel, '
      + 'against the P90 of past payouts. SAR 1.0 used a second set (15 / 30 / 70%) on this page (SPEC §19.4).'));
    root.append(panel);
  }

  const sg = sideGames(m);
  if (sg.show) {
    const side = h('section', 'panel sd-side');
    side.dataset.section = 'side-games';
    side.innerHTML = `
      <h3 class="panel-title">Side games</h3>
      <table class="cat-table"><thead><tr><th class="name">Game</th><th>Collected</th><th>Paid out</th><th>Net</th></tr></thead>
      <tbody>
        <tr><td class="name">Yellow sheet</td><td>${usd(sg.yellowIn)}</td>
          <td class="${sg.yellowOut ? 'tone-neg' : ''}">${sg.yellowOut === null ? DASH : usd(-Math.abs(sg.yellowOut) || 0)}</td>
          <td class="${sg.yellowNet < 0 ? 'tone-neg' : sg.yellowNet > 0 ? 'tone-pos' : ''}">${signed(sg.yellowNet)}</td></tr>
        <tr><td class="name">Concessions</td><td>${usd(sg.concessions)}</td>
          <td class="dim" title="Concessions have no payout">no payout</td>
          <td class="${sg.concessions > 0 ? 'tone-pos' : ''}">${usd(sg.concessions)}</td></tr>
        <tr class="total-row"><td class="name">Total side games</td><td>${usd(sg.totalIn)}</td>
          <td>${sg.totalOut === null ? DASH : (sg.totalOut > 0 ? usd(-sg.totalOut) : '$0')}</td><td>${signed(sg.totalNet)}</td></tr>
      </tbody></table>`;
    root.append(side);
  }
  return root;
}

/* ---------------------------------------------------------------------------
   Summary — SPEC §4.11
--------------------------------------------------------------------------- */

function varianceBox(v) {
  const s = varianceState(v);
  if (!s) return '<div class="sd-var is-none"><span class="sd-var-icon">–</span><span>Over/short: not recorded</span></div>';
  return `<div class="sd-var is-${s}" data-state="${s}"><span class="sd-var-icon">${s === 'good' ? '✓' : '!'}</span>
    <span>Over/short: ${signed(v)}</span></div>`;
}

function renderSummary(ev, t, m, ctx) {
  const root = h('div', 'sd-page sd-summary');
  const ci = cashIntegrity(m, ctx.jackpots);

  if (ci.hasReconciliation) {
    const grid = h('div', `sd-grid-2${ci.hasPTRecon && ci.hasBingoRecon ? '' : ' is-single'}`);
    grid.dataset.section = 'cash-integrity';
    const B = ci.bingo;
    if (ci.hasBingoRecon) {
      const bp = h('section', 'panel sd-register');
      bp.innerHTML = `<h3 class="panel-title">Bingo register</h3>
        ${row('Starting cash', money(B.startCash), { cls: 'is-muted' })}
        ${row('Cash collected', money(B.cash))}
        ${row('Credit collected', money(B.credit))}
        ${row('Actual deposit', money(B.actual), { cls: 'is-subtotal' })}
        ${row('Expected deposit', money(B.expected), { cls: 'is-muted' })}
        ${varianceBox(B.variance)}`;
      grid.append(bp);
    }
    if (ci.hasPTRecon) {
      const P = ci.pulltab;
      const pp = h('section', 'panel sd-drawer');
      pp.innerHTML = `<h3 class="panel-title">Pull tab drawer</h3>
        ${row('Starting cash', money(P.startCash), { cls: 'is-muted' })}
        ${row('Cash count (end of night)', money(P.cashCount))}
        ${row('Less: jackpot deposit', money(P.jackpotDeposit === null ? null : asNegative(P.jackpotDeposit)))}
        ${row('Cash deposit', money(P.cash))}
        ${row('Credit deposit', money(P.credit))}
        ${row('Actual deposit', money(P.actual), { cls: 'is-subtotal' })}
        ${row('Expected deposit', money(P.expected), { cls: 'is-muted' })}
        ${varianceBox(P.variance)}`;
      grid.append(pp);
    }
    root.append(grid);
  }

  const pl = h('section', 'panel sd-eventpl');
  const rows = eventPL(t);
  pl.innerHTML = `<h3 class="panel-title">Event P&amp;L</h3>
    ${rows.length ? rows.map((c) => row(`${esc(c.name)} net`,
    `<span class="${c.net >= 0 ? 'tone-pos' : 'tone-neg'}">${signed(c.net)}</span>`, { key: `pl-${c.key}` })).join('')
    : '<p class="dim">No category recorded any revenue or net this session.</p>'}
    ${row('Event net revenue', `<span class="${t.net >= 0 ? 'tone-pos' : 'tone-neg'}">${signed(t.net)}</span>`, { cls: 'is-total', key: 'eventNet' })}`;

  const b = bingoPerformance(m);
  const p = pullTabPerformance(m);
  const bvp = bingoVsPullTab(b.pl, p.net);
  const combined = ci.hasReconciliation ? ci.combined : null;
  const cs = ci.hasReconciliation ? varianceState(combined) : null;
  const stats = h('div', 'sd-stats');
  stats.innerHTML = `
    <div class="sd-stat" data-key="combined">
      <div class="sd-stat-label">Combined over/short</div>
      <div class="sd-stat-value ${cs ? `is-${cs}` : 'dim'}">${ci.hasReconciliation ? signed(combined) : 'N/A'}</div>
      <div class="sd-stat-detail dim">${ci.hasReconciliation
    ? `Bingo: ${signed(ci.bingo.variance)} · Instants: ${signed(ci.pulltab.variance)}` : 'No reconciliation data'}</div>
    </div>
    <div class="sd-stat" data-key="bingo-vs-pt">
      <div class="sd-stat-label">Bingo as % of pull tab profit</div>
      <div class="sd-stat-value">${bvp.pct === null ? DASH : pct(bvp.pct)}</div>
      <div class="sd-stat-detail dim">${esc(bvp.detail ?? 'Needs bingo and pull-tab figures')}</div>
    </div>`;
  pl.append(stats);
  root.append(pl);
  root.append(renderLadder(t));
  return root;
}

/* ---------------------------------------------------------------------------
   Crew — MANAGERS DESIGN §6
--------------------------------------------------------------------------- */

/** The three roles, in the order they appear on the roster. */
const CREW_ROLES = ['MOD', 'Paymaster', 'Flash Manager'];

/**
 * Who ran this session.
 *
 * A role with no assignment prints a dash and KEEPS ITS LABEL. Dropping it
 * would make a session with no Paymaster look identical to one where the
 * Paymaster simply is not shown, and a missing Paymaster is information.
 *
 * A day that failed the ordinal-join count guard says so with both counts,
 * rather than rendering an empty crew line that reads as "nobody worked".
 */
export function renderCrew(ev, ctx, onNavigate) {
  const wrap = h('div', 'crew');

  /* The data validator is where crews are entered now, so its list wins when
     it has this night — every role, not only the three managers. */
  const v = ctx.crew?.ok ? ctx.crew.byEvent?.get(ev.id) : null;
  if (v && v.crew.length) return renderValidatorCrew(wrap, v, onNavigate);

  if (!ctx.managers?.ok) {
    wrap.innerHTML = `<span class="crew-label">Crew</span>
      <span class="dim">Scheduler not connected</span>`;
    return wrap;
  }

  const clash = ctx.managers.report?.mismatched?.find(
    (m) => m.date === ev.event_date && m.locationId === ev.location_id,
  );
  if (clash) {
    wrap.innerHTML = `<span class="crew-label">Crew</span>
      <span class="dim">Not matched — ${int(clash.ops)} scheduled,
      ${int(clash.events)} with results on this day</span>`;
    return wrap;
  }

  const crew = ctx.managers.crewOf?.get(ev.id);
  if (!crew) {
    wrap.innerHTML = `<span class="crew-label">Crew</span>
      <span class="dim">No roster for this date</span>`;
    return wrap;
  }

  wrap.append(h('span', 'crew-label', 'Crew'));
  for (const role of CREW_ROLES) {
    const person = crew[role];
    const slot = h('span', 'crew-slot');
    if (person) {
      const btn = h('button', 'crew-name');
      btn.type = 'button';
      btn.textContent = person.name;
      btn.title = `${role} — open their record`;
      btn.addEventListener('click', () => onNavigate('managers', {
        tab: 'person', staff: person.staffId, role,
      }));
      slot.append(text('span', 'crew-role', role), btn);
    } else {
      slot.append(text('span', 'crew-role', role), h('span', 'crew-none', DASH));
    }
    wrap.append(slot);
  }
  wrap.append(h('span', 'crew-src dim', ctx.crew && !ctx.crew.ok
    ? 'from the scheduler · validator not connected' : 'from the scheduler'));
  return wrap;
}

/**
 * The validator's crew, by role in roster order. The three manager roles keep
 * their label even when empty, as above; names are free text typed by
 * managers, so they are set as text, never as HTML.
 */
function renderValidatorCrew(wrap, v, onNavigate) {
  wrap.classList.add('crew-validator');
  wrap.append(h('span', 'crew-label', 'Crew'));
  const roles = [...new Set([...CREW_ROLES, ...v.crew.map((c) => c.role)])];
  for (const role of roles) {
    const people = v.crew.filter((c) => c.role === role);
    const slot = h('span', 'crew-slot');
    slot.append(text('span', 'crew-role', role));
    if (!people.length) {
      slot.append(h('span', 'crew-none', DASH));
    } else {
      const names = h('span', 'crew-names');
      people.forEach((c, i) => {
        if (i) names.append(document.createTextNode(', '));
        if (CREW_ROLES.includes(role)) {
          const btn = h('button', 'crew-name');
          btn.type = 'button';
          btn.textContent = c.name;
          btn.title = `${role} — open their record`;
          btn.addEventListener('click', () => onNavigate('managers', { tab: 'person', staff: c.id, role }));
          names.append(btn);
        } else {
          const t = h('span', 'crew-plain');
          t.textContent = c.name;
          names.append(t);
        }
      });
      slot.append(names);
    }
    wrap.append(slot);
  }
  const src = h('span', `crew-src ${v.approved ? 'dim' : 'crew-pending'}`);
  src.textContent = v.approved ? 'from the validator (approved)' : 'from the validator (not yet approved)';
  src.textContent += ` · ${validatorClosureLabel(v.session?.status)}`;
  wrap.append(src);
  return wrap;
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function renderSession({ data, params = {}, onNavigate, setInspectorContent }) {
  const idx = data.idx;
  const events = data.events;                 // newest first
  const root = h('div', 'screen');

  if (!events.length) {
    root.append(h('div', 'placeholder', '<p class="semi">No sessions recorded</p>'));
    return root;
  }

  const from = isDate(params.from) ? params.from : null;
  const visible = from ? events.filter((e) => e.event_date <= from) : events;
  const selectedId = (params.id && events.some((e) => e.id === params.id) ? params.id : null)
    || events.find((e) => e.event_date === params.date)?.id
    || visible[0]?.id
    || events[0]?.id;

  const ev = events.find((e) => e.id === selectedId) ?? events[0];
  const m = metricsFor(ev.id, data.metrics, idx);
  const t = sessionTotals(m, data.categories);
  const hall = data.locations.find((l) => l.id === ev.location_id)?.name ?? 'Unknown hall';

  const opts = poolOptions(params);
  const page = pageOf(params);
  const pool = sessionPool(ev, data, opts);
  const jpf = filterJackpot(data.config);
  const ctx = {
    ...data, idx, events, visible, selectedId, opts,
    poolT: poolTotals(pool, data),
    jackpots: data.config?.settings?.jackpots ?? [],
    jackpotName: jpf.name,
    targetBalance: getMetric(m, jpf.balanceKey) ?? 0,
  };

  /** Every change goes through the hash, keeping what was not changed. */
  const go = (patch) => onNavigate('session', { ...params, ...patch });

  root.append(renderPicker(ctx, {
    from,
    onPick: (id) => go({ id }),
    onFrom: (d) => go({ from: d, id: undefined }),
  }));

  const head = h('div', 'screen-head');
  head.innerHTML = `
    <h2>${esc(hall)} · ${dateLong(ev.event_date)}</h2>
    <p class="muted">${esc(sessionType(ev.event_type))} session</p>`;
  root.append(head);

  root.append(renderCrew(ev, ctx, onNavigate));
  root.append(renderPoolBar(ev, opts, pool.length, ctx, go));
  root.append(renderTabs(page, go));

  // Lazy: only the page in the URL is built.
  if (page === 'performance') {
    root.append(renderPerformance(ev, t, m, ctx));
  } else if (page === 'jackpots') {
    root.append(renderJackpotsPage(ev, t, m, ctx));
  } else if (page === 'summary') {
    root.append(renderSummary(ev, t, m, ctx));
  } else {
    const ov = h('div', 'sd-page sd-overview');
    ov.append(renderKpis(ev, t, ctx));
    const g1 = h('div', 'sd-grid-75');
    g1.append(renderBridge(t, ctx, params.bridge === 'category' ? 'category' : 'driver', go), renderDrivers(t, ctx));
    ov.append(g1);
    ov.append(renderFindings(t, ctx, ev, m));
    ov.append(renderCategories(t, ctx));
    const g2 = h('div', 'sd-grid-2');
    g2.append(
      renderDonut('Revenue distribution', distribution(t, data.categories, 'revenue'),
        'No revenue recorded for this session.'),
      renderDonut('Payout distribution', distribution(t, data.categories, 'payout'),
        'No payouts recorded for this session.'),
    );
    ov.append(g2);
    const g3 = h('div', 'sd-grid-75');
    g3.append(renderBand(ev, ctx), renderLadder(t));
    ov.append(g3);
    ov.append(renderJackpots(ev, m, ctx));
    root.append(ov);
  }

  /* The inspector describes the selected night before anything is clicked. */
  const n = pool.length;
  setInspectorContent?.(`
    <p class="semi">${dateLong(ev.event_date)}</p>
    <p class="muted">${esc(hall)} · ${esc(sessionType(ev.event_type))}</p>
    <p class="inspector-section-label">This night</p>
    <dl class="inspector-filters">
      <dt>Gross</dt><dd>${usd(t.revenue)}</dd>
      <dt>Net</dt><dd>${usd(t.net)}</dd>
      <dt>Margin</dt><dd>${pct(t.margin)}</dd>
      <dt>Attendance</dt><dd>${int(t.attendance)}</dd>
      <dt>Per head</dt><dd>${usd2(t.rpa)}</dd>
    </dl>
    <p class="inspector-section-label">Compared against</p>
    <p class="muted">${esc(poolSentence(ev, opts, n, { jackpotName: ctx.jackpotName, targetBalance: ctx.targetBalance }))}.</p>
    <p class="dim">A trailing window, not all history: gross has grown about
       75% in two years, so an all-time average measures growth rather than
       this session. The window ends the day before this session.</p>
    ${n < MIN_POOL
      ? `<p class="dim">Below the ${MIN_POOL}-session floor, so comparisons are withheld rather than shown from too little data.</p>`
      : ''}`);

  return root;
}
