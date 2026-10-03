/* ============================================================================
   Bingo Scout — the hall inbox and the directory

   Pure functions over the Bingo Monitor's collection (GET /api/monitor), so
   they can be tested without a browser.

   THE HALL IS THE KEY, NOT THE SENDER. Many halls text from one shared short
   code (70503 carries a dozen of them), so a sender number identifies nothing.
   Every message carries `hallIds`, set by the monitor's classifier; that is
   the only attribution used here.

   ONE CARD PER HALL, TEXTS AND EMAILS TOGETHER. The counts on a card are the
   monitor's own (`summaries`: count, smsCount, emailCount) so the card and
   the collector can never disagree. A message sent to several halls (a
   shared list) appears in each hall's history, once per hall.

   THE DIRECTORY IS NOT THE MAP. The directory lists every hall the monitor
   knows, whatever its research state. The competitive maps count only halls
   whose `competitionEligibility.status` is "qualified" (an operator website
   and at least weekly bingo). Halls that need their schedule verified are
   shown separately, never silently counted.
   ========================================================================== */

/** Message kinds that are about the subscription, not about bingo. */
const PROCEDURAL_KINDS = new Set([
  'procedural', 'operational', 'welcome', 'verification', 'enrollment', 'confirmation', 'opt_in', 'opt_out', 'system',
]);
/**
 * Subscription chatter, recognised by its wording when the classifier left
 * no kind: "You're now subscribed", "Reply Y to confirm", "verification code".
 * Narrow on purpose: a promotion that merely ends "Reply STOP to opt out" is
 * still a promotion.
 */
const PROCEDURAL_TEXT = /\b(you(?:'|’)?re now (?:subscribed|enrolled|signed up)|thanks? for (?:subscribing|signing up|joining)|welcome to (?:our|the) (?:text|sms|vip)|reply (?:y|yes) to confirm|confirm your (?:subscription|number)|verification code|your code is)\b/i;

export function isProcedural(m = {}) {
  if (PROCEDURAL_KINDS.has(String(m.kind || '').toLowerCase())) return true;
  if (m.kind && m.kind !== '') return false;
  return PROCEDURAL_TEXT.test(`${m.subject || ''} ${m.body || ''}`);
}

/** Text or Email, as the inbox labels it. */
export const channelLabel = (m) => (m.channel === 'email' ? 'Email' : 'Text');

/**
 * An email as the hall sent it: the collection inbox is a Google Group, which
 * appends its own footer ("You received this message because you are
 * subscribed…"). That is ours, not the hall's, so it is cut.
 */
export function cleanBody(m = {}) {
  let b = String(m.body ?? '');
  if (m.channel === 'email') {
    const cut = b.search(/\r?\n-- ?\r?\nYou received this message because you are subscribed to the Google Groups/);
    if (cut >= 0) b = b.slice(0, cut);
  }
  return b.trim();
}

const when = (m) => Date.parse(m?.receivedAt ?? '') || 0;

/** The halls the monitor knows, without aliases of other records. */
export function directory(halls = []) {
  return halls.filter((h) => h && h.id && !h.duplicateOf);
}

export const ELIGIBILITY = Object.freeze({
  qualified: 'On the competitive maps',
  needs_verification: 'Schedule to verify',
  excluded: 'Not a competitor',
});
export function eligibilityOf(h) {
  const s = h?.competitionEligibility?.status;
  return { status: s ?? 'unknown', label: ELIGIBILITY[s] ?? 'Not yet assessed', reason: h?.competitionEligibility?.reason ?? '' };
}

/**
 * One card per hall that has updates, newest first. Counts come from the
 * monitor's summary for that hall ID. A hall ID missing from the directory
 * still gets a card, named by its ID, rather than vanishing.
 */
export function inboxCards(snapshot = {}) {
  const byId = new Map(directory(snapshot.halls ?? []).map((h) => [h.id, h]));
  return (snapshot.summaries ?? [])
    .filter((s) => s && s.hallId)
    .map((s) => {
      const h = byId.get(s.hallId);
      const latest = s.latest ?? null;
      return {
        hallId: s.hallId,
        name: h?.name ?? s.hallId,
        city: h?.city ?? '',
        known: Boolean(h),
        total: Number(s.count) || 0,
        sms: Number(s.smsCount) || 0,
        email: Number(s.emailCount) || 0,
        latest: latest ? {
          at: latest.receivedAt ?? null,
          channel: channelLabel(latest),
          subject: latest.subject ?? null,
          preview: cleanBody(latest).replace(/\s+/g, ' ').slice(0, 220),
        } : null,
        eligibility: eligibilityOf(h),
      };
    })
    .sort((a, b) => (Date.parse(b.latest?.at ?? '') || 0) - (Date.parse(a.latest?.at ?? '') || 0)
      || a.name.localeCompare(b.name));
}

/**
 * A hall's history as the inbox shows it: newest first, procedural messages
 * left out, every message kept (two identical texts on two days are two
 * rows), and the other halls of a shared message named.
 */
export function historyRows(messages = [], hallId, halls = []) {
  const names = new Map(directory(halls).map((h) => [h.id, h.name]));
  const seen = new Set();
  const rows = [];
  for (const m of messages) {
    if (!m || isProcedural(m)) continue;
    const ids = m.hallIds?.length ? m.hallIds : [m.hallId];
    if (hallId && !ids.includes(hallId)) continue;
    // The same stored message delivered twice by paging is one row; two
    // messages with the same words are two rows.
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    rows.push({
      id: m.id ?? null,
      at: m.receivedAt ?? null,
      channel: channelLabel(m),
      subject: m.channel === 'email' ? (m.subject || '(no subject)') : null,
      body: cleanBody(m),
      sharedWith: ids.filter((id) => id !== hallId).map((id) => names.get(id) ?? id),
    });
  }
  return rows.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
}

/** One day's updates across every hall, newest first, procedural left out. */
export function dayRows(messages = [], halls = []) {
  const names = new Map(directory(halls).map((h) => [h.id, h.name]));
  return messages
    .filter((m) => m && !isProcedural(m))
    .map((m) => {
      const ids = m.hallIds?.length ? m.hallIds : (m.hallId ? [m.hallId] : []);
      return {
        id: m.id ?? null, at: m.receivedAt ?? null, channel: channelLabel(m),
        subject: m.channel === 'email' ? (m.subject || '(no subject)') : null,
        body: cleanBody(m), hallIds: ids,
        halls: ids.map((id) => names.get(id) ?? id),
        unassigned: ids.length === 0,
      };
    })
    .sort((a, b) => when({ receivedAt: b.at }) - when({ receivedAt: a.at }));
}

/** A valid calendar date as YYYY-MM-DD, or null. */
export function validDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * Physical locations behind a set of program listings. Several charities can
 * run programs in one building, so programs ≥ locations. Keyed by the
 * geocoded point (to ~10 m) where there is one, else the normalised address;
 * a listing with neither is its own location.
 */
export function locationKey(h) {
  const { lat, lng } = h?.location ?? {};
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `@${lat.toFixed(4)},${lng.toFixed(4)}`;
  const a = String(h?.address ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return a ? `#${a}` : `!${h?.id}`;
}
export function locationCount(halls = []) {
  return new Set(halls.map(locationKey)).size;
}

/** The directory, filtered, alphabetical. */
export function directoryRows(halls = [], { status = '', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  return directory(halls)
    .filter((h) => !status || eligibilityOf(h).status === status)
    .filter((h) => !q || `${h.name} ${h.city} ${h.address ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}
