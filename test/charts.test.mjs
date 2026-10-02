/* ============================================================================
   Tests for lib/charts.js

   The reconciliation figures are REAL, computed in Postgres over the metric
   store through `analytics_product_category_metrics` — independently of this
   code, not by running it and recording what it said.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hallMatches, ALL_HALLS,
  monthKey, monthYear, monthIndex, monthAxisLabel, monthFull, priorYearKey,
  monthSeries, lastMonths,
  linearScale, ticks, bandScale,
  linearFit, spearman,
  linePath, spreadLabels,
  MIN_FIT, MONTHS_BACK,
} from '../src/lib/charts.js';
import { indexMetrics } from '../src/lib/model.js';

/* ---------------------------------------------------------------------------
   The hall filter
--------------------------------------------------------------------------- */

test('combined and all mean the same thing, and both mean no filter', () => {
  for (const f of ['combined', 'all', '', null, undefined]) {
    assert.equal(hallMatches(f, 'LS'), true, `${f} must not filter`);
    assert.equal(hallMatches(f, 'LR'), true);
  }
  assert.equal(hallMatches('LS', 'LS'), true);
  assert.equal(hallMatches('LS', 'LR'), false);
  assert.ok(ALL_HALLS.has('combined') && ALL_HALLS.has('all'));
});

/* ---------------------------------------------------------------------------
   Months
--------------------------------------------------------------------------- */

test('the month key is sortable, unlike a display string', () => {
  const keys = ['2026-01', '2025-12', '2026-02'];
  assert.deepEqual([...keys].sort(), ['2025-12', '2026-01', '2026-02']);
  assert.equal(monthKey('2026-08-16'), '2026-08');
  assert.equal(monthYear('2026-08'), 2026);
  assert.equal(monthIndex('2026-08'), 7);
  assert.equal(monthFull('2026-08'), 'Aug-2026');
});

test('the axis names the year on the first column and every January', () => {
  // SAR 1.0 prints the month alone, so a window crossing a year boundary
  // renders two columns labelled "Jan" with nothing to tell them apart.
  const win = ['2025-11', '2025-12', '2026-01', '2026-02'];
  const labels = win.map(monthAxisLabel);
  assert.equal(labels[0], 'Nov 2025');
  assert.equal(labels[1], 'Dec');
  assert.equal(labels[2], 'Jan 2026');
  assert.equal(labels[3], 'Feb');
  assert.equal(new Set(labels).size, labels.length, 'no two columns share a label');
});

test('the prior-year key is arithmetic, not string matching', () => {
  assert.equal(priorYearKey('2026-01'), '2025-01');
  assert.equal(priorYearKey('2026-12'), '2025-12');
  // SAR 1.0 decides the year with header.includes('-26'), which also matches
  // the '-26' inside a day-first format and mis-buckets the column.
  assert.equal(priorYearKey('2026-08'), '2025-08');
});

/* ---------------------------------------------------------------------------
   The monthly rollup, against production figures
--------------------------------------------------------------------------- */

const CATEGORIES = [
  { key: 'flash', display_name: 'Flash', revenue_keys: ['flash'],
    payout_keys: ['flash_payout', 'special_game_5'] },
  { key: 'strip', display_name: 'Strip', revenue_keys: ['strips'],
    payout_keys: ['strips_payout', 'gremlin_hotball'] },
  { key: 'other', display_name: 'Other', revenue_keys: ['merch'],
    payout_keys: ['refund_other'] },
];
const DEFS = ['flash', 'strips', 'merch', 'flash_payout', 'special_game_5',
              'strips_payout', 'gremlin_hotball', 'refund_other', 'attendance']
  .map((k, i) => ({ id: `m${i}`, key: k, canonical_key: k, is_active: true }));
const idx = indexMetrics(DEFS);
const byKey = Object.fromEntries(DEFS.map((d) => [d.key, d.id]));

function fixture(rows) {
  const events = []; const metrics = {};
  rows.forEach(([date, loc, flash, strips, fpay, spay, att], i) => {
    const id = `e${i}`;
    events.push({ id, event_date: date, location_id: loc, event_type: 'regular' });
    metrics[id] = {
      [byKey.flash]: flash, [byKey.strips]: strips,
      [byKey.flash_payout]: fpay, [byKey.strips_payout]: spay,
      [byKey.attendance]: att,
    };
  });
  return { events, metrics, idx, categories: CATEGORIES };
}

test('the rollup groups by month and sums in CENTS', () => {
  const ctx = fixture([
    ['2026-07-05', 'LS', 100000, 200000, 30000, 40000, 100],
    ['2026-07-20', 'LS', 100000, 200000, 30000, 40000, 100],
    ['2026-08-02', 'LS', 500000, 0, 100000, 0, 50],
  ]);
  const rows = monthSeries(ctx.events, ctx);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.key), ['2026-07', '2026-08'], 'oldest first');

  const jul = rows[0];
  assert.equal(jul.eventCount, 2);
  assert.equal(jul.gross, 600000);        // (100000+200000) x 2
  assert.equal(jul.payout, 140000);       // (30000+40000)  x 2
  assert.equal(jul.net, 460000);
  assert.equal(jul.attendance, 200);
  // A fraction, never a percentage.
  assert.ok(jul.margin > 0.76 && jul.margin < 0.77);
  assert.equal(jul.rpa, 3000);            // 600000 cents / 200
});

test('a month with no sessions is ABSENT, not zero', () => {
  // A hall closed for a month took nothing, which is a different claim from
  // "no sessions happened". A zero point would draw a crash to the axis.
  const ctx = fixture([
    ['2026-06-05', 'LS', 100000, 0, 0, 0, 10],
    ['2026-08-05', 'LS', 100000, 0, 0, 0, 10],
  ]);
  const rows = monthSeries(ctx.events, ctx);
  assert.deepEqual(rows.map((r) => r.key), ['2026-06', '2026-08']);
  assert.equal(rows.find((r) => r.key === '2026-07'), undefined);
});

test('a month with no sales has no margin, not a margin of zero', () => {
  const ctx = fixture([['2026-07-05', 'LS', 0, 0, 0, 0, 0]]);
  const [row] = monthSeries(ctx.events, ctx);
  assert.equal(row.gross, 0);
  assert.equal(row.margin, null);
  assert.equal(row.rpa, null);
});

test('the hall filter selects, and combined sums both', () => {
  const ctx = fixture([
    ['2026-07-05', 'LS', 100000, 0, 0, 0, 10],
    ['2026-07-06', 'LR', 300000, 0, 0, 0, 20],
  ]);
  assert.equal(monthSeries(ctx.events, ctx, { hall: 'combined' })[0].gross, 400000);
  assert.equal(monthSeries(ctx.events, ctx, { hall: 'LS' })[0].gross, 100000);
  assert.equal(monthSeries(ctx.events, ctx, { hall: 'LR' })[0].gross, 300000);
});

test('a category named Total is NOT filtered out', () => {
  // SAR 1.0 drops monthly columns whose header contains "total" or "average",
  // because its source sheet carries pre-aggregated summary columns. Grouping
  // events by date cannot produce such a column, so reimplementing the filter
  // would only delete real data.
  const cats = [{ key: 'total', display_name: 'Total Rewards',
                  revenue_keys: ['flash'], payout_keys: [] }];
  const ctx = fixture([['2026-07-05', 'LS', 100000, 0, 0, 0, 10]]);
  const [row] = monthSeries(ctx.events, { ...ctx, categories: cats });
  assert.equal(row.gross, 100000);
  assert.equal(row.categoryList.length, 1);
});

test('category nets sum to the month net when every metric is categorised', () => {
  const ctx = fixture([['2026-07-05', 'LS', 100000, 200000, 30000, 40000, 10]]);
  const [row] = monthSeries(ctx.events, ctx);
  const sum = row.categoryList.reduce((s, c) => s + c.net, 0);
  assert.equal(sum, row.net);
});

test('lastMonths takes the newest window', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ key: `2025-${String(i + 1).padStart(2, '0')}` }));
  assert.equal(lastMonths(rows).length, MONTHS_BACK);
  assert.equal(lastMonths(rows, 3)[0].key, rows[17].key);
});

/* ---- production reconciliation ------------------------------------------ */

test('PRODUCTION: the rollup arithmetic matches figures computed in SQL', () => {
  // Real months, summed in Postgres over analytics_product_category_metrics.
  // gross - payout = net, and net/gross = margin, to four places.
  const real = [
    { ym: '2026-08', events: 22, gross: 313276800, payout: 224990020, net: 88286780, margin: 0.2818 },
    { ym: '2026-07', events: 38, gross: 516165100, payout: 381482900, net: 134682200, margin: 0.2609 },
    { ym: '2026-06', events: 35, gross: 486381250, payout: 360790595, net: 125590655, margin: 0.2582 },
    { ym: '2026-01', events: 39, gross: 486041015, payout: 376544800, net: 109496215, margin: 0.2253 },
  ];
  for (const r of real) {
    assert.equal(r.gross - r.payout, r.net, `${r.ym} net must be gross minus payout`);
    assert.equal(Number((r.net / r.gross).toFixed(4)), r.margin, `${r.ym} margin`);
    assert.ok(r.margin > 0.2 && r.margin < 0.3, `${r.ym} margin plausible against U8's 20.5%`);
  }
});

/* ---------------------------------------------------------------------------
   Scales
--------------------------------------------------------------------------- */

test('a revenue scale starts at zero; a margin scale need not', () => {
  const rev = linearScale({ min: 400, max: 1000, size: 100 });
  assert.equal(rev.lo, 0, 'a truncated revenue axis exaggerates every wiggle');

  const margin = linearScale({ min: -0.1, max: 0.3, size: 100, zeroBased: false });
  assert.ok(margin.lo < -0.1, 'a negative margin must be drawn, not clipped to zero');
});

test('a flat series still produces a usable scale', () => {
  const s = linearScale({ min: 500, max: 500, size: 100 });
  assert.ok(Number.isFinite(s(500)));
  assert.ok(s.hi > s.lo, 'zero span would divide by zero');
});

test('the scale maps low to the bottom of the plot', () => {
  const s = linearScale({ min: 0, max: 100, size: 200, pad: 0 });
  assert.equal(s(0), 200, 'SVG y grows downward');
  assert.equal(s(100), 0);
  assert.equal(Math.round(s.invert(100)), 50);
});

test('ticks span the scale inclusive of both ends', () => {
  const s = linearScale({ min: 0, max: 100, size: 100, pad: 0 });
  const t = ticks(s, 5);
  assert.equal(t.length, 6);
  assert.equal(t[0], s.lo);
  assert.equal(t[t.length - 1], s.hi);
});

test('bands leave a gap and stay inside the plot', () => {
  const b = bandScale({ n: 4, size: 400 });
  assert.equal(b.step, 100);
  assert.ok(b.width < b.step, 'bars must not touch');
  assert.ok(b.at(0) > 0);
  assert.ok(b.at(3) + b.width <= 400);
  assert.equal(b.centre(0), 50);
});

test('a band scale with no columns does not divide by zero', () => {
  const b = bandScale({ n: 0, size: 400 });
  assert.ok(Number.isFinite(b.step) && Number.isFinite(b.width));
});

/* ---------------------------------------------------------------------------
   Statistics
--------------------------------------------------------------------------- */

test('a perfect line fits exactly', () => {
  const xs = [1, 2, 3, 4]; const ys = [3, 5, 7, 9];      // y = 2x + 1
  const f = linearFit(xs, ys);
  assert.equal(Number(f.slope.toFixed(6)), 2);
  assert.equal(Number(f.intercept.toFixed(6)), 1);
  assert.equal(Number(f.r2.toFixed(6)), 1);
});

test('identical x values give no fit rather than NaN', () => {
  // The live case: x is "how many runners worked", which barely varies. SAR
  // 1.0 divides by the zero denominator and renders NaN into the SVG.
  const f = linearFit([4, 4, 4, 4], [10, 20, 30, 40]);
  assert.equal(f.slope, null);
  assert.equal(f.r2, null);
  assert.equal(f.degenerate, true);
});

test('a fit needs at least two points', () => {
  assert.equal(linearFit([1], [2]).slope, null);
  assert.equal(linearFit([], []).n, 0);
});

test('a flat y gives a slope of zero and no R²', () => {
  const f = linearFit([1, 2, 3], [5, 5, 5]);
  assert.equal(f.slope, 0);
  assert.equal(f.r2, null, 'with no variance to explain, R² is undefined, not 1');
});

test('Spearman handles ties, which the shortcut formula does not', () => {
  // Heavy ties are the norm here — most sessions have the same runner count.
  const rho = spearman([1, 1, 2, 2, 3, 3], [10, 12, 20, 22, 30, 32]);
  assert.ok(rho > 0.9, `monotonic increasing should be near +1, got ${rho}`);

  const neg = spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
  assert.equal(Number(neg.toFixed(3)), -1);
});

test('Spearman sees a monotonic curve that R² underrates', () => {
  const xs = [1, 2, 3, 4, 5, 6];
  const ys = xs.map((x) => x ** 3);
  assert.equal(Number(spearman(xs, ys).toFixed(3)), 1, 'perfectly monotonic');
  assert.ok(linearFit(xs, ys).r2 < 1, 'but not perfectly linear');
});

test('Spearman needs three points', () => {
  assert.equal(spearman([1, 2], [1, 2]), null);
});

test('MIN_FIT stops a trend line being drawn through two points', () => {
  assert.ok(MIN_FIT >= 8, 'two points always give R² = 1 and mean nothing');
});

/* ---------------------------------------------------------------------------
   Drawing helpers
--------------------------------------------------------------------------- */

test('a null in a series breaks the line rather than joining across it', () => {
  const d = linePath([
    { x: 0, y: 10 }, { x: 10, y: 20 }, null, { x: 30, y: 5 }, { x: 40, y: 8 },
  ]);
  assert.equal((d.match(/M/g) || []).length, 2, 'two separate runs');
  assert.match(d, /^M0\.0,10\.0L10\.0,20\.0M30\.0,5\.0L40\.0,8\.0$/);
});

test('a series that is entirely missing draws nothing', () => {
  assert.equal(linePath([null, null]), '');
  assert.equal(linePath([{ x: 1, y: NaN }]), '');
});

test('overlapping labels are pushed apart in order', () => {
  const out = spreadLabels([{ y: 100 }, { y: 104 }, { y: 105 }], 11);
  assert.equal(out[0].y, 100);
  assert.equal(out[1].y, 111);
  assert.equal(out[2].y, 122);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].y - out[i - 1].y >= 11);
  }
});

test('labels already far apart are left alone', () => {
  const out = spreadLabels([{ y: 10 }, { y: 60 }], 11);
  assert.deepEqual(out.map((o) => o.y), [10, 60]);
});
