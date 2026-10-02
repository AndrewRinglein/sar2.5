/* ============================================================================
   SAR 2.0 — configuration

   THE TARGET DATABASE IS ESTABLISHED HERE, ONCE.

   `bms-production` is the database the running SAR application reads. That was
   determined by tracing the Supabase client `sar/app.html` constructs — it
   loads `../fgs-data.js`, which builds the client, and CI rewrites that URL to
   the production secret on any build of `main`.

   It was NOT determined by reading a project name off a dashboard. A project
   called "Vanguard SAR + Com + Finances", holding 771 plausible sessions for
   the right two halls with the right dates, turned out to be an earlier demo
   build. Most of a working session went into it. See SPEC §3.0.

   READ ONLY. Nothing in this project may create, alter or drop anything in
   bms-production — no table, no function, no policy, no migration.
   ========================================================================== */

/** Production. The only analytics source. */
export const SUPABASE_URL = 'https://faoqpyjhwvwgwvmgqxjr.supabase.co';

/**
 * Publishable key. Public by design — it ships in `fgs-data.js` and on the
 * deployed site. It is not a secret and is not treated as one: on its own it
 * reads nothing, because every analytics table is gated by
 * `analytics_has_access(customer_id)`, which requires a signed-in user with a
 * role in `user_roles`.
 */
export const SUPABASE_KEY = 'sb_publishable_rVzwH5plpZ3Z9yJvw4BLIg_4ZuJC0oT';

/**
 * The one tenant in scope. Every query is scoped by this EXPLICITLY rather
 * than assuming the data is already filtered — production carries nine
 * customer IDs, and an unscoped query silently mixes another tenant's
 * sessions in, making the numbers merely look slightly wrong.
 */
export const CUSTOMER_ID = 'vanguard';

/** Operational DB identity for source attribution; reads go through the SAR API below. */
export const OPS_URL = 'https://lkcfbgnuodqzvowschjn.supabase.co';

/**
 * Where the SAR API (Operations data, Ask SAR, Bingo Scout) is served.
 *
 *   On the owner's laptop (localhost / 127.0.0.1) the Vite dev server answers
 *   `/api/...` itself, exactly as before.
 *   Everywhere else (the GitHub Pages site) the same routes are served by the
 *   Supabase Edge Function `sar2-api` on the Operations project.
 *
 * Either way the browser sends only its bms-production sign-in token; no
 * database or Anthropic credential is ever in the browser.
 */
export const LOCAL_API_BASE = '/api';
export const EDGE_API_BASE = `${OPS_URL}/functions/v1/sar2-api`;
export const LOCAL_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1']);

/** The one decision: which API base this page should call. */
export function apiBase(hostname = globalThis.location?.hostname ?? '') {
  return LOCAL_HOSTNAMES.includes(hostname) ? LOCAL_API_BASE : EDGE_API_BASE;
}

/** How long cached reads stay fresh before a background refresh. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Tables readable WITHOUT a session, confirmed by a real anon call on
 * 12 Aug 2026. Everything else returns 200 with zero rows when signed out —
 * an empty result, not an error, which is exactly how a broken access model
 * masquerades as an empty database.
 */
export const PUBLIC_TABLES = Object.freeze([
  'analytics_config',
  'analytics_metric_definitions',   // is_active = true only
  'analytics_product_categories',
]);

/**
 * Flash ticket price in DOLLARS for this tenant. Confirmed by the owner on
 * 1 Oct 2026: $1 per ticket at both halls. A value stored on
 * `analytics_config.settings.flashTicketPrice` or
 * `locations[].settings.flashTicketPrice` overrides this; production holds
 * neither today, and this project may not write there (SPEC §3.1).
 */
export const FLASH_TICKET_PRICE = 1.00;

/**
 * Closures the OWNER has confirmed, which the forecast treats as fact rather
 * than learning from history. Keyed by holiday (a forecast-model HOLIDAYS key
 * or its common name) and analytics location CODE. Confirmed by the owner on
 * 1 Oct 2026: Santa Clara is closed on Christmas Day.
 *
 * Such a night is excluded and labelled "Closed — confirmed by owner". It can
 * still be re-opened for a scenario with the holiday "Open" switch, and a
 * deployed or planned roster session for that night still wins.
 */
export const OWNER_CLOSURES = Object.freeze([
  Object.freeze({ holiday: 'christmas', hall: 'SC', confirmed: '2026-10-01' }),
]);

/**
 * How crew names typed in different ways are treated as one person. Confirmed
 * by the owner on 2 Oct 2026: "Match them all. Everybody who is a role other
 * than Flash Runner: there are no duplicate names unless it's obviously a
 * duplicate, like a James with a different initial."
 *
 * Applied by crew-model `buildNameMerge` to every name in a role other than
 * `exceptRoles` — validator names, and scheduler people on the sessions whose
 * crew comes from the scheduler. Within one first name:
 *   - "Sam", "Sam O." and "Sam Ortiz" are one person, shown as the
 *     fullest form;
 *   - two different surnames or initials with different first letters are two
 *     people ("Jamie Cole", "Jamie Gray"); "Jamie G." joins Gray, and a bare
 *     "Jamie" is then AMBIGUOUS and left as its own name, listed for review.
 * Flash Runners entries are never merged by the rule: a person's Flash Runner
 * entries stay under the name as typed even when their MOD entries merge.
 * Every merge is listed on Managers and on Staff › Worked for review.
 */
export const OWNER_NAME_RULE = Object.freeze({
  mergeByFirstName: true, exceptRoles: Object.freeze(['Flash Runners']), confirmed: '2026-10-02',
});

/**
 * Names the owner has said are DIFFERENT people, as pairs of names as typed
 * (case, spacing and trailing dots ignored): `[['Sam O.', 'Sam Ortiz']]`.
 * Overrides the rule: where both names of a pair would merge, whichever is not
 * the merge's canonical (fullest) name is split out as its own person, and a
 * bare first name never joins a person it is kept apart from. Empty until the
 * owner names one.
 */
export const OWNER_NAME_KEEP_APART = Object.freeze([]);

/**
 * Explicit merges the owner has confirmed, 'variant' -> 'canonical', as typed:
 * `{ 'Bobby': 'Robert Smith' }`. Overrides the rule and the keep-apart list —
 * a nickname with a different first name, or a bare first name the rule left
 * ambiguous. Not applied to Flash Runners entries. Empty until the owner names one.
 */
export const OWNER_NAME_ALIASES = Object.freeze({});
