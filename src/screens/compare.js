/* ============================================================================
   SAR 2.0 — U18, Compare (cohort comparison)

   Rebuilt to match SAR 1.0's `CohortComparison` (sar/app.html ~8382–9290)
   and SPEC §7, rather than the single-dimension A-vs-B picker that stood here
   before.

   TWO COHORTS, EACH: a date range, a weekday set, a session type.
   LOCATION IS SHARED — one filter for both cohorts, as in SAR 1.0.
   Cohort B can mirror A's dates and/or days (days mirror is on by default).

   What is preserved from SAR 1.0, verbatim in effect:
     · the six metrics, in order: Total Sales, Net Sales, Total Payout,
       Margin %, RPA, Attendance — and no per-category breakdown
     · Welch's t-test with Welch–Satterthwaite df, Cohen's d with pooled SD
     · the percentage delta formula: (meanA − meanB) / |meanB|, A relative to B
     · the d and p label thresholds (0.2/0.5/0.8 and 0.001/0.01/0.05/0.10)
       and SAR 1.0's wording for them
     · six accordion cards, where expanding one expands all
     · four charts: Delta (default), Day Breakdown, Dot Plot, Box & Whisker
     · day options generated from the data, with Early/Late splits only where
       a weekday actually has both
     · defaults of last three months vs the three months before, auto-run

   What is deliberately different:
     · ONE median and ONE quartile definition (SPEC §19.7). The box plot uses
       `model.median` and `model.percentile`, the same functions the stats
       table uses. SAR 1.0's box plot used nearest-rank and recomputed its own
       median, so its box disagreed with its own table.
     · A minimum-sample gate of 3 per side (`model.welchT`'s default), not 2.
       Below it the card says "not enough sessions" instead of a verdict.
     · A session-type control per cohort (U18): Regular / Late / Both.
     · State lives in the URL hash, so a comparison survives reload and can
       be shared. SAR 1.0 reset everything on reload.
     · B's default range ends the day BEFORE A starts. SAR 1.0's default had
       B end on A's start date, so a session on that date sat in both.
     · No "Run Comparison" button: every change navigates, and every render
       runs. SAR 1.0 auto-ran on every change too, which made its button moot.
     · The ⓘ explanations are inline `<details>`, never a popup or a dialog.
     · Total Payout's delta is shown without a good/bad colour. A higher
       payout is not bad on its own — it usually means more sales — and
       colouring it green or red asserts a judgement the number does not
       support. The sign and arrow still show.
   ========================================================================== */

import {
  metricsFor, sessionTotals, mean, median, stdev, percentile, welchT, effectSize,
  significance,
} from '../lib/model.js';
import { frame, axes, linearScale, bandScale, svgEl, withTitle, legend } from '../lib/charts.js';
import { usd, usd2, pct, pctDelta, int, esc, DASH, weekday, dateShort } from '../lib/fmt.js';
import { buildHash } from '../lib/router.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/* ---------------------------------------------------------------------------
   Constants — SAR 1.0's six metrics, in its order and with its labels
--------------------------------------------------------------------------- */

/**
 * `fmt` formats a value of the metric for display; `fmtAbs` formats a spread
 * (an SD is never negative, so the same formatter serves).
 * `neutral` withholds a good/bad tone from the delta — see the header.
 */
export const METRICS = [
  { key: 'totalSales',   label: 'Total Sales',  get: (t) => t.revenue,    fmt: usd },
  { key: 'netSales',     label: 'Net Sales',    get: (t) => t.net,        fmt: usd },
  { key: 'totalPayouts', label: 'Total Payout', get: (t) => t.payout,     fmt: usd, neutral: true },
  { key: 'margin',       label: 'Margin %',     get: (t) => t.margin,     fmt: (v) => pct(v) },
  { key: 'rpa',          label: 'RPA',          get: (t) => t.rpa,        fmt: usd2 },
  { key: 'attendance',   label: 'Attendance',   get: (t) => t.attendance, fmt: int },
];

/** The four sub-metrics of SAR 1.0's Day Breakdown chart, in its order. */
export const DAY_METRICS = ['attendance', 'rpa', 'netSales', 'margin'];

export const CHARTS = [
  { key: 'delta',    label: 'Delta' },
  { key: 'days',     label: 'Day breakdown' },
  { key: 'dumbbell', label: 'Dot plot' },
  { key: 'box',      label: 'Box & whisker' },
];

export const SESSION_TYPES = [
  { key: 'both',    label: 'Both' },
  { key: 'regular', label: 'Regular' },
  { key: 'late',    label: 'Late' },
];

/** The minimum sessions per side before a verdict is offered. */
export const MIN_SESSIONS = 3;

/**
 * SAR 1.0's wording for the significance bands. `model.significance` uses
 * the SAME thresholds (0.001 / 0.01 / 0.05 / 0.10) but returns the words
 * "very strong / strong / moderate / weak / none" for use in sentences.
 * The cards keep SAR 1.0's labels so the screen reads as the one people
 * know; the mapping is here, in one place.
 */
export const SIGNIFICANCE_LABELS = {
  'very strong': 'Highly Significant',
  strong: 'Very Significant',
  moderate: 'Significant',
  weak: 'Marginally Significant',
  none: 'Not Significant',
};

/** SAR 1.0's Cohen's d labels. Same thresholds as `model.effectSize`. */
export const EFFECT_LABELS = {
  negligible: 'Negligible', small: 'Small', medium: 'Medium', large: 'Large',
};

const COHEN_HELP = "Cohen's d measures the size of the difference between the two cohorts "
  + 'relative to how spread out their sessions are. Below 0.2 is negligible, 0.2–0.5 small, '
  + '0.5–0.8 medium, above 0.8 large. Unlike the percentage change, d accounts for the '
  + 'night-to-night variation, so it says whether a difference is big enough to matter.';

const P_HELP = "The p-value, from Welch's t-test, is how often random chance alone would "
  + 'produce a gap this large between two groups of sessions. Below 0.001 is highly '
  + 'significant, below 0.01 very significant, below 0.05 significant, below 0.10 marginal, '
  + `otherwise not significant. Needs at least ${MIN_SESSIONS} sessions in each cohort.`;

/* ---------------------------------------------------------------------------
   Dates — UTC throughout, as fmt.js parses them
--------------------------------------------------------------------------- */

const asUTC = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
const toISO = (d) => d.toISOString().slice(0, 10);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(iso, n) {
  const d = asUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

/** Months arithmetic that clamps to the month end: 31 May − 3 = 28 Feb. */
export function addMonths(iso, n) {
  const d = asUTC(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toISO(d);
}

/**
 * Defaults: A is the last three months ending at the latest session; B is
 * the three months before that, ending the day before A starts.
 */
export function defaultCohorts(events = [], { today = null } = {}) {
  let latest = null;
  for (const e of events) {
    const d = String(e.event_date ?? '').slice(0, 10);
    if (ISO_RE.test(d) && (latest === null || d > latest)) latest = d;
  }
  const aTo = latest ?? toISO(today ? asUTC(today) : new Date());
  const aFrom = addMonths(aTo, -3);
  const bTo = addDays(aFrom, -1);
  const bFrom = addMonths(aFrom, -3);
  return { aFrom, aTo, bFrom, bTo };
}

/* ---------------------------------------------------------------------------
   Day options — generated from the data, as SAR 1.0 does
--------------------------------------------------------------------------- */

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday first, as SAR 1.0 lists them. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** A session's weekday index. The stored name wins; the date decides otherwise. */
export function dowOf(e) {
  const i = DOW.indexOf(String(e.day_of_week ?? ''));
  if (i >= 0) return i;
  return DOW.indexOf(weekday(e.event_date));
}

const typeOf = (e) => (e.event_type === 'late' ? 'late' : 'regular');

/**
 * Only weekdays with sessions appear. A weekday with both regular and late
 * sessions splits into "Sat Early" and "Sat Late"; one with only late
 * sessions shows "Sat Late"; one with only regular shows "Sat".
 */
export function dayOptions(events = []) {
  const seen = new Set();
  for (const e of events) {
    const d = dowOf(e);
    if (d >= 0) seen.add(`${d}:${typeOf(e)}`);
  }
  const out = [];
  for (const d of DAY_ORDER) {
    const hasRegular = seen.has(`${d}:regular`);
    const hasLate = seen.has(`${d}:late`);
    const abbr = ABBR[d];
    const base = abbr.toLowerCase();
    if (hasRegular && hasLate) {
      out.push({ key: base, dow: d, type: 'regular', label: `${abbr} Early` });
      out.push({ key: `${base}-late`, dow: d, type: 'late', label: `${abbr} Late` });
    } else if (hasRegular) {
      out.push({ key: base, dow: d, type: 'regular', label: abbr });
    } else if (hasLate) {
      out.push({ key: `${base}-late`, dow: d, type: 'late', label: `${abbr} Late` });
    }
  }
  return out;
}

/** The option a session falls under, or null if its weekday has none. */
function optionFor(e, opts) {
  const d = dowOf(e); const t = typeOf(e);
  return opts.find((o) => o.dow === d && o.type === t) ?? null;
}

/* ---------------------------------------------------------------------------
   State — read from the hash, written back to it
--------------------------------------------------------------------------- */

const validType = (t) => (SESSION_TYPES.some((s) => s.key === t) ? t : 'both');
const validChart = (c) => (CHARTS.some((x) => x.key === c) ? c : 'delta');
const validDate = (s, fallback) => (ISO_RE.test(String(s ?? '')) ? s : fallback);

/**
 * Day selections encode as a comma list of option keys. Absent means ALL —
 * the default — and a lone "-" means none, so the two are never confused.
 */
function parseDays(raw, allKeys) {
  if (raw === undefined || raw === null || raw === '') return [...allKeys];
  if (raw === '-') return [];
  return String(raw).split(',').filter((k) => allKeys.includes(k));
}
function encodeDays(days, allKeys) {
  if (days.length === allKeys.length && allKeys.every((k) => days.includes(k))) return undefined;
  if (!days.length) return '-';
  return days.join(',');
}

export function readState(params = {}, data = {}) {
  const opts = dayOptions(data.events ?? []);
  const allKeys = opts.map((o) => o.key);
  const def = defaultCohorts(data.events ?? []);
  const halls = (data.locations ?? []).map((l) => l.id);
  return {
    hall: halls.includes(params.hall) ? params.hall : 'all',
    a: {
      from: validDate(params.a_from, def.aFrom),
      to: validDate(params.a_to, def.aTo),
      days: parseDays(params.a_days, allKeys),
      type: validType(params.a_type),
    },
    b: {
      from: validDate(params.b_from, def.bFrom),
      to: validDate(params.b_to, def.bTo),
      days: parseDays(params.b_days, allKeys),
      type: validType(params.b_type),
    },
    mirrorDates: params.mdates === '1',
    mirrorDays: params.mdays !== '0',
    chart: validChart(params.chart),
    opts,
  };
}

/** Every field the hash needs, with defaults omitted so the URL stays short. */
export function stateToParams(st) {
  const allKeys = st.opts.map((o) => o.key);
  return {
    hall: st.hall === 'all' ? undefined : st.hall,
    a_from: st.a.from, a_to: st.a.to,
    a_days: encodeDays(st.a.days, allKeys),
    a_type: st.a.type === 'both' ? undefined : st.a.type,
    b_from: st.b.from, b_to: st.b.to,
    b_days: encodeDays(st.b.days, allKeys),
    b_type: st.b.type === 'both' ? undefined : st.b.type,
    mdates: st.mirrorDates ? '1' : undefined,
    mdays: st.mirrorDays ? undefined : '0',
    chart: st.chart === 'delta' ? undefined : st.chart,
  };
}

/** Cohort B as it is actually applied, after the mirror checkboxes. */
export function effectiveCohorts(st) {
  const b = {
    from: st.mirrorDates ? st.a.from : st.b.from,
    to: st.mirrorDates ? st.a.to : st.b.to,
    days: st.mirrorDays ? st.a.days : st.b.days,
    type: st.mirrorDays ? st.a.type : st.b.type,
  };
  return { a: { ...st.a }, b };
}

/* ---------------------------------------------------------------------------
   Filtering and statistics
--------------------------------------------------------------------------- */

export function filterCohort(events, cohort, hall, opts) {
  return events.filter((e) => {
    const d = String(e.event_date ?? '').slice(0, 10);
    if (d < cohort.from || d > cohort.to) return false;
    if (hall !== 'all' && e.location_id !== hall) return false;
    if (cohort.type !== 'both' && typeOf(e) !== cohort.type) return false;
    const o = optionFor(e, opts);
    return o !== null && cohort.days.includes(o.key);
  });
}

/** Per cohort per metric: mean, median, sample SD, min, max, count, sum. */
export function cohortStats(values) {
  const xs = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (!xs.length) {
    return { values: [], n: 0, mean: null, median: null, sd: null, min: null, max: null, sum: 0 };
  }
  return {
    values: xs, n: xs.length,
    mean: mean(xs), median: median(xs), sd: stdev(xs),
    min: Math.min(...xs), max: Math.max(...xs),
    sum: xs.reduce((s, v) => s + v, 0),
  };
}

/**
 * SAR 1.0's percentage change: (meanA − meanB) / |meanB|, A relative to B.
 * Undefined when B is empty or its mean is zero.
 */
export function pctChange(A, B) {
  if (!B.n || !A.n || B.mean === 0) return null;
  return (A.mean - B.mean) / Math.abs(B.mean);
}

/** Welch's t, Cohen's d and their labels for one metric. */
export function testMetric(A, B) {
  const r = welchT(A.values, B.values, { min: MIN_SESSIONS });
  if (!r.enough && r.reason === 'no variance') {
    // Both sides flat. SAR 1.0 reports t = 0, p = 1, d = 0 here, and so do we:
    // two groups of identical numbers are not "insufficient", they are equal.
    return { enough: true, t: 0, df: A.n + B.n - 2, p: 1, d: 0,
             sig: 'none', eff: 'negligible' };
  }
  if (!r.enough) return { enough: false, nA: r.nA, nB: r.nB };
  return {
    enough: true, t: r.t, df: r.df, p: r.p, d: r.cohensD,
    sig: significance(r.p), eff: effectSize(r.cohensD),
  };
}

/** The whole comparison, computed once per render and shared by every chart. */
export function compareCohorts(data, st) {
  const { a, b } = effectiveCohorts(st);
  const totalsOf = (e) => sessionTotals(metricsFor(e.id, data.metrics, data.idx), data.categories);
  const eventsA = filterCohort(data.events ?? [], a, st.hall, st.opts);
  const eventsB = filterCohort(data.events ?? [], b, st.hall, st.opts);
  const rowsA = eventsA.map((e) => ({ event: e, totals: totalsOf(e) }));
  const rowsB = eventsB.map((e) => ({ event: e, totals: totalsOf(e) }));

  const results = METRICS.map((metric) => {
    const A = cohortStats(rowsA.map((r) => metric.get(r.totals)));
    const B = cohortStats(rowsB.map((r) => metric.get(r.totals)));
    return { metric, A, B, test: testMetric(A, B), pct: pctChange(A, B) };
  });

  return { a, b, rowsA, rowsB, results };
}

/* ---------------------------------------------------------------------------
   Charts — SVG, colours only through CSS classes
--------------------------------------------------------------------------- */

const text = (attrs, content) => {
  const t = svgEl('text', attrs);
  t.textContent = content;
  return t;
};

/**
 * Sign and tone are decided on the ROUNDED one-decimal percentage, so a
 * change of −0.04% reads "0.0%" with no arrow rather than "▼ −0.0%".
 */
const roundPct = (fraction) => (fraction === null ? null : Math.round(fraction * 1000) / 1000);
const dirOf = (fraction) => {
  const r = roundPct(fraction);
  return r === null ? null : (r > 0 ? 1 : r < 0 ? -1 : 0);
};
const fmtSigned = (fraction) => (fraction === null ? DASH : pctDelta(roundPct(fraction)));

/** Delta: one bar per metric, percentage change, positive up. */
export function deltaChart(results) {
  const f = frame({ height: 300, left: 56, right: 16, bottom: 44 });
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch cmp-chart' });
  const deltas = results.map((r) => (r.pct === null ? 0 : r.pct * 100));
  // Symmetric about zero, never narrower than ±5%, so a flat comparison does
  // not read as a dramatic one. SAR 1.0 used the same floor.
  const maxAbs = Math.max(5, ...deltas.map(Math.abs));
  const y = linearScale({ min: -maxAbs, max: maxAbs, size: f.plotHeight, pad: 0.1, zeroBased: false });
  const band = bandScale({ n: results.length, size: f.plotWidth, inner: 0.4 });
  axes(svg, f, {
    yScale: y, yTicks: 4, fmtY: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}%`,
    band, xLabels: results.map((r) => r.metric.label),
  });
  results.forEach((r, i) => {
    const d = deltas[i];
    const top = f.top + y(Math.max(0, d));
    const bottom = f.top + y(Math.min(0, d));
    const dir = dirOf(r.pct);
    const cls = dir === null ? 'cmp-none' : (dir >= 0 ? 'cmp-pos' : 'cmp-neg');
    svg.append(withTitle(svgEl('rect', {
      x: f.left + band.at(i), y: top, width: band.width,
      height: Math.max(1, bottom - top), rx: 3, class: `ch-bar cmp-delta ${cls}`,
    }), `${r.metric.label}: ${fmtSigned(r.pct)} (A ${r.metric.fmt(r.A.mean)} vs B ${r.metric.fmt(r.B.mean)})`));
    svg.append(text({
      x: f.left + band.centre(i), y: d >= 0 ? top - 6 : bottom + 12,
      class: `ch-label cmp-delta-label ${cls}`,
    }, fmtSigned(r.pct)));
  });
  svg.append(text({ x: f.left + f.plotWidth / 2, y: f.top - 4, class: 'ch-label' },
    '% change from Cohort B to Cohort A'));
  return svg;
}

/**
 * Day breakdown: a group per weekday (with Late split), four sub-metrics
 * each, A solid and B at 30% opacity, every metric normalised to its own
 * maximum so four different units share one axis.
 */
export function dayBreakdownChart(rowsA, rowsB, opts) {
  const wrap = h('div', 'cmp-days');
  const metrics = DAY_METRICS.map((k) => METRICS.find((m) => m.key === k));
  const groupOf = (rows) => {
    const g = new Map();
    for (const r of rows) {
      const o = optionFor(r.event, opts);
      if (!o) continue;
      if (!g.has(o.key)) g.set(o.key, []);
      g.get(o.key).push(r.totals);
    }
    return g;
  };
  const gA = groupOf(rowsA); const gB = groupOf(rowsB);
  const days = opts.filter((o) => gA.has(o.key) || gB.has(o.key));

  if (!days.length) {
    wrap.append(h('p', 'dim', 'No sessions to break down by day.'));
    return wrap;
  }

  const meanOf = (totals, m) => {
    const xs = totals.map(m.get).filter((v) => v !== null && Number.isFinite(v));
    return xs.length ? mean(xs) : 0;
  };
  const cell = (g, day, m) => meanOf(g.get(day.key) ?? [], m);
  const maxPer = metrics.map((m) => Math.max(1e-9,
    ...days.map((d) => Math.max(cell(gA, d, m), cell(gB, d, m)))));

  const f = frame({ height: 320, left: 48, right: 16, bottom: 56 });
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch cmp-chart' });
  const y = linearScale({ min: 0, max: 1, size: f.plotHeight, pad: 0 });
  const band = bandScale({ n: days.length, size: f.plotWidth, inner: 0.25 });
  axes(svg, f, {
    yScale: y, yTicks: 4, fmtY: (v) => `${Math.round(v * 100)}%`, band,
    xLabels: days.map((d) => d.label),
  });
  const slot = band.width / metrics.length;
  const barW = Math.max(2, (slot - 2) / 2);

  days.forEach((day, di) => {
    metrics.forEach((m, mi) => {
      const vA = cell(gA, day, m); const vB = cell(gB, day, m);
      const x0 = f.left + band.at(di) + mi * slot;
      const diff = vA - vB;
      const title = `${day.label} · ${m.label}\nCohort A: ${m.fmt(vA)}\nCohort B: ${m.fmt(vB)}`
        + `\nDiff: ${diff >= 0 ? '+' : ''}${m.fmt(diff)}`;
      for (const [which, v, dx] of [['a', vA, 0], ['b', vB, barW + 1]]) {
        const top = f.top + y(Math.max(0, v / maxPer[mi]));
        svg.append(withTitle(svgEl('rect', {
          x: x0 + dx, y: top, width: barW, height: Math.max(0, f.plotBottom - top), rx: 2,
          class: `ch-bar cmp-dm cmp-dm-${mi} cmp-bar-${which}`,
        }), title));
      }
    });
    const nA = (gA.get(day.key) ?? []).length; const nB = (gB.get(day.key) ?? []).length;
    svg.append(text({ x: f.left + band.centre(di), y: f.plotBottom + 32, class: 'ch-label' },
      `A:${nA} B:${nB}`));
  });

  wrap.append(svg);
  wrap.append(legend(metrics.map((m, mi) => ({
    key: m.key, label: `${m.label} (max ${m.fmt(maxPer[mi])})`, colour: `var(--series-${[5, 1, 2, 4][mi]})`,
  }))));
  const ab = h('div', 'ch-legend cmp-ab-legend');
  ab.innerHTML = '<span class="ch-key"><span class="ch-swatch cmp-swatch-a"></span>Cohort A</span>'
    + '<span class="ch-key"><span class="ch-swatch cmp-swatch-b"></span>Cohort B</span>';
  wrap.append(ab);
  return wrap;
}

/** Dot plot: A and B means per metric joined by a line; each row scales itself. */
export function dumbbellChart(results) {
  const rowH = 48;
  const f = frame({ height: 28 + results.length * rowH + 12, left: 110, right: 84, top: 28, bottom: 12 });
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch cmp-chart' });

  // Legend in the top-right, as SAR 1.0 draws it.
  svg.append(svgEl('circle', { cx: f.width - 150, cy: 12, r: 5, class: 'cmp-dot-a' }));
  svg.append(text({ x: f.width - 141, y: 16, class: 'ch-tick', 'text-anchor': 'start' }, 'Cohort A'));
  svg.append(svgEl('circle', { cx: f.width - 72, cy: 12, r: 5, class: 'cmp-dot-b' }));
  svg.append(text({ x: f.width - 63, y: 16, class: 'ch-tick', 'text-anchor': 'start' }, 'Cohort B'));

  results.forEach((r, i) => {
    const cy = f.top + i * rowH + rowH / 2;
    svg.append(text({ x: f.left - 12, y: cy + 4, class: 'ch-tick ch-tick-y' }, r.metric.label));
    svg.append(svgEl('line', {
      x1: f.left, x2: f.left + f.plotWidth, y1: cy, y2: cy, class: 'ch-grid',
    }));
    const a = r.A.mean; const b = r.B.mean;
    const vals = [a, b].filter((v) => v !== null);
    if (!vals.length) return;
    // Per-row scale: 15% of the larger magnitude as padding each side, which
    // is SAR 1.0's ×0.85 / ×1.15 for positive values and still works for a
    // negative margin, where multiplying by 0.85 would shrink the wrong way.
    const pad = 0.15 * Math.max(...vals.map(Math.abs)) || 1;
    const lo = Math.min(...vals) - pad; const hi = Math.max(...vals) + pad;
    const x = (v) => f.left + ((v - lo) / (hi - lo)) * f.plotWidth;
    if (a !== null && b !== null) {
      svg.append(svgEl('line', { x1: x(a), x2: x(b), y1: cy, y2: cy, class: 'cmp-dumbbell' }));
    }
    for (const [which, v] of [['b', b], ['a', a]]) {
      if (v === null) continue;
      svg.append(withTitle(svgEl('circle', { cx: x(v), cy, r: 7, class: `cmp-dot-${which}` }),
        `Cohort ${which.toUpperCase()} mean ${r.metric.label}: ${r.metric.fmt(v)}`));
      svg.append(text({ x: x(v), y: cy - 12, class: `ch-label cmp-val-${which}` }, r.metric.fmt(v)));
    }
    if (r.pct !== null) {
      svg.append(text({
        x: f.width - 8, y: cy + 4, 'text-anchor': 'end',
        class: `ch-tick cmp-delta-label ${dirOf(r.pct) >= 0 ? 'cmp-pos' : 'cmp-neg'}`,
      }, fmtSigned(r.pct)));
    }
  });
  return svg;
}

/**
 * Box & whisker small multiples: one cell per metric, A and B side by side.
 * Quartiles by `model.percentile` and the median by `model.median` — the
 * same definitions as the stats table (SPEC §19.7). Whiskers are min and
 * max, as in SAR 1.0; there is no outlier rule.
 */
export function boxPlotChart(results) {
  const cols = 3; const rows = Math.ceil(results.length / cols);
  const cellW = 250; const cellH = 170;
  const W = cols * cellW + 10; const H = rows * cellH + 10;
  const pad = { top: 28, right: 14, bottom: 26, left: 58 };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ch cmp-chart cmp-boxes' });

  results.forEach((r, i) => {
    const ox = (i % cols) * cellW + 5; const oy = Math.floor(i / cols) * cellH + 5;
    const plotW = cellW - pad.left - pad.right; const plotH = cellH - pad.top - pad.bottom;
    svg.append(svgEl('rect', { x: ox, y: oy, width: cellW - 4, height: cellH - 4, rx: 6, class: 'cmp-cell' }));
    svg.append(text({ x: ox + cellW / 2, y: oy + 16, class: 'cmp-cell-title' }, r.metric.label));

    const all = [...r.A.values, ...r.B.values];
    if (!all.length) {
      svg.append(text({ x: ox + cellW / 2, y: oy + cellH / 2, class: 'ch-label' }, 'No sessions'));
      return;
    }
    const y = linearScale({
      min: Math.min(...all), max: Math.max(...all), size: plotH, pad: 0, zeroBased: false,
    });
    const yAt = (v) => oy + pad.top + y(v);
    for (let t = 0; t <= 4; t += 1) {
      const v = y.lo + ((y.hi - y.lo) * t) / 4;
      svg.append(svgEl('line', {
        x1: ox + pad.left - 4, x2: ox + pad.left + plotW, y1: yAt(v), y2: yAt(v), class: 'ch-grid',
      }));
      svg.append(text({ x: ox + pad.left - 8, y: yAt(v) + 3, class: 'ch-tick ch-tick-y' }, r.metric.fmt(v)));
    }

    const boxW = 32;
    for (const [which, S, frac] of [['a', r.A, 0.3], ['b', r.B, 0.7]]) {
      if (!S.n) continue;
      const q1 = percentile(S.values, 0.25);
      const q3 = percentile(S.values, 0.75);
      const med = median(S.values);        // THE median. Same as the table.
      const cx = ox + pad.left + plotW * frac;
      const g = svgEl('g', { class: `cmp-box cmp-box-${which}` });
      g.append(svgEl('line', { x1: cx, x2: cx, y1: yAt(S.max), y2: yAt(S.min), class: 'cmp-whisker' }));
      g.append(svgEl('line', { x1: cx - 8, x2: cx + 8, y1: yAt(S.max), y2: yAt(S.max), class: 'cmp-whisker' }));
      g.append(svgEl('line', { x1: cx - 8, x2: cx + 8, y1: yAt(S.min), y2: yAt(S.min), class: 'cmp-whisker' }));
      g.append(svgEl('rect', {
        x: cx - boxW / 2, y: yAt(q3), width: boxW, height: Math.max(1, yAt(q1) - yAt(q3)), rx: 3,
        class: 'cmp-iqr',
      }));
      g.append(svgEl('line', {
        x1: cx - boxW / 2, x2: cx + boxW / 2, y1: yAt(med), y2: yAt(med), class: 'cmp-median',
        'data-median': med,
      }));
      g.append(text({ x: cx, y: oy + cellH - 10, class: `ch-label cmp-val-${which}` },
        `${which.toUpperCase()} (n=${S.n})`));
      withTitle(g, `${r.metric.label} — Cohort ${which.toUpperCase()}\nmin ${r.metric.fmt(S.min)}`
        + ` · Q1 ${r.metric.fmt(q1)} · median ${r.metric.fmt(med)} · Q3 ${r.metric.fmt(q3)}`
        + ` · max ${r.metric.fmt(S.max)}`);
      svg.append(g);
    }
  });
  return svg;
}

/* ---------------------------------------------------------------------------
   The screen
--------------------------------------------------------------------------- */

const describeCohort = (c, opts) => {
  const allKeys = opts.map((o) => o.key);
  const days = c.days.length === allKeys.length ? 'every day'
    : c.days.length ? opts.filter((o) => c.days.includes(o.key)).map((o) => o.label).join(', ')
      : 'no days';
  const type = c.type === 'both' ? '' : ` · ${c.type} only`;
  return `${dateShort(c.from)} ${c.from.slice(0, 4)} – ${dateShort(c.to)} ${c.to.slice(0, 4)} · ${days}${type}`;
};

export function renderCompare({ data, params = {}, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen cmp');
  const st = readState(params, data);
  const go = (next) => onNavigate?.('compare', stateToParams({ ...st, ...next, opts: st.opts }));

  /* ---- shared location ---- */
  const bar = h('div', 'filter-bar');
  bar.append(h('span', 'picker-label', 'Location'));
  for (const l of [{ id: 'all', name: 'Both halls' }, ...(data.locations ?? [])]) {
    const b = h('button', `chip${st.hall === l.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l.name; b.dataset.hall = l.id;
    b.addEventListener('click', () => go({ hall: l.id }));
    bar.append(b);
  }
  root.append(bar);

  /* ---- cohort cards ---- */
  const cmp = compareCohorts(data, st);
  const grid = h('div', 'cmp-cohorts');
  grid.append(cohortCard('a', st, cmp, go), cohortCard('b', st, cmp, go));
  root.append(grid);

  if (!cmp.rowsA.length && !cmp.rowsB.length) {
    root.append(h('div', 'placeholder',
      '<p class="semi">No sessions in either cohort</p>'
      + '<p class="dim">Widen a date range or tick more days.</p>'));
    setInspectorContent?.(inspectorHtml(data, st, cmp));
    return root;
  }

  /* ---- six accordion cards ---- */
  const cards = h('div', 'cmp-cards');
  cmp.results.forEach((r, i) => cards.append(metricCard(r, i, cards)));
  root.append(cards);

  /* ---- charts: built once, switched without recomputation ---- */
  const panel = h('section', 'panel cmp-chart-panel');
  const head = h('div', 'cmp-chart-head');
  head.append(h('h3', 'panel-title', 'Visual comparison'));
  const chips = h('div', 'filter-bar cmp-chart-chips');
  const built = {
    delta: deltaChart(cmp.results),
    days: dayBreakdownChart(cmp.rowsA, cmp.rowsB, st.opts),
    dumbbell: dumbbellChart(cmp.results),
    box: boxPlotChart(cmp.results),
  };
  const stage = h('div', 'cmp-stage');
  for (const c of CHARTS) {
    const holder = h('div', 'cmp-chart-holder');
    holder.dataset.chart = c.key;
    holder.hidden = c.key !== st.chart;
    holder.append(built[c.key]);
    stage.append(holder);
  }
  const show = (key) => {
    for (const holder of stage.children) holder.hidden = holder.dataset.chart !== key;
    for (const chip of chips.children) chip.classList.toggle('is-active', chip.dataset.chart === key);
    // Remember the choice in the hash WITHOUT a re-render: replaceState fires
    // no hashchange, so the cached charts stay and a reload comes back here.
    try {
      window.history?.replaceState?.(null, '', buildHash('compare',
        stateToParams({ ...st, chart: key })));
    } catch { /* no history in this environment; the choice is still shown */ }
  };
  for (const c of CHARTS) {
    const chip = h('button', `chip${c.key === st.chart ? ' is-active' : ''}`);
    chip.type = 'button'; chip.textContent = c.label; chip.dataset.chart = c.key;
    chip.addEventListener('click', () => show(c.key));
    chips.append(chip);
  }
  head.append(chips);
  panel.append(head, stage);
  root.append(panel);

  setInspectorContent?.(inspectorHtml(data, st, cmp));
  return root;
}

/* ---- one cohort's controls ---- */
function cohortCard(side, st, cmp, go) {
  const isB = side === 'b';
  const c = st[side];
  const n = isB ? cmp.rowsB.length : cmp.rowsA.length;
  const card = h('section', `panel cmp-cohort cmp-cohort-${side}`);
  card.dataset.cohort = side;
  card.append(h('h3', 'panel-title',
    `<span class="cmp-swatch cmp-swatch-${side}"></span>Cohort ${side.toUpperCase()} `
    + `<span class="dim cmp-count">${int(n)} session${n === 1 ? '' : 's'}</span>`));

  const set = (patch) => go({ [side]: { ...c, ...patch } });

  /* dates */
  const datesHead = h('div', 'cmp-row-head');
  datesHead.append(h('span', 'picker-label', 'Date range'));
  if (isB) {
    datesHead.append(checkbox('mdates', "Mirror A's dates", st.mirrorDates,
      (on) => go({ mirrorDates: on })));
  }
  card.append(datesHead);
  const dates = h('div', 'cmp-dates');
  for (const [key, label] of [['from', 'From'], ['to', 'To']]) {
    const lab = h('label', 'cmp-field');
    lab.append(h('span', 'dim', label));
    const input = h('input');
    input.type = 'date'; input.name = `${side}_${key}`;
    input.setAttribute('value', c[key]); input.value = c[key];
    input.addEventListener('change', () => {
      if (ISO_RE.test(input.value)) set({ [key]: input.value });
    });
    lab.append(input);
    dates.append(lab);
  }
  dates.hidden = isB && st.mirrorDates;
  card.append(dates);

  /* days + session type */
  const daysHead = h('div', 'cmp-row-head');
  daysHead.append(h('span', 'picker-label', 'Days of week'));
  if (isB) {
    daysHead.append(checkbox('mdays', "Mirror A's days", st.mirrorDays,
      (on) => go({ mirrorDays: on })));
  }
  const mirroring = isB && st.mirrorDays;
  if (!mirroring) {
    const allNone = h('span', 'cmp-all-none');
    for (const [label, keys] of [['All', st.opts.map((o) => o.key)], ['None', []]]) {
      const b = h('button', 'chip');
      b.type = 'button'; b.textContent = label;
      b.addEventListener('click', () => set({ days: keys }));
      allNone.append(b);
    }
    daysHead.append(allNone);
  }
  card.append(daysHead);

  const days = h('div', 'cmp-days-list');
  if (!st.opts.length) days.append(h('span', 'dim', 'No sessions loaded.'));
  for (const o of st.opts) {
    const excluded = c.type !== 'both' && o.type !== c.type;
    const lab = h('label', `cmp-day${excluded ? ' is-off' : ''}`);
    const cb = h('input'); cb.type = 'checkbox'; cb.value = o.key;
    cb.checked = c.days.includes(o.key); cb.disabled = excluded;
    if (cb.checked) cb.setAttribute('checked', '');
    cb.addEventListener('change', () => set({
      days: cb.checked ? [...c.days, o.key] : c.days.filter((k) => k !== o.key),
    }));
    lab.append(cb, document.createTextNode(o.label));
    days.append(lab);
  }
  days.hidden = mirroring;
  card.append(days);

  const typeRow = h('div', 'filter-bar cmp-type');
  typeRow.append(h('span', 'picker-label', 'Sessions'));
  for (const t of SESSION_TYPES) {
    const b = h('button', `chip${c.type === t.key ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = t.label; b.dataset.type = t.key;
    b.addEventListener('click', () => set({ type: t.key }));
    typeRow.append(b);
  }
  typeRow.hidden = mirroring;
  card.append(typeRow);

  if (mirroring) card.append(h('p', 'dim cmp-mirror-note', "Using Cohort A's days and session type."));
  return card;
}

function checkbox(name, label, checked, onChange) {
  const lab = h('label', 'cmp-mirror');
  const cb = h('input'); cb.type = 'checkbox'; cb.name = name; cb.checked = checked;
  if (checked) cb.setAttribute('checked', '');
  cb.addEventListener('change', () => onChange(cb.checked));
  lab.append(cb, document.createTextNode(label));
  return lab;
}

/* ---- one metric's accordion card ---- */
function metricCard(r, i, cards) {
  const m = r.metric;
  const card = h('article', 'cmp-card');
  card.dataset.metric = m.key;

  const dir = dirOf(r.pct);
  const toneOf = () => {
    if (!dir || m.neutral) return 'tone-neutral';
    return dir > 0 ? 'tone-pos' : 'tone-neg';
  };
  const arrow = !dir ? '·' : (dir > 0 ? '▲' : '▼');
  const sd = (S) => (S.sd === null ? '' : `<span class="dim cmp-sd">± ${m.fmt(S.sd)}</span>`);

  const head = h('button', 'cmp-card-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  head.innerHTML = `
    <span class="cmp-card-title">${m.label}<span class="cmp-chevron">▾</span></span>
    <span class="cmp-means">
      <span class="cmp-mean cmp-mean-a"><span class="cmp-side">Cohort A</span>
        <span class="cmp-big">${m.fmt(r.A.mean)}</span>${sd(r.A)}</span>
      <span class="cmp-mean cmp-mean-b"><span class="cmp-side">Cohort B</span>
        <span class="cmp-big">${m.fmt(r.B.mean)}</span>${sd(r.B)}</span>
    </span>
    <span class="cmp-delta ${toneOf()}">${arrow} ${fmtSigned(r.pct)}</span>`;

  const row = (label, a, b) => `<div class="cmp-detail"><span class="dim">${label}</span>`
    + `<span class="cmp-val-a">${a}</span><span class="cmp-val-b">${b}</span></div>`;
  const span = (label, value, cls, help) => `<div class="cmp-detail cmp-detail-span">`
    + `<div class="dim cmp-detail-label">${label}<details class="cmp-info">`
    + `<summary aria-label="What is ${esc(label)}?">ⓘ</summary>`
    + `<p class="dim">${esc(help)}</p></details></div><div class="semi ${cls}">${value}</div></div>`;

  let dLabel; let pLabel; let dCls = ''; let pCls = '';
  const t = r.test;
  if (!t.enough) {
    dLabel = pLabel = `Not enough sessions (${t.nA} in A, ${t.nB} in B; need ${MIN_SESSIONS})`;
  } else {
    // |d| < 0.005 prints as 0.00, not "-0.00".
    const dShown = t.d === null ? null : (Math.abs(t.d) < 0.005 ? 0 : t.d);
    dLabel = dShown === null ? DASH : `${dShown.toFixed(2)} (${EFFECT_LABELS[t.eff]})`;
    dCls = t.eff ? `cmp-eff-${t.eff}` : '';
    const pStr = t.p < 0.001 ? '&lt; 0.001' : t.p.toFixed(3);
    pLabel = `${pStr} (${SIGNIFICANCE_LABELS[t.sig]})`;
    pCls = `cmp-sig-${t.sig.replace(' ', '-')}`;
  }

  const expand = h('div', 'cmp-expand');
  expand.innerHTML = `
    <div class="cmp-detail cmp-detail-head"><span></span>
      <span class="cmp-val-a">Cohort A</span><span class="cmp-val-b">Cohort B</span></div>
    ${row('Min', m.fmt(r.A.min), m.fmt(r.B.min))}
    ${row('Median', m.fmt(r.A.median), m.fmt(r.B.median))}
    ${row('Max', m.fmt(r.A.max), m.fmt(r.B.max))}
    ${row('Sessions', int(r.A.n), int(r.B.n))}
    ${span("Cohen's d", dLabel, dCls, COHEN_HELP)}
    ${span('p-value', pLabel, pCls, P_HELP)}`;
  expand.hidden = true;

  // SAR 1.0: expanding one card expands them all.
  head.addEventListener('click', () => {
    const open = !card.classList.contains('is-open');
    for (const c of cards.querySelectorAll('.cmp-card')) {
      c.classList.toggle('is-open', open);
      c.querySelector('.cmp-expand').hidden = !open;
      c.querySelector('.cmp-card-head').setAttribute('aria-expanded', String(open));
    }
  });

  card.append(head, expand);
  return card;
}

/* ---- inspector ---- */
function inspectorHtml(data, st, cmp) {
  const hallName = st.hall === 'all' ? 'Both halls'
    : (data.locations ?? []).find((l) => l.id === st.hall)?.name ?? st.hall;
  const nA = cmp.rowsA.length; const nB = cmp.rowsB.length;

  // The strongest significant difference: among metrics with a verdict and
  // p < 0.05, the one with the largest |d|.
  const sig = cmp.results.filter((r) => r.test.enough && r.test.p < 0.05 && r.test.d !== null)
    .sort((x, y) => Math.abs(y.test.d) - Math.abs(x.test.d));
  let read;
  if (!nA || !nB) {
    read = 'One cohort has no sessions, so there is nothing to compare yet.';
  } else if (cmp.results.every((r) => !r.test.enough)) {
    read = `Fewer than ${MIN_SESSIONS} sessions on one side. The test is withheld rather than `
      + 'shown with false confidence — a p-value from two nights is theatre.';
  } else if (!sig.length) {
    read = 'No metric differs significantly between the cohorts at p < 0.05. Whatever gap '
      + 'the means show is within what night-to-night variation would produce; treat the '
      + 'two groups as the same until more sessions say otherwise.';
  } else {
    const r = sig[0]; const m = r.metric; const t = r.test;
    const dir = dirOf(r.pct) === null ? 'differs' : (dirOf(r.pct) >= 0 ? 'higher' : 'lower');
    const chance = t.p < 0.001 ? 'less than once in a thousand'
      : `about ${Math.max(1, Math.round(t.p * 100))} in a hundred times`;
    read = `The clearest difference is ${m.label}: Cohort A averaged ${m.fmt(r.A.mean)} against `
      + `${m.fmt(r.B.mean)} in B${r.pct === null ? '' : ` (${fmtSigned(r.pct)}, ${dir})`}. `
      + `The effect is ${t.eff} (d = ${t.d.toFixed(2)}) and a gap this size would arise by `
      + `chance ${chance} (p ${t.p < 0.001 ? '< 0.001' : `= ${t.p.toFixed(3)}`}).`
      + (sig.length > 1 ? ` ${sig.length - 1} other metric${sig.length > 2 ? 's' : ''} also `
        + `differ${sig.length > 2 ? '' : 's'} significantly.` : '');
  }

  return `
    <p class="semi">Cohort comparison</p>
    <p class="muted">${esc(hallName)} · ${int(nA)} vs ${int(nB)} sessions</p>
    <p class="inspector-section-label">Cohorts</p>
    <dl class="inspector-filters">
      <dt>A</dt><dd>${esc(describeCohort(cmp.a, st.opts))} · ${int(nA)} sessions</dd>
      <dt>B</dt><dd>${esc(describeCohort(cmp.b, st.opts))} · ${int(nB)} sessions${
        st.mirrorDates || st.mirrorDays ? ` · mirrors A's ${
          [st.mirrorDates && 'dates', st.mirrorDays && 'days'].filter(Boolean).join(' and ')}` : ''}</dd>
      <dt>Location</dt><dd>${esc(hallName)} (shared)</dd>
    </dl>
    <p class="inspector-section-label">Reading it</p>
    <p class="muted">${esc(read)}</p>
    <p class="inspector-section-label">Method</p>
    <p class="muted">Welch's t-test — unequal variances assumed, because two groups of
      sessions are never balanced. Cohen's d with pooled SD. The percentage change is A
      relative to B. One median: the box plot and the table use the same definition.</p>`;
}
