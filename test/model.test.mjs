/* ============================================================================
   Tests for lib/model.js

   The session fixture is REAL: Redwood City, 6 August 2026, read out of
   production. Expected values were computed by hand from those figures before
   the code was run, so a passing test means the code agrees with arithmetic —
   not that it agrees with itself.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexMetrics, metricsFor, getMetric, categoryRollup, sessionTotals,
  mean, median, stdev, percentile, zScore,
  comparisonPool, standing, MIN_POOL,
  jackpotCap, jackpotFill, jackpotMaxPayout, jackpotHistory,
  jackpotStatus, sinceLastHit, jackpotParticipation, wasHit,
  commissionPool, commissionSplit, delta,
} from '../src/lib/model.js';

/* ---- real production category structure --------------------------------- */
const CATEGORIES = [
  { key: 'flash',    display_name: 'Flash',    show_rpa: true,  show_margin: true,
    revenue_keys: ['flash'],
    payout_keys:  ['flash_payout', 'flash_payout_unclaimed', 'special_game_5'] },
  { key: 'strip',    display_name: 'Strip',    show_rpa: true,  show_margin: true,
    revenue_keys: ['strips'],
    payout_keys:  ['gremlin_hotball', 'hotball_payout_line', 'numbers_payout', 'strips_payout'] },
  { key: 'paper',    display_name: 'Paper',    show_rpa: false, show_margin: true,
    revenue_keys: ['paper'],
    payout_keys:  ['flash_bonus_paper', 'paper_payout', 'payout_double_action',
                   'payout_rwb', 'payout_winnemucca', 'vanguard_derby'] },
  { key: 'cherries', display_name: 'Cherries', show_rpa: true,  show_margin: true,
    revenue_keys: ['cherries'], payout_keys: ['special_game_1', 'special_game_2'] },
  { key: 'other',    display_name: 'Other',    show_rpa: false, show_margin: false,
    revenue_keys: ['bday_redeemed', 'merch'],
    payout_keys:  ['refund_other', 'special_game_3'] },
];

/* Redwood City, 2026-08-06, exactly as stored — cents. */
const M = {
  attendance: 191,
  flash: 3322900, strips: 5049500, paper: 811500, cherries: 0, merch: 7600, bday_redeemed: 0,
  flash_payout: 1594400, flash_payout_unclaimed: 0, special_game_5: 717800,
  gremlin_hotball: 0, hotball_payout_line: 0, numbers_payout: 30000, strips_payout: 3904300,
  flash_bonus_paper: 100000, paper_payout: 0, payout_double_action: 200000,
  payout_rwb: 50000, payout_winnemucca: 0, vanguard_derby: 120000,
  special_game_1: 0, special_game_2: 0, refund_other: 20400, special_game_3: 0,
};

/* ---- metric access ------------------------------------------------------- */

test('EAV values are resolved by key, not by metric_id', () => {
  const idx = indexMetrics([
    { id: 'u1', key: 'flash', canonical_key: 'flash' },
    { id: 'u2', key: 'strips', canonical_key: 'strips' },
  ]);
  const got = metricsFor('e1', { e1: { u1: 3322900, u2: 5049500 } }, idx);
  assert.deepEqual(got, { flash: 3322900, strips: 5049500 });
});

test('a missing metric is null, not zero', () => {
  // Zero is "nothing sold". Null is "nobody recorded it". A screen must be
  // able to show "not recorded" rather than a confident $0.
  assert.equal(getMetric(M, 'flash'), 3322900);
  assert.equal(getMetric(M, 'never_recorded'), null);
  assert.equal(getMetric(M, 'cherries'), 0);
});

/* ---- category rollup, hand-checked --------------------------------------- */

test('category revenue, payout and net match hand arithmetic', () => {
  const c = Object.fromEntries(categoryRollup(M, CATEGORIES).map((x) => [x.key, x]));

  assert.equal(c.flash.revenue, 3322900);
  assert.equal(c.flash.payout, 1594400 + 0 + 717800);       // 2312200
  assert.equal(c.flash.net, 1010700);

  assert.equal(c.strip.payout, 0 + 0 + 30000 + 3904300);    // 3934300
  assert.equal(c.strip.net, 1115200);

  assert.equal(c.paper.payout, 100000 + 0 + 200000 + 50000 + 0 + 120000); // 470000
  assert.equal(c.paper.net, 341500);

  assert.equal(c.other.revenue, 7600);
  assert.equal(c.other.payout, 20400);
  assert.equal(c.other.net, -12800);                        // negative is legitimate
});

test('ORACLE: a negative payout line is a credit and raises net, as SAR 1.0 and the sheet do', () => {
  // Verified against production 1 Oct 2026: `flash_payout_unclaimed` is the
  // only payout key ever stored negative, and it means an unclaimed prize
  // came back. SAR 1.0 and the spreadsheet TOTAL PAYOUTS sum it as signed.
  // An abs() here understated net by 2x the amount on 178 sessions.
  const credited = { ...M, flash_payout_unclaimed: -25000 };
  const base = Object.fromEntries(categoryRollup(M, CATEGORIES).map((x) => [x.key, x]));
  const c = Object.fromEntries(categoryRollup(credited, CATEGORIES).map((x) => [x.key, x]));
  assert.equal(c.flash.payout, base.flash.payout - 25000);
  assert.equal(c.flash.net, base.flash.net + 25000);
});

test('margin on zero revenue is null, not zero', () => {
  const c = Object.fromEntries(categoryRollup(M, CATEGORIES).map((x) => [x.key, x]));
  assert.equal(c.cherries.revenue, 0);
  assert.equal(c.cherries.margin, null);
});

/* ---- session totals, hand-checked ---------------------------------------- */

test('session totals match hand arithmetic', () => {
  const t = sessionTotals(M, CATEGORIES);
  assert.equal(t.revenue, 9191500);   // 3322900+5049500+811500+0+7600+0
  assert.equal(t.payout,  6736900);   // 2312200+3934300+470000+0+20400
  assert.equal(t.net,     2454600);
  assert.equal(t.attendance, 191);
});

test('category nets sum to the session net', () => {
  // If these ever disagree, a category is double-counted or orphaned.
  const t = sessionTotals(M, CATEGORIES);
  assert.equal(t.categories.reduce((s, c) => s + c.net, 0), t.net);
});

test('RPA is gross sales per attendee, in cents', () => {
  const t = sessionTotals(M, CATEGORIES);
  assert.equal(Math.round(t.rpa), 48123);          // 9191500 / 191 -> $481.23
});

test('margin is a fraction, never a percentage', () => {
  // A function returning 26.7 next to one returning 0.267 is how a chart ends
  // up 100x off.
  const t = sessionTotals(M, CATEGORIES);
  assert.ok(t.margin > 0.26 && t.margin < 0.27, `margin was ${t.margin}`);
  // 2,454,600 / 9,191,500 = 0.2670510798 -> 26.71%.
  // This assertion originally read 26.7, from a hand-rounding slip while
  // writing the fixture. The code was right and the expected value was wrong,
  // which is the whole reason expected values are computed independently.
  assert.equal(Math.round(t.margin * 10000) / 100, 26.71);
});

test('attendance percentage uses the documented 300 default', () => {
  assert.equal(sessionTotals(M, CATEGORIES).attendancePct, 191 / 300);
  assert.equal(sessionTotals(M, CATEGORIES, { maxAttendance: 200 }).attendancePct, 191 / 200);
});

test('a session with no attendance yields null RPA, not Infinity', () => {
  const t = sessionTotals({ ...M, attendance: 0 }, CATEGORIES);
  assert.equal(t.rpa, null);
  assert.equal(t.attendancePct, null);
});

/* ---- statistics ---------------------------------------------------------- */

test('one median definition, and it averages the middle pair', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);   // SPEC §19.7
  assert.equal(median([]), null);
});

test('standard deviation is the sample form', () => {
  // [2,4,4,4,5,5,7,9]: population 2, sample sqrt(32/7) = 2.138...
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13809) < 0.0001);
  assert.equal(stdev([5]), null);
});

test('percentile interpolates', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10, 20], 0.9), 19);
  assert.equal(percentile([7], 0.9), 7);
});

test('z of a flat series is null, not zero', () => {
  assert.equal(zScore(5, [5, 5, 5]), null);
});

/* ---- comparison pools ---------------------------------------------------- */

const ev = (id, date, type = 'regular', loc = 'L1') =>
  ({ id, event_date: date, event_type: type, location_id: loc });

test('pool is same location, same weekday, same session type', () => {
  const target = ev('t', '2026-08-06');                 // Thursday
  const all = [
    target,
    ev('a', '2026-07-30'),                              // Thursday, same type
    ev('b', '2026-07-23'),                              // Thursday, same type
    ev('c', '2026-07-31'),                              // Friday — excluded
    ev('d', '2026-07-30', 'late'),                      // late — excluded
    ev('e', '2026-07-30', 'regular', 'L2'),             // other hall — excluded
  ];
  const pool = comparisonPool(target, all);
  assert.deepEqual(pool.map((x) => x.id).sort(), ['a', 'b']);
});

test('the target is never in its own pool', () => {
  const target = ev('t', '2026-08-06');
  assert.equal(comparisonPool(target, [target]).length, 0);
});

test('a window excludes sessions older than it', () => {
  const target = ev('t', '2026-08-06');
  const all = [target, ev('a', '2026-07-30'), ev('old', '2026-01-01')];
  assert.deepEqual(comparisonPool(target, all, { windowDays: 30 }).map((x) => x.id), ['a']);
});

test('standing refuses to report below the minimum pool size', () => {
  const small = Array.from({ length: MIN_POOL - 1 }, (_, i) => i);
  assert.equal(standing(3, small).enough, false);
  assert.equal(standing(3, small).n, MIN_POOL - 1);
});

test('standing reports position once the pool is big enough', () => {
  const s = standing(10, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(s.enough, true);
  assert.equal(s.median, 8);
  assert.equal(s.mean, 8);
  assert.ok(Math.abs(s.percentile - 4 / 7) < 1e-9);   // 2,4,6,8 are below 10
});

test('nulls in a pool are ignored rather than counted as zero', () => {
  const s = standing(10, [2, null, 4, 6, 8, null, 10, 12, 14]);
  assert.equal(s.n, 7);
});

/* ---- jackpots, reconciled against SAR 1.0 -------------------------------- */

const HOTBALL = { name: 'Hotball', scope: 'per_location',
  balanceKey: 'hotball_total', collectedKey: 'hotball_carryover',
  paidKey: 'hotball_payout', participationCostKey: 'hotball_participation_cost',
  participationCost: 500 };
const MEGA = { ...HOTBALL, name: 'Mega Hotball', scope: 'org_wide',
  balanceKey: 'mega_hotball_total', collectedKey: 'mega_hotball_carryover',
  paidKey: 'mega_hotball_payout', participationCost: 1000 };

test('cap rounds up to a readable step, as SAR 1.0 does', () => {
  // P90 of these is 1,936,500 cents = $19,365 -> step 100 -> $19,400.
  const payouts = [100000, 500000, 900000, 1500000, 2000000];
  const cap = jackpotCap(payouts, []);
  assert.equal(cap % 10000, 0, 'should land on a $100 step');
  assert.ok(cap >= percentile(payouts, 0.9));
});

test('"Max" is the largest payout, and is NOT the cap', () => {
  // The distinction that made $19,365 look like a disagreement with $12k.
  const payouts = [100000, 3518000, 250000];
  assert.equal(jackpotMaxPayout(payouts), 3518000);
  assert.notEqual(jackpotCap(payouts, []), jackpotMaxPayout(payouts));
});

test('cap falls back to balances with fewer than three payouts', () => {
  const cap = jackpotCap([500000], [100000, 200000, 300000]);
  assert.ok(cap >= percentile([100000, 200000, 300000], 0.9));
});

test('cap returns the supplied fallback when there is no history', () => {
  assert.equal(jackpotCap([], [], { fallback: 500000 }), 500000);
  assert.equal(jackpotCap([], []), null);
});

test('an org-wide pot dedupes balances by date but not payouts', () => {
  // The same shared balance is recorded on BOTH halls' events. Counting both
  // double-weights every balance and drags the P90 sideways.
  const events = [
    { id: 'a', event_date: '2026-08-01', location_id: 'L1' },
    { id: 'b', event_date: '2026-08-01', location_id: 'L2' },
  ];
  const metrics = {
    a: { mega_hotball_total: 500000, mega_hotball_payout: 0 },
    b: { mega_hotball_total: 500000, mega_hotball_payout: 120000 },
  };
  const hist = jackpotHistory(events, (e) => metrics[e.id], MEGA);
  assert.equal(hist.balances.length, 1, 'balance counted once for the date');
  assert.equal(hist.payouts.length, 1, 'the single payout is kept');
});

test('an org-wide payout recorded at both halls counts once', () => {
  const events = [
    { id: 'a', event_date: '2026-08-01', location_id: 'L1' },
    { id: 'b', event_date: '2026-08-01', location_id: 'L2' },
  ];
  const metrics = {
    a: { mega_hotball_total: 500000, mega_hotball_payout: 120000 },
    b: { mega_hotball_total: 500000, mega_hotball_payout: 120000 },
  };
  assert.deepEqual(jackpotHistory(events, (e) => metrics[e.id], MEGA).payouts, [120000]);
});

test('a per-location pot does not dedupe', () => {
  const events = [
    { id: 'a', event_date: '2026-08-01', location_id: 'L1' },
    { id: 'b', event_date: '2026-08-01', location_id: 'L2' },
  ];
  const metrics = { a: { hotball_total: 100000 }, b: { hotball_total: 200000 } };
  const hist = jackpotHistory(events, (e) => metrics[e.id], HOTBALL);
  assert.equal(hist.balances.length, 2);
});

test('fill is floored at 5% and capped at 1', () => {
  assert.equal(jackpotFill(0, 1000), 0.05);
  assert.equal(jackpotFill(5000, 1000), 1);
  assert.equal(jackpotFill(500, 1000), 0.5);
});

test('status uses ONE threshold set', () => {
  // SPEC §19.4: SAR 1.0 bands the same ratio three different ways.
  assert.equal(jackpotStatus(0.10), 'LOW');
  assert.equal(jackpotStatus(0.50), 'BUILDING');
  assert.equal(jackpotStatus(0.70), 'HIGH');
  assert.equal(jackpotStatus(0.95), 'HOT');
  assert.equal(jackpotStatus(1), 'HOT');
});

test('a payout before any pot existed is not a hit', () => {
  // Jackpot startup can record a payout before anything accumulated.
  assert.equal(wasHit({ hotball_payout: 50000 }, false, HOTBALL), false);
  assert.equal(wasHit({ hotball_payout: 50000 }, true, HOTBALL), true);
  assert.equal(wasHit({ hotball_payout: 0 }, true, HOTBALL), false);
});

test('sessions since the last hit, and the last payout', () => {
  const history = [
    { balance: 100000, payout: 0 },
    { balance: 200000, payout: 0 },
    { balance: 300000, payout: 81500 },   // the hit
    { balance: 20000,  payout: 0 },
    { balance: 40000,  payout: 0 },
  ];
  // Two sessions came after the hit; the last row IS the session being
  // viewed, so one session sits strictly between — SAR 1.0's "Since hit: 1".
  const r = sinceLastHit(history);
  assert.equal(r.since, 1);
  assert.equal(r.lastPayout, 81500);
  assert.equal(sinceLastHit(history.slice(0, 4)).since, 0, 'hit was the previous session');
  assert.equal(sinceLastHit(history.slice(0, 3)).since, 0, 'hit this session');
});

test('never hit yields null, which is not the same as zero', () => {
  // Zero would mean "hit this session".
  const r = sinceLastHit([{ balance: 100000, payout: 0 }, { balance: 200000, payout: 0 }]);
  assert.equal(r.since, null);
  assert.equal(r.lastPayout, null);
});

test('participation is money added divided by the cost of one entry', () => {
  // balance 300000 - collected 221000 = 79000 added, at 500 a go = 158 players.
  // These are the real figures behind SAR 1.0 showing "158 (93%)".
  const m = { hotball_total: 300000, hotball_carryover: 221000, hotball_participation_cost: 500 };
  const p = jackpotParticipation(m, HOTBALL, 169);
  assert.equal(p.players, 158);
  assert.equal(Math.round(p.pctOfAttendance * 100), 93);
});

test('participation is null, not zero, when nothing was added', () => {
  const m = { hotball_total: 100000, hotball_carryover: 100000 };
  assert.equal(jackpotParticipation(m, HOTBALL, 169).players, null);
});

/* ---- commission ---------------------------------------------------------- */

test('pool follows the scheduler formula', () => {
  // (500 - 450) * 200 * 0.1 = 1000
  assert.equal(commissionPool({ rpa: 500, targetRpa: 450, attendance: 200, rate: 0.1 }), 1000);
});

test('a session below target pays nothing rather than clawing back', () => {
  assert.equal(commissionPool({ rpa: 400, targetRpa: 450, attendance: 200, rate: 0.1 }), 0);
});

test('a missing target yields null, not a pool computed from zero', () => {
  assert.equal(commissionPool({ rpa: 500, targetRpa: null, attendance: 200, rate: 0.1 }), null);
});

test('split is share-weighted and defaults to one share each', () => {
  const s = commissionSplit(900, [{ id: 'a' }, { id: 'b', shares: 2 }]);
  assert.equal(s[0].payout, 300);
  assert.equal(s[1].payout, 600);
});

/* ---- deltas -------------------------------------------------------------- */

test('direction and tone are separate', () => {
  const up = delta(110, 100);
  assert.equal(up.dir, 1);
  assert.equal(up.tone, 'pos');
  assert.equal(up.relative, 0.1);
});

test('invert marks a rise as bad without changing the direction', () => {
  // A rising payout ratio moved UP and that is BAD. The v9 mockup showed it
  // green because these were the same field.
  const worse = delta(0.55, 0.50, { invert: true });
  assert.equal(worse.dir, 1);
  assert.equal(worse.tone, 'neg');
});

test('a zero baseline gives null relative rather than Infinity', () => {
  assert.equal(delta(50, 0).relative, null);
  assert.equal(delta(50, 0).dir, 1);
});

test('a missing value is neutral, not a 100% drop', () => {
  assert.equal(delta(null, 100).tone, 'neutral');
  assert.equal(delta(null, 100).dir, 0);
});

/* ---- the comparison window ---------------------------------------------- */

test('comparison defaults to a trailing window, not all history', async () => {
  const { DEFAULT_WINDOW_DAYS } = await import('../src/lib/model.js');
  assert.equal(DEFAULT_WINDOW_DAYS, 90);

  const target = ev('t', '2026-08-13');                 // Thursday
  const all = [
    target,
    ev('recent', '2026-08-06'),
    ev('ancient', '2024-09-05'),                        // Thursday, ~2 years back
  ];
  // Growth of ~75% over two years means an all-time mean measures the trend,
  // not the session. Default must exclude the old one.
  assert.deepEqual(comparisonPool(target, all).map((x) => x.id), ['recent']);
  assert.equal(comparisonPool(target, all, { windowDays: null }).length, 2);
});

test('the window is anchored on the target, not on today', () => {
  // Comparing a session from last year against the last 90 days would measure
  // it against nights that had not happened yet.
  const target = ev('old', '2025-03-06');
  const all = [target, ev('near', '2025-02-27'), ev('future', '2026-08-06')];
  assert.deepEqual(comparisonPool(target, all).map((x) => x.id), ['near']);
});

test('ORACLE: capacity comes from each hall, not a flat default', async () => {
  const { maxAttendanceFor, DEFAULT_MAX_ATTENDANCE } = await import('../src/lib/model.js');
  const locations = [
    { id: 'sc', name: 'Santa Clara', settings: { max_attendance: 430 } },
    { id: 'rwc', name: 'Redwood City', settings: { max_attendance: 200 } },
    { id: 'x', name: 'Unset', settings: {} },
  ];
  assert.equal(maxAttendanceFor('sc', locations), 430);
  assert.equal(maxAttendanceFor('rwc', locations), 200);
  assert.equal(maxAttendanceFor('x', locations), DEFAULT_MAX_ATTENDANCE);
  assert.equal(maxAttendanceFor('missing', locations), DEFAULT_MAX_ATTENDANCE);
});
