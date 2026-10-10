/* ============================================================================
   SAR 2.0 — Hotball pots: the night-by-night chain and its pot drops

   Ported from the "Hotball Pots: Developer Handoff" (9 Oct 2026): its
   reference SQL decides the numbers, and this file must reproduce that SQL
   row for row (test/hotball.test.mjs checks it against the live output).
   `hotball.html` in Session Reconciliation adds cash movements on top; they
   are applied the same way here.

   THE OWNER'S RULE. If the next night opens lower than the pot the night
   before, the pot dropped by the difference after that earlier night. It is
   a POT DROP, never "paid out": the halls do not know that every drop was a
   winner. Drops found this way are counted automatically and labelled with
   their basis, so nobody mistakes one for a keyed payout.

   Three chains: RWC Hotball ($5, RWC only), SC Hotball ($5, SC only) and Mega
   Hotball ($10), one pot SHARED by both halls — a drop at either lowers it
   for both, so its chain interleaves the two halls by date and time.

   Gaps that are NOT money, flagged and left out of drop totals:
     startup      a session opened on the app's built-in default (before
                  STARTUP_BEFORE), or the next one did
     skipped      the next session opened on an OLDER session's closing (up to
                  SKIP_LOOKBACK back), so this one's additions were skipped
     restores     a later raise equal to an earlier skip puts them back
     raise        a raise one opening that the next opening takes back is
                  netted against the following drop
     shift back   a drop with no hit ticked, after a session with a hit ticked
                  and nothing paid, is credited to that earlier session
   ========================================================================== */

/** The validator app's built-in openings, by ledger key. Not configurable:
 *  they are what the app typed in before real carries existed. */
export const DEFAULT_OPENING = Object.freeze({ hotball: 9820, mega_hotball: 71110 });
/** Real carries start on this date; a default opening after it is real money. */
export const STARTUP_BEFORE = '2026-08-19';
/** How far back a "skipped" opening is looked for. */
export const SKIP_LOOKBACK = 6;

export const MOVEMENT_KINDS = Object.freeze({
  payout:   { label: 'Pot drop',       sign: -1 },
  cash_out: { label: 'Cash out',       sign: -1 },
  cash_in:  { label: 'Cash in',        sign: 1 },
  count:    { label: 'Envelope count', sign: 0 },
});

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);
const cents = (v) => Math.round(v * 100) / 100;
const same = (a, b) => Math.abs(a - b) < 0.005;
/** The reference SQL's to_char(x, 'FM$999,999'). */
export const wholeUsd = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

export function potKeyOf(row) {
  return row.pot === 'mega_hotball' ? 'mega' : `${row.hall_id}_hotball`;
}

/** Labels come from the data's hall ids, never from a hall-name pattern. */
export function potLabel(key) {
  if (key === 'mega') return 'Mega Hotball';
  return `${key.replace(/_hotball$/, '').toUpperCase()} Hotball`;
}

const stamp = (date, time) => `${date}|${time || ''}`;

/**
 * Walk one chain (rows already sorted) and derive every column. Pure: the
 * input rows are not changed.
 */
export function walkChain(sorted, movements = []) {
  const list = sorted.map((r) => {
    const opening = num(r.opening);
    const added = num(r.added);
    const total = r.total === null || r.total === undefined ? opening + added : num(r.total);
    const paidLedger = num(r.paid_ledger);
    // On the Mega pot the app drops the single Paid box from the ledger;
    // what the paymaster typed recovers it (handoff, rule 2).
    const paidKeyed = (!r.overridden && r.typed_hit && num(r.typed_paid) > paidLedger)
      ? num(r.typed_paid) : paidLedger;
    const closingLedger = r.closing_ledger === null || r.closing_ledger === undefined
      ? total - paidLedger : num(r.closing_ledger);
    return {
      pot: r.pot, potKey: potKeyOf(r), hall: String(r.hall_id || '').toUpperCase(),
      date: r.session_date, time: r.session_time || '', slot: r.slot_name || '', status: r.status,
      opening, added, total, paidLedger, paidKeyed,
      hitMarked: !!(r.hit_ledger || r.typed_hit || r.typed_hits_any),
      overridden: !!r.overridden, overrideReason: r.override_reason ?? null,
      defaultOpening: opening === DEFAULT_OPENING[r.pot] && !r.carry_edited
        && r.session_date < STARTUP_BEFORE,
      closingBase: paidKeyed > paidLedger ? Math.max(total - paidKeyed, 0) : closingLedger,
      moves: [], counts: [],
    };
  });

  // Each movement belongs to the latest session at or before it; a movement
  // with no time belongs after the last session that day.
  for (const m of movements) {
    const at = stamp(m.movement_date, m.session_time || '99:99');
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
      if (stamp(list[i].date, list[i].time) <= at) idx = i; else break;
    }
    if (idx < 0 || !MOVEMENT_KINDS[m.kind]) continue;
    (m.kind === 'count' ? list[idx].counts : list[idx].moves).push(m);
  }

  for (const r of list) {
    r.moveNet = r.moves.reduce((s, m) => s + MOVEMENT_KINDS[m.kind].sign * num(m.amount), 0);
    r.movedDrops = r.moves.filter((m) => m.kind === 'payout').reduce((s, m) => s + num(m.amount), 0);
    r.closing = cents(r.closingBase + r.moveNet);
    r.count = r.counts.length ? num(r.counts.at(-1).amount) : null;
  }

  list.forEach((r, i) => {
    const nx = list[i + 1];
    r.nextOpening = nx ? nx.opening : null;
    r.nextDefault = nx ? nx.defaultOpening : false;
    r.gap = nx ? cents(nx.opening - r.closing) : null;
    r.startup = r.defaultOpening || r.nextDefault;
    r.skipped = (r.nextOpening ?? 0) > 0
      && list.slice(Math.max(0, i - SKIP_LOOKBACK), i).some((q) => same(q.closing, r.nextOpening));
  });
  list.forEach((r, i) => {
    r.restores = r.gap !== null && r.gap > 0 && !r.startup
      && list.slice(Math.max(0, i - SKIP_LOOKBACK), i).some((x) => x.skipped && x.gap !== null && same(-x.gap, r.gap));
  });
  list.forEach((r, i) => {
    const p = list[i - 1];
    r.prevRaise = p && p.gap !== null && p.gap > 0 && !p.startup && !p.restores ? p.gap : 0;
    r.prevHitUnpaid = !!(p && p.hitMarked && p.paidKeyed === 0 && p.movedDrops === 0 && p.gap !== null && same(p.gap, 0));
    r.derivedRaw = r.gap !== null && r.gap < 0 && !r.startup && !r.skipped
      ? cents(Math.max(-r.gap - r.prevRaise, 0)) : 0;
    r.shiftBack = r.derivedRaw > 0 && !r.hitMarked && r.prevHitUnpaid;
  });
  list.forEach((r, i) => {
    const nx = list[i + 1];
    r.derivedNext = nx && nx.shiftBack ? nx.derivedRaw : 0;
    r.derived = (r.shiftBack ? 0 : r.derivedRaw) + r.derivedNext;
    r.drop = cents(r.paidKeyed + r.movedDrops + r.derived);
    const otherMoves = r.moveNet + r.movedDrops; // cash in/out, without recorded drops
    r.potAfter = r.drop > 0
      ? Math.max(cents(r.total - r.drop + otherMoves), 0)
      : (r.nextOpening !== null && !r.skipped && !r.startup ? r.nextOpening : r.closing);
    r.balanced = r.gap === null || same(r.gap, 0);
    r.basis = basisOf(r);
    r.notes = notesOf(r);
  });
  return list;
}

/** Where a pot drop's amount came from, in the words the handoff uses. */
function basisOf(r) {
  if (r.drop <= 0) return '';
  const parts = [];
  if (r.paidKeyed > 0) parts.push(r.paidKeyed > r.paidLedger ? 'Paid box (state only)' : 'Paid box');
  if (r.movedDrops > 0) parts.push('Recorded pot drop');
  if (r.derived > 0) {
    let s = 'Next opening';
    if (r.hitMarked) s += ', hit ticked';
    if (r.derivedNext > 0) s += ' (credited back)';
    if (r.prevRaise > 0 && r.derivedRaw > 0) s += `, net of +${wholeUsd(r.prevRaise)}`;
    parts.push(s);
  }
  return parts.join(' + ');
}

/** The plain-English notes, worded exactly as the reference SQL words them. */
function notesOf(r) {
  const n = [];
  if (r.defaultOpening) n.push('Opened on the app default, not a real carry');
  if (!r.defaultOpening && r.nextDefault) n.push('Next session opened on the app default');
  if (r.skipped) n.push('Next session opened past this one, so its additions were skipped');
  if (r.restores) n.push(`Next opening raised ${wholeUsd(r.gap)} to restore skipped additions`);
  if (r.gap !== null && r.gap > 0 && !r.startup && !r.restores) n.push(`Next session opened ${wholeUsd(r.gap)} higher`);
  if (r.gap !== null && r.gap < 0 && !r.startup && !r.skipped && r.derivedRaw === 0) {
    n.push(`Next opening ${wholeUsd(-r.gap)} lower, reversing the raise before`);
  }
  if (r.prevRaise > 0 && r.derivedRaw > 0) n.push(`Net of the ${wholeUsd(r.prevRaise)} raise the session before`);
  if (r.derivedNext > 0) n.push('Amount is the pot drop found one session later');
  if (r.shiftBack) n.push('Pot drop credited to the hit ticked the session before');
  if (r.paidKeyed > r.paidLedger) n.push('Amount typed in the Paid box but the ledger saved 0');
  if (r.overridden) n.push(`Closing overridden: ${r.overrideReason ?? 'no reason given'}`);
  return n;
}

/** Summary figures for one walked chain. */
export function summarize(key, list) {
  const last = list.at(-1) ?? null;
  let lastDropIdx = -1;
  list.forEach((r, i) => { if (r.drop > 0) lastDropIdx = i; });
  const lastDrop = lastDropIdx >= 0 ? list[lastDropIdx] : null;
  const after = list.slice(lastDropIdx + 1);
  const counted = [...list].reverse().find((r) => r.count !== null) ?? null;
  return {
    key, label: potLabel(key), shared: key === 'mega',
    rows: list,
    now: last ? last.potAfter : null,
    asOf: last,
    lastDrop,
    sessionsSince: lastDrop ? after.length : null,
    addedSince: after.reduce((s, r) => s + r.added, 0),
    count: counted ? { row: counted, amount: counted.count, overShort: cents(counted.count - counted.potAfter) } : null,
    drops: list.filter((r) => r.drop > 0),
    totalDropped: cents(list.reduce((s, r) => s + r.drop, 0)),
  };
}

/** Pot order on screen: the shared pot first, then the halls' own pots. */
const ORDER = (a, b) => (a === 'mega' ? -1 : b === 'mega' ? 1 : a.localeCompare(b));

/**
 * Build every pot from the projected rows and the unvoided movements.
 * `through` (YYYY-MM-DD) cuts the chains off after that date — used to check
 * the handoff's figures, which were taken before a later session arrived.
 */
export function buildHotball({ rows = [], movements = [], through = null } = {}) {
  const byPot = new Map();
  for (const r of rows) {
    if (!DEFAULT_OPENING[r.pot] || !r.session_date) continue;
    if (through && r.session_date > through) continue;
    const key = potKeyOf(r);
    if (!byPot.has(key)) byPot.set(key, []);
    byPot.get(key).push(r);
  }
  const pots = [...byPot.keys()].sort(ORDER).map((key) => {
    const sorted = byPot.get(key).sort((a, b) =>
      stamp(a.session_date, a.session_time).localeCompare(stamp(b.session_date, b.session_time)));
    const moves = movements.filter((m) => m.pot_key === key && (!through || m.movement_date <= through));
    return summarize(key, walkChain(sorted, moves));
  });
  const drops = pots.flatMap((p) => p.drops.map((r) => ({ ...r, potLabel: p.label })))
    .sort((a, b) => stamp(b.date, b.time).localeCompare(stamp(a.date, a.time)));
  return {
    pots,
    drops,
    totalDropped: cents(drops.reduce((s, r) => s + r.drop, 0)),
    sessions: new Set(rows.filter((r) => !through || r.session_date <= through)
      .map((r) => `${r.hall_id}|${r.session_date}|${r.session_time}`)).size,
  };
}
