/* ============================================================================
   SAR 2.0 — the model layer

   Every formula in SPEC §16 and every threshold in SPEC §17, in one place.
   No screen computes its own metric. SAR 1.0 has two net-revenue calculations
   that disagree (SPEC §19.5) precisely because that rule did not exist.

   MONEY IS INTEGER CENTS THROUGHOUT.
   `analytics_event_data.value` is cents and stays cents through every
   calculation here. Conversion happens once, at the display boundary, in
   `fmt.js`. SAR 1.0 carries defects from code that converted twice and from
   code that never converted at all — keeping the boundary in one place is the
   fix. Nothing in this file divides by 100.

   RATIOS ARE RETURNED AS FRACTIONS, not percentages. `0.267`, not `26.7`.
   Formatting decides how to show it. A function that returns 26.7 and another
   that returns 0.267 is how a chart ends up 100× off.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   Metric access over EAV
--------------------------------------------------------------------------- */

/**
 * Index metric definitions so values can be looked up by their stable `key`
 * rather than by `metric_id`, which is a per-tenant UUID.
 *
 * `canonical_key` is preferred where present — it is what survives a metric
 * being renamed.
 */
export function indexMetrics(metricDefs = []) {
  const byId = new Map();
  const byKey = new Map();
  for (const m of metricDefs) {
    byId.set(m.id, m);
    byKey.set(m.key, m);
    if (m.canonical_key && !byKey.has(m.canonical_key)) byKey.set(m.canonical_key, m);
  }
  return { byId, byKey, defs: metricDefs };
}

/**
 * One session's metrics as `{ key: value }`, in cents.
 *
 * A metric absent from the payload is absent from the result — **not zero**.
 * The distinction matters: zero is a night where nothing sold, absent is a
 * night nobody recorded. Screens must be able to tell those apart, so
 * `getMetric` returns `null` rather than 0 for a missing key.
 */
export function metricsFor(eventId, metrics, idx) {
  const raw = metrics?.[eventId] ?? {};
  const out = {};
  for (const [metricId, value] of Object.entries(raw)) {
    const def = idx.byId.get(metricId);
    if (def) out[def.key] = value;
  }
  return out;
}

/** Missing returns null, never 0. See above. */
export function getMetric(m, key) {
  const v = m?.[key];
  return v === undefined || v === null ? null : Number(v);
}

/** For summing, where a missing metric legitimately contributes nothing. */
const num = (v) => (v === undefined || v === null ? 0 : Number(v));

/* ---------------------------------------------------------------------------
   Categories — SPEC §16 "Category"
--------------------------------------------------------------------------- */

/**
 * Roll one session up by product category.
 *
 * Payout keys are summed AS SIGNED, exactly as SAR 1.0 and the spreadsheet's
 * TOTAL PAYOUTS cell do. An earlier version took the absolute value on the
 * theory that signs were spreadsheet noise. Verified against production on
 * 1 Oct 2026: the only payout metric that is ever negative is
 * `flash_payout_unclaimed` (178 sessions, $60,389), and it is negative on
 * purpose — an unclaimed prize is money that came back, so it REDUCES
 * payouts. Taking abs() flipped it into an extra payout and understated net
 * by twice the amount, ~$121k over Aug 2025–Sep 2026, and reshuffled the net
 * and margin leaderboards against the oracle.
 */
export function categoryRollup(m, categories = []) {
  return categories.map((c) => {
    const revenue = (c.revenue_keys ?? []).reduce((s, k) => s + num(m[k]), 0);
    const payout  = (c.payout_keys  ?? []).reduce((s, k) => s + num(m[k]), 0);
    const net = revenue - payout;
    return {
      key: c.key,
      name: c.display_name,
      showRpa: c.show_rpa,
      showMargin: c.show_margin,
      revenue,
      payout,
      net,
      /** null when revenue is zero — a margin on nothing is not 0%, it is undefined. */
      margin: revenue > 0 ? net / revenue : null,
    };
  });
}

/* ---------------------------------------------------------------------------
   Core per-session — SPEC §16 "Core per-event"
--------------------------------------------------------------------------- */

export const DEFAULT_MAX_ATTENDANCE = 300;

/**
 * A hall's seat count: `locations.settings.max_attendance` (Santa Clara 430,
 * Redwood City 200 in production), falling back to the flat default. SAR 1.0
 * reads the same setting; a flat 300 put Santa Clara at "102% of capacity".
 */
export function maxAttendanceFor(locationId, locations = []) {
  const loc = locations.find((l) => l.id === locationId);
  const v = Number(loc?.settings?.max_attendance);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_ATTENDANCE;
}

export function sessionTotals(m, categories, { maxAttendance = DEFAULT_MAX_ATTENDANCE } = {}) {
  const cats = categoryRollup(m, categories);
  const revenue = cats.reduce((s, c) => s + c.revenue, 0);
  const payout  = cats.reduce((s, c) => s + c.payout, 0);
  const net = revenue - payout;
  const attendance = getMetric(m, 'attendance');

  return {
    categories: cats,
    revenue,
    payout,
    net,
    attendance,
    /** Gross sales per attendee, in cents. Gross — not net. SPEC §16. */
    rpa: attendance > 0 ? revenue / attendance : null,
    margin: revenue > 0 ? net / revenue : null,
    attendancePct: attendance > 0 ? attendance / maxAttendance : null,
  };
}

/* ---------------------------------------------------------------------------
   Statistics
--------------------------------------------------------------------------- */

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * ONE median definition for the whole product.
 *
 * SPEC §19.7: SAR 1.0 has two, so its box plot disagrees with its own stats
 * table. Even-length arrays average the middle pair.
 */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample standard deviation (n−1). Population SD understates a sample's spread. */
export function stdev(xs) {
  if (xs.length < 2) return null;
  const mu = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1));
}

/** Linear-interpolated percentile, p in 0..1. Matches the P90 jackpot cap. */
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function zScore(value, xs) {
  const sd = stdev(xs);
  if (sd === null || sd === 0) return null;   // no spread: z is undefined, not 0
  return (value - mean(xs)) / sd;
}

/* ---------------------------------------------------------------------------
   Comparison pools — SPEC §4.2
--------------------------------------------------------------------------- */

/** Below this a pool is not reported. Six is the documented floor. */
export const MIN_POOL = 6;

/**
 * Default comparison window, in days.
 *
 * NOT optional, and the reason matters. Measured on real data: Redwood City
 * Thursday gross averaged $46,796 in 2024, $59,401 in 2025 and $82,002 in
 * 2026 — the business grew about 75% in two years.
 *
 * Against the all-time mean of $64,723 a recent $80,632 night reads +24.9%.
 * Against the trailing 90 days ($89,942) the same night is **-10%**. The
 * first number is arithmetically correct and tells you the opposite of the
 * truth: it is measuring growth, not this session.
 *
 * Every session card on the first build of U8 showed a positive delta. Six
 * consecutive above-average nights is not plausible, and that implausibility
 * is what exposed it.
 *
 * 90 days keeps pools above MIN_POOL for both halls: RWC Thursdays yield 12,
 * which matches SAR 1.0's "Pool: 12" exactly.
 */
export const DEFAULT_WINDOW_DAYS = 90;

/**
 * Sessions comparable to a given one: **same location, same weekday, same
 * session type**, within an optional window, excluding the session itself.
 *
 * Weekday and type both matter. A Friday late session compared against a
 * Tuesday regular is not a comparison, and mixing them is what makes a normal
 * night look like an outlier.
 *
 * Options added for Session detail's pool controls (SPEC §4.2). Every one
 * defaults to the original behaviour, so existing callers are unaffected:
 *
 *  · `dayOnly` (default true) — false keeps the same hall but any weekday and
 *    any session type, as SAR 1.0's "Day Only" checkbox does when cleared.
 *  · `jackpotFilter` — 'none' (default) | 'category' | '10%' | '20%', matched
 *    on `balanceOf(event)` in cents. SAR 1.0 reads the FIRST configured
 *    jackpot's balance (`hotballTotal`) and treats a missing one as zero; so
 *    does this. See `jackpotMatches`.
 *  · `strict` (default false) — SAR 1.0's window is `start ≤ date < target`.
 *    The original rule here kept `date ≤ target`, which only differs when
 *    another session at the same hall falls on the same date — possible once
 *    `dayOnly` is off (a regular and a late on one day). Strict also applies
 *    the upper bound when there is no window, so a pool never contains a
 *    session that had not happened yet.
 */
export function comparisonPool(target, all, {
  windowDays = DEFAULT_WINDOW_DAYS, now = null,
  dayOnly = true, jackpotFilter = 'none', balanceOf = null, strict = false,
} = {}) {
  const day = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getUTCDay();
  const targetDay = day(target.event_date);
  // Anchored on the TARGET's date, not on today: comparing a session from
  // last year against the last 90 days would measure it against nights that
  // had not happened yet.
  const anchor = new Date(`${String(now ?? target.event_date).slice(0, 10)}T00:00:00Z`);
  const cutoff = windowDays ? new Date(anchor.getTime() - windowDays * 86400000) : null;
  const filterJp = jackpotFilter && jackpotFilter !== 'none';
  const bal = (e) => (balanceOf ? (balanceOf(e) ?? 0) : 0);
  const targetBal = filterJp ? bal(target) : 0;

  return all.filter((e) => {
    if (e.id === target.id || e.location_id !== target.location_id) return false;
    if (dayOnly && (e.event_type !== target.event_type || day(e.event_date) !== targetDay)) return false;
    const d = new Date(`${String(e.event_date).slice(0, 10)}T00:00:00Z`);
    if (strict) {
      if (!(d < anchor)) return false;
      if (cutoff && d < cutoff) return false;
    } else if (cutoff && !(d >= cutoff && d <= anchor)) return false;
    if (filterJp && !jackpotMatches(jackpotFilter, targetBal, bal(e))) return false;
    return true;
  });
}

/** SPEC §4.2 / §17 jackpot pool bands, in cents: under $5,000 · under $10,000 · above. */
export const JACKPOT_BANDS = Object.freeze([500000, 1000000]);

/** 'low' | 'mid' | 'high' — SAR 1.0 calls the same three bands green / yellow / red. */
export function jackpotBucket(cents) {
  const v = Number(cents) || 0;
  if (v < JACKPOT_BANDS[0]) return 'low';
  if (v < JACKPOT_BANDS[1]) return 'mid';
  return 'high';
}

/**
 * Does a candidate's jackpot balance match the target's under a filter?
 * Exactly SAR 1.0's rules: same band, or |candidate − target| ≤ target × 10%
 * (or 20%). A target of zero therefore only matches other zeros under 10/20%.
 */
export function jackpotMatches(filter, target, candidate) {
  const t = Number(target) || 0;
  const c = Number(candidate) || 0;
  switch (filter) {
    case 'category': return jackpotBucket(t) === jackpotBucket(c);
    case '10%': case '10': return Math.abs(c - t) <= t * 0.1;
    case '20%': case '20': return Math.abs(c - t) <= t * 0.2;
    default: return true;
  }
}

/**
 * Where a session sits against its pool.
 *
 * Returns `{ enough: false }` below MIN_POOL rather than a confident-looking
 * number from four samples.
 */
export function standing(value, poolValues) {
  const xs = poolValues.filter((v) => v !== null && Number.isFinite(v));
  if (xs.length < MIN_POOL) return { enough: false, n: xs.length };
  const sorted = [...xs].sort((a, b) => a - b);
  const below = sorted.filter((v) => v < value).length;
  return {
    enough: true,
    n: xs.length,
    mean: mean(xs),
    median: median(xs),
    z: zScore(value, xs),
    percentile: below / xs.length,
    delta: value - mean(xs),
  };
}

/* ---------------------------------------------------------------------------
   Jackpots — SPEC §16, §3.2a
--------------------------------------------------------------------------- */

/**
 * Jackpot rules, reconciled against SAR 1.0's implementation rather than
 * inferred. Reading its source settled three things I had wrong:
 *
 *  1. The "Max" it displays ($19,365) is the LARGEST PAYOUT EVER, not the
 *     fill cap. My cap of $12k was never in disagreement with it — I was
 *     comparing against the wrong figure.
 *  2. The P90 cap is ROUNDED UP to a readable step.
 *  3. For an org-wide pot, balances are DEDUPED BY DATE, because the same
 *     shared balance is recorded on both halls' events. Payouts are not
 *     deduped — a hit happens at one hall only.
 *
 * SPEC §19.14 warned that `*_hit` flags were never set. That was the demo
 * database. SAR 1.0 shows "Since hit: 12" against production, so hits ARE
 * detectable here — via payout, not a flag.
 */

/** Round a cap up to a readable step. SAR 1.0 works in dollars; this is cents. */
function roundCap(cents) {
  const dollars = cents / 100;
  const step = dollars >= 1000 ? 100 : dollars >= 100 ? 10 : 1;
  return Math.ceil(dollars / step) * step * 100;
}

/**
 * Display cap: P90 of historical payouts, or of balances when fewer than
 * three payouts exist, rounded up.
 *
 * Without a cap, one enormous historic win flattens every later reading to a
 * sliver.
 */
export function jackpotCap(payouts = [], balances = [], { fallback = null } = {}) {
  const paid = payouts.filter((v) => v > 0);
  const basis = paid.length >= 3 ? paid : balances.filter((v) => v > 0);
  if (!basis.length) return fallback;
  return roundCap(percentile(basis, 0.9));
}

/** The largest payout ever seen — what SAR 1.0 labels "Max". Not the cap. */
export function jackpotMaxPayout(payouts = []) {
  const paid = payouts.map(Math.abs).filter((v) => v > 0);
  return paid.length ? Math.max(...paid) : null;
}

/**
 * Gather one jackpot's history with the right scoping.
 *
 * `org_wide` means a single pot shared across halls, so every hall's event
 * carries the same balance. Counting both would double-weight every balance
 * and drag the P90 sideways. Deduped by date, exactly as SAR 1.0 does.
 */
export function jackpotHistory(events, metricsOf, jp) {
  const payouts = [];
  const balances = [];
  const seenDates = new Set();
  const orgWide = jp.scope === 'org_wide';

  for (const e of events) {
    const m = metricsOf(e);
    const payout = Math.abs(getMetric(m, jp.paidKey) ?? 0);
    const balance = getMetric(m, jp.balanceKey) ?? 0;
    if (payout > 0) payouts.push(payout);
    if (balance > 0) {
      if (orgWide) {
        if (seenDates.has(e.event_date)) continue;
        seenDates.add(e.event_date);
      }
      balances.push(balance);
    }
  }
  return { payouts, balances };
}

/** Fill fraction, floored at 5% so an empty pot is still visible. */
export function jackpotFill(balance, cap) {
  if (!cap || cap <= 0) return null;
  return Math.max(0.05, Math.min(1, balance / cap));
}

/**
 * Status bands. SPEC §19.4 records that SAR 1.0 uses three different
 * threshold sets for the same ratio in three places. **One set here**, the
 * one its thermometer actually draws.
 */
export function jackpotStatus(fill) {
  if (fill === null) return null;
  if (fill < 0.33) return 'LOW';
  if (fill < 0.66) return 'BUILDING';
  if (fill < 0.90) return 'HIGH';
  return 'HOT';
}

/**
 * Was this session a hit?
 *
 * A payout alone is not enough: at jackpot startup a payout can appear before
 * any pot has accumulated. SAR 1.0 guards against that by requiring some
 * earlier session to have carried a balance, and this does the same.
 */
export function wasHit(m, priorHadBalance, jp) {
  const payout = getMetric(m, jp.paidKey) ?? 0;
  return payout > 0 && priorHadBalance;
}

/**
 * Sessions since the last hit, and the last payout amount.
 *
 * `history` ends with the session being viewed. `since` counts the sessions
 * STRICTLY BETWEEN the hit and that session, which is what SAR 1.0's
 * "Since hit" shows (verified 1 Oct 2026: RWC 30 Sep read 2 in SAR 1.0 while
 * an inclusive count read 3). So: hit this session → 0; hit last session → 0;
 * hit two sessions ago → 1. `null` means never hit.
 */
export function sinceLastHit(history) {
  let since = null;
  let lastPayout = null;
  let seenBalance = false;
  let count = 0;

  for (const row of history) {
    const payout = Math.abs(row.payout ?? 0);
    if (payout > 0 && seenBalance) { since = 0; lastPayout = payout; count = 0; }
    else if (since !== null) { since = count++; }
    if ((row.balance ?? 0) > 0) seenBalance = true;
  }
  return { since, lastPayout };
}

/**
 * Estimated players, from money added divided by the cost of one entry.
 *
 * added = balance - collected. Both the metric and the config fallback are in
 * cents, confirmed by measurement: `hotball_participation_cost` reads 500 in
 * EAV and `participationCost` is 500 in config.
 */
export function jackpotParticipation(m, jp, attendance) {
  const balance = getMetric(m, jp.balanceKey) ?? 0;
  const collected = getMetric(m, jp.collectedKey) ?? 0;
  const cost = (jp.participationCostKey ? getMetric(m, jp.participationCostKey) : null)
    || jp.participationCost || 0;
  const added = balance - collected;
  if (cost <= 0 || added <= 0) return { players: null, pctOfAttendance: null };
  const players = Math.round(added / cost);
  return {
    players,
    pctOfAttendance: attendance > 0 ? players / attendance : null,
  };
}

/* ---------------------------------------------------------------------------
   Commission — SPEC §16
--------------------------------------------------------------------------- */

/**
 * pool = max(0, (rpa − target) × attendance × rate)
 *
 * `rpa` is GROSS sales per attendee. Floored at zero: a session below target
 * pays nothing, it does not claw back.
 *
 * `targetRpa` comes from `sched_rpa_defaults` in Ops — see join.rpaPartFor(),
 * and note Redwood City files its targets under 'PM' despite a blank part.
 */
export function commissionPool({ rpa, targetRpa, attendance, rate }) {
  if (![rpa, targetRpa, attendance, rate].every((v) => v !== null && Number.isFinite(v))) return null;
  return Math.max(0, (rpa - targetRpa) * attendance * rate);
}

/** Share-weighted split. Default one share each. */
export function commissionSplit(pool, shares = []) {
  const total = shares.reduce((s, x) => s + (x.shares ?? 1), 0);
  if (!total || pool === null) return [];
  return shares.map((x) => ({ ...x, payout: pool * ((x.shares ?? 1) / total) }));
}

/* ---------------------------------------------------------------------------
   Deltas — SPEC §16
--------------------------------------------------------------------------- */

/**
 * Change against a baseline.
 *
 * `invert` marks metrics where up is bad — a rising payout ratio is not good
 * news. SPEC §19: the v9 mockup showed a worsening payout ratio in green
 * because this flag did not exist.
 *
 * `dir` (which way it moved) is separate from `tone` (whether that is good).
 * Collapsing them is how a badge ends up contradicting the sentence beside it.
 */
export function delta(value, baseline, { invert = false } = {}) {
  if (value === null || baseline === null || !Number.isFinite(value) || !Number.isFinite(baseline)) {
    return { absolute: null, relative: null, dir: 0, tone: 'neutral' };
  }
  const absolute = value - baseline;
  const dir = absolute === 0 ? 0 : (absolute > 0 ? 1 : -1);
  const good = invert ? dir < 0 : dir > 0;
  return {
    absolute,
    relative: baseline === 0 ? null : absolute / Math.abs(baseline),
    dir,
    tone: dir === 0 ? 'neutral' : (good ? 'pos' : 'neg'),
  };
}

/* ---------------------------------------------------------------------------
   Cohort comparison — SPEC §7
--------------------------------------------------------------------------- */

/** Regularised incomplete beta, for the t-distribution tail. */
function betacf(a, b, x) {
  const FPMIN = 1e-30;
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}

function gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Welch's t-test — unequal variances, which is the honest default for two
 * groups of sessions that were never designed to be balanced.
 *
 * Returns null rather than a number when either group is too small to say
 * anything. A p-value from three sessions is theatre.
 */
export function welchT(a, b, { min = 3 } = {}) {
  const A = a.filter(Number.isFinite);
  const B = b.filter(Number.isFinite);
  if (A.length < min || B.length < min) {
    return { enough: false, nA: A.length, nB: B.length };
  }
  const mA = mean(A), mB = mean(B);
  const vA = stdev(A) ** 2, vB = stdev(B) ** 2;
  const se = Math.sqrt(vA / A.length + vB / B.length);
  if (!se) return { enough: false, nA: A.length, nB: B.length, reason: 'no variance' };

  const t = (mA - mB) / se;
  // Welch–Satterthwaite degrees of freedom.
  const df = (vA / A.length + vB / B.length) ** 2
    / ((vA / A.length) ** 2 / (A.length - 1) + (vB / B.length) ** 2 / (B.length - 1));
  const p = betai(df / 2, 0.5, df / (df + t * t));

  // Cohen's d with pooled SD.
  const pooled = Math.sqrt(((A.length - 1) * vA + (B.length - 1) * vB)
    / (A.length + B.length - 2));
  const d = pooled ? (mA - mB) / pooled : null;

  return {
    enough: true, nA: A.length, nB: B.length,
    meanA: mA, meanB: mB, diff: mA - mB,
    relative: mB === 0 ? null : (mA - mB) / Math.abs(mB),
    t, df, p, cohensD: d,
  };
}

/** SPEC §17 bands. Reported as words so the reader is not left to judge 0.043. */
export function effectSize(d) {
  if (d === null || !Number.isFinite(d)) return null;
  const a = Math.abs(d);
  if (a < 0.2) return 'negligible';
  if (a < 0.5) return 'small';
  if (a < 0.8) return 'medium';
  return 'large';
}

export function significance(p) {
  if (p === null || !Number.isFinite(p)) return null;
  if (p < 0.001) return 'very strong';
  if (p < 0.01) return 'strong';
  if (p < 0.05) return 'moderate';
  if (p < 0.10) return 'weak';
  return 'none';
}

/* ---------------------------------------------------------------------------
   Projection — SPEC §8.3
--------------------------------------------------------------------------- */

/**
 * Project a partial month to a full one.
 *
 * NOT by simple extrapolation of elapsed days. Sessions are not evenly spread
 * — a hall running Saturdays earns far more per calendar day in a week
 * containing one. The projection adds the sessions the schedule says are still
 * to come, each valued at its own weekday-and-type average.
 *
 * `expectedSchedules` comes from `analytics_config.settings`.
 */
export function projectMonth({ month, actual, sessionsSoFar, expected, averages }) {
  const remaining = Math.max(0, expected - sessionsSoFar);
  if (!remaining) return { projected: actual, remaining: 0, basis: 'complete' };
  const perSession = averages.length ? mean(averages) : null;
  if (perSession === null) return { projected: null, remaining, basis: 'no history' };
  return {
    projected: actual + remaining * perSession,
    remaining,
    perSession,
    basis: `${sessionsSoFar} recorded + ${remaining} expected`,
  };
}
