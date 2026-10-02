/* ============================================================================
   SAR 2.0 — Crew model: who actually worked, from the data validator

   Pure functions. No DOM, no network. Input is the projected validator read
   (`schedule.validator.rows`, see ops-schema VALIDATOR_COLUMNS), the
   scheduler's `sched_staff`, and analytics events; output is plain objects.

   WHY THIS EXISTS. The owner now enters each night's crew in the data
   validator — the nightly reconciliation app — rather than the scheduler. The
   validator records WHO worked and in WHICH ROLE, signed off per session
   (`staff_status` 'approved' or 'progress'). It records no times, so hours and
   overtime still come from the scheduler only.

   THE THREE THINGS THAT ARE EASY TO GET WRONG:

   1. NAMES ARE FREE TEXT. Managers type them. Matching is on a normalised key
      (trimmed, spaces collapsed, case-folded) and a validator name is tied to a
      scheduler person when that key equals exactly ONE `sched_staff.name`.
      On top of that, the OWNER'S NAME RULE (config OWNER_NAME_RULE, confirmed
      2 Oct 2026) merges spellings of one first name — "Sam", "Sam O.",
      "Sam Ortiz" — in every role except Flash Runners; see
      `buildNameMerge`. Different initials stay different people, a bare first
      name that could be either is left alone and listed as ambiguous, and
      every merge is listed for review. Flash Runners keep the old behaviour:
      likely duplicates are LISTED (`possibleDuplicates`), never merged.

   2. THE JOIN TO ANALYTICS IS ORDINAL WITH A COUNT GUARD, as in managers.js.
      Within a hall and date the validator orders sessions by start time
      (13:00 before 18:30), analytics by type (regular before late). A day whose
      counts disagree is skipped and reported, never guessed.

   3. ONE ROW PER SESSION. Should the validator ever hold two rows for the same
      hall, date and time, the approved one wins, then the one with a crew,
      then the most recently updated; the others are counted, not used.
   ========================================================================== */

import { COUNTED_STATUSES, payPeriod, payPeriods, inPeriod } from './staff-model.js';
import { OWNER_NAME_RULE, OWNER_NAME_KEEP_APART, OWNER_NAME_ALIASES } from './config.js';

/** The scheduler's six roles, in roster order. The validator uses the same names. */
export const VALIDATOR_ROLES = Object.freeze([
  'MOD', 'Paymaster', 'Flash Manager', 'Opener/Swing Shift', 'Callers/Strip', 'Flash Runners',
]);

/** The roles the Managers screen scores. */
export const MANAGER_CREW_ROLES = Object.freeze(['MOD', 'Paymaster', 'Flash Manager']);

/** Analytics order within a day: the main session before the late one. */
const TYPE_ORDER = { regular: 0, late: 1 };
/** Scheduler order within a day. */
const PART_ORDER = { AM: 0, PM: 1 };

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dateOf = (d) => (d ? String(d).slice(0, 10) : null);
const roleRank = (r) => {
  const i = VALIDATOR_ROLES.indexOf(r);
  return i < 0 ? VALIDATOR_ROLES.length : i;
};

/* ---------------------------------------------------------------------------
   Names
--------------------------------------------------------------------------- */

/** Display clean-up only: trimmed, inner whitespace collapsed. Case is kept. */
export function cleanName(s) {
  if (s === null || s === undefined) return '';
  return String(s).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** The matching key: `cleanName`, case-folded. */
export const nameKey = (s) => cleanName(s).toLocaleLowerCase('en-US');

const wordsOf = (key) => (key ? key.split(' ') : []);

/** 'HH:MM' or 'HH:MM:SS' to minutes since midnight, or null. */
export function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/* ---------------------------------------------------------------------------
   Rows
--------------------------------------------------------------------------- */

/** Validator rows to plain session objects. Crew entries with no name are dropped. */
export function normaliseValidator(rows = []) {
  return (rows ?? []).filter((r) => r && r.session_date && r.hall_id).map((r) => {
    const crew = (Array.isArray(r.crew) ? r.crew : []).map((c, order) => ({
      name: cleanName(c?.name), key: nameKey(c?.name),
      role: cleanName(c?.role) || 'Unknown role', slot: num(c?.slot), order,
    })).filter((c) => c.key);
    return {
      id: r.id ?? null,
      hall: String(r.hall_id).toLowerCase(),
      date: dateOf(r.session_date),
      time: r.session_time ? String(r.session_time).slice(0, 5) : null,
      minutes: minutesOf(r.session_time),
      slotName: r.slot_name ?? null,
      status: r.status ?? null,
      closedAt: r.closed_at ?? null,
      updatedAt: r.updated_at ? String(r.updated_at) : null,
      staffStatus: r.staff_status ?? null,
      approved: r.staff_status === 'approved',
      commissionRate: num(r.commission_rate),
      commissionTarget: num(r.commission_target),
      crew,
    };
  });
}

/**
 * One row per (hall, date, time): approved first, then a row with a crew,
 * then the most recently updated. Returns `{ sessions, superseded }`.
 */
export function pickSessions(sessions = []) {
  const by = new Map();
  for (const s of sessions) {
    const k = `${s.hall}|${s.date}|${s.time ?? s.id}`;
    (by.get(k) ?? by.set(k, []).get(k)).push(s);
  }
  const out = []; const superseded = [];
  for (const list of by.values()) {
    list.sort((a, b) => (Number(b.approved) - Number(a.approved))
      || (Number(b.crew.length > 0) - Number(a.crew.length > 0))
      || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    out.push(list[0]);
    superseded.push(...list.slice(1));
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.hall.localeCompare(b.hall)
    || (a.minutes ?? 0) - (b.minutes ?? 0));
  return { sessions: out, superseded };
}

/* ---------------------------------------------------------------------------
   Identities
--------------------------------------------------------------------------- */

/**
 * One identity per normalised validator name.
 *
 * `match`:
 *   'matched'    the key equals exactly one `sched_staff.name` key — the person
 *                takes that scheduler id (and the scheduler's name, so a person
 *                reads the same whichever source a session came from)
 *   'ambiguous'  the key equals two or more scheduler names — NOT mapped
 *   'none'       no scheduler name has this key — NOT mapped
 *
 * Unmapped identities get the id `v:<key>` and the display form: the spelling
 * used most often in the validator (ties to the alphabetically first).
 */
export function buildIdentities(sessions = [], staff = [], merge = null) {
  // Entries are grouped by `who` — the identity key the owner's name rule gave
  // the entry (`buildCrewModel` sets it) — or by the typed name's key.
  const spellings = new Map();
  for (const s of sessions) {
    for (const c of s.crew) {
      const k = whoOf(c);
      const m = spellings.get(k) ?? spellings.set(k, new Map()).get(k);
      m.set(c.name, (m.get(c.name) ?? 0) + 1);
    }
  }
  const index = new Map();
  for (const p of staff ?? []) {
    const k = nameKey(p?.name);
    if (!k) continue;
    (index.get(k) ?? index.set(k, []).get(k)).push(p);
  }
  const out = new Map();
  for (const [key, m] of spellings) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const display = ranked[0][0];
    const hits = index.get(key) ?? [];
    const merged = merge?.identity?.get(key);
    if (merged) {
      out.set(key, {
        key, display, id: merged.id, staffId: merged.staffId, name: merged.name,
        match: merged.match, candidates: hits.length, merged: true,
        spellings: ranked.map(([spelling, n]) => ({ spelling, n })),
        entries: ranked.reduce((t, [, n]) => t + n, 0),
        words: wordsOf(key).length,
      });
      continue;
    }
    const match = hits.length === 1 ? 'matched' : hits.length > 1 ? 'ambiguous' : 'none';
    const p = match === 'matched' ? hits[0] : null;
    out.set(key, {
      key, display,
      id: p ? p.id : `v:${key}`,
      staffId: p ? p.id : null,
      name: p ? (cleanName(p.name) || display) : display,
      match, candidates: hits.length,
      spellings: ranked.map(([spelling, n]) => ({ spelling, n })),
      entries: ranked.reduce((t, [, n]) => t + n, 0),
      words: wordsOf(key).length,
    });
  }
  return out;
}

/** An entry's identity key: the owner's name rule's, else the typed name's. */
const whoOf = (c) => c.who ?? c.key;

/**
 * Names that are PROBABLY one person, for the owner to review. Never merged.
 *
 * The rule is narrow on purpose: a single-word name that equals the first word
 * of exactly one multi-word name at the same hall in the same role ("Sam" and
 * "Sam Ortiz" both Paymaster at one hall). Two multi-word first-name matches,
 * or none, are not suggested. A pair the scheduler already knows as two
 * different people (both matched, to different ids) is not suggested either.
 *
 * `opts.roles` limits it to those roles — `buildCrewModel` passes the roles the
 * owner's name rule does NOT merge (Flash Runners); everywhere else the rule
 * has already joined such names.
 */
export function possibleDuplicates(sessions = [], ids = new Map(), opts = {}) {
  const only = opts.roles ? new Set(opts.roles) : null;
  const groups = new Map();
  for (const s of sessions) {
    for (const c of s.crew) {
      if (only && !only.has(c.role)) continue;
      const g = `${s.hall}|${c.role}`;
      const m = groups.get(g) ?? groups.set(g, new Map()).get(g);
      m.set(c.key, (m.get(c.key) ?? 0) + 1);
    }
  }
  const pairs = new Map();
  for (const [g, m] of groups) {
    const [hall, role] = [g.slice(0, g.indexOf('|')), g.slice(g.indexOf('|') + 1)];
    const keys = [...m.keys()];
    for (const short of keys) {
      if (wordsOf(short).length !== 1) continue;
      const cands = keys.filter((k) => wordsOf(k).length > 1 && wordsOf(k)[0] === short);
      if (cands.length !== 1) continue;
      const long = cands[0];
      const a = ids.get(short); const b = ids.get(long);
      if (a?.staffId && b?.staffId && a.staffId !== b.staffId) continue;
      const pk = `${short}|${long}`;
      const p = pairs.get(pk) ?? pairs.set(pk, {
        short: { key: short, name: a?.name ?? short, match: a?.match ?? 'none' },
        long: { key: long, name: b?.name ?? long, match: b?.match ?? 'none' },
        where: [],
      }).get(pk);
      p.where.push({ hall, role, shortEntries: m.get(short), longEntries: m.get(long) });
    }
  }
  return [...pairs.values()].sort((x, y) => x.long.name.localeCompare(y.long.name)
    || x.short.name.localeCompare(y.short.name));
}

/* ---------------------------------------------------------------------------
   The owner's name rule — one person, several spellings (config OWNER_NAME_RULE)
--------------------------------------------------------------------------- */

const push = (map, k, v) => (map.get(k) ?? map.set(k, []).get(k)).push(v);

/** The rule's key: `nameKey` with trailing dots dropped from each word ("Sam O." -> "sam o"). */
export function ruleKey(s) {
  return nameKey(s).split(' ').map((w) => w.replace(/\.+$/, '')).filter(Boolean).join(' ');
}

/** First name, and the rest of the name: '' when there is none, one letter when an initial. */
export function nameParts(s) {
  const key = ruleKey(s);
  const i = key.indexOf(' ');
  return i < 0 ? { key, first: key, surname: '' } : { key, first: key.slice(0, i), surname: key.slice(i + 1) };
}

/**
 * Scheduler people on the sessions whose crew comes from the SCHEDULER — the
 * analytics sessions the validator has no crew for — one entry per (person,
 * role) with the number of such sessions. Deployed and planned sessions only,
 * no training places, as on Managers.
 *
 * Scheduler sessions are joined to analytics as `managers.joinSessions` does:
 * by order within (hall, date), AM before PM and regular before late, and a
 * day whose counts differ is skipped. `validatorLinks` is `joinValidator`'s
 * `links`; an event linked to a validator session WITH a crew is the
 * validator's, exactly as `mergeCrewSources` decides.
 */
export function schedulerSourcedUses({ schedule = null, events = [], hallMap = new Map(), validatorLinks = new Map() } = {}) {
  if (!schedule?.sessions?.length || !events.length) return [];
  const sByDay = new Map();
  for (const s of schedule.sessions) {
    if (!countedStatus(s) || !s.session_date) continue;
    const loc = hallMap.get(String(s.hall_id).toLowerCase());
    if (loc) push(sByDay, `${dateOf(s.session_date)}|${loc}`, s);
  }
  const eByDay = new Map();
  for (const e of events) push(eByDay, `${e.event_date}|${e.location_id}`, e);
  const sourced = new Set();
  for (const [k, ss] of sByDay) {
    const es = eByDay.get(k);
    if (!es || es.length !== ss.length) continue;
    const sl = [...ss].sort((a, b) => (PART_ORDER[a.part] ?? 99) - (PART_ORDER[b.part] ?? 99));
    const el = [...es].sort((a, b) => (TYPE_ORDER[a.event_type] ?? 99) - (TYPE_ORDER[b.event_type] ?? 99));
    for (let i = 0; i < sl.length; i += 1) {
      if (validatorLinks.get(el[i].id)?.crew?.length) continue;
      sourced.add(sl[i].id);
    }
  }
  const staffName = new Map((schedule.staff ?? []).map((p) => [p.id, cleanName(p.name ?? p.first_name)]));
  const roleName = new Map((schedule.roles ?? []).map((r) => [r.id, r.name]));
  const uses = new Map();
  for (const a of schedule.assignments ?? []) {
    if (a.is_training || !sourced.has(a.session_id)) continue;
    const role = roleName.get(a.role_id) ?? 'Unknown role';
    const k = `${a.staff_id}|${role}`;
    const u = uses.get(k) ?? uses.set(k, { staffId: a.staff_id, name: staffName.get(a.staff_id) ?? '',
      role, sessions: new Set() }).get(k);
    u.sessions.add(a.session_id);
  }
  return [...uses.values()].map(({ sessions, ...u }) => ({ ...u, count: sessions.size }));
}

const STATUS_ORDER = { merged: 0, ambiguous: 1, 'kept apart': 2 };

/**
 * The owner's name rule (config OWNER_NAME_RULE, confirmed 2 Oct 2026): "Match
 * them all. Everybody who is a role other than Flash Runner: there are no
 * duplicate names unless it's obviously a duplicate, like a James with a
 * different initial."
 *
 * Input: the validator sessions, `sched_staff`, and `scheduler` — the scheduler
 * people on scheduler-sourced sessions (`schedulerSourcedUses`). Entries in a
 * role in `rule.exceptRoles` take no part at all.
 *
 *   1. Names are compared on `ruleKey` (case-folded, spaces collapsed, trailing
 *      dots dropped). First word = first name; the rest = surname part, which
 *      may be an initial ("m") or empty.
 *   2. Within a first name, names are grouped by the FIRST LETTER of the
 *      surname part: "Sam O." and "Sam Ortiz" are one person; "Jamie
 *      Cole" and "Jamie Gray" are two, and "Jamie G." joins Gray.
 *   3. A bare first name joins the one person of its first name; where there
 *      are two or more it is AMBIGUOUS and left as its own name. A first name
 *      typed only bare is one person.
 *   4. Canonical = the fullest form (a surname of two or more letters), ties to
 *      the most used. The merged person takes the scheduler identity matching
 *      the canonical exactly and uniquely; failing that, the scheduler identity
 *      of a variant (the most used); failing that, `v:<canonical key>` — so
 *      scheduler- and validator-sourced sessions land on one person.
 *   5. `keepApart` pairs are different people: whichever of the two is not the
 *      canonical is split out as its own person, and a bare first name will not
 *      join a person it is kept apart from. `aliases` ('variant' -> 'canonical')
 *      join a name to the canonical's person whatever the rule says.
 *
 * Returns:
 *   table      [{ canonical, id, status: 'merged'|'ambiguous'|'kept apart',
 *                 variants: [{ name, source: 'validator'|'scheduler', roles,
 *                 count, alias? }], candidates? }] — for review. 'merged' rows
 *                 join two or more former identities; 'ambiguous' rows are bare
 *                 first names left alone, with the people they could be.
 *   identity   Map identity key -> { id, staffId, name, match } for merged people
 *   whoOf(key, role)  the identity key for a validator entry
 *   staffRemap Map scheduler staff id -> { id, name } for scheduler-sourced crews
 */
export function buildNameMerge({ sessions = [], staff = [], scheduler = [], rule = OWNER_NAME_RULE,
  keepApart = OWNER_NAME_KEEP_APART, aliases = OWNER_NAME_ALIASES } = {}) {
  const except = [...(rule?.exceptRoles ?? [])];
  const isExcept = (role) => except.includes(role);
  const staffByKey = new Map(); const staffByRk = new Map();
  for (const p of staff ?? []) {
    if (nameKey(p?.name)) push(staffByKey, nameKey(p.name), p);
    if (ruleKey(p?.name)) push(staffByRk, ruleKey(p.name), p);
  }
  const uniqueStaff = (map, k) => { const hits = map.get(k) ?? []; return hits.length === 1 ? hits[0] : null; };

  // Members: one per validator name (typed key) and one per scheduler person.
  const members = new Map();
  const member = (mid, base) => members.get(mid)
    ?? members.set(mid, { mid, ...base, roles: new Set(), count: 0, spell: new Map() }).get(mid);
  const tally = (m, role, name, n) => {
    m.roles.add(role); m.count += n; m.spell.set(name, (m.spell.get(name) ?? 0) + n);
  };
  for (const s of sessions) {
    for (const c of s.crew) {
      if (isExcept(c.role) || !ruleKey(c.name)) continue;
      tally(member(`v|${c.key}`, { source: 'validator', key: c.key, staffId: null }), c.role, c.name, 1);
    }
  }
  for (const u of scheduler ?? []) {
    const name = cleanName(u.name);
    if (isExcept(u.role) || !ruleKey(name) || !u.count) continue;
    tally(member(`s|${u.staffId}`, { source: 'scheduler', key: nameKey(name), staffId: u.staffId }), u.role, name, u.count);
  }
  for (const m of members.values()) {
    m.name = [...m.spell.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const parts = nameParts(m.name);
    m.rk = parts.key; m.first = parts.first; m.surname = parts.surname;
    if (m.source === 'validator') {
      const hit = uniqueStaff(staffByKey, m.key);
      m.preStaff = hit?.id ?? null;
      m.pre = hit ? hit.id : `v:${m.key}`;
    } else {
      m.preStaff = m.staffId; m.pre = m.staffId;
    }
  }

  const apartPairs = new Set();
  for (const pair of keepApart ?? []) {
    const [a, b] = (pair ?? []).map(ruleKey);
    if (a && b && a !== b) { apartPairs.add(`${a}|${b}`); apartPairs.add(`${b}|${a}`); }
  }
  const apart = (a, b) => apartPairs.has(`${a}|${b}`);
  const aliasOf = new Map();
  for (const [v, c] of Object.entries(aliases ?? {})) {
    if (ruleKey(v) && ruleKey(c) && ruleKey(v) !== ruleKey(c)) aliasOf.set(ruleKey(v), { rk: ruleKey(c), name: cleanName(c) });
  }

  /** The canonical spelling of a group: fullest, then most used, then longest. */
  const canonicalOf = (g) => {
    const byRk = new Map();
    for (const m of g) {
      const e = byRk.get(m.rk) ?? byRk.set(m.rk, { rk: m.rk, surname: m.surname, count: 0, best: m }).get(m.rk);
      e.count += m.count;
      if (m.count > e.best.count || (m.count === e.best.count && m.source === 'validator' && e.best.source !== 'validator')) e.best = m;
    }
    const c = [...byRk.values()].sort((a, b) => Number(b.surname.length > 1) - Number(a.surname.length > 1)
      || b.count - a.count || b.surname.length - a.surname.length || a.rk.localeCompare(b.rk))[0];
    return { rk: c.rk, name: c.best.name, key: c.best.key };
  };

  const pool = [...members.values()];
  const aliased = pool.filter((m) => aliasOf.has(m.rk));
  const ruled = pool.filter((m) => !aliasOf.has(m.rk));
  const groups = []; const ambiguous = [];
  if (rule?.mergeByFirstName) {
    const byFirst = new Map();
    for (const m of ruled) push(byFirst, m.first, m);
    for (const [first, list] of byFirst) {
      const letters = new Map();
      for (const m of list.filter((x) => x.surname)) push(letters, m.surname[0], m);
      const people = [];
      for (const g of letters.values()) {
        // Kept apart: whichever of a pair is not the canonical leaves the group.
        let rest = g;
        for (const p of apartPairs) {
          const [a, b] = p.split('|');
          if (!rest.some((m) => m.rk === a) || !rest.some((m) => m.rk === b)) continue;
          const canon = canonicalOf(rest).rk;
          const out = canon === b ? a : b;
          const moved = rest.filter((m) => m.rk === out);
          rest = rest.filter((m) => m.rk !== out);
          people.push(Object.assign(moved, { keptApart: true }));
        }
        people.push(rest);
      }
      const bare = list.filter((x) => !x.surname);
      if (!bare.length) { groups.push(...people); continue; }
      if (!people.length) { groups.push(bare); continue; }
      const cands = people.filter((g) => !g.some((m) => apart(m.rk, first)));
      if (cands.length === 1) cands[0].push(...bare);
      else if (!cands.length) groups.push(Object.assign(bare, { keptApart: true }));
      else ambiguous.push({ members: bare, candidates: cands });
      groups.push(...people);
    }
  } else {
    for (const m of ruled) groups.push([m]);
  }
  for (const m of aliased) {
    const to = aliasOf.get(m.rk);
    m.alias = true;
    const g = groups.find((x) => x.some((y) => y.rk === to.rk));
    if (g) g.push(m);
    else groups.push(Object.assign([m], { forced: { rk: to.rk, name: to.name, key: nameKey(to.name) } }));
  }

  const identity = new Map(); const memberOf = new Map(); const staffRemap = new Map();
  const table = [];
  // The canonical spelling first, then by use.
  const variantsOf = (g, rk = null) => [...g].sort((a, b) => Number(b.rk === rk) - Number(a.rk === rk)
    || b.count - a.count || a.name.localeCompare(b.name)
    || a.source.localeCompare(b.source)).map((m) => ({
    name: m.name, source: m.source, roles: [...m.roles].sort((a, b) => roleRank(a) - roleRank(b) || a.localeCompare(b)),
    count: m.count, ...(m.alias ? { alias: true } : {}),
  }));
  for (const g of groups) {
    const formerly = new Set(g.map((m) => m.pre));
    if (formerly.size < 2 && !g.forced && !g.keptApart) continue;
    const canon = g.forced ?? canonicalOf(g);
    const exact = uniqueStaff(staffByRk, canon.rk);
    let staffId = exact?.id ?? null;
    if (!staffId) {
      const ids = new Map();
      for (const m of g) if (m.preStaff) ids.set(m.preStaff, (ids.get(m.preStaff) ?? 0) + m.count);
      staffId = [...ids.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? null;
    }
    const id = staffId ?? `v:${canon.key}`;
    const name = exact ? (cleanName(exact.name) || canon.name) : canon.name;
    identity.set(canon.key, { id, staffId, name, match: staffId ? 'matched' : 'none' });
    for (const m of g) {
      if (m.source === 'validator') memberOf.set(m.key, canon.key);
      if (m.preStaff) staffRemap.set(m.preStaff, { id, name });
    }
    const status = formerly.size >= 2 || g.forced ? 'merged' : 'kept apart';
    table.push({ canonical: name, id, status, variants: variantsOf(g, canon.rk) });
  }
  for (const a of ambiguous) {
    table.push({ canonical: canonicalOf(a.members).name, id: null, status: 'ambiguous', variants: variantsOf(a.members),
      candidates: a.candidates.map((g) => {
        const c = canonicalOf(g);
        const hit = uniqueStaff(staffByRk, c.rk);
        return hit ? (cleanName(hit.name) || c.name) : c.name;
      }).sort((x, y) => x.localeCompare(y)) });
  }
  table.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.canonical.localeCompare(b.canonical));
  return {
    rule: rule ?? null, except,
    table,
    counts: {
      merged: table.filter((r) => r.status === 'merged').length,
      ambiguous: table.filter((r) => r.status === 'ambiguous').length,
      keptApart: table.filter((r) => r.status === 'kept apart').length,
      variants: table.filter((r) => r.status === 'merged').reduce((t, r) => t + r.variants.length, 0),
    },
    identity, staffRemap,
    whoOf: (key, role) => (isExcept(role) ? key : (memberOf.get(key) ?? key)),
  };
}

/** The merge table on its own: the rule applied, for review. Pure. */
export function nameMergeTable(input = {}) {
  return buildNameMerge(input).table;
}

/* ---------------------------------------------------------------------------
   The join to analytics
--------------------------------------------------------------------------- */

/**
 * Validator sessions to analytics events, by ORDINAL within (hall, date).
 *
 * `hallMap` maps the validator's hall id ('sc', 'rwc') to an analytics
 * location id — build it with forecast-model `hallMapFromLocations` (location
 * codes first), never by matching hall names here.
 *
 * Returns `{ links: Map eventId -> session, eventOf: Map sessionId -> eventId,
 * report }`. Each validator session that does not link is listed with why:
 *   'hall'       its hall has no analytics location
 *   'no-results' no analytics session that day at that hall (yet)
 *   'count'      the counts differ — two validator sessions and one result, or
 *                the reverse — so which is which is unknown; skipped
 */
export function joinValidator(sessions = [], events = [], hallMap = new Map()) {
  const links = new Map(); const eventOf = new Map();
  const report = { matched: 0, unmatched: [], mismatched: [] };
  const vByDay = new Map();
  for (const s of sessions) {
    const loc = hallMap.get(s.hall);
    if (!loc) { report.unmatched.push({ id: s.id, date: s.date, hall: s.hall, time: s.time, reason: 'hall' }); continue; }
    const k = `${s.date}|${loc}`;
    (vByDay.get(k) ?? vByDay.set(k, []).get(k)).push(s);
  }
  const eByDay = new Map();
  for (const e of events) {
    const k = `${e.event_date}|${e.location_id}`;
    (eByDay.get(k) ?? eByDay.set(k, []).get(k)).push(e);
  }
  for (const [k, vs] of vByDay) {
    const es = eByDay.get(k);
    if (!es) {
      for (const s of vs) report.unmatched.push({ id: s.id, date: s.date, hall: s.hall, time: s.time, reason: 'no-results' });
      continue;
    }
    if (es.length !== vs.length) {
      const [date, locationId] = k.split('|');
      report.mismatched.push({ date, locationId, hall: vs[0].hall, validator: vs.length, events: es.length });
      for (const s of vs) report.unmatched.push({ id: s.id, date: s.date, hall: s.hall, time: s.time, reason: 'count' });
      continue;
    }
    const v = [...vs].sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
    const e = [...es].sort((a, b) => (TYPE_ORDER[a.event_type] ?? 99) - (TYPE_ORDER[b.event_type] ?? 99));
    for (let i = 0; i < v.length; i += 1) {
      links.set(e[i].id, v[i]);
      eventOf.set(v[i].id, e[i].id);
      report.matched += 1;
    }
  }
  return { links, eventOf, report };
}

/* ---------------------------------------------------------------------------
   Crew per session
--------------------------------------------------------------------------- */

/** Every crew entry of a session with its identity, roster-ordered. */
export function fullCrew(session, ids = new Map()) {
  return session.crew.map((c) => {
    const who = ids.get(whoOf(c));
    return { role: c.role, slot: c.slot, order: c.order, key: c.key,
      id: who?.id ?? `v:${whoOf(c)}`, staffId: who?.staffId ?? null,
      name: who?.name ?? c.name, match: who?.match ?? 'none' };
  }).sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.role.localeCompare(b.role)
    || (a.slot ?? 99) - (b.slot ?? 99) || a.order - b.order);
}

/**
 * The managers of a session, in the shape `attributeManagers` returns:
 * `{ MOD: { staffId, name }, ... }`. Where a role lists more than one person,
 * the first in slot order is credited and `extra` says how many more there were.
 */
export function managerCrew(session, ids = new Map()) {
  const out = {};
  const crew = fullCrew(session, ids);
  for (const role of MANAGER_CREW_ROLES) {
    const list = crew.filter((c) => c.role === role);
    if (!list.length) continue;
    out[role] = { staffId: list[0].id, name: list[0].name, extra: list.length - 1 };
  }
  return out;
}

/* ---------------------------------------------------------------------------
   The whole model
--------------------------------------------------------------------------- */

/** Dates, counts and approval state of what the validator holds. */
export function validatorCoverage(all = [], sessions = [], ids = new Map()) {
  const dates = all.map((s) => s.date).filter(Boolean).sort();
  return {
    rows: all.length,
    sessions: sessions.length,
    first: dates[0] ?? null,
    last: dates.at(-1) ?? null,
    closed: all.filter((s) => s.status === 'closed').length,
    open: all.filter((s) => s.status === 'open').length,
    approved: all.filter((s) => s.approved).length,
    progress: all.filter((s) => s.staffStatus === 'progress').length,
    entries: all.reduce((t, s) => t + s.crew.length, 0),
    people: ids.size,
    matched: [...ids.values()].filter((i) => i.match === 'matched').length,
    ambiguous: [...ids.values()].filter((i) => i.match === 'ambiguous').length,
  };
}

const EMPTY = Object.freeze({
  ok: false, sessions: [], superseded: [], identities: new Map(), duplicates: [], names: null,
  join: { links: new Map(), eventOf: new Map(), report: { matched: 0, unmatched: [], mismatched: [] } },
  byEvent: new Map(), coverage: null,
});

/**
 * Everything the crew features use.
 *
 * `validator` is `schedule.validator` ({ ok, rows }). When it is missing or
 * failed, `ok` is false and every screen says "validator not connected";
 * scheduler-based figures carry on unchanged.
 */
export function buildCrewModel({
  validator = null, staff = [], events = [], hallMap = new Map(), schedule = null,
  nameRule = OWNER_NAME_RULE, keepApart = OWNER_NAME_KEEP_APART, aliases = OWNER_NAME_ALIASES,
} = {}) {
  const rule = { rule: nameRule, keepApart, aliases };
  if (!validator?.ok) {
    // The owner's name rule still joins scheduler spellings on Managers.
    const names = buildNameMerge({ staff, ...rule,
      scheduler: schedulerSourcedUses({ schedule, events, hallMap }) });
    return { ...EMPTY, identities: new Map(), byEvent: new Map(), names };
  }
  const all = normaliseValidator(validator.rows ?? []);
  const { sessions, superseded } = pickSessions(all);
  const join = joinValidator(sessions, events, hallMap);
  const names = buildNameMerge({ sessions, staff, ...rule,
    scheduler: schedulerSourcedUses({ schedule, events, hallMap, validatorLinks: join.links }) });
  for (const s of sessions) for (const c of s.crew) c.who = names.whoOf(c.key, c.role);
  const identities = buildIdentities(sessions, staff, names);
  const byEvent = new Map();
  for (const [eventId, s] of join.links) {
    byEvent.set(eventId, { session: s, approved: s.approved, crew: fullCrew(s, identities),
      managers: managerCrew(s, identities) });
  }
  return {
    ok: true, sessions, superseded, identities, names,
    // Only where the name rule does not merge (Flash Runners); elsewhere it has.
    duplicates: possibleDuplicates(sessions, identities, nameRule?.mergeByFirstName ? { roles: names.except } : {}),
    join, byEvent, coverage: validatorCoverage(all, sessions, identities),
  };
}

/* ---------------------------------------------------------------------------
   Crew source per session — validator first, scheduler second
--------------------------------------------------------------------------- */

/**
 * Pick each analytics session's crew source.
 *
 *   validator   a linked validator session with at least one crew entry —
 *               approved preferred by `pickSessions`; one still in 'progress'
 *               is used and flagged (`approved: false`)
 *   scheduler   otherwise the scheduler's attribution (`schedCrew`, a Map from
 *               event id to `{ role: { staffId, name } }`)
 *   none        neither
 *
 * Counts cover the SPAN of crewed sessions (first to last date with any crew),
 * so "K with no crew" means nights inside the covered period, not the whole
 * two-year history.
 */
export function mergeCrewSources({ events = [], schedCrew = new Map(), crew = null } = {}) {
  const crewOf = new Map(); const sourceOf = new Map();
  for (const e of events) {
    const v = crew?.ok ? crew.byEvent.get(e.id) : null;
    if (v && v.crew.length) {
      crewOf.set(e.id, v.managers);
      sourceOf.set(e.id, { source: 'validator', approved: v.approved, sessionId: v.session.id });
    } else if (schedCrew.has(e.id)) {
      crewOf.set(e.id, schedCrew.get(e.id));
      sourceOf.set(e.id, { source: 'scheduler', approved: null, sessionId: null });
    }
  }
  const crewed = events.filter((e) => sourceOf.has(e.id)).map((e) => e.event_date).sort();
  const span = crewed.length ? { start: crewed[0], end: crewed.at(-1) } : null;
  const counts = { validator: 0, validatorProgress: 0, scheduler: 0, none: 0, total: 0 };
  if (span) {
    for (const e of events) {
      if (e.event_date < span.start || e.event_date > span.end) continue;
      counts.total += 1;
      const s = sourceOf.get(e.id);
      if (!s) counts.none += 1;
      else if (s.source === 'validator') {
        counts.validator += 1;
        if (!s.approved) counts.validatorProgress += 1;
      } else counts.scheduler += 1;
    }
  }
  return { crewOf, sourceOf, counts, span };
}

/* ---------------------------------------------------------------------------
   Staff Overview — the Worked tab
--------------------------------------------------------------------------- */

/** The latest pay period holding any validator session, or null. */
export function latestValidatorPeriod(crew) {
  // The latest period with an APPROVED crew — so the tab does not open on a
  // period holding only tonight's unfinished session. Falls back to any data.
  const approved = (crew?.sessions ?? []).filter((s) => s.approved).map((s) => s.date).sort();
  const last = approved.at(-1) ?? crew?.coverage?.last ?? crew?.sessions?.at(-1)?.date ?? null;
  return last ? payPeriod(last) : null;
}

/**
 * Who worked, per person, from the validator. opts: { period (any date in it;
 * default the latest period with validator data), hall: 'all'|'sc'|'rwc',
 * role: 'all'|role NAME }.
 *
 * A "session worked" is a validator session the person is on the crew of; a
 * person listed twice on one crew (two roles) is one session, counted once
 * under each role.
 */
export function buildWorked(crew, opts = {}) {
  const hall = opts.hall && opts.hall !== 'all' ? opts.hall : null;
  const role = opts.role && opts.role !== 'all' ? opts.role : null;
  const anchor = opts.period ?? crew?.coverage?.last ?? null;
  const periods = anchor ? payPeriods(anchor) : null;
  const period = periods?.current ?? null;
  const ids = crew?.identities ?? new Map();
  const inView = (crew?.sessions ?? []).filter((s) => period && inPeriod(s.date, period)
    && (!hall || s.hall === hall));

  const people = new Map();
  const roleTotals = new Map();
  const counted = new Set();
  let places = 0;
  for (const s of inView) {
    for (const c of s.crew) {
      if (role && c.role !== role) continue;
      counted.add(s.id);
      places += 1;
      const who = ids.get(whoOf(c));
      const id = who?.id ?? `v:${whoOf(c)}`;
      const p = people.get(id) ?? people.set(id, {
        id, name: who?.name ?? c.name, match: who?.match ?? 'none', staffId: who?.staffId ?? null,
        sessions: new Set(), byRole: new Map(), byHall: new Map(), first: null, last: null,
        notApproved: new Set(),
      }).get(id);
      p.sessions.add(s.id);
      (p.byRole.get(c.role) ?? p.byRole.set(c.role, new Set()).get(c.role)).add(s.id);
      (p.byHall.get(s.hall) ?? p.byHall.set(s.hall, new Set()).get(s.hall)).add(s.id);
      if (!s.approved) p.notApproved.add(s.id);
      if (!p.first || s.date < p.first) p.first = s.date;
      if (!p.last || s.date > p.last) p.last = s.date;
      (roleTotals.get(c.role) ?? roleTotals.set(c.role, new Set()).get(c.role)).add(`${s.id}|${id}`);
    }
  }
  const rows = [...people.values()].map((p) => ({
    id: p.id, name: p.name, match: p.match, staffId: p.staffId,
    sessions: p.sessions.size,
    byRole: Object.fromEntries([...p.byRole].map(([r, set]) => [r, set.size])),
    byHall: Object.fromEntries([...p.byHall].map(([h, set]) => [h, set.size])),
    first: p.first, last: p.last, notApproved: p.notApproved.size,
  })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  const roles = [...roleTotals.keys()].sort((a, b) => roleRank(a) - roleRank(b) || a.localeCompare(b));
  const halls = [...new Set(inView.map((s) => s.hall))].sort();
  const sessionsCounted = inView.filter((s) => counted.has(s.id));
  return {
    period, periods, hall, role, rows, roles, halls,
    totals: {
      people: rows.length,
      sessions: sessionsCounted.length,
      places,
      byRole: Object.fromEntries(roles.map((r) => [r, roleTotals.get(r).size])),
      notApproved: sessionsCounted.filter((s) => !s.approved).length,
      unmatchedPeople: rows.filter((r) => r.match !== 'matched').length,
    },
  };
}

/* ---------------------------------------------------------------------------
   Scheduled vs worked
--------------------------------------------------------------------------- */

const countedStatus = (s) => !s?.status || COUNTED_STATUSES.includes(s.status);

/**
 * People scheduled but not on the validator crew, and on the crew but not
 * scheduled, for the sessions BOTH sources cover.
 *
 * Sessions are paired within (hall, date) by order — the scheduler's AM before
 * PM, the validator's earlier start before later — with the same count guard
 * as everywhere else: a day where the two disagree on how many sessions there
 * were is listed as a clash and not compared.
 *
 * People are compared ONLY through the exact-unique name map. A validator name
 * that maps to nobody cannot be said to be "not scheduled" — it may be a
 * scheduled person under another spelling — so it is listed in `unmatched`
 * and counted in neither direction. For the same reason a scheduled person on
 * a session that has unmatched names is flagged `maybeUnmatched`.
 *
 * Scheduler sessions count when deployed or planned (or carry no status);
 * training places are left out, as everywhere else.
 */
export function scheduledVsWorked({ crew = null, schedule = {}, period = null, hall = null } = {}) {
  const out = { compared: 0, both: 0, scheduledOnly: [], workedOnly: [], unmatched: [],
    clashes: [], span: null, possiblePairs: 0 };
  if (!crew?.ok) return out;
  const ids = crew.identities;
  const names = crew.names ?? null;
  const staffName = new Map((schedule.staff ?? []).map((p) => [p.id, cleanName(p.name ?? p.first_name) || 'Unknown']));
  const roleName = new Map((schedule.roles ?? []).map((r) => [r.id, r.name]));
  const asg = new Map();
  for (const a of schedule.assignments ?? []) {
    if (a.is_training) continue;
    (asg.get(a.session_id) ?? asg.set(a.session_id, []).get(a.session_id)).push(a);
  }
  const sByDay = new Map();
  for (const s of schedule.sessions ?? []) {
    if (!countedStatus(s) || !asg.has(s.id) || !s.session_date) continue;
    const k = `${String(s.hall_id).toLowerCase()}|${dateOf(s.session_date)}`;
    (sByDay.get(k) ?? sByDay.set(k, []).get(k)).push(s);
  }
  const vByDay = new Map();
  for (const s of crew.sessions) {
    if (!s.crew.length) continue;
    const k = `${s.hall}|${s.date}`;
    (vByDay.get(k) ?? vByDay.set(k, []).get(k)).push(s);
  }
  const both = [...vByDay.keys()].filter((k) => sByDay.has(k)).sort((a, b) =>
    a.slice(a.indexOf('|') + 1).localeCompare(b.slice(b.indexOf('|') + 1)) || a.localeCompare(b));
  if (both.length) {
    const ds = both.map((k) => k.slice(k.indexOf('|') + 1)).sort();
    out.span = { start: ds[0], end: ds.at(-1) };
  }
  for (const k of both) {
    const [h, date] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
    if (period && !inPeriod(date, period)) continue;
    if (hall && h !== hall) continue;
    const sl = [...sByDay.get(k)].sort((a, b) => (PART_ORDER[a.part] ?? 9) - (PART_ORDER[b.part] ?? 9));
    const vl = [...vByDay.get(k)].sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
    if (sl.length !== vl.length) {
      out.clashes.push({ date, hall: h, scheduled: sl.length, validator: vl.length });
      continue;
    }
    for (let i = 0; i < sl.length; i += 1) {
      const s = sl[i]; const v = vl[i];
      out.compared += 1;
      const sched = new Map();
      for (const a of asg.get(s.id)) {
        const role = roleName.get(a.role_id) ?? 'Unknown role';
        // The owner's name rule: a scheduler person merged with another
        // spelling counts as that person, except in the roles it leaves alone.
        const to = names?.except?.includes(role) ? null : names?.staffRemap?.get(a.staff_id);
        const sid = to?.id ?? a.staff_id;
        if (to) staffName.set(sid, to.name);
        const e = sched.get(sid) ?? sched.set(sid, new Set()).get(sid);
        e.add(role);
      }
      const worked = new Map(); const unmatchedHere = [];
      for (const c of v.crew) {
        const who = ids.get(whoOf(c));
        if (who?.match === 'matched') {
          const e = worked.get(who.staffId) ?? worked.set(who.staffId, { name: who.name, roles: new Set() }).get(who.staffId);
          e.roles.add(c.role);
        } else {
          unmatchedHere.push({ date, hall: h, time: v.time, part: s.part ?? null, name: who?.name ?? c.name,
            role: c.role, match: who?.match ?? 'none', possibly: null });
        }
      }
      const schedOnlyHere = [];
      for (const [staffId, roles] of sched) {
        if (worked.has(staffId)) { out.both += 1; continue; }
        schedOnlyHere.push({ date, hall: h, part: s.part ?? null, time: v.time, staffId,
          name: staffName.get(staffId) ?? 'Unknown', roles: [...roles].sort(),
          maybeUnmatched: unmatchedHere.length, possibly: null });
      }
      // A HINT, never a match: an unmatched crew name and a scheduled-only
      // person on the SAME session whose names start with the same word, when
      // each is the other's only such candidate. Shown beside both; counted in
      // neither direction.
      const first = (n) => wordsOf(nameKey(n))[0] ?? '';
      for (const u of unmatchedHere) {
        const c = schedOnlyHere.filter((x) => first(x.name) === first(u.name));
        if (c.length !== 1) continue;
        const back = unmatchedHere.filter((y) => first(y.name) === first(c[0].name));
        if (back.length !== 1) continue;
        u.possibly = c[0].name; c[0].possibly = u.name;
        out.possiblePairs += 1;
      }
      out.unmatched.push(...unmatchedHere);
      out.scheduledOnly.push(...schedOnlyHere);
      for (const [staffId, w] of worked) {
        if (sched.has(staffId)) continue;
        out.workedOnly.push({ date, hall: h, part: s.part ?? null, time: v.time, staffId,
          name: w.name, roles: [...w.roles].sort() });
      }
    }
  }
  return out;
}
