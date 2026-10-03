/* ============================================================================
   SAR 2.0 — Manager attribution and day-normalized scoring

   Pure functions. No DOM, no network, no Supabase — everything here takes
   arrays and returns arrays, so all of it is testable without a browser.
   See SAR2-MANAGERS-DESIGN.md; section numbers below refer to it.

   THE THREE THINGS THAT ARE EASY TO GET WRONG:

   1. THE JOIN IS ORDINAL, NOT A LOOKUP TABLE. Ops says AM/PM, analytics says
      regular/late, and `PM -> late` is WRONG on weekdays — a weekday has one
      session that Ops calls PM and analytics calls regular. A static map drops
      half the data silently. Match the nth session of the day to the nth.

   2. A SESSION IS EXCLUDED FROM ITS OWN BASELINE. Otherwise a session is
      partly scored against itself, which flattens every score toward zero.

   3. SCORES ARE PER (PERSON, ROLE), NOT PER PERSON. Sagit was MOD and
      Paymaster on the same night; one result cannot be credited to one person
      twice over as though they were two people.
   ========================================================================== */

import { COUNTED_STATUSES } from './staff-model.js';
import { mergeCrewSources } from './crew-model.js';

/* ---------------------------------------------------------------------------
   Constants — DESIGN §10
--------------------------------------------------------------------------- */

/** Trailing window for a slot baseline. From the Saturday-late drift, §3.1. */
export const SLOT_WINDOW_DAYS = 365;

/** Below this, a slot has no usable baseline and the score is null. §4.2 */
export const MIN_SLOT_SESSIONS = 8;

/** Below this, scores are shown but the list is not ranked. §5 */
export const MIN_RANK_SESSIONS = 10;

export const Z_95 = 1.96;

/**
 * Half-width of the window used to work out how the business was running at
 * the time. +/- 14 days, so a session is compared against roughly a month of
 * its own neighbours across both halls.
 */
export const TREND_HALF_WINDOW_DAYS = 14;

/* ---------------------------------------------------------------------------
   Halls — DESIGN §2.3
--------------------------------------------------------------------------- */

const HALL_PATTERNS = Object.freeze([
  ['sc', /santa\s*clara/i],
  ['rwc', /redwood/i],
]);

/**
 * Map Ops hall slugs onto analytics location ids, BY NAME.
 *
 * There is no shared key between the databases. Hardcoding the two uuids
 * would work until a third hall appears, and then be wrong in a way nobody
 * notices. Returns `null` for a slug that cannot be resolved, and the caller
 * reports the feature unavailable rather than guessing.
 */
export function resolveHalls(locations = []) {
  const map = new Map();
  for (const [slug, pattern] of HALL_PATTERNS) {
    const hit = locations.find((l) => pattern.test(l.name ?? ''));
    if (hit) map.set(slug, hit.id);
  }
  return map;
}

/* ---------------------------------------------------------------------------
   Dates
--------------------------------------------------------------------------- */

/** 'YYYY-MM-DD' to a day number. UTC throughout — no local timezone drift. */
export function dayNumber(d) {
  return Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000);
}

/** 0 = Sunday. UTC, for the same reason. */
export function weekdayIndex(d) {
  return new Date(`${d}T00:00:00Z`).getUTCDay();
}

/* ---------------------------------------------------------------------------
   The join — DESIGN §2
--------------------------------------------------------------------------- */

/** Ops order within a day. AM before PM. */
const PART_ORDER = { AM: 0, PM: 1 };
/** Analytics order within a day. The main session before the late one. */
const TYPE_ORDER = { regular: 0, late: 1 };

const byOrder = (order) => (a, b) => (order[a.k] ?? 99) - (order[b.k] ?? 99);

/**
 * Match Ops sessions to analytics events by ORDINAL POSITION within the day.
 *
 * Returns `{ links, report }` where `links` is a Map from analytics event id
 * to the Ops session id, and `report` records what did not match and why.
 *
 * The count guard (§2.2) is the point of this function. When a day has two
 * scheduled sessions and one result, the correspondence is genuinely unknown —
 * matching the first to the first would attribute a whole evening's takings to
 * whoever happened to be rostered in the morning. Those days are skipped and
 * counted, never guessed.
 */
export function joinSessions(opsSessions = [], events = [], hallMap = new Map()) {
  const links = new Map();
  const report = { matched: 0, mismatched: [], unmatchedOps: 0, unmatchedEvents: 0 };

  // Bucket both sides by (date, analytics location id).
  const opsByDay = new Map();
  for (const s of opsSessions) {
    const loc = hallMap.get(s.hall_id);
    if (!loc) { report.unmatchedOps += 1; continue; }
    const key = `${s.session_date}|${loc}`;
    const list = opsByDay.get(key) ?? [];
    list.push({ id: s.id, k: s.part, session: s });
    opsByDay.set(key, list);
  }

  const evByDay = new Map();
  for (const e of events) {
    const key = `${e.event_date}|${e.location_id}`;
    const list = evByDay.get(key) ?? [];
    list.push({ id: e.id, k: e.event_type, event: e });
    evByDay.set(key, list);
  }

  for (const [key, opsList] of opsByDay) {
    const evList = evByDay.get(key);
    if (!evList) { report.unmatchedOps += opsList.length; continue; }

    if (opsList.length !== evList.length) {
      const [date, loc] = key.split('|');
      report.mismatched.push({ date, locationId: loc, ops: opsList.length, events: evList.length });
      continue;
    }

    opsList.sort(byOrder(PART_ORDER));
    evList.sort(byOrder(TYPE_ORDER));
    for (let i = 0; i < opsList.length; i += 1) {
      links.set(evList[i].id, opsList[i].id);
      report.matched += 1;
    }
  }

  for (const [key, evList] of evByDay) {
    if (!opsByDay.has(key)) report.unmatchedEvents += evList.length;
  }

  return { links, report };
}

/* ---------------------------------------------------------------------------
   Attribution — who ran which session
--------------------------------------------------------------------------- */

/**
 * Build a Map from analytics event id to `{ MOD, Paymaster, 'Flash Manager' }`,
 * each value `{ staffId, name }` or absent.
 *
 * Training assignments are excluded: somebody shadowing the Paymaster did not
 * run the till, and counting them would credit or blame the wrong person.
 */
export function attributeManagers({
  links, assignments = [], staff = [], roles = [], managerRoles,
}) {
  const wanted = new Set(managerRoles ?? ['MOD', 'Paymaster', 'Flash Manager']);
  const roleName = new Map(roles.filter((r) => wanted.has(r.name)).map((r) => [r.id, r.name]));
  const staffName = new Map(staff.map((s) => [s.id, s.name ?? s.first_name ?? 'Unknown']));

  // Ops session id -> { role -> person }
  const bySession = new Map();
  for (const a of assignments) {
    const role = roleName.get(a.role_id);
    if (!role || a.is_training) continue;
    const entry = bySession.get(a.session_id) ?? {};
    entry[role] = { staffId: a.staff_id, name: staffName.get(a.staff_id) ?? 'Unknown' };
    bySession.set(a.session_id, entry);
  }

  const byEvent = new Map();
  for (const [eventId, opsId] of links) {
    const crew = bySession.get(opsId);
    if (crew) byEvent.set(eventId, crew);
  }
  return byEvent;
}

/* ---------------------------------------------------------------------------
   Baselines — DESIGN §4.2
--------------------------------------------------------------------------- */

/** A slot is a hall, a weekday and a session type. Not `day_type`. §4.1 */
export function slotKey(event) {
  return `${event.location_id}|${weekdayIndex(event.event_date)}|${event.event_type}`;
}

function meanSd(xs) {
  const n = xs.length;
  if (!n) return { mean: null, sd: null, n: 0 };
  const mu = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean: mu, sd: null, n };
  const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1);
  return { mean: mu, sd: Math.sqrt(v), n };
}

/**
 * A trailing baseline per event, for one metric.
 *
 * `valueOf(event)` returns a number or null. Events whose value is null take
 * no part — in either the baseline or the scoring — because an unrecorded
 * metric is missing, not zero.
 *
 * STRICTLY EARLIER dates only. An event never contributes to its own baseline.
 */
export function buildBaselines(events, valueOf, {
  windowDays = SLOT_WINDOW_DAYS, minSessions = MIN_SLOT_SESSIONS,
} = {}) {
  const bySlot = new Map();
  for (const e of events) {
    const v = valueOf(e);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const k = slotKey(e);
    const list = bySlot.get(k) ?? [];
    list.push({ id: e.id, day: dayNumber(e.event_date), value: v });
    bySlot.set(k, list);
  }
  for (const list of bySlot.values()) list.sort((a, b) => a.day - b.day);

  const out = new Map();
  for (const [k, list] of bySlot) {
    for (const target of list) {
      const window = list.filter(
        (o) => o.day < target.day && o.day >= target.day - windowDays,
      );
      const { mean, sd, n } = meanSd(window.map((o) => o.value));
      out.set(target.id, {
        slot: k,
        value: target.value,
        mean, sd, n,
        usable: n >= minSessions && sd !== null && sd > 0,
      });
    }
  }
  return out;
}

/**
 * Score one session against its baseline. DESIGN §4.3
 *
 * `z` is the headline: standard deviations from a typical night of this kind.
 * `ratio` is the plain-language reading, e.g. 0.14 for "14% above".
 *
 * `better: -1` inverts, for metrics where small is good — the Paymaster's
 * cash variance being the one that matters. Without the inversion a till that
 * was $3,000 short would score as a triumph.
 */
export function scoreSession(baseline, { better = 1 } = {}) {
  if (!baseline || !baseline.usable) {
    return { z: null, ratio: null, n: baseline?.n ?? 0 };
  }
  const z = ((baseline.value - baseline.mean) / baseline.sd) * better;
  const ratio = baseline.mean !== 0 ? (baseline.value - baseline.mean) / Math.abs(baseline.mean) : null;
  return { z, ratio: ratio === null ? null : ratio * better, n: baseline.n };
}

/* ---------------------------------------------------------------------------
   Correcting for the trend — DESIGN §4.6

   FOUND BY VERIFYING AGAINST PRODUCTION, NOT BY REASONING.

   Scoring the 31 Jul - 16 Aug 2026 roster window gave a positive z for
   nineteen of twenty-two sessions, and the mean across ALL sessions in the
   fortnight was +0.67 sigma. Both halls were running well above their trailing
   year, on nights with a named MOD and nights without one.

   So a raw z confounds two different things: how well the person ran the
   night, and how the business happened to be doing that month. Rank on it and
   the top of the table is whoever was rostered during a good fortnight.

   The correction is to subtract the concurrent level. For each session, take
   the mean z of every session within +/- 14 days — the other halls and the
   other nights, the manager's own included, which is negligible in a pool of
   forty and keeps the definition simple — and score the difference.

   `z`   answers "how did this night compare with a typical night like it?"
   `adj` answers "how did it compare with everything else happening then?"

   The second is the one a person can be held to. It is what the screen ranks
   on, and both are shown, because a fortnight where the whole business is up
   is worth knowing about too.
--------------------------------------------------------------------------- */

/**
 * Mean z among sessions near in time, per event id.
 *
 * Deliberately pooled across halls: a good month at Santa Clara and a good
 * month at Redwood City are the same underlying weather, and splitting the
 * pool by hall would shrink it to the point of being noise itself.
 */
export function trendLevels(scoredByEvent, dayOf, { halfWindow = TREND_HALF_WINDOW_DAYS } = {}) {
  const pts = [];
  for (const [id, z] of scoredByEvent) {
    if (z === null || !Number.isFinite(z)) continue;
    pts.push({ id, day: dayOf(id), z });
  }
  const out = new Map();
  for (const p of pts) {
    const near = pts.filter((o) => Math.abs(o.day - p.day) <= halfWindow);
    out.set(p.id, near.reduce((a, b) => a + b.z, 0) / near.length);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Rolling up to a person — DESIGN §4.5
--------------------------------------------------------------------------- */

/**
 * Average a person's session scores, with the uncertainty attached.
 *
 * `se = 1/sqrt(n)` because z has unit variance by construction, so the mean of
 * n of them has standard error 1/sqrt(n). At n=9 that is ±0.65 at 95% — which
 * is why §5 exists and why the interval is never hidden.
 */
export function rollup(scores = []) {
  const usable = scores.filter((s) => s.z !== null && Number.isFinite(s.z));
  const n = usable.length;
  if (!n) {
    return { n: 0, score: null, raw: null, trend: null,
             se: null, lo: null, hi: null, rankable: false };
  }
  const avg = (f) => usable.reduce((a, s) => a + f(s), 0) / n;
  const raw = avg((s) => s.z);
  // Sessions with no trend level fall back to their raw z, which is the same
  // as assuming the period was ordinary — the honest default when there is
  // nothing else running at the time to compare against.
  const score = avg((s) => (Number.isFinite(s.adj) ? s.adj : s.z));
  const se = 1 / Math.sqrt(n);
  return {
    n,
    score,                    // trend-corrected: what the screen ranks on
    raw,                      // against a typical night of this kind
    trend: raw - score,       // how the business was running at the time
    se,
    lo: score - Z_95 * se,
    hi: score + Z_95 * se,
    rankable: n >= MIN_RANK_SESSIONS,
  };
}

/**
 * Is this difference distinguishable from noise?
 *
 * Two independent means of z-scores; the difference has se = sqrt(1/na + 1/nb).
 * Used to grey out the gap between adjacent rows rather than implying that a
 * hundredth of a sigma separates two people.
 */
export function separable(a, b) {
  if (!a?.n || !b?.n || a.score === null || b.score === null) return false;
  const se = Math.sqrt(1 / a.n + 1 / b.n);
  return Math.abs(a.score - b.score) > Z_95 * se;
}

/* ---------------------------------------------------------------------------
   Role metrics — DESIGN §4.4
--------------------------------------------------------------------------- */

/**
 * What each role is primarily judged on.
 *
 * A single "revenue score" for all three would be lazy and would blame the
 * Paymaster for a quiet Tuesday. `variance` is the till being over or short:
 * present on 449 sessions, mean absolute $683 — the closest thing in the
 * database to a direct measure of whether the Paymaster did their job.
 */
export const ROLE_METRIC = Object.freeze({
  MOD: 'gross',
  Paymaster: 'balance',
  'Flash Manager': 'flash',
});

/**
 * GROSS, NOT NET, and this is a deliberate correction.
 *
 * Net subtracts payouts, and payouts turn on who wins — a jackpot landing on a
 * Tuesday is luck, not management. Scoring a MOD on net would credit and blame
 * them for the outcome of the games. Gross is what the room actually sold, and
 * it is the part a manager can move.
 */

/**
 * Roles whose primary figure is a RATE, not a sigma.
 *
 * The Paymaster is judged on how often the books balance, which does not need
 * day-normalizing: a till either reconciles or it does not, and that is no
 * harder on a busy Friday than a quiet Tuesday.
 */
export const RATE_ROLES = Object.freeze(['Paymaster']);

/** Every metric offered, in card order. `better: -1` means smaller is better. */
export const METRICS = Object.freeze([
  { key: 'gross', label: 'Gross', better: 1, kind: 'money' },
  { key: 'net', label: 'Net', better: 1, kind: 'money' },
  { key: 'flash', label: 'Flash', better: 1, kind: 'money' },
  { key: 'rpa', label: 'RPA', better: 1, kind: 'money' },
  { key: 'attendance', label: 'Att', better: 1, kind: 'int' },
  { key: 'margin', label: 'Margin', better: 1, kind: 'rate' },
  { key: 'variance', label: 'Cash var', better: -1, kind: 'money' },
]);

export const metricByKey = (k) => METRICS.find((m) => m.key === k) ?? METRICS[0];

/**
 * Build the whole model: attribution, baselines for every metric, and a
 * per-(person, role) rollup.
 *
 * `valuesOf(event)` returns `{ net, gross, flash, rpa, attendance, margin,
 * variance }`, any of which may be null. Supplied by the screen so this file
 * stays free of the EAV store.
 */
export function buildManagerModel({
  events = [], locations = [], schedule, valuesOf, crew = null,
}) {
  const hallMap = resolveHalls(locations);
  if (hallMap.size < HALL_PATTERNS.length) {
    return {
      ok: false,
      reason: 'Could not match Operational hall slugs to analytics locations by name.',
      roles: [], report: null, crewOf: new Map(),
    };
  }

  // Deployed and planned sessions only, the Staff Overview rule (Q26). A draft
  // is a plan nobody confirmed; its assignments say nothing about who worked.
  // A session with no status at all is kept.
  const counted = (schedule.sessions ?? []).filter((s) => !s.status || COUNTED_STATUSES.includes(s.status));
  const { links, report } = joinSessions(counted, events, hallMap);
  report.notCounted = (schedule.sessions ?? []).length - counted.length;
  const schedCrew = attributeManagers({
    links,
    assignments: schedule.assignments,
    staff: schedule.staff,
    roles: schedule.roles,
  });

  // The owner's name rule (config OWNER_NAME_RULE): a scheduler person whose
  // name is another spelling of someone — "Sam" beside "Sam Ortiz" —
  // is credited as that one person, so their scheduler- and validator-sourced
  // nights add up. Built by crew-model `buildNameMerge`; listed on screen.
  const names = crew?.names ?? null;
  if (names?.staffRemap?.size) {
    for (const entry of schedCrew.values()) {
      for (const [role, p] of Object.entries(entry)) {
        const to = names.except?.includes(role) ? null : names.staffRemap.get(p.staffId);
        if (to) entry[role] = { ...p, staffId: to.id, name: to.name };
      }
    }
  }

  // The crew source per session: the data validator where it has the night
  // (approved preferred; 'progress' used but flagged), else the scheduler.
  const { crewOf, sourceOf, counts: sources, span: sourceSpan } = mergeCrewSources({
    events, schedCrew, crew,
  });

  // Baselines are computed over EVERY event, not only attributed ones — the
  // baseline describes the night, not the manager, and the whole two-year
  // history is what makes it precise. Attribution only decides whose column a
  // score lands in.
  const cache = new Map();
  for (const e of events) cache.set(e.id, valuesOf(e));

  const baselines = new Map();
  for (const m of METRICS) {
    baselines.set(m.key, buildBaselines(events, (e) => {
      const v = cache.get(e.id)?.[m.key];
      // Cash variance is judged on SIZE, not direction: a till $500 over is as
      // wrong as one $500 short, and averaging the signed number would let the
      // two cancel and read as perfect.
      if (m.key === 'variance') return v === null || v === undefined ? null : Math.abs(v);
      return v ?? null;
    }));
  }

  // The concurrent level, per metric. Computed over EVERY session, not only
  // the attributed ones — the business trend is a property of the fortnight,
  // not of the people who happen to have been rostered in it.
  const dayOf = new Map(events.map((e) => [e.id, dayNumber(e.event_date)]));
  const trends = new Map();
  for (const m of METRICS) {
    const zs = new Map();
    for (const e of events) {
      zs.set(e.id, scoreSession(baselines.get(m.key).get(e.id), { better: m.better }).z);
    }
    trends.set(m.key, trendLevels(zs, (id) => dayOf.get(id)));
  }

  // person+role -> sessions
  const byPersonRole = new Map();
  for (const [eventId, crew] of crewOf) {
    for (const [role, person] of Object.entries(crew)) {
      const key = `${person.staffId}|${role}`;
      const entry = byPersonRole.get(key)
        ?? { staffId: person.staffId, name: person.name, role, sessions: [] };
      const scores = {};
      for (const m of METRICS) {
        const s = scoreSession(baselines.get(m.key).get(eventId), { better: m.better });
        const level = trends.get(m.key).get(eventId);
        scores[m.key] = {
          ...s,
          level: level ?? null,
          adj: s.z === null || level === null || level === undefined ? null : s.z - level,
        };
      }
      const src = sourceOf.get(eventId);
      entry.sessions.push({ eventId, scores, checks: balanceChecks(cache.get(eventId) ?? {}),
        source: src?.source ?? null, approved: src?.approved ?? null,
        sessionStatus: src?.sessionStatus ?? null, closedAt: src?.closedAt ?? null });
      byPersonRole.set(key, entry);
    }
  }

  const people = [...byPersonRole.values()].map((p) => {
    const roll = {};
    for (const m of METRICS) {
      roll[m.key] = rollup(p.sessions.map((s) => s.scores[m.key]));
    }
    const balance = rollupBalance(p.sessions.map((s) => s.checks));
    const isRate = RATE_ROLES.includes(p.role);
    return {
      ...p, roll, balance, isRate,
      primary: isRate ? balance : (roll[ROLE_METRIC[p.role]] ?? roll.gross),
    };
  });

  return {
    ok: true, reason: null, user: schedule.user ?? null,
    people, crewOf, sourceOf, sources, sourceSpan, baselines, trends, report, hallMap, names,
    validator: crew ? { ok: Boolean(crew.ok), report: crew.join?.report ?? null } : null,
    roles: [...new Set(people.map((p) => p.role))],
  };
}

/* ---------------------------------------------------------------------------
   Balancing — the Paymaster's score

   "How often do the different pieces balance." Two independent checks survived
   testing against 285 sessions of 2026; the others were discarded and it is
   worth recording why, because a check that always passes is worse than no
   check at all — it silently inflates everybody's rate.

     KEPT   deposit    |bingo_variance| within tolerance.  64/285 clean at $5.
     KEPT   sales tie  line items against the sheet's own
                       total.  277/285 clean, mean gap $2.
     DROPPED pulltab   sales - payouts against pulltab_net.
                       285/285. Never fails, so it measures nothing.
     DROPPED payouts   the payout metrics overlap each other, so a sum of them
                       is not comparable to source_total_payouts. 0/285 —
                       the check is wrong, not the books.
   --------------------------------------------------------------------------- */

/** Within five dollars. A till out by small change has balanced. */
export const BALANCE_TOLERANCE_CENTS = 500;
/** The line items should agree with the sheet total to the dollar. */
export const TIE_TOLERANCE_CENTS = 100;

/**
 * Which pieces balanced on one session.
 *
 * Returns one entry per check that COULD be made. A check with a missing
 * input is omitted rather than counted as a failure — an unrecorded figure is
 * not a Paymaster's mistake.
 */
export function balanceChecks(v = {}) {
  const out = [];
  if (Number.isFinite(v.variance)) {
    out.push({
      key: 'deposit',
      label: 'Deposit',
      ok: Math.abs(v.variance) <= BALANCE_TOLERANCE_CENTS,
      off: v.variance,
    });
  }
  if (Number.isFinite(v.lineSales) && Number.isFinite(v.sourceSales)) {
    out.push({
      key: 'sales',
      label: 'Sales tie',
      ok: Math.abs(v.lineSales - v.sourceSales) <= TIE_TOLERANCE_CENTS,
      off: v.lineSales - v.sourceSales,
    });
  }
  return out;
}

/**
 * Wilson score interval for a proportion.
 *
 * Not the textbook normal approximation: at three sessions and three passes
 * that gives an interval of zero width, which would claim certainty from
 * almost no evidence. Wilson stays honest at small n, which is the only n
 * this screen has.
 */
export function wilson(passed, n, z = Z_95) {
  if (!n) return { rate: null, lo: null, hi: null };
  const p = passed / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { rate: p, lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d) };
}

/** Roll a person's sessions into a balance rate over every check made. */
export function rollupBalance(sessionChecks = []) {
  let n = 0; let passed = 0; let sessions = 0; let clean = 0;
  const tally = new Map();
  for (const checks of sessionChecks) {
    if (!checks.length) continue;
    sessions += 1;
    const good = checks.filter((c) => c.ok).length;
    n += checks.length;
    passed += good;
    if (good === checks.length) clean += 1;
    for (const c of checks) {
      const e = tally.get(c.key) ?? { key: c.key, label: c.label, n: 0, passed: 0 };
      e.n += 1;
      if (c.ok) e.passed += 1;
      tally.set(c.key, e);
    }
  }
  const byCheck = [...tally.values()].map((e) => ({ ...e, ...wilson(e.passed, e.n) }));
  return {
    n: sessions, checks: n, passed, clean,
    ...wilson(passed, n),
    cleanRate: sessions ? clean / sessions : null,
    // Per check as well as combined. A check that nearly always passes drags
    // every combined rate toward the middle and hides the one that
    // discriminates — the sales tie-out passes on 277 of 285 sessions, so a
    // person's whole score would otherwise be half a constant.
    byCheck,
    rankable: sessions >= MIN_RANK_SESSIONS,
  };
}

/* ---------------------------------------------------------------------------
   Day shape — DESIGN §7, the Day shape tab
--------------------------------------------------------------------------- */

/**
 * Per-slot index and spread, so the normalization is inspectable.
 *
 * Index is the slot mean over the all-slot mean IN THE SAME WINDOW — a ratio
 * of means within one period, never mixing periods, because the overall level
 * rose 34% in two years and an index built across that would be meaningless.
 */
export function daySlots(events, valueOf, { windowDays = SLOT_WINDOW_DAYS, now = null } = {}) {
  const today = now ?? Math.max(...events.map((e) => dayNumber(e.event_date)));
  const inWindow = events.filter((e) => {
    const d = dayNumber(e.event_date);
    return d > today - windowDays && d <= today;
  });

  const rows = new Map();
  const all = [];
  for (const e of inWindow) {
    const v = valueOf(e);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    all.push(v);
    const k = slotKey(e);
    const r = rows.get(k)
      ?? { key: k, locationId: e.location_id, weekday: weekdayIndex(e.event_date),
           eventType: e.event_type, values: [] };
    r.values.push(v);
    rows.set(k, r);
  }

  const overall = meanSd(all);
  return [...rows.values()].map((r) => {
    const { mean, sd, n } = meanSd(r.values);
    return {
      ...r,
      n,
      mean,
      sd,
      index: overall.mean ? mean / overall.mean : null,
      cv: mean ? sd / mean : null,
    };
  }).sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
}
