/* ============================================================================
   SAR 2.0 — the aspect register

   An "aspect" is one sortable measure of a session. The Leaderboard puts them
   all on a line; you click one and the table sorts by it.

   THIS IS THE SHAPE THE LEADERBOARD MUST HAVE. An earlier mockup lost it and
   was rebuilt: the point is not a table with a few sort arrows, it is every
   metric visible at once as a row of choices.

   Ten universal aspects, plus three for each product category, generated from
   the tenant's own categories rather than hardcoded — five categories today
   gives 25 aspects.

   Each aspect declares:
     · `value(t)`   how to read it from sessionTotals
     · `format`     how it becomes text
     · `better`     which direction is good, for tone
     · `higherFirst` the sensible default sort direction
   ========================================================================== */

import { usd, usd2, pct, int } from './fmt.js';

/** Direction that counts as good. Used for tone, never for sort order. */
export const BETTER = { UP: 1, DOWN: -1, NEUTRAL: 0 };

const money = (v) => usd(v);

export const UNIVERSAL = [
  { key: 'gross',        label: 'Gross sales',   group: 'Session',
    value: (t) => t.revenue,      format: money,  better: BETTER.UP,      higherFirst: true },
  { key: 'net',          label: 'Net',           group: 'Session',
    value: (t) => t.net,          format: money,  better: BETTER.UP,      higherFirst: true },
  { key: 'payouts',      label: 'Payouts',       group: 'Session',
    value: (t) => t.payout,       format: money,  better: BETTER.NEUTRAL, higherFirst: true },
  { key: 'margin',       label: 'Margin',        group: 'Session',
    value: (t) => t.margin,       format: (v) => pct(v), better: BETTER.UP, higherFirst: true },
  { key: 'payoutRatio',  label: 'Payout ratio',  group: 'Session',
    value: (t) => (t.revenue ? t.payout / t.revenue : null),
    format: (v) => pct(v),        better: BETTER.DOWN,    higherFirst: true },
  { key: 'attendance',   label: 'Attendance',    group: 'Session',
    value: (t) => t.attendance,   format: int,    better: BETTER.UP,      higherFirst: true },
  { key: 'rpa',          label: 'Per head',      group: 'Session',
    value: (t) => t.rpa,          format: usd2,   better: BETTER.UP,      higherFirst: true },
  { key: 'netPerHead',   label: 'Net per head',  group: 'Session',
    value: (t) => (t.attendance > 0 ? t.net / t.attendance : null),
    format: usd2,                 better: BETTER.UP,      higherFirst: true },
  { key: 'capacity',     label: 'Capacity used', group: 'Session',
    value: (t) => t.attendancePct, format: (v) => pct(v), better: BETTER.UP, higherFirst: true },
  { key: 'grossPerCat',  label: 'Category spread', group: 'Session',
    // How concentrated the night was. A high number means one category carried
    // it — useful for spotting a session propped up by a single product.
    value: (t) => {
      const shares = t.categories.map((c) => (t.revenue ? c.revenue / t.revenue : 0));
      return shares.length ? Math.max(...shares) : null;
    },
    format: (v) => pct(v), better: BETTER.NEUTRAL, higherFirst: true },
];

/** Three per category: revenue, net, margin. Built from the tenant's config. */
export function categoryAspects(categories = []) {
  const out = [];
  for (const c of categories) {
    const find = (t) => t.categories.find((x) => x.key === c.key);
    out.push(
      { key: `cat:${c.key}:revenue`, label: `${c.display_name} revenue`, group: c.display_name,
        value: (t) => find(t)?.revenue ?? null, format: money, better: BETTER.UP, higherFirst: true },
      { key: `cat:${c.key}:net`, label: `${c.display_name} net`, group: c.display_name,
        value: (t) => find(t)?.net ?? null, format: money, better: BETTER.UP, higherFirst: true },
      { key: `cat:${c.key}:margin`, label: `${c.display_name} margin`, group: c.display_name,
        value: (t) => find(t)?.margin ?? null, format: (v) => pct(v),
        better: BETTER.UP, higherFirst: true },
    );
  }
  return out;
}

export function allAspects(categories = []) {
  return [...UNIVERSAL, ...categoryAspects(categories)];
}

export const DEFAULT_ASPECT = 'gross';

/**
 * Sort rows by an aspect.
 *
 * **Nulls always sort last, in both directions.** A session with no recorded
 * attendance is not the worst-attended session — it is unmeasured, and
 * floating it to either end of the table would be a claim the data does not
 * support.
 */
export function sortByAspect(rows, aspect, descending) {
  const withValue = [];
  const withoutValue = [];
  for (const r of rows) {
    const v = aspect.value(r.totals);
    if (v === null || v === undefined || !Number.isFinite(v)) withoutValue.push(r);
    else withValue.push({ ...r, _v: v });
  }
  withValue.sort((a, b) => (descending ? b._v - a._v : a._v - b._v));
  return [...withValue, ...withoutValue];
}
