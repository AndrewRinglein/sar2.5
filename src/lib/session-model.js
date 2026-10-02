/* ============================================================================
   SAR 2.0 — Session detail model (U8)

   Pure functions behind the session screen: the comparison pool's controls,
   per-category comparison, the bridge and its drivers, findings, the
   expected-range band, and the Performance / Jackpots / Summary sub-pages.

   Same rules as model.js: MONEY IS INTEGER CENTS, ratios are fractions, and a
   missing metric is `null`, never 0. Where SAR 1.0's own rule differs it is
   named at the function.

   Metric keys used by the sub-pages are SAR 1.0's own, read from its source
   (app.html, `updatePerformancePage`, `updateJackpotsPage`,
   `updateSummaryPage`), so a tenant's data lights up the same rows in both.
   ========================================================================== */

import {
  metricsFor, getMetric, sessionTotals, comparisonPool, mean, median, percentile,
  zScore, delta, jackpotBucket, MIN_POOL,
} from './model.js';
import { usd, usd2, pct, int, weekday, sessionType } from './fmt.js';

/* ---------------------------------------------------------------------------
   Pool controls — SPEC §4.2
--------------------------------------------------------------------------- */

/** SAR 1.0's three windows. Default 3M. */
export const POOL_PERIODS = Object.freeze({ '1M': 30, '3M': 90, '1Y': 365 });
export const DEFAULT_PERIOD = '3M';
export const JACKPOT_FILTERS = Object.freeze(['none', 'category', '10%', '20%']);
export const PAGES = Object.freeze(['overview', 'performance', 'jackpots', 'summary']);

/**
 * Pool options from the hash. Every control lives in the URL, so a reload or
 * a shared link reproduces the same comparison — SAR 1.0 reset all four on
 * reload (SPEC §4.2 "in-memory only").
 *
 *   period=1M|3M|1Y   dayOnly=0 (off; absent = on)   jp=none|category|10%|20%
 */
export function poolOptions(params = {}) {
  const period = POOL_PERIODS[params.period] ? params.period : DEFAULT_PERIOD;
  const dayOnly = params.dayOnly !== '0';
  const jackpot = JACKPOT_FILTERS.includes(params.jp) ? params.jp : 'none';
  return { period, windowDays: POOL_PERIODS[period], dayOnly, jackpot };
}

/** The page shown, defaulting to Overview. */
export const pageOf = (params = {}) => (PAGES.includes(params.page) ? params.page : 'overview');

/**
 * The jackpot SAR 1.0's pool filter reads: the FIRST configured jackpot's
 * balance (`BingoEvent.hotballTotal`), falling back to `hotball_total` when
 * none is configured. Production: Hotball, per hall.
 */
export function filterJackpot(config) {
  const jp = config?.settings?.jackpots?.[0];
  return { name: jp?.name ?? 'Jackpot', balanceKey: jp?.balanceKey ?? 'hotball_total' };
}

/** The comparison pool for a session under the chosen options. Strict window. */
export function sessionPool(ev, data, opts) {
  const { balanceKey } = filterJackpot(data.config);
  const balanceOf = (e) => getMetric(metricsFor(e.id, data.metrics, data.idx), balanceKey) ?? 0;
  return comparisonPool(ev, data.events, {
    windowDays: opts.windowDays,
    dayOnly: opts.dayOnly,
    jackpotFilter: opts.jackpot,
    balanceOf,
    strict: true,
  });
}

const PERIOD_WORDS = { '1M': '1 month', '3M': '3 months', '1Y': '1 year' };
const BAND_WORDS = { low: 'under $5,000', mid: '$5,000–$10,000', high: '$10,000 or more' };

/**
 * "Compared to:" — the active filter state in words, with the pool size.
 * SPEC §4.8 calls SAR 1.0's version good practice; this one also names the
 * band or tolerance the target itself sits in, so the sentence is checkable.
 */
export function poolSentence(ev, opts, n, { jackpotName = 'Jackpot', targetBalance = 0 } = {}) {
  const parts = [`the ${PERIOD_WORDS[opts.period]} before this session`];
  parts.push(opts.dayOnly
    ? `${weekday(ev.event_date)} ${sessionType(ev.event_type).toLowerCase()} sessions only`
    : 'any day or session type at this hall');
  if (opts.jackpot === 'category') {
    parts.push(`${jackpotName} in the same band (${BAND_WORDS[jackpotBucket(targetBalance)]})`);
  } else if (opts.jackpot === '10%' || opts.jackpot === '20%') {
    parts.push(`${jackpotName} within ${opts.jackpot} of ${usd(targetBalance)}`);
  } else {
    parts.push(`any ${jackpotName} balance`);
  }
  const count = n === 0 ? 'no sessions' : `${int(n)} session${n === 1 ? '' : 's'}`;
  return `${parts.join(' · ')} — ${count}`;
}

/* ---------------------------------------------------------------------------
   Pool aggregates
--------------------------------------------------------------------------- */

const sum = (xs) => xs.reduce((s, x) => s + (x ?? 0), 0);
/** Round to whole cents, never −0 (Intl prints −0 as "-$0"). */
const cents = (x) => Math.round(x) || 0;

/** Totals for each pool session, in the same category order as the target. */
export function poolTotals(pool, data) {
  return pool.map((p) => ({
    id: p.id, event: p,
    m: metricsFor(p.id, data.metrics, data.idx),
    ...sessionTotals(metricsFor(p.id, data.metrics, data.idx), data.categories),
  }));
}

/**
 * Attendance-weighted per-head figures use only pool sessions that RECORDED
 * attendance. SAR 1.0 averages attendance over the whole pool with a missing
 * value read as zero, which inflates the pool's per-head figure whenever a
 * session went unrecorded. With every session recorded the two agree exactly
 * (avgRev / avgAtt = ΣRev / ΣAtt).
 */
function attended(pool) { return pool.filter((p) => p.attendance !== null && p.attendance > 0); }

/** Margin from 0 to 50% is shown; outside that SAR 1.0 prints N/A as unreliable. SPEC §4.8 */
export const marginValid = (m) => m !== null && Number.isFinite(m) && m >= 0 && m <= 0.5;

/**
 * Each category against the pool. SPEC §4.8.
 *
 *  · revenue, payout, net against the pool AVERAGE of each;
 *  · payout changes carry a neutral tone — more paid out is not self-evidently bad;
 *  · RPA against pool revenue ÷ pool attendance (SAR 1.0: "recomputed against
 *    the pool's average attendance");
 *  · margin from pool TOTALS, and only when both sides fall in 0–50%.
 *
 * Below MIN_POOL every comparison is withheld, as on the KPI strip.
 */
export function categoryComparison(t, pool) {
  const enough = pool.length >= MIN_POOL;
  const withAtt = attended(pool);
  const poolAtt = sum(withAtt.map((p) => p.attendance));
  const poolRevAll = sum(pool.map((p) => p.revenue));

  return t.categories.map((c, i) => {
    const revs = pool.map((p) => p.categories[i]?.revenue ?? 0);
    const pays = pool.map((p) => p.categories[i]?.payout ?? 0);
    const avgRev = pool.length ? mean(revs) : null;
    const avgPay = pool.length ? mean(pays) : null;
    const avgNet = pool.length ? avgRev - avgPay : null;
    const sRev = sum(revs);
    const poolMargin = sRev > 0 ? (sRev - sum(pays)) / sRev : null;
    const compRpa = poolAtt > 0 ? sum(withAtt.map((p) => p.categories[i]?.revenue ?? 0)) / poolAtt : null;
    const rpa = t.attendance !== null && t.attendance > 0 ? c.revenue / t.attendance : null;

    const d = (value, base, opts) => (enough && base !== null && base !== 0 && value !== null
      ? delta(value, base, opts) : null);
    const payoutDelta = enough && avgPay > 0 ? { ...delta(c.payout, avgPay), tone: 'neutral' } : null;

    return {
      ...c,
      share: t.revenue > 0 ? c.revenue / t.revenue : null,
      rpa: c.showRpa ? rpa : null,
      marginShown: c.showMargin ? (c.margin === null ? null : (marginValid(c.margin) ? c.margin : 'N/A')) : null,
      pool: {
        n: pool.length, avgRevenue: avgRev, avgPayout: avgPay, avgNet,
        margin: poolMargin, rpa: compRpa,
        share: poolRevAll > 0 ? sRev / poolRevAll : null,
      },
      deltas: {
        revenue: avgRev > 0 ? d(c.revenue, avgRev) : null,
        payout: payoutDelta,
        net: d(c.net, avgNet),
        rpa: c.showRpa && compRpa > 0 ? d(rpa, compRpa) : null,
        marginPP: enough && c.showMargin && marginValid(c.margin) && marginValid(poolMargin)
          ? c.margin - poolMargin : null,
      },
    };
  });
}

/**
 * Revenue or payout distribution by category, coloured from the tenant's own
 * `color_border` as SAR 1.0 does (SPEC §4.7), else a series token.
 */
export function distribution(t, categories, field) {
  return t.categories.map((c, i) => ({
    key: c.key,
    label: c.name,
    value: c[field],
    colour: categories[i]?.color_border || `var(--series-${(i % 5) + 1})`,
  }));
}

/* ---------------------------------------------------------------------------
   Why net moved — drivers and the bridge (v9 mockup M.drivers / M.bridge)
--------------------------------------------------------------------------- */

/**
 * Decompose (this net − typical net) into candidate causes, in cents.
 *
 *   attendance   (att − baseAtt) × baseSpend × (1 − basePayoutRatio)
 *   spend/head   (spend − baseSpend) × att × (1 − basePayoutRatio)
 *   payout ratio −(ratio − baseRatio) × gross
 *   residual     whatever those three cannot account for
 *
 * The mockup's formulas, with two SAR 2 choices: the baseline spend and
 * payout ratio come from pool TOTALS (as the KPI strip's RPA and margin do,
 * SPEC §4.2), and a session without recorded attendance falls back to a
 * single "Gross sales" row instead of inventing a head count.
 *
 * Every row is rounded to the cent and the residual is computed from the
 * rounded rows, so the rows sum EXACTLY to the rounded gap.
 */
export function netDrivers(t, pool) {
  if (!pool.length) return null;
  const baseNet = mean(pool.map((p) => p.net));
  const baseRev = mean(pool.map((p) => p.revenue));
  const sRev = sum(pool.map((p) => p.revenue));
  const basePr = sRev > 0 ? sum(pool.map((p) => p.payout)) / sRev : 0;
  const withAtt = attended(pool);
  const sAtt = sum(withAtt.map((p) => p.attendance));
  const baseAtt = withAtt.length ? sAtt / withAtt.length : null;
  const baseSpa = sAtt > 0 ? sum(withAtt.map((p) => p.revenue)) / sAtt : null;
  const pr = t.revenue > 0 ? t.payout / t.revenue : basePr;
  const keep = 1 - basePr;
  const gap = Math.round(t.net) - Math.round(baseNet);

  const rows = [];
  if (t.attendance !== null && baseAtt !== null && baseSpa !== null) {
    const att = t.attendance;
    const spa = att > 0 ? t.revenue / att : baseSpa;
    rows.push({ key: 'attendance', label: 'Attendance', value: att, base: baseAtt,
                impact: cents((att - baseAtt) * baseSpa * keep) });
    rows.push({ key: 'spend', label: 'Spend per head', value: att > 0 ? spa : null, base: baseSpa,
                impact: cents((spa - baseSpa) * att * keep) });
  } else {
    rows.push({ key: 'gross', label: 'Gross sales', value: t.revenue, base: baseRev,
                impact: cents((t.revenue - baseRev) * keep) });
  }
  rows.push({ key: 'payoutRatio', label: 'Payout ratio', value: t.revenue > 0 ? pr : null, base: basePr,
              impact: cents(-(pr - basePr) * t.revenue) });
  const explained = sum(rows.map((r) => r.impact));
  rows.push({ key: 'residual', label: 'Unexplained', residual: true, impact: gap - explained });

  const absTotal = sum(rows.map((r) => Math.abs(r.impact))) || 1;
  const ranked = rows
    .map((r) => ({ ...r, share: Math.abs(r.impact) / absTotal }))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return { baseNet: Math.round(baseNet), net: Math.round(t.net), gap, rows: ranked, ordered: rows };
}

/**
 * Bridge items, from the typical night to this one.
 *
 *  · mode 'driver' (default, the mockup's): attendance, spend, payout ratio,
 *    residual — operational levers, every bar labelled.
 *  · mode 'category': one bar per category, this night's net less the pool
 *    average of that category's net. Exact by construction: net is the sum of
 *    category nets and a mean is linear, so there is no residual.
 *
 * Deltas are rounded CUMULATIVELY (each bar is the change in the rounded
 * running total), so start + Σ deltas equals the end to the cent.
 */
export function bridgeItems(t, pool, mode = 'driver') {
  if (!pool.length) return null;
  const baseNet = mean(pool.map((p) => p.net));
  let parts;
  if (mode === 'category') {
    parts = t.categories.map((c, i) => ({
      label: c.name, exact: c.net - mean(pool.map((p) => p.categories[i]?.net ?? 0)),
    }));
  } else {
    const d = netDrivers(t, pool);
    parts = d.ordered.map((r) => ({ label: r.label, exact: r.impact, residual: !!r.residual }));
  }
  const items = [{ label: 'Typical night', value: Math.round(baseNet), type: 'start' }];
  let exactRun = Math.round(baseNet);
  let shown = Math.round(baseNet);
  for (const p of parts) {
    exactRun += p.exact;
    const next = Math.round(exactRun);
    items.push({ label: p.label, value: (next - shown) || 0, type: 'delta', residual: p.residual || undefined });
    shown = next;
  }
  // Close the bridge exactly on this night's net, whatever float noise remains.
  const end = Math.round(t.net);
  if (shown !== end && items.length > 1) items[items.length - 1].value += end - shown;
  items.push({ label: 'This night', value: end, type: 'total' });
  return items;
}

/* ---------------------------------------------------------------------------
   Findings (v9 mockup M.insights) — ranked, never a single cause
--------------------------------------------------------------------------- */

const FINDING_CHECKS = [
  { key: 'net', label: 'Net', of: (x) => x.net, fmt: usd },
  { key: 'revenue', label: 'Gross sales', of: (x) => x.revenue, fmt: usd },
  { key: 'rpa', label: 'Revenue per attendee', of: (x) => x.rpa, fmt: usd2 },
  { key: 'attendance', label: 'Attendance', of: (x) => x.attendance, fmt: int },
  { key: 'margin', label: 'Margin', of: (x) => x.margin, fmt: (v) => pct(v) },
  { key: 'payoutRatio', label: 'Payout ratio', of: (x) => (x.revenue > 0 ? x.payout / x.revenue : null),
    fmt: (v) => pct(v), invert: true },
];

/**
 * Findings for one session against its pool.
 *
 *  · a `gate` finding leads whenever the pool is under MIN_POOL, and every
 *    finding under it is downgraded to a mover with low confidence;
 *  · |z| ≥ 1.5 is a flag, else the top three movers are kept so the panel is
 *    never empty; category nets flag at |z| ≥ 1.8;
 *  · `context` notes (a jackpot hit, a drawer out by more than $100) are
 *    explicitly not statistical claims.
 */
export function findings(t, pool, { ev, m = {}, jackpots = [], label = 'comparable' } = {}) {
  const out = [];
  const underpowered = pool.length < MIN_POOL;
  const slot = ev ? `${weekday(ev.event_date).slice(0, 3)} ${sessionType(ev.event_type).toLowerCase()}` : label;

  const scored = FINDING_CHECKS.map((c) => {
    const val = c.of(t);
    const xs = pool.map(c.of).filter((v) => v !== null && Number.isFinite(v));
    const z = val === null || xs.length < 2 ? null : zScore(val, xs);
    return { ...c, val, z, base: xs.length ? mean(xs) : null };
  }).filter((c) => c.z !== null && Number.isFinite(c.z))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  scored.forEach((c, i) => {
    const notable = Math.abs(c.z) >= 1.5;
    if (!notable && i >= 3) return;
    const good = c.invert ? c.z < 0 : c.z > 0;
    out.push({
      kind: notable && !underpowered ? 'flag' : 'mover',
      severity: Math.abs(c.z) >= 2.5 ? 'high' : notable ? 'med' : 'low',
      tone: Math.abs(c.z) < 0.6 ? 'neutral' : (good ? 'pos' : 'neg'),
      dir: c.z > 0 ? 'above' : 'below',
      metric: c.label, z: c.z,
      confidence: underpowered ? 'low' : (Math.abs(c.z) >= 2.5 ? 'high' : 'moderate'),
      text: `${c.label} of ${c.fmt(c.val)} ran ${Math.abs(c.z).toFixed(1)}σ ${c.z > 0 ? 'above' : 'below'} `
        + `the ${pool.length}-session ${slot} baseline of ${c.fmt(c.base)}.`,
    });
  });

  t.categories.forEach((c, i) => {
    const xs = pool.map((p) => p.categories[i]?.net ?? 0);
    if (xs.length < 2) return;
    const z = zScore(c.net, xs);
    if (z === null || Math.abs(z) < 1.8) return;
    out.push({
      kind: underpowered ? 'mover' : 'flag', severity: Math.abs(z) >= 2.5 ? 'high' : 'med',
      tone: z > 0 ? 'pos' : 'neg', dir: z > 0 ? 'above' : 'below', metric: c.name, z,
      confidence: underpowered ? 'low' : 'moderate',
      text: `${c.name} net of ${usd(c.net)} ran ${Math.abs(z).toFixed(1)}σ ${z > 0 ? 'above' : 'below'} `
        + `its usual ${usd(mean(xs))} on this slot.`,
    });
  });

  for (const jp of jackpots) {
    const paid = Math.abs(getMetric(m, jp.paidKey) ?? 0);
    if (paid > 0) {
      out.push({
        kind: 'context', severity: 'high', tone: 'neutral', metric: jp.name, z: null, confidence: 'n/a',
        text: `${jp.name} paid ${usd(paid)} this session. Expect attendance to soften on this slot while the pot rebuilds.`,
      });
    }
  }
  const variance = getMetric(m, 'bingo_variance');
  if (variance !== null && Math.abs(variance) > VARIANCE_BAD) {
    out.push({
      kind: 'flag', severity: 'high', tone: 'neg', metric: 'Cash variance', z: null, confidence: 'n/a',
      dir: variance < 0 ? 'short' : 'over',
      text: `Bingo register came up ${variance < 0 ? 'short' : 'over'} by ${usd(Math.abs(variance))}, outside the ±$100 tolerance.`,
    });
  }

  if (underpowered) {
    out.unshift({
      kind: 'gate', severity: 'low', tone: 'neutral', metric: 'Small sample', z: null, confidence: 'low',
      text: `Only ${pool.length} comparable session${pool.length === 1 ? '' : 's'} in the window `
        + `(${MIN_POOL} needed for a confident call). Anything below is directional, not significant.`,
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Expected range — the passive form of anomaly detection
--------------------------------------------------------------------------- */

export const BAND_WINDOW = 30;
export const BAND_LOOKBACK = 12;

/**
 * For each of the last `window` points, the expected value and 95% range from
 * the `lookback` sessions BEFORE it on the same slot.
 *
 * The v9 mockup used mean ± 1.96σ over 8 points, and invented a ±12% band
 * when history was short. Here the band IS the 2.5th–97.5th percentile of
 * recent history (model.percentile) and the expectation its median — no
 * normality assumed of a series that has jackpot spikes in it — and a point
 * with fewer than MIN_POOL prior sessions gets no band at all.
 *
 * `series`: [{ id, date, value }] oldest first, ending with the target.
 */
export function expectedBand(series, { window = BAND_WINDOW, lookback = BAND_LOOKBACK, min = MIN_POOL } = {}) {
  const startAt = Math.max(0, series.length - window);
  const out = [];
  for (let g = startAt; g < series.length; g += 1) {
    const prior = series.slice(Math.max(0, g - lookback), g)
      .map((s) => s.value).filter((v) => v !== null && Number.isFinite(v));
    const has = prior.length >= min;
    const row = {
      ...series[g],
      n: prior.length,
      expected: has ? median(prior) : null,
      lo: has ? percentile(prior, 0.025) : null,
      hi: has ? percentile(prior, 0.975) : null,
    };
    row.inside = has && row.value !== null ? row.value >= row.lo && row.value <= row.hi : null;
    out.push(row);
  }
  return out;
}

/** The same-slot series ending at (and including) the target, oldest first. */
export function slotSeries(ev, data) {
  const day = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getUTCDay();
  const td = day(ev.event_date);
  return data.events
    .filter((e) => e.location_id === ev.location_id && e.event_type === ev.event_type
      && day(e.event_date) === td && e.event_date <= ev.event_date
      && (e.event_date < ev.event_date || e.id === ev.id))
    .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0))
    .map((e) => {
      const t = sessionTotals(metricsFor(e.id, data.metrics, data.idx), data.categories);
      return { id: e.id, date: e.event_date, value: t.net, attendance: t.attendance, revenue: t.revenue };
    });
}

/* ---------------------------------------------------------------------------
   Performance — SPEC §4.9, SAR 1.0 `updatePerformancePage`
--------------------------------------------------------------------------- */

/** Sum of the values that were recorded; null only when none were. */
export function sumPresent(...vals) {
  const xs = vals.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
}

/** A deduction always displays as a negative, whatever sign it was stored with. */
export const asNegative = (v) => (v === null ? null : (-Math.abs(v) || 0));
const abs0 = (v) => (v === null ? 0 : Math.abs(v));

/**
 * Bingo panel. Keys and formulas exactly as SAR 1.0:
 *
 *   bingoSales     = paper_sales + strips
 *   netBingoSales  = bingoSales + supply_sales − |total_discounts|
 *   bingoPL        = netBingoSales − |bingo_payout|
 *   avg (paper)    = (bingoSales − |discounts|) / attendance
 *   avg (supplies) = (bingoSales + supply_sales − |discounts|) / attendance
 *
 * Missing is not zero: with no paper or strip sales recorded there are no
 * bingo sales to speak of (null); with no `bingo_payout` the P&L is null
 * rather than silently "sales with nothing paid out".
 */
export function bingoPerformance(m) {
  const g = (k) => getMetric(m, k);
  const paper = g('paper_sales');
  const strips = g('strips');
  const supply = g('supply_sales');
  const discounts = g('total_discounts');
  const payout = g('bingo_payout');
  const attendance = g('attendance');
  const bingoSales = sumPresent(paper, strips);
  const netBingoSales = bingoSales === null ? null : bingoSales + (supply ?? 0) - abs0(discounts);
  const pl = netBingoSales === null || payout === null ? null : netBingoSales - Math.abs(payout);
  const per = (v) => (v === null || !(attendance > 0) ? null : v / attendance);
  return {
    paper, strips, supply,
    daubers: g('merchandise_daubers'), tape: g('merchandise_tape'),
    discounts, door10: g('discount_door_10'), door30: g('discount_door_30'),
    points: g('discount_points'), refunds: g('discount_refunds'),
    payout, attendance, bingoSales, netBingoSales, pl,
    showStrips: strips !== null && strips > 0,
    avgPaperOnly: per(bingoSales === null ? null : bingoSales - abs0(discounts)),
    avgWithSupplies: per(netBingoSales),
    recorded: [paper, strips, supply, discounts, payout].some((v) => v !== null),
  };
}

/**
 * Pull-tab panel. SAR 1.0 keys: pulltab_sales, pulltab_payouts, pulltab_net,
 * pulltab_credit_deposit. Cash is derived (sales − credit) and is null when
 * either side is missing; the split bar is not drawn then.
 */
export function pullTabPerformance(m) {
  const g = (k) => getMetric(m, k);
  const sales = g('pulltab_sales');
  const prizes = g('pulltab_payouts');
  const net = g('pulltab_net');
  const credit = g('pulltab_credit_deposit');
  const attendance = g('attendance');
  const cash = sales !== null && credit !== null ? sales - credit : null;
  const per = (v) => (v === null || !(attendance > 0) ? null : v / attendance);
  return {
    sales, prizes, net, credit, cash, attendance,
    yield: sales > 0 && net !== null ? net / sales : null,
    cashShare: cash !== null && sales > 0 ? cash / sales : null,
    creditShare: credit !== null && sales > 0 ? credit / sales : null,
    avgSpend: per(sales),
    avgProfit: per(net),
    recorded: [sales, prizes, net, credit].some((v) => v !== null),
  };
}

/**
 * Pool average of one metric — SAR 1.0 `getPoolAvg`, which divides by the
 * whole pool with a missing value read as zero. Here the mean is over the
 * sessions that recorded it; null when none did.
 */
export function poolAvg(poolMetrics, key, { abs = false } = {}) {
  const xs = poolMetrics.map((m) => getMetric(m, key)).filter((v) => v !== null);
  if (!xs.length) return null;
  return mean(abs ? xs.map(Math.abs) : xs);
}

/**
 * A change badge: blank (null) when the pool average is null or zero, as SAR
 * 1.0's `setChangeBadge` does. Relative change against |avg|.
 */
export function changeBadge(current, avg, { neutral = false } = {}) {
  if (current === null || avg === null || avg === 0 || !Number.isFinite(avg)) return null;
  const rel = (current - avg) / Math.abs(avg);
  const dir = rel > 0 ? 1 : rel < 0 ? -1 : 0;
  return { rel, dir, avg, tone: neutral || dir === 0 ? 'neutral' : (dir > 0 ? 'pos' : 'neg') };
}

/** Profit Center / Loss Center, keyed on the sign. Null when there is no P&L. */
export const centreBadge = (pl) => (pl === null ? null : (pl >= 0 ? 'Profit Center' : 'Loss Center'));

/** $1 — the reconciliation tolerance between the two P&L paths (SPEC §19.5). */
export const RECONCILE_TOLERANCE = 100;

/**
 * Headline net comes from ONE source, the category rollup. SAR 1.0's
 * Performance page computes from canonical keys instead (SPEC §19.5); here
 * the canonical figure (bingo P&L + pull-tab net) is compared, and any gap
 * over $1 is reported rather than left to differ silently.
 */
export function reconcile(categoryNet, bingo, pulltab) {
  const canonical = sumPresent(bingo.pl, pulltab.net);
  if (canonical === null) return { canonical: null, diff: null, agrees: null };
  const diff = canonical - categoryNet;
  return { canonical, diff, agrees: Math.abs(diff) <= RECONCILE_TOLERANCE };
}

/* ---------------------------------------------------------------------------
   Jackpots page — SPEC §4.10, SAR 1.0 `updateJackpotsPage`
--------------------------------------------------------------------------- */

/** SAR 1.0's table status: No Game / Active / Building. */
export function jackpotGameStatus(collected, paid) {
  const c = collected ?? 0;
  const p = paid ?? 0;
  if (c === 0 && p === 0) return 'No Game';
  if (p > 0) return 'Active';
  return 'Building';
}

/**
 * One row per configured jackpot, plus totals. Participation as SAR 1.0:
 * players = (balance − collected) / cost, shown when a cost exists.
 */
export function jackpotTable(m, jackpots = [], attendance = null) {
  const rows = jackpots.map((jp) => {
    const collected = getMetric(m, jp.collectedKey);
    const paid = getMetric(m, jp.paidKey);
    const balance = getMetric(m, jp.balanceKey);
    const cost = (jp.participationCostKey ? getMetric(m, jp.participationCostKey) : null)
      || jp.participationCost || 0;
    const added = (balance ?? 0) - (collected ?? 0);
    const players = cost > 0 && balance !== null ? (added > 0 ? Math.round(added / cost) : 0) : null;
    return {
      jp, name: jp.name, collected, paid, balance,
      net: collected === null && paid === null ? null : (collected ?? 0) - abs0(paid),
      players,
      pctAtt: players !== null && attendance > 0 ? players / attendance : null,
      status: jackpotGameStatus(collected, paid),
    };
  });
  const any = (k) => rows.some((r) => r[k] !== null);
  const total = {
    collected: any('collected') ? sum(rows.map((r) => r.collected)) : null,
    paid: any('paid') ? sum(rows.map((r) => abs0(r.paid))) : null,
    balance: any('balance') ? sum(rows.map((r) => r.balance)) : null,
    players: any('players') ? sum(rows.map((r) => r.players)) : null,
  };
  total.net = total.collected === null && total.paid === null ? null : (total.collected ?? 0) - (total.paid ?? 0);
  total.pctAtt = total.players !== null && attendance > 0 ? total.players / attendance : null;
  return { rows, total, active: rows.filter((r) => r.status !== 'No Game').length };
}

/**
 * Side games — yellow_sheet_in, yellow_sheet_out, concessions_sales.
 * `show` is false when all three are zero or unrecorded (SAR 1.0 hides the
 * section in that case).
 */
export function sideGames(m) {
  const yIn = getMetric(m, 'yellow_sheet_in');
  const yOut = getMetric(m, 'yellow_sheet_out');
  const con = getMetric(m, 'concessions_sales');
  const nz = (v) => v !== null && v !== 0;
  const yellowNet = yIn === null && yOut === null ? null : (yIn ?? 0) - abs0(yOut);
  const totalIn = sumPresent(yIn, con);
  return {
    yellowIn: yIn, yellowOut: yOut, yellowNet, concessions: con,
    totalIn, totalOut: yOut === null ? null : Math.abs(yOut),
    totalNet: totalIn === null && yOut === null ? null : (totalIn ?? 0) - abs0(yOut),
    show: nz(yIn) || nz(yOut) || nz(con),
  };
}

/* ---------------------------------------------------------------------------
   Summary — SPEC §4.11, SAR 1.0 `updateSummaryPage`
--------------------------------------------------------------------------- */

/** Variance thresholds, in cents: |v| > $100 bad, > $25 warn. SPEC §17 */
export const VARIANCE_BAD = 10000;
export const VARIANCE_WARN = 2500;

export function varianceState(v) {
  if (v === null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a > VARIANCE_BAD) return 'bad';
  if (a > VARIANCE_WARN) return 'warn';
  return 'good';
}

/**
 * Cash integrity. Variance is READ from `bingo_variance` / `pulltab_variance`
 * — never recomputed as actual − expected — exactly as SAR 1.0.
 */
export function cashIntegrity(m, jackpots = []) {
  const g = (k) => getMetric(m, k);
  const nz = (v) => v !== null && v !== 0;
  const bingo = {
    startCash: g('bingo_starting_cash'),
    cash: g('bingo_cash_deposit'),
    credit: g('bingo_credit_deposit'),
    expected: g('bingo_expected_deposit'),
    variance: g('bingo_variance'),
  };
  bingo.actual = sumPresent(bingo.cash, bingo.credit);
  const collectedKeys = jackpots.map((j) => j.collectedKey).filter(Boolean);
  const pulltab = {
    startCash: g('pulltab_starting_cash'),
    cashCount: g('pulltab_cash_count'),
    jackpotDeposit: sumPresent(...collectedKeys.map(g)),
    cash: g('pulltab_cash_deposit'),
    credit: g('pulltab_credit_deposit'),
    expected: g('pulltab_expected_deposit'),
    variance: g('pulltab_variance'),
  };
  pulltab.actual = sumPresent(pulltab.cash, pulltab.credit);
  // SAR 1.0's visibility rules, verbatim.
  const hasReconciliation = nz(bingo.startCash) || nz(bingo.expected)
    || nz(pulltab.startCash) || nz(pulltab.expected);
  const hasPTRecon = nz(pulltab.startCash) || nz(pulltab.cashCount) || nz(pulltab.expected);
  const hasBingoRecon = [bingo.startCash, bingo.cash, bingo.credit, bingo.expected, bingo.variance].some(nz);
  const combined = bingo.variance === null && pulltab.variance === null
    ? null : (bingo.variance ?? 0) + (pulltab.variance ?? 0);
  return { bingo, pulltab, hasReconciliation, hasPTRecon, hasBingoRecon, combined };
}

/** Event P&L rows: per category, shown when |net| > $0.50 or |revenue| > $0.50. */
export function eventPL(t) {
  return t.categories.filter((c) => Math.abs(c.net) > 50 || Math.abs(c.revenue) > 50);
}

/**
 * "Bingo as % of Pull Tab Profit". SPEC §19.6: SAR 1.0 hardcodes "loss" in
 * the detail line. Here each side says loss or profit by its own sign. The
 * percentage needs a pull-tab profit to be a share of; otherwise it is null.
 */
export function bingoVsPullTab(bingoPL, ptNet) {
  if (bingoPL === null || ptNet === null) return { pct: null, detail: null, bingoWord: null, ptWord: null };
  const word = (v) => (v < 0 ? 'loss' : 'profit');
  return {
    pct: ptNet > 0 ? Math.abs(bingoPL) / ptNet : null,
    bingoWord: word(bingoPL),
    ptWord: word(ptNet),
    detail: `${usd(Math.abs(bingoPL))} bingo ${word(bingoPL)} / ${usd(Math.abs(ptNet))} pull-tab ${word(ptNet)}`,
  };
}

/* ---------------------------------------------------------------------------
   P&L ladder — gross to net, then the rows this database cannot fill
--------------------------------------------------------------------------- */

/**
 * The same shape as Monthly P&L's ladder: expense rows are present but EMPTY
 * (`value: null`, `missing: true`) — operating expenses are not stored in
 * this database, and a zero would read as "nothing was spent".
 */
export function plLadder(t) {
  return [
    { key: 'gross', label: 'Gross sales', value: t.revenue, kind: 'line' },
    ...t.categories.filter((c) => c.revenue !== 0).map((c) => ({
      key: `cat-${c.key}`, label: c.name, value: c.revenue, kind: 'sub',
      note: t.revenue > 0 ? `${pct(c.revenue / t.revenue)} of gross` : '',
    })),
    { key: 'payouts', label: 'Prize payouts', value: -t.payout || 0, kind: 'line',
      note: t.revenue > 0 ? `${pct(t.payout / t.revenue)} of gross` : '' },
    { key: 'net', label: 'Net sales (contribution)', value: t.net, kind: 'total',
      note: t.margin !== null ? `margin ${pct(t.margin)}` : '' },
    { key: 'expenses', label: 'Operating expenses', value: null, kind: 'missing',
      note: 'not in this database' },
    { key: 'profit', label: 'Session profit', value: null, kind: 'missing',
      note: 'needs expenses' },
  ];
}
