/* ============================================================================
   SAR 2.0 — chart primitives and the monthly rollup

   Hand-rolled SVG, no charting library, consistent with the rest of the
   project. The difference from SAR 1.0 is that the layout maths lives HERE,
   once, instead of being copy-pasted into each of six chart functions.

   MONEY IS INTEGER CENTS ALL THE WAY TO THE AXIS FORMATTER. SAR 1.0 converts
   to dollars deep inside its data layer and its chart code works in floats;
   ours does not convert until `fmt.js` at the very edge. This is the single
   biggest internal difference between the two and the likeliest source of an
   off-by-100, so every function here that takes money says so.

   See SAR2-CHARTS-DESIGN.md.
   ========================================================================== */

import { metricsFor, sessionTotals } from './model.js';

/* ---------------------------------------------------------------------------
   Constants — DESIGN §5
--------------------------------------------------------------------------- */

export const MONTHS_BACK = 12;
export const JACKPOT_DAYS = 30;
/** Below this many points, no trend line and no R². DESIGN §4.6 */
export const MIN_FIT = 8;
export const LABEL_MIN_GAP = 11;

/* ---------------------------------------------------------------------------
   The hall filter — ONE copy

   SAR 1.0 repeats this four-way condition in all six charts:
     if (f && f !== 'combined' && f !== 'all' && f !== code) return;
   `combined` and `all` mean the same thing. Six copies is five chances to get
   it subtly different.
--------------------------------------------------------------------------- */

export const ALL_HALLS = new Set(['combined', 'all', '', null, undefined]);

export const hallMatches = (filter, locationId) =>
  ALL_HALLS.has(filter) || filter === locationId;

/* ---------------------------------------------------------------------------
   Months
--------------------------------------------------------------------------- */

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The month key is 'YYYY-MM' — SORTABLE, and parseable without guessing.
 *
 * SAR 1.0 keys months on the DISPLAY string, 'Jan-2026'. That is why it needs
 * a hand-written month-order array to sort, and why its YTD chart tests three
 * different string formats to decide which year a column belongs to. Keying on
 * the display string is the cause; both are symptoms.
 */
export const monthKey = (date) => String(date).slice(0, 7);

export const monthYear = (key) => Number(key.slice(0, 4));
export const monthIndex = (key) => Number(key.slice(5, 7)) - 1;

/**
 * Axis label. Year shown on the first column and on every January.
 *
 * SAR 1.0 prints the 3-letter month alone, so a rolling 12-month window that
 * crosses a year boundary shows two columns labelled `Jan` with nothing to
 * tell them apart. DESIGN §4.1.
 */
export function monthAxisLabel(key, i) {
  const m = MONTH_ABBR[monthIndex(key)];
  return (i === 0 || monthIndex(key) === 0) ? `${m} ${monthYear(key)}` : m;
}

export const monthFull = (key) => `${MONTH_ABBR[monthIndex(key)]}-${monthYear(key)}`;

/** The same month a year earlier. Arithmetic, not string surgery. */
export const priorYearKey = (key) => `${monthYear(key) - 1}-${key.slice(5, 7)}`;

/* ---------------------------------------------------------------------------
   The monthly rollup — DESIGN §2

   Charts 1, 2, 3 and 5 all need this. SAR 1.0 builds it four times.
--------------------------------------------------------------------------- */

/**
 * Money per month, from the metric store, through the product categories.
 *
 * NAMED `monthSeries`, NOT `monthlyRollup`. `monthly-pl.js` already exports a
 * `monthlyRollup` with a different signature and a different output — it
 * carries expenses and profit. Two same-named rollups in one project is how a
 * screen ends up importing the wrong one and silently drawing P&L rows on a
 * revenue axis. The names differ so the mistake cannot be made.
 *
 * Built on `sessionTotals`, the same path the session screen and Reporting
 * already use — verified against SAR 1.0 on U8, every figure matching.
 *
 * ALL MONEY IN CENTS. `margin` is a fraction, never a percentage.
 *
 * Ascending, oldest first: charts read left to right. Months with no sessions
 * are ABSENT rather than zero — a hall closed for a month took nothing, which
 * is a different claim from "no sessions happened". DESIGN §2.
 */
export function monthSeries(events, ctx, { hall = 'combined' } = {}) {
  const byMonth = new Map();

  for (const e of events) {
    if (!hallMatches(hall, e.location_id)) continue;
    const key = monthKey(e.event_date);
    const t = sessionTotals(metricsFor(e.id, ctx.metrics, ctx.idx), ctx.categories);

    const m = byMonth.get(key) ?? {
      key,
      label: monthFull(key),
      year: monthYear(key),
      month: monthIndex(key),
      eventCount: 0,
      gross: 0,
      payout: 0,
      attendance: 0,
      categories: new Map(),
      // Raw per-metric sums. The Monthly sheet shows one row per metric, so a
      // category rollup alone is not enough.
      metricTotals: Object.create(null),
    };

    m.eventCount += 1;
    m.gross += t.revenue;
    m.payout += t.payout;
    m.attendance += t.attendance ?? 0;

    const raw = metricsFor(e.id, ctx.metrics, ctx.idx);
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (v === null || v === undefined) continue;
      m.metricTotals[k] = (m.metricTotals[k] ?? 0) + Number(v);
    }

    for (const c of t.categories) {
      const cur = m.categories.get(c.key)
        ?? { key: c.key, name: c.name, revenue: 0, payout: 0 };
      cur.revenue += c.revenue;
      cur.payout += c.payout;              // already absolute, see categoryRollup
      m.categories.set(c.key, cur);
    }
    byMonth.set(key, m);
  }

  return [...byMonth.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((m) => {
      for (const c of m.categories.values()) c.net = c.revenue - c.payout;
      const net = m.gross - m.payout;
      return {
        ...m,
        net,
        // Guarded: a month with no sales has NO margin, not a margin of zero.
        margin: m.gross > 0 ? net / m.gross : null,
        rpa: m.attendance > 0 ? m.gross / m.attendance : null,
        categoryList: [...m.categories.values()],
        uncategorised: null,     // filled by the caller that knows the total
      };
    });
}

/** The last n months of a rollup. */
export const lastMonths = (rows, n = MONTHS_BACK) => rows.slice(-n);

/* ---------------------------------------------------------------------------
   Scales
--------------------------------------------------------------------------- */

/**
 * A linear scale. `nice` rounds the top out to a readable number.
 *
 * `zeroBased` is explicit rather than assumed: revenue axes start at zero
 * because a truncated revenue axis exaggerates every wiggle, but a margin axis
 * must NOT, because margins can be negative and forcing zero hides that.
 */
export function linearScale({ min = 0, max = 1, size = 100, pad = 0.1, zeroBased = true }) {
  let lo = zeroBased ? Math.min(0, min) : min;
  let hi = max;
  if (!(hi > lo)) hi = lo + 1;                    // a flat series still draws
  const span = hi - lo;
  hi += span * pad;
  if (!zeroBased) lo -= span * pad;
  const scale = (v) => size - ((v - lo) / (hi - lo)) * size;
  scale.lo = lo;
  scale.hi = hi;
  scale.invert = (px) => lo + ((size - px) / size) * (hi - lo);
  return scale;
}

/** Evenly spaced tick values, ends included. */
export function ticks(scale, count = 5) {
  const out = [];
  for (let i = 0; i <= count; i += 1) out.push(scale.lo + ((scale.hi - scale.lo) * i) / count);
  return out;
}

/**
 * Band positions for categorical x, as SVG needs them.
 *
 * `inner` leaves a gap between groups; `slots` splits a band for grouped bars.
 */
export function bandScale({ n, size, inner = 0.2 }) {
  const step = n > 0 ? size / n : size;
  const width = step * (1 - inner);
  const at = (i) => step * i + (step - width) / 2;
  return { step, width, at, centre: (i) => step * i + step / 2 };
}

/* ---------------------------------------------------------------------------
   Statistics — DESIGN §4.6
--------------------------------------------------------------------------- */

/**
 * Ordinary least squares, with R².
 *
 * Returns nulls rather than NaN when the fit is undefined. The denominator
 * `n·Σx² − (Σx)²` is zero when every x is identical — which is a live
 * possibility here, because x is "how many runners worked" and that barely
 * varies. SAR 1.0 divides anyway and renders NaN into the SVG.
 */
export function linearFit(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: null, intercept: null, r2: null, n };

  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: null, intercept: null, r2: null, n, degenerate: true };

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  let ssRes = 0; let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    ssTot += (ys[i] - mean) ** 2;
  }
  return { slope, intercept, n, r2: ssTot > 0 ? 1 - ssRes / ssTot : null };
}

/** Ranks, averaging ties — needed for a correct Spearman. */
function rank(xs) {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) r[idx[k].i] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * Spearman's rho — rank correlation, which assumes only monotonicity.
 *
 * Shown beside R² because x here is a small integer count with heavy ties, and
 * a Pearson fit on three distinct x values is far more fragile than its tidy
 * R² suggests. Computed as Pearson on the ranks, so ties are handled properly
 * rather than by the 6Σd²/n(n²−1) shortcut, which is wrong when ties exist.
 */
export function spearman(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const rx = rank(xs.slice(0, n));
  const ry = rank(ys.slice(0, n));
  const fit = linearFit(rx, ry);
  if (fit.slope === null || fit.r2 === null) return null;
  return Math.sign(fit.slope) * Math.sqrt(Math.max(0, fit.r2));
}

/* ---------------------------------------------------------------------------
   SVG helpers
--------------------------------------------------------------------------- */

export const NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  return el;
}

/** A `<title>` child — the accessible, dependency-free tooltip. */
export function withTitle(el, text) {
  const t = svgEl('title');
  t.textContent = text;
  el.append(t);
  return el;
}

/** Standard plot geometry. One definition, used by every panel. */
export function frame({ width = 760, height = 300, left = 62, right = 52, top = 16, bottom = 40 } = {}) {
  return {
    width, height, left, right, top, bottom,
    plotWidth: Math.max(1, width - left - right),
    plotHeight: Math.max(1, height - top - bottom),
    get plotBottom() { return this.top + this.plotHeight; },
  };
}

/**
 * Axes, gridlines and tick labels.
 *
 * `fmtY` receives the raw value — cents for money — and is responsible for
 * every conversion. Nothing here divides by 100.
 */
export function axes(g, f, { yScale, yTicks = 5, fmtY = String, xLabels = [], band = null,
                             rightScale = null, fmtRight = String, rotateX = false }) {
  for (const v of ticks(yScale, yTicks)) {
    const y = f.top + yScale(v);
    g.append(svgEl('line', {
      x1: f.left, x2: f.left + f.plotWidth, y1: y, y2: y, class: 'ch-grid',
    }));
    const t = svgEl('text', { x: f.left - 8, y: y + 4, class: 'ch-tick ch-tick-y' });
    t.textContent = fmtY(v);
    g.append(t);
  }

  // A zero line, drawn solid, whenever the axis crosses zero. Without it a
  // signed stack has no visible baseline.
  if (yScale.lo < 0 && yScale.hi > 0) {
    const y = f.top + yScale(0);
    g.append(svgEl('line', {
      x1: f.left, x2: f.left + f.plotWidth, y1: y, y2: y, class: 'ch-zero',
    }));
  }

  if (rightScale) {
    for (const v of ticks(rightScale, yTicks)) {
      const t = svgEl('text', {
        x: f.left + f.plotWidth + 8, y: f.top + rightScale(v) + 4, class: 'ch-tick ch-tick-r',
      });
      t.textContent = fmtRight(v);
      g.append(t);
    }
  }

  xLabels.forEach((label, i) => {
    const x = band ? f.left + band.centre(i) : f.left + (i * f.plotWidth) / Math.max(1, xLabels.length - 1);
    const y = f.plotBottom + (rotateX ? 14 : 18);
    const t = svgEl('text', { x, y, class: 'ch-tick ch-tick-x' });
    if (rotateX) t.setAttribute('transform', `rotate(-45 ${x} ${y})`);
    t.textContent = label;
    g.append(t);
  });
}

/** A polyline through points, skipping nulls so a gap stays a gap. */
export function linePath(points) {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p === null || p === undefined || !Number.isFinite(p.y)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/**
 * Push overlapping labels apart. DESIGN §4.5.
 *
 * SAR 1.0's version, kept because it solves a real problem on a dense stack.
 * What is NOT kept is recomputing the chart height from the result, which made
 * the panel jump as labels moved.
 */
export function spreadLabels(labels, gap = LABEL_MIN_GAP) {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
  }
  return sorted;
}

/** A legend row. `onToggle` makes each key clickable. */
export function legend(items, onToggle = null) {
  const wrap = document.createElement('div');
  wrap.className = 'ch-legend';
  for (const it of items) {
    const el = document.createElement(onToggle ? 'button' : 'span');
    el.className = `ch-key${it.hidden ? ' is-off' : ''}`;
    if (onToggle) {
      el.type = 'button';
      el.addEventListener('click', () => onToggle(it.key));
      el.title = it.hidden ? `Show ${it.label}` : `Hide ${it.label}`;
    }
    const sw = document.createElement('span');
    sw.className = `ch-swatch${it.dashed ? ' is-dashed' : ''}`;
    if (it.colour) sw.style.background = it.colour;
    el.append(sw, document.createTextNode(it.label));
    wrap.append(el);
  }
  return wrap;
}

/* ---------------------------------------------------------------------------
   Session detail (U8) — donut, floating bridge, expected-range band

   Added for the session screen. Layout maths is split from drawing so it can
   be tested without a DOM: `donutSegments`, `waterfallLayout` and
   `bandSegments` are pure; the `*Chart` builders only draw what they return.
   Colours come from CSS classes (tokens) or from per-tenant category colours
   passed in as data — never literals here.
--------------------------------------------------------------------------- */

const TAU = Math.PI * 2;

/**
 * Positive values only, as angles. A category whose value is zero or negative
 * has no slice: a donut cannot show a negative share, and SAR 1.0's donuts do
 * the same. `total` is the sum of the slices drawn, so the shares add to 1.
 */
export function donutSegments(items = []) {
  const kept = items.filter((it) => Number.isFinite(it.value) && it.value > 0);
  const total = kept.reduce((s, it) => s + it.value, 0);
  if (!(total > 0)) return { total: 0, segments: [] };
  let a = 0;
  const segments = kept.map((it) => {
    const share = it.value / total;
    const seg = { ...it, share, a0: a, a1: a + share * TAU };
    a += share * TAU;
    return seg;
  });
  return { total, segments };
}

/** An annular sector, angles clockwise from 12 o'clock. A full turn is drawn as two halves. */
export function donutArcPath(cx, cy, r, inner, a0, a1) {
  const pt = (rad, a) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  const f = (n) => n.toFixed(2);
  if (a1 - a0 >= TAU - 1e-6) {
    const mid = a0 + Math.PI;
    return donutArcPath(cx, cy, r, inner, a0, mid) + donutArcPath(cx, cy, r, inner, mid, a0 + TAU);
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(r, a0); const [x1, y1] = pt(r, a1);
  const [x2, y2] = pt(inner, a1); const [x3, y3] = pt(inner, a0);
  return `M${f(x0)},${f(y0)}A${r},${r} 0 ${large} 1 ${f(x1)},${f(y1)}`
    + `L${f(x2)},${f(y2)}A${inner},${inner} 0 ${large} 0 ${f(x3)},${f(y3)}Z`;
}

/**
 * A donut as SVG. `items`: [{ label, value (cents), colour?, title? }].
 * Returns null when there is nothing to draw — the caller writes an explicit
 * empty state (SPEC §19.2: SAR 1.0 returned early and left the previous
 * session's donut on screen).
 */
export function donutChart(items, { size = 160, thickness = 26, centre = '', centreSub = '' } = {}) {
  const { segments } = donutSegments(items);
  if (!segments.length) return null;
  const r = size / 2 - 2;
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, class: 'ch donut', role: 'img' });
  segments.forEach((s, i) => {
    const p = svgEl('path', {
      d: donutArcPath(size / 2, size / 2, r, r - thickness, s.a0, s.a1),
      class: `donut-seg donut-seg-${i % 5}`,
      style: s.colour ? `fill:${s.colour}` : null,
    });
    withTitle(p, s.title ?? `${s.label}: ${(s.share * 100).toFixed(1)}%`);
    svg.append(p);
  });
  const t = svgEl('text', { x: size / 2, y: size / 2 + (centreSub ? 0 : 5), class: 'donut-centre' });
  t.textContent = centre;
  svg.append(t);
  if (centreSub) {
    const t2 = svgEl('text', { x: size / 2, y: size / 2 + 16, class: 'donut-centre-sub' });
    t2.textContent = centreSub;
    svg.append(t2);
  }
  return svg;
}

/**
 * Floating bridge geometry. items: [{ label, value, type: 'start'|'delta'|'total' }].
 *
 * Each delta floats from the running total; anchors stand on the floor. The
 * domain is the JOURNEY only — the v9 mockup's lesson: letting the anchors'
 * [0, value] range set the floor turns every delta into an invisible sliver.
 * `end` is where the deltas land, so a caller can check the bridge closes.
 */
export function waterfallLayout(items = []) {
  let acc = 0;
  const bars = items.map((it) => {
    if (it.type !== 'delta') { acc = it.value; return { ...it, from: it.value, to: it.value }; }
    const from = acc; acc += it.value;
    return { ...it, from, to: acc };
  });
  const journey = bars.flatMap((b) => [b.from, b.to]);
  let lo = Math.min(...journey);
  let hi = Math.max(...journey);
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  lo -= span * 0.55;
  hi += span * 0.3;
  const lastDelta = [...bars].reverse().find((b) => b.type === 'delta');
  return { bars, lo, hi, end: lastDelta ? lastDelta.to : (bars[0]?.value ?? 0) };
}

/** The bridge as SVG. Every bar carries its value as text and a <title>. */
export function waterfallChart(items, { width = 660, height = 250, fmt = String, fmtDelta = null } = {}) {
  const { bars, lo, hi } = waterfallLayout(items);
  const m = { t: 24, r: 10, b: 44, l: 10 };
  const ih = height - m.t - m.b;
  const Y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const band = (width - m.l - m.r) / Math.max(1, bars.length);
  const bw = Math.min(64, band * 0.56);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'ch wf', role: 'img' });

  if (bars.length) {
    const y0 = Y(bars[0].value);
    svg.append(svgEl('line', { x1: m.l, x2: width - m.r, y1: y0, y2: y0, class: 'wf-baseline' }));
  }
  bars.forEach((b, i) => {
    const x = m.l + band * i + (band - bw) / 2;
    const anchor = b.type !== 'delta';
    const top = anchor ? Y(b.value) : Y(Math.max(b.from, b.to));
    const bottom = anchor ? m.t + ih : Y(Math.min(b.from, b.to));
    const cls = anchor ? 'wf-total' : (b.residual ? 'wf-residual' : (b.value >= 0 ? 'wf-up' : 'wf-down'));
    const valueText = anchor ? fmt(b.value) : (fmtDelta ?? fmt)(b.value);
    const rect = svgEl('rect', {
      x: x.toFixed(2), y: top.toFixed(2), width: bw.toFixed(2),
      height: Math.max(2, bottom - top).toFixed(2), rx: 2.5, class: `wf-bar ${cls}`,
    });
    withTitle(rect, `${b.label}: ${valueText}`);
    svg.append(rect);
    if (i < bars.length - 1) {
      const yc = Y(anchor ? b.value : b.to);
      svg.append(svgEl('line', {
        x1: (x + bw).toFixed(2), x2: (m.l + band * (i + 1) + (band - bw) / 2).toFixed(2),
        y1: yc.toFixed(2), y2: yc.toFixed(2), class: 'wf-connector',
      }));
    }
    const below = !anchor && b.value < 0;
    const lbl = svgEl('text', {
      x: (x + bw / 2).toFixed(1), y: (below ? bottom + 13 : top - 6).toFixed(1),
      class: `wf-value${anchor ? ' wf-value-anchor' : ''}`,
    });
    lbl.textContent = valueText;
    svg.append(lbl);
    const words = String(b.label).split(' ');
    const first = words.length > 1 ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : words[0];
    const rest = words.length > 1 ? words.slice(Math.ceil(words.length / 2)).join(' ') : '';
    const t1 = svgEl('text', { x: (x + bw / 2).toFixed(1), y: height - (rest ? 24 : 16), class: 'ch-tick ch-tick-x' });
    t1.textContent = first;
    svg.append(t1);
    if (rest) {
      const t2 = svgEl('text', { x: (x + bw / 2).toFixed(1), y: height - 11, class: 'ch-tick ch-tick-x' });
      t2.textContent = rest;
      svg.append(t2);
    }
  });
  return svg;
}

/**
 * Split a band into runs of consecutive points that HAVE a band. A point with
 * too little history has no band, and the area must break there rather than
 * interpolate across the gap.
 */
export function bandSegments(rows) {
  const runs = [];
  let cur = [];
  rows.forEach((r, i) => {
    if (Number.isFinite(r.lo) && Number.isFinite(r.hi)) cur.push({ i, lo: r.lo, hi: r.hi });
    else if (cur.length) { runs.push(cur); cur = []; }
  });
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Actual against an expected range. rows: [{ value, lo, hi, expected, label,
 * title, highlight }]. The highlighted point is drawn larger and ringed; a
 * point outside its band is marked, not merely coloured.
 */
export function bandedTrendChart(rows, { width = 660, height = 240, fmtY = String, labelEvery = 6 } = {}) {
  const f = frame({ width, height, left: 58, right: 14, top: 14, bottom: 28 });
  const vals = rows.flatMap((r) => [r.value, r.lo, r.hi]).filter(Number.isFinite);
  const yScale = linearScale({
    min: Math.min(...vals), max: Math.max(...vals), size: f.plotHeight, pad: 0.08, zeroBased: false,
  });
  const n = rows.length;
  const X = (i) => f.left + (n > 1 ? (i * f.plotWidth) / (n - 1) : f.plotWidth / 2);
  const Y = (v) => f.top + yScale(v);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'ch band-chart', role: 'img' });
  const g = svgEl('g');
  axes(g, f, { yScale, yTicks: 4, fmtY });
  svg.append(g);

  for (const run of bandSegments(rows)) {
    if (run.length === 1) {
      const p = run[0];
      svg.append(svgEl('line', { x1: X(p.i), x2: X(p.i), y1: Y(p.hi), y2: Y(p.lo), class: 'band-whisker' }));
      continue;
    }
    const up = run.map((p) => `${X(p.i).toFixed(1)},${Y(p.hi).toFixed(1)}`);
    const dn = [...run].reverse().map((p) => `${X(p.i).toFixed(1)},${Y(p.lo).toFixed(1)}`);
    svg.append(svgEl('path', { d: `M${up.join('L')}L${dn.join('L')}Z`, class: 'band-area' }));
  }
  svg.append(svgEl('path', {
    d: linePath(rows.map((r, i) => (Number.isFinite(r.expected) ? { x: X(i), y: Y(r.expected) } : null))),
    class: 'band-expected',
  }));
  svg.append(svgEl('path', {
    d: linePath(rows.map((r, i) => (Number.isFinite(r.value) ? { x: X(i), y: Y(r.value) } : null))),
    class: 'band-actual',
  }));
  rows.forEach((r, i) => {
    if (!Number.isFinite(r.value)) return;
    const out = Number.isFinite(r.lo) && Number.isFinite(r.hi) && (r.value < r.lo || r.value > r.hi);
    const c = svgEl('circle', {
      cx: X(i).toFixed(1), cy: Y(r.value).toFixed(1), r: r.highlight ? 5 : (out ? 3.6 : 2.4),
      class: `band-pt${out ? ' is-out' : ''}${r.highlight ? ' is-this' : ''}`,
    });
    if (r.title) withTitle(c, r.title);
    svg.append(c);
    if (r.label && (i % labelEvery === 0 || r.highlight || i === n - 1)) {
      const t = svgEl('text', { x: X(i).toFixed(1), y: f.plotBottom + 18, class: `ch-tick ch-tick-x${r.highlight ? ' is-this' : ''}` });
      t.textContent = r.label;
      svg.append(t);
    }
  });
  return svg;
}
