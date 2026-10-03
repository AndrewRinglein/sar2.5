/* ============================================================================
   SAR 2.0 — Dashboard, the six chart panels

   SAR 1.0 has SIX charts behind one <select>, not the five the gap audit
   recorded: Jackpot Impact (30 Days) was missed. All six are here.

   Built against SAR2-CHARTS-DESIGN.md, which was written from SAR 1.0's own
   source rather than from its screenshots.

   THE CORRECTION THAT SHAPED THIS FILE. I reported that four of these charts
   were reading a broken materialized view and were 25x too low. They are not.
   `analytics_monthly_summary` does have broken money columns — August 2026
   comes out of it at -2982% margin — but SAR 1.0 never reads them: it passes
   event-derived aggregates into `monthlyToColumn` and recomputes every figure
   from the metric store through the product categories. So these panels must
   MATCH SAR 1.0, not correct it. Each panel below names its real source.
   ========================================================================== */

import {
  monthSeries, lastMonths, priorYearKey, monthAxisLabel, monthFull, monthKey,
  hallMatches, linearScale, bandScale, axes, frame, svgEl, withTitle, linePath,
  legend, linearFit, spearman, spreadLabels,
  MONTHS_BACK, JACKPOT_DAYS, MIN_FIT,
} from '../lib/charts.js';
import {
  metricsFor, sessionTotals, getMetric, jackpotParticipation,
} from '../lib/model.js';
import { usd, usdShort, pct, int, pctDelta, esc, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export const CHARTS = [
  { id: '12months', label: '12 Months Revenue' },
  { id: 'yoy', label: 'Year over Year' },
  { id: 'ytd', label: 'YTD Gross and Net' },
  { id: 'jackpot', label: 'Jackpot Impact (30 days)' },
  { id: 'product', label: 'Net Revenue by Product' },
  { id: 'runners', label: 'Flash Runner Correlation' },
];

/** Money axis: cents in, short dollars out. Nothing else divides by 100. */
const money = (c) => usdShort(c);

const SERIES = {
  gross: 'var(--series-1)', net: 'var(--series-2)', prior: 'var(--series-3)',
  margin: 'var(--series-4)', att: 'var(--series-5)',
};

/* ---------------------------------------------------------------------------
   1 — Twelve Months Revenue. DESIGN §4.1
--------------------------------------------------------------------------- */

export function twelveMonths(rows, { labels = true } = {}) {
  const win = lastMonths(rows, MONTHS_BACK);
  const f = frame();
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch' });
  if (!win.length) return { svg, empty: true, win };

  const y = linearScale({
    min: 0, max: Math.max(...win.map((m) => m.gross)), size: f.plotHeight,
  });
  const band = bandScale({ n: win.length, size: f.plotWidth });

  axes(svg, f, {
    yScale: y, fmtY: money, band,
    xLabels: win.map((m, i) => monthAxisLabel(m.key, i)),
  });

  const at = (m, i, key) => ({ x: f.left + band.centre(i), y: f.top + y(m[key]) });
  for (const [key, cls] of [['gross', 'gross'], ['net', 'net']]) {
    svg.append(svgEl('path', {
      d: linePath(win.map((m, i) => at(m, i, key))),
      class: `ch-line ch-${cls}`, fill: 'none',
    }));
    win.forEach((m, i) => {
      const p = at(m, i, key);
      svg.append(withTitle(
        svgEl('circle', { cx: p.x, cy: p.y, r: 3, class: `ch-dot ch-${cls}` }),
        `${monthFull(m.key)} ${key}: ${usd(m[key])}`,
      ));
      if (labels) {
        const t = svgEl('text', {
          x: p.x, y: p.y + (key === 'gross' ? -8 : 16), class: 'ch-label data-label',
        });
        t.textContent = money(m[key]);
        svg.append(t);
      }
    });
  }
  return { svg, win, empty: false };
}

/* ---------------------------------------------------------------------------
   2 — Year over Year. DESIGN §4.2
--------------------------------------------------------------------------- */

/** Months that have a same-month counterpart a year earlier. */
export function yoyPairs(rows) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return lastMonths(rows, MONTHS_BACK)
    .map((cur) => ({ cur, prior: byKey.get(priorYearKey(cur.key)) }))
    .filter((p) => p.prior);
}

export function yearOverYear(rows, { labels = true } = {}) {
  const pairs = yoyPairs(rows);
  const f = frame({ height: 320 });
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch' });
  if (!pairs.length) return { svg, pairs, empty: true };

  const yRev = linearScale({
    min: 0, size: f.plotHeight,
    max: Math.max(...pairs.flatMap((p) => [p.cur.gross, p.prior.gross])),
  });
  const margins = pairs.flatMap((p) => [p.cur.margin, p.prior.margin])
    .filter((m) => m !== null);
  // NOT zero-based: a negative margin month must be drawn, not clipped.
  const yMar = linearScale({
    min: margins.length ? Math.min(...margins) : 0,
    max: margins.length ? Math.max(...margins) : 1,
    size: f.plotHeight, zeroBased: false,
  });

  const band = bandScale({ n: pairs.length, size: f.plotWidth });
  axes(svg, f, {
    yScale: yRev, fmtY: money, band, rightScale: yMar, fmtRight: (v) => pct(v, { decimals: 0 }),
    xLabels: pairs.map((p, i) => monthAxisLabel(p.cur.key, i)),
  });

  const BARS = [
    ['prior', 'gross', 'ch-prior-gross'], ['cur', 'gross', 'ch-gross'],
    ['prior', 'net', 'ch-prior-net'], ['cur', 'net', 'ch-net'],
  ];
  const w = band.width / BARS.length;

  pairs.forEach((p, i) => {
    BARS.forEach(([which, key, cls], b) => {
      const v = p[which][key];
      const top = f.top + yRev(v);
      svg.append(withTitle(svgEl('rect', {
        x: f.left + band.at(i) + b * w, y: top, width: Math.max(1, w - 1),
        height: Math.max(0, f.plotBottom - top), class: `ch-bar ${cls}`,
      }), `${monthFull(p[which].key)} ${key}: ${usd(v)}`));
    });
  });

  // Margin lines. A month with no sales has a null margin and BREAKS the line
  // rather than plotting 0%, which would read as break-even. DESIGN §4.2.
  for (const [which, cls, dash] of [['cur', 'ch-margin', null], ['prior', 'ch-margin-prior', '4 3']]) {
    const pts = pairs.map((p, i) => (p[which].margin === null ? null
      : { x: f.left + band.centre(i), y: f.top + yMar(p[which].margin) }));
    svg.append(svgEl('path', {
      d: linePath(pts), class: `ch-line ${cls}`, fill: 'none', 'stroke-dasharray': dash,
    }));
    if (labels) {
      pts.forEach((pt, i) => {
        if (!pt) return;
        const t = svgEl('text', { x: pt.x, y: pt.y - 6, class: 'ch-label data-label' });
        t.textContent = pct(pairs[i][which].margin, { decimals: 0 });
        svg.append(t);
      });
    }
  }
  return { svg, pairs, empty: false };
}

/** The three stat cards above the YoY chart. Margin delta in POINTS. */
export function yoyTotals(pairs) {
  const sum = (which, key) => pairs.reduce((s, p) => s + p[which][key], 0);
  const cg = sum('cur', 'gross'); const pg = sum('prior', 'gross');
  const cn = sum('cur', 'net'); const pn = sum('prior', 'net');
  const change = (a, b) => (b > 0 ? (a - b) / b : null);
  return {
    gross: { cur: cg, prior: pg, change: change(cg, pg) },
    net: { cur: cn, prior: pn, change: change(cn, pn) },
    margin: {
      cur: cg > 0 ? cn / cg : null,
      prior: pg > 0 ? pn / pg : null,
      points: cg > 0 && pg > 0 ? cn / cg - pn / pg : null,
    },
  };
}

/* ---------------------------------------------------------------------------
   3 — YTD Gross and Net. DESIGN §4.3
--------------------------------------------------------------------------- */

/** Display year: this year if it has data, else last year, and say so. */
export function ytdYear(rows, now = new Date()) {
  const thisYear = now.getUTCFullYear();
  const has = (y) => rows.some((r) => r.year === y);
  if (has(thisYear)) return { year: thisYear, fellBack: false };
  return { year: thisYear - 1, fellBack: has(thisYear - 1) };
}

export function ytd(rows, { now = new Date(), labels = true } = {}) {
  const { year, fellBack } = ytdYear(rows, now);
  // The parsed integer year — NOT SAR 1.0's three-way string includes() test,
  // which can match the wrong year outright. DESIGN §4.3.
  const win = rows.filter((r) => r.year === year);
  const f = frame();
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch' });
  if (!win.length) return { svg, empty: true, year, fellBack, cumGross: 0, cumNet: 0 };

  let g = 0; let n = 0;
  const cum = win.map((m) => { g += m.gross; n += m.net; return { key: m.key, g, n }; });

  const y = linearScale({ min: 0, max: g, size: f.plotHeight });
  const band = bandScale({ n: win.length, size: f.plotWidth });
  axes(svg, f, {
    yScale: y, fmtY: money, band, xLabels: win.map((m, i) => monthAxisLabel(m.key, i)),
  });

  const xs = cum.map((_, i) => f.left + band.centre(i));
  const area = (key) => {
    const top = cum.map((c, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${(f.top + y(c[key])).toFixed(1)}`).join('');
    return `${top}L${xs[xs.length - 1].toFixed(1)},${f.plotBottom}L${xs[0].toFixed(1)},${f.plotBottom}Z`;
  };
  // Gross beneath, net over. The visible band between them is CUMULATIVE
  // PAYOUTS — labelled, which SAR 1.0 does not do.
  svg.append(svgEl('path', { d: area('g'), class: 'ch-area ch-gross' }));
  svg.append(svgEl('path', { d: area('n'), class: 'ch-area ch-net' }));

  for (const [key, cls] of [['g', 'gross'], ['n', 'net']]) {
    const pts = cum.map((c, i) => ({ x: xs[i], y: f.top + y(c[key]) }));
    svg.append(svgEl('path', { d: linePath(pts), class: `ch-line ch-${cls}`, fill: 'none' }));
    pts.forEach((p, i) => {
      svg.append(withTitle(svgEl('circle', { cx: p.x, cy: p.y, r: 3, class: `ch-dot ch-${cls}` }),
        `${monthFull(cum[i].key)} cumulative ${key === 'g' ? 'gross' : 'net'}: ${usd(cum[i][key])}`));
      if (labels && (i === pts.length - 1 || i % 2 === 0)) {
        const t = svgEl('text', { x: p.x, y: p.y - 7, class: 'ch-label data-label' });
        t.textContent = money(cum[i][key]);
        svg.append(t);
      }
    });
  }
  return { svg, empty: false, year, fellBack, cumGross: g, cumNet: n, payouts: g - n };
}

/* ---------------------------------------------------------------------------
   4 — Jackpot Impact. DESIGN §4.4 — the panel the gap audit missed
--------------------------------------------------------------------------- */

/**
 * One row per EVENT in the last 30 days — not per day. Santa Clara runs two
 * sessions on a weekend day and both belong on the axis.
 */
export function jackpotWindow(data, { hall = 'combined', days = JACKPOT_DAYS, now = new Date() } = {}) {
  const jackpots = data.config?.settings?.jackpots ?? [];
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);

  const rows = data.events
    .filter((e) => e.event_date >= cutoff && hallMatches(hall, e.location_id))
    .sort((a, b) => (a.event_date < b.event_date ? -1 : 1))
    .map((e) => {
      const m = metricsFor(e.id, data.metrics, data.idx);
      const t = sessionTotals(m, data.categories);
      return {
        event: e,
        net: t.net,
        rpa: t.rpa,
        attendance: t.attendance,
        jackpots: jackpots.map((jp) => ({
          name: jp.name,
          balance: getMetric(m, jp.balanceKey),
          // Reused from model.js (SPEC §17), not rewritten: players =
          // (balance - collected) / participation cost, null when no cost is
          // configured. SAR 1.0 returns 0 and draws a flat line along zero.
          players: jackpotParticipation(m, jp, t.attendance),
        })),
      };
    });
  return { rows, jackpots };
}

export function jackpotImpact(win, { hidden = {}, labels = true } = {}) {
  const f = frame({ height: 320, bottom: 54 });
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch' });
  const { rows, jackpots } = win;
  if (!rows.length || !jackpots.length) return { svg, empty: true };

  const dollars = [
    ...rows.flatMap((r) => r.jackpots.map((j) => j.balance ?? 0)),
    ...rows.map((r) => r.net ?? 0),
  ];
  const yL = linearScale({ min: 0, max: Math.max(...dollars, 1), size: f.plotHeight });
  // Attendance and players share the right axis AND therefore share ONE scale.
  // SAR 1.0 puts attendance and RPA on the same physical axis at two different
  // scales, which makes the point where the lines cross meaningless.
  const rightVals = [
    ...rows.map((r) => r.attendance ?? 0),
    ...rows.flatMap((r) => r.jackpots.map((j) => j.players ?? 0)),
  ];
  const yR = linearScale({ min: 0, max: Math.max(...rightVals, 1), size: f.plotHeight });

  const band = bandScale({ n: rows.length, size: f.plotWidth });
  axes(svg, f, {
    yScale: yL, fmtY: money, band, rightScale: yR, fmtRight: (v) => int(Math.round(v)),
    rotateX: true,
    xLabels: rows.map((r) => `${Number(r.event.event_date.slice(5, 7))}/${Number(r.event.event_date.slice(8, 10))}`),
  });

  const w = band.width / Math.max(1, jackpots.length);
  jackpots.forEach((jp, ji) => {
    if (hidden[`bal-${ji}`]) return;
    rows.forEach((r, i) => {
      const v = r.jackpots[ji].balance;
      if (v === null || v === undefined) return;
      const top = f.top + yL(v);
      svg.append(withTitle(svgEl('rect', {
        x: f.left + band.at(i) + ji * w, y: top, width: Math.max(1, w - 1),
        height: Math.max(0, f.plotBottom - top), class: `ch-bar ch-jp-${ji % 5}`,
      }), `${jp.name}: ${usd(v)} (${r.event.event_date})`));
    });
  });

  if (!hidden.net) {
    svg.append(svgEl('path', {
      d: linePath(rows.map((r, i) => ({ x: f.left + band.centre(i), y: f.top + yL(r.net) }))),
      class: 'ch-line ch-net', fill: 'none',
    }));
  }
  if (!hidden.att) {
    svg.append(svgEl('path', {
      d: linePath(rows.map((r, i) => (r.attendance === null ? null
        : { x: f.left + band.centre(i), y: f.top + yR(r.attendance) }))),
      class: 'ch-line ch-att', fill: 'none', 'stroke-dasharray': '2 3',
    }));
  }
  jackpots.forEach((jp, ji) => {
    if (hidden[`part-${ji}`]) return;
    // A null player count leaves a GAP. No cost configured means unknown, not
    // zero participants.
    svg.append(svgEl('path', {
      d: linePath(rows.map((r, i) => (r.jackpots[ji].players === null ? null
        : { x: f.left + band.centre(i), y: f.top + yR(r.jackpots[ji].players) }))),
      class: `ch-line ch-part-${ji % 5}`, fill: 'none', 'stroke-dasharray': '5 3',
    }));
  });

  const anyPlayers = rows.some((r) => r.jackpots.some((j) => j.players !== null));
  return { svg, empty: false, anyPlayers };
}

/* ---------------------------------------------------------------------------
   5 — Net Revenue by Product. DESIGN §4.5
--------------------------------------------------------------------------- */

export function productNet(rows, categories, { hidden = {}, labels = true } = {}) {
  const win = lastMonths(rows, MONTHS_BACK);
  const f = frame({ height: 330, bottom: 46 });
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch' });
  if (!win.length || !categories.length) return { svg, empty: true, win };

  const visible = categories.filter((c) => !hidden[`cat-${c.key}`]);
  const stacks = win.map((m) => {
    let up = 0; let down = 0;
    for (const c of visible) {
      const v = m.categories.get(c.key)?.net ?? 0;
      if (v > 0) up += v; else down += v;
    }
    return { up, down, net: m.net };
  });

  const y = linearScale({
    min: Math.min(0, ...stacks.map((s) => s.down), ...win.map((m) => m.net)),
    max: Math.max(0, ...stacks.map((s) => s.up), ...win.map((m) => m.net)),
    size: f.plotHeight, zeroBased: false,
  });
  const band = bandScale({ n: win.length, size: f.plotWidth });
  axes(svg, f, { yScale: y, fmtY: money, band, xLabels: win.map((m, i) => monthAxisLabel(m.key, i)) });

  const zero = f.top + y(0);
  const pending = [];

  win.forEach((m, i) => {
    let up = 0; let down = 0;
    for (const c of visible) {
      const v = m.categories.get(c.key)?.net ?? 0;
      if (v === 0) continue;                       // no bar at all, not a zero bar
      const size = Math.abs(y(0) - y(Math.abs(v)));
      const top = v > 0 ? zero - (up + size) : zero + Math.abs(down);
      svg.append(withTitle(svgEl('rect', {
        x: f.left + band.at(i), y: top, width: band.width, height: Math.max(1, size),
        class: 'ch-bar', style: c.color_bg_from ? `fill:${c.color_bg_from}` : null,
      }), `${c.display_name}: ${usd(v)} (${monthFull(m.key)})`));
      if (v > 0) up += size; else down -= size;
      if (labels) pending.push({ col: i, y: top + size / 2, text: usdShort(v) });
    }
  });

  // Net line, over the stack. It will NOT equal the stack when some metric
  // belongs to no configured category — that gap is real and is named in the
  // tooltip rather than quietly hidden.
  if (!hidden.net) {
    const pts = win.map((m, i) => ({ x: f.left + band.centre(i), y: f.top + y(m.net) }));
    svg.append(svgEl('path', { d: linePath(pts), class: 'ch-line ch-net', fill: 'none' }));
    win.forEach((m, i) => {
      const stack = stacks[i].up + stacks[i].down;
      svg.append(withTitle(svgEl('circle', { cx: pts[i].x, cy: pts[i].y, r: 3, class: 'ch-dot ch-net' }),
        `Net (all products): ${usd(m.net)} (${monthFull(m.key)})`
        + `\nCategories shown: ${usd(stack)}`
        + `\nUncategorised: ${usd(m.net - stack)}`));
    });
  }

  // Collision resolution per column, clipped to the plot — SAR 1.0 grows the
  // chart instead, which makes the panel jump as labels move.
  for (let c = 0; c < win.length; c += 1) {
    for (const l of spreadLabels(pending.filter((p) => p.col === c))) {
      if (l.y < f.top || l.y > f.plotBottom) continue;
      const t = svgEl('text', { x: f.left + band.centre(c), y: l.y, class: 'ch-label data-label' });
      t.textContent = l.text;
      svg.append(t);
    }
  }
  return { svg, empty: false, win, stacks };
}

/* ---------------------------------------------------------------------------
   6 — Flash Runner Correlation. DESIGN §4.6
--------------------------------------------------------------------------- */

export const RUNNER_METRICS = [
  { key: 'net', label: 'Net revenue' },
  { key: 'flash', label: 'Net flash revenue' },
  { key: 'rpa', label: 'RPA' },
];

export function runnerPoints(data, { hall = 'combined', metric = 'net' } = {}) {
  const byEvent = new Map();
  for (const re of data.runnerEvents ?? []) {
    const s = byEvent.get(re.event_id) ?? new Set();
    s.add(re.runner_id);
    byEvent.set(re.event_id, s);
  }
  const pts = [];
  for (const e of data.events) {
    const set = byEvent.get(e.id);
    if (!set || !hallMatches(hall, e.location_id)) continue;
    const m = metricsFor(e.id, data.metrics, data.idx);
    const t = sessionTotals(m, data.categories);
    const flash = t.categories.find((c) => /flash/i.test(c.key));
    const y = metric === 'flash' ? (flash ? flash.net ?? flash.revenue - flash.payout : null)
      : metric === 'rpa' ? t.rpa : t.net;
    if (y === null || y === undefined || !Number.isFinite(y)) continue;
    pts.push({ x: set.size, y, event: e, attendance: t.attendance });
  }
  return pts;
}

export function runnerCorrelation(pts, locations, { metric = 'net' } = {}) {
  const f = frame({ height: 320, left: 70 });
  const svg = svgEl('svg', { viewBox: `0 0 ${f.width} ${f.height}`, class: 'ch' });
  if (!pts.length) return { svg, empty: true, fit: null, rho: null, n: 0 };

  const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
  const xLo = 0; const xHi = Math.max(...xs) + 1;
  const yS = linearScale({ min: Math.min(0, ...ys), max: Math.max(...ys), size: f.plotHeight,
                           zeroBased: Math.min(...ys) >= 0 });
  const xAt = (v) => f.left + ((v - xLo) / (xHi - xLo)) * f.plotWidth;

  const xLabels = [];
  for (let v = xLo; v <= xHi; v += 1) xLabels.push(String(v));
  axes(svg, f, { yScale: yS, fmtY: metric === 'rpa' ? usd : money, xLabels });

  const colourOf = new Map(locations.map((l, i) => [l.id, `var(--series-${(i % 5) + 1})`]));
  for (const p of pts) {
    svg.append(withTitle(svgEl('circle', {
      cx: xAt(p.x), cy: f.top + yS(p.y), r: 3.5, class: 'ch-pt',
      style: `fill:${colourOf.get(p.event.location_id) ?? 'var(--series-1)'}`,
    }), `${p.event.event_date} · ${p.x} runners · ${usd(p.y)} · att ${int(p.attendance)}`));
  }

  const fit = linearFit(xs, ys);
  const rho = spearman(xs, ys);
  const distinctX = new Set(xs).size;

  // No trend line on a thin or degenerate sample. Two points always give
  // R² = 1.000 and a line through both, which means nothing. DESIGN §4.6.
  const drawable = pts.length >= MIN_FIT && fit.slope !== null && distinctX >= 2;
  if (drawable) {
    const y1 = fit.slope * xLo + fit.intercept;
    const y2 = fit.slope * xHi + fit.intercept;
    svg.append(svgEl('line', {
      x1: xAt(xLo), y1: f.top + yS(y1), x2: xAt(xHi), y2: f.top + yS(y2),
      class: 'ch-fit',
    }));
  }
  return { svg, empty: false, fit, rho, n: pts.length, drawable, distinctX };
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderDashboard({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const chart = CHARTS.find((c) => c.id === params.chart)?.id ?? '12months';
  const hall = params.hall ?? 'combined';
  const labels = params.labels !== 'off';
  const metric = params.metric ?? 'net';
  // Series hidden from the legend (SAR 1.0 §5: Jackpot Impact and Net by
  // Product have clickable legends). Kept in the hash so it survives reload.
  const hiddenKeys = new Set(String(params.hide ?? '').split(',').filter(Boolean));
  const hidden = Object.fromEntries([...hiddenKeys].map((k) => [k, true]));
  const toggle = (key) => {
    const next = new Set(hiddenKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    play('select');
    onNavigate('dashboard', { ...params, hide: [...next].join(',') || undefined });
  };
  const withState = (items) => items.map((it) => ({ ...it, hidden: hiddenKeys.has(it.key) }));

  /* ---- controls ---- */
  const bar = h('div', 'filter-bar');
  for (const l of [{ id: 'combined', name: 'Both halls' }, ...data.locations]) {
    const b = h('button', `chip${hall === l.id ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = l.name;
    b.addEventListener('click', () => { play('select'); onNavigate('dashboard', { ...params, hall: l.id }); });
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  const sel = h('select', 'ch-select');
  for (const c of CHARTS) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.label; o.selected = c.id === chart;
    sel.append(o);
  }
  sel.addEventListener('change', () => { play('select'); onNavigate('dashboard', { ...params, chart: sel.value, hide: undefined }); });
  bar.append(sel);

  const lab = h('button', `chip${labels ? ' is-active' : ''}`);
  lab.type = 'button'; lab.textContent = 'Data labels';
  lab.addEventListener('click', () => onNavigate('dashboard', { ...params, labels: labels ? 'off' : 'on' }));
  bar.append(h('span', 'filter-sep'), lab);
  root.append(bar);

  const panel = h('section', 'panel');
  const title = CHARTS.find((c) => c.id === chart).label;
  panel.append(h('h3', 'panel-title', title));

  const rows = monthSeries(data.events, data, { hall });
  const empty = (msg) => panel.append(h('div', 'placeholder', `<p class="semi">${msg}</p>`));
  let note = '';

  if (chart === '12months') {
    const r = twelveMonths(rows, { labels });
    if (r.empty) empty('No monthly data yet'); else panel.append(r.svg);
    panel.append(legend([
      { key: 'g', label: 'Gross', colour: SERIES.gross },
      { key: 'n', label: 'Net', colour: SERIES.net },
    ]));
    note = `${r.win.length} months, oldest first.`;
  } else if (chart === 'yoy') {
    const r = yearOverYear(rows, { labels });
    if (r.empty) {
      empty('Not enough history for a year-over-year comparison');
      note = 'Needs a month with the same month one year earlier.';
    } else {
      const t = yoyTotals(r.pairs);
      panel.append(h('div', 'kpis', `
        <div class="kpi"><span class="kpi-label">Gross</span>
          <span class="kpi-value">${usd(t.gross.cur)}</span>
          <span class="kpi-sub">${t.gross.change === null ? DASH : pctDelta(t.gross.change)} vs prior year</span></div>
        <div class="kpi"><span class="kpi-label">Net</span>
          <span class="kpi-value">${usd(t.net.cur)}</span>
          <span class="kpi-sub">${t.net.change === null ? DASH : pctDelta(t.net.change)} vs prior year</span></div>
        <div class="kpi"><span class="kpi-label">Margin</span>
          <span class="kpi-value">${pct(t.margin.cur)}</span>
          <span class="kpi-sub">${t.margin.points === null ? DASH
            : `${(t.margin.points * 100).toFixed(1)} pts`} vs prior year</span></div>`));
      panel.append(r.svg);
      note = `${r.pairs.length} months with a prior-year match.`;
    }
    panel.append(legend([
      { key: 'pg', label: 'Prior gross', colour: SERIES.prior },
      { key: 'cg', label: 'Gross', colour: SERIES.gross },
      { key: 'cn', label: 'Net', colour: SERIES.net },
      { key: 'm', label: 'Margin (right axis)', colour: SERIES.margin },
    ]));
  } else if (chart === 'ytd') {
    const r = ytd(rows, { labels });
    if (r.empty) empty('No data for this year or last');
    else {
      panel.append(h('div', 'kpis', `
        <div class="kpi"><span class="kpi-label">YTD gross</span>
          <span class="kpi-value">${usd(r.cumGross)}</span></div>
        <div class="kpi"><span class="kpi-label">YTD net</span>
          <span class="kpi-value">${usd(r.cumNet)}</span></div>
        <div class="kpi"><span class="kpi-label">YTD payouts</span>
          <span class="kpi-value">${usd(r.payouts)}</span>
          <span class="kpi-sub">the band between the two</span></div>`));
      panel.append(r.svg);
      note = r.fellBack
        ? `No sessions yet this year — showing ${r.year}.`
        : `Cumulative from January ${r.year}.`;
    }
  } else if (chart === 'jackpot') {
    const win = jackpotWindow(data, { hall });
    const r = jackpotImpact(win, { labels, hidden });
    if (r.empty) empty(win.jackpots.length ? 'No sessions in the last 30 days' : 'No jackpots configured');
    else {
      panel.append(r.svg);
      panel.append(legend(withState([
        ...win.jackpots.map((j, i) => ({ key: `bal-${i}`, label: j.name, colour: `var(--series-${(i % 5) + 1})` })),
        { key: 'net', label: 'Net revenue', colour: SERIES.net },
        { key: 'att', label: 'Attendance (right)', colour: SERIES.att, dashed: true },
      ]), toggle));
      note = r.anyPlayers
        ? 'Players estimated as jackpot growth divided by the cost of one play.'
        : 'No participation cost configured, so player counts cannot be estimated.';
    }
  } else if (chart === 'product') {
    const r = productNet(rows, data.categories, { labels, hidden });
    if (r.empty) empty(data.categories.length ? 'No revenue in this window' : 'No product categories configured');
    else {
      panel.append(r.svg);
      panel.append(legend(withState([
        ...data.categories.map((c) => ({ key: `cat-${c.key}`, label: c.display_name, colour: c.color_bg_from })),
        { key: 'net', label: 'Net (all products)', colour: SERIES.net },
      ]), toggle));
      note = 'The net line sits above the stack by whatever belongs to no category.';
    }
  } else {
    const pts = runnerPoints(data, { hall, metric });
    const r = runnerCorrelation(pts, data.locations, { metric });
    const mbar = h('div', 'filter-bar');
    for (const m of RUNNER_METRICS) {
      const b = h('button', `chip${metric === m.key ? ' is-active' : ''}`);
      b.type = 'button'; b.textContent = m.label;
      b.addEventListener('click', () => onNavigate('dashboard', { ...params, metric: m.key }));
      mbar.append(b);
    }
    panel.append(mbar);
    if (r.empty) empty('No runner data for this filter');
    else {
      panel.append(r.svg);
      note = r.drawable
        ? `R² ${r.fit.r2 === null ? DASH : r.fit.r2.toFixed(3)} · Spearman ρ ${
            r.rho === null ? DASH : r.rho.toFixed(3)} · ${r.n} sessions.`
        : r.distinctX < 2
          ? `Every session in this window had the same number of runners, so there is no relationship to measure. ${r.n} sessions.`
          : `${r.n} sessions — fewer than ${MIN_FIT}, so no trend line is drawn.`;
    }
  }

  if (note) panel.append(h('p', 'muted', note));
  root.append(panel);

  setInspectorContent?.(`
    <p class="semi">${title}</p>
    <p class="muted">${esc(hall === 'combined' ? 'Both halls' : data.locations.find((l) => l.id === hall)?.name ?? hall)}</p>
    <p class="inspector-section-label">Where these numbers come from</p>
    <p class="muted">The metric store, rolled up through the product categories —
      the same path as the session screen and Reporting. Not the monthly summary
      view, whose money columns have not been maintained since March and which
      nothing in either version of SAR reads.</p>
    ${chart === 'runners' ? `
    <p class="inspector-section-label">Correlation is not cause</p>
    <p class="muted">More runners on a busy night is a rostering decision, so the
      arrow runs from expected takings to runners at least as much as the other
      way. Spearman's ρ is shown beside R² because the horizontal axis is a small
      integer count with heavy ties, which flatters a straight-line fit.</p>` : ''}
    ${chart === 'product' ? `
    <p class="inspector-section-label">Why the line sits above the bars</p>
    <p class="muted">Net counts every metric; the stack counts only metrics
      assigned to a category. The difference is in each point's tooltip.</p>` : ''}`);

  return root;
}
