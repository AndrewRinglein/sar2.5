/* ============================================================================
   SAR 2.0 — production read layer

   WHAT THIS IS
   The single place SAR 2.0 talks to bms-production. Read only. There is no
   write path in this file and there must never be one.

   THE ACCESS MODEL, AND WHY IT IS NOT A LINK
   The original plan was a token in a URL and no login. That is impossible
   here. Every analytics table is gated by `analytics_has_access(customer_id)`,
   which resolves to:

       is_superadmin()  OR  a row in user_roles for auth.uid() + customer_id

   With no session there is no `auth.uid()`, so the policy is false and
   PostgREST returns **200 with an empty array** — not 403. Verified against
   production with the real anon key: analytics_events, analytics_event_data,
   locations, flash_runners and pos_shifts all returned zero rows signed out.

   That failure mode is the dangerous one. An empty array looks exactly like a
   database with no data in it, and would have been discovered somewhere around
   the fourth screen as "why is everything blank". Hence `assertReadable()`
   below, which refuses to let that silence pass.

   WHAT READS WITHOUT A SESSION
   analytics_config, active analytics_metric_definitions, and
   analytics_product_categories. Enough to brand the login screen, and nothing
   else. See config.PUBLIC_TABLES.
   ========================================================================== */

import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_KEY, CUSTOMER_ID, CACHE_TTL_MS,
} from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ---------------------------------------------------------------------------
   Errors — distinguishable, because the caller has to react differently to
   "you are signed out" than to "the network is down".
--------------------------------------------------------------------------- */
export class NotSignedIn extends Error {
  constructor(msg = 'Sign in to see session data') { super(msg); this.name = 'NotSignedIn'; }
}
export class NoAccess extends Error {
  constructor(msg = 'Signed in, but this account has no SAR role for Vanguard') {
    super(msg); this.name = 'NoAccess';
  }
}

/* ---------------------------------------------------------------------------
   Session
--------------------------------------------------------------------------- */
export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user ?? null;
}

/**
 * Email and password sign-in.
 *
 * WHY THIS IS THE DEFAULT RATHER THAN GOOGLE.
 * Google sign-in redirects out to google.com and back, and Supabase only
 * returns users to addresses on its allow-list. That list holds
 * `bingobuyin.com` and nothing else — which is why SAR 1.0 works and a local
 * build does not. Same database, same key; only the address differs.
 *
 * A password grant does not redirect. Supabase returns the session directly,
 * so this works from localhost, from GitHub Pages, from anywhere, with **no
 * change to any Supabase setting**. That is the whole reason it exists here.
 *
 * The password is typed by the user into their own browser and goes straight
 * to Supabase over TLS. It is never stored, logged, or put anywhere by this
 * code — the value leaves this function and is not retained.
 */
export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(password || ''),
  });
  if (error) {
    // Supabase returns the same message for a wrong password and an unknown
    // address, deliberately — do not "improve" it into something that reveals
    // which accounts exist.
    throw new Error(error.message || 'Sign-in failed');
  }
  return data;
}

/**
 * Google sign-in — the platform's existing flow, not a new one.
 *
 * Only works once the app is served from an address on Supabase's redirect
 * list. Offered as a secondary option, and the UI says so rather than
 * failing mysteriously.
 *
 * `access_type: 'offline'` and `prompt: 'consent'` match `fgs-data.js`
 * exactly. They matter: without them Google returns no refresh token on
 * repeat sign-ins, and the session silently stops renewing after an hour.
 *
 * The redirect returns to the exact URL the user started from, query string
 * included, so `?customer=` and any saved view survive the round trip.
 *
 * NOTE: this project never handles a password. Google collects the
 * credential on its own domain; SAR only ever sees the resulting session.
 */
export async function signInWithGoogle() {
  const redirectTo = window.location.origin + window.location.pathname + window.location.search;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  if (error) throw error;
  return data;
}

/**
 * Auth-state subscription.
 *
 * THE CALLBACK IS DEFERRED, AND THAT IS LOad-BEARING.
 *
 * supabase-js holds an internal navigator.locks lock for the duration of an
 * `onAuthStateChange` callback. Calling `getSession()` — or anything that
 * calls it, such as a full re-boot — from inside that callback waits on the
 * same lock, and the two deadlock. No error is thrown and no promise rejects:
 * the app simply sits on its loading state forever with a clean console.
 *
 * That is exactly what happened the first time this ran in a browser. Pushing
 * the callback to a fresh task with setTimeout(0) releases the lock first.
 *
 * The session is passed through as well, so callers have no reason to call
 * `getSession()` at all in response to a change.
 */
export function onAuthChange(fn) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(() => fn(session?.user ?? null, event, session), 0);
  });
  return () => data?.subscription?.unsubscribe();
}

export async function signOut() {
  await supabase.auth.signOut();
  await clearCache();
}

/**
 * Roles that `analytics_has_access()` accepts. Copied from the function
 * definition in production, which is the authority — if it changes there,
 * this list is wrong and the fallback below is what saves us.
 */
const SAR_ROLES = ['owner', 'admin', 'manager', 'staff', 'sar.admin', 'sar.view'];

/**
 * Is this account actually allowed to see Vanguard analytics?
 *
 * Reads the caller's own roles. `user_roles` carries a "Users can view own
 * roles" policy (`user_id = auth.uid()`), so this works for any signed-in
 * user without needing elevated rights.
 *
 * Why not just probe for one event: because "no rows" would then mean both
 * "you have no role" and "there is genuinely no data", and those need
 * different messages on screen. Asking about the role answers the question
 * actually being asked.
 *
 * The probe survives as a fallback, because `analytics_has_access()` also
 * returns true for `is_superadmin()`, and a superadmin need not have a
 * Vanguard row in `user_roles` at all.
 */
export async function hasAccess() {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('customer_id', CUSTOMER_ID);

  if (!error && data?.some((r) => SAR_ROLES.includes(r.role))) return true;

  const probe = await supabase
    .from('analytics_events')
    .select('id')
    .eq('customer_id', CUSTOMER_ID)
    .limit(1);
  if (probe.error) throw probe.error;
  return (probe.data?.length ?? 0) > 0;
}

/**
 * The guard that stops an empty array being mistaken for an empty business.
 *
 * Called before any screen renders. Turns the silent zero-row case into a
 * stated reason.
 */
export async function assertReadable() {
  const user = await currentUser();
  if (!user) throw new NotSignedIn();
  if (!(await hasAccess())) throw new NoAccess();
  return user;
}

/* ---------------------------------------------------------------------------
   Cache — IndexedDB, not localStorage.

   localStorage is synchronous, ~5 MB, and string-only. The event payload is
   larger than that and blocking the main thread to parse it is exactly the
   stutter SAR 1.0 has on open.
--------------------------------------------------------------------------- */
const DB_NAME = 'sar2';
const STORE = 'reads';
let _db;

function idb() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

async function cacheGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  } catch { return null; }   // a broken cache must never break the app
}

async function cachePut(key, value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ at: Date.now(), value }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* non-fatal */ }
}

export async function clearCache() {
  try {
    const db = await idb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch { /* non-fatal */ }
}

/**
 * Cache-then-refresh. Returns cached data immediately if fresh enough, and
 * refreshes behind it. A cold open shows something rather than a spinner; a
 * warm open shows last-known rather than nothing when the network is down.
 */
async function cached(key, loader, { force = false } = {}) {
  const hit = await cacheGet(key);
  const fresh = hit && (Date.now() - hit.at) < CACHE_TTL_MS;
  if (fresh && !force) return { data: hit.value, stale: false, at: hit.at };

  try {
    const data = await loader();
    await cachePut(key, data);
    return { data, stale: false, at: Date.now() };
  } catch (err) {
    if (hit) return { data: hit.value, stale: true, at: hit.at, error: err };
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   Paging.

   PostgREST caps a response. An un-paged read returns a plausible number that
   is quietly short — the failure that has already produced three wrong answers
   on this project. Nothing in this file reads without paging.
--------------------------------------------------------------------------- */
const PAGE = 1000;
/** How many ids go in one `in (...)` filter; 100 uuids is about 3.7 KB of URL. */
const ID_CHUNK = 100;
export const NOTIFICATION_LIMIT = 500;

async function all(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/* ---------------------------------------------------------------------------
   Reads
--------------------------------------------------------------------------- */

/** Tenant config — branding, timezone, currency, jackpot and schedule settings. */
export async function getConfig({ force } = {}) {
  return cached('config', async () => {
    const { data, error } = await supabase
      .from('analytics_config')
      .select('name, timezone, currency, settings, logo_url')
      .eq('customer_id', CUSTOMER_ID)
      .maybeSingle();
    if (error) throw error;
    return data;
  }, { force });
}

/** Metric definitions. `canonical_key` is what joins a metric to a category. */
export async function getMetricDefinitions({ force } = {}) {
  return cached('metric_defs', () => all(() => supabase
    .from('analytics_metric_definitions')
    .select('id, key, canonical_key, display_name, display_order, metric_type, data_type, aggregation, is_computed, formula, is_active')
    .eq('customer_id', CUSTOMER_ID)
    .eq('is_active', true)
    .order('display_order')
    .order('id')), { force });
}

/** Product categories, with their per-tenant colours. */
export async function getProductCategories({ force } = {}) {
  return cached('categories', async () => {
    const cats = await all(() => supabase
      .from('analytics_product_categories')
      .select('id, key, display_name, display_order, color_bg_from, color_bg_to, color_border, color_text, color_text_dark, show_rpa, show_margin')
      .eq('customer_id', CUSTOMER_ID)
      .eq('is_active', true)
      .order('display_order')
      .order('id'));

    const links = cats.length
      ? await all(() => supabase
          .from('analytics_product_category_metrics')
          .select('category_id, metric_key, role')
          .in('category_id', cats.map((c) => c.id))
          .order('id'))
      : [];

    // role is 'revenue' or 'payout' — the sign convention lives here, once.
    return cats.map((c) => ({
      ...c,
      revenue_keys: links.filter((l) => l.category_id === c.id && l.role === 'revenue').map((l) => l.metric_key),
      payout_keys:  links.filter((l) => l.category_id === c.id && l.role === 'payout').map((l) => l.metric_key),
    }));
  }, { force });
}

/**
 * Flash runners and their per-session performance.
 *
 * Inactive runners are dropped HERE rather than at the picker. SPEC §19a:
 * SAR 1.0 hides them from the dropdown but still counts them in comparison
 * totals, so the fleet numbers include people who no longer work there.
 */
export async function getRunners({ force } = {}) {
  return cached('runners', async () => {
    const runners = await all(() => supabase
      .from('flash_runners')
      .select('id, name, is_active, staff_id')
      .eq('customer_id', CUSTOMER_ID)
      .eq('is_active', true)
      .order('name')
      .order('id'));

    const events = await all(() => supabase
      .from('flash_runner_events')
      .select('id, runner_id, event_id, location_id, event_date, event_type, '
            + 'is_flash_desk, tickets_checked_out, tickets_sold, tickets_returned, '
            + 'tickets_unsold, cash_returned, credit_cards, revenue, restock_count')
      .eq('customer_id', CUSTOMER_ID)
      .order('event_date', { ascending: false })
      .order('id'));

    const activeIds = new Set(runners.map((r) => r.id));
    return {
      runners,
      // Sessions worked by runners who have since been deactivated are
      // excluded from every figure, not just from the list.
      events: events.filter((e) => activeIds.has(e.runner_id)),
    };
  }, { force });
}

/** Promotions. Empty on production today; read anyway so the screen fills in. */
export async function getPromotions({ force } = {}) {
  return cached('promotions', async () => all(() => supabase
    .from('promotions')
    .select('id, code, name, description, promo_type, discount_type, discount_value, '
          + 'valid_from, valid_to, max_uses, current_uses, is_active')
    .eq('customer_id', CUSTOMER_ID)
    .order('id')), { force });
}

/**
 * The stored monthly summary, read only to RECONCILE it against the metric
 * store (DATA-DESIGN §5). Its money columns are integer cents, like the EAV
 * store; they stopped tracking the metric store in March 2026, which is
 * exactly what Reconcile exists to show.
 */
export async function getMonthlySummary({ force } = {}) {
  return cached('monthly-summary', () => all(() => supabase
    .from('analytics_monthly_summary')
    .select('location_id, month, event_count, total_sales, net_sales, total_attendance')
    .eq('customer_id', CUSTOMER_ID)
    .order('location_id')
    .order('month')), { force });
}

/**
 * Notifications and this user's read state.
 *
 * Read only: `notification_reads` is fetched to SHOW what has been read, never
 * written to. Marking read is a write and SAR 2.0 does not write.
 */
export async function getNotifications({ force } = {}) {
  return cached('notifications', async () => {
    // The newest NOTIFICATION_LIMIT, in one page. (Going through all() would
    // let its paging range override the limit and read every row.)
    const { data, error } = await supabase
      .from('notifications')
      .select('id, event_type, severity, title, body, entity_type, entity_id, created_at')
      .eq('customer_id', CUSTOMER_ID)
      .order('created_at', { ascending: false })
      .order('id')
      .range(0, NOTIFICATION_LIMIT - 1);
    if (error) throw error;
    const notifications = data ?? [];
    // Read state in chunks so the `in` list never outgrows a URL.
    const ids = notifications.map((n) => n.id);
    const reads = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      reads.push(...await all(() => supabase
        .from('notification_reads')
        .select('user_id, notification_id, read_at, archived_at')
        .in('notification_id', ids.slice(i, i + ID_CHUNK))
        .order('notification_id')
        .order('user_id')));
    }
    return { notifications, reads };
  }, { force });
}

export async function getLocations({ force } = {}) {
  return cached('locations', () => all(() => supabase
    .from('locations')
    .select('id, name, code, settings')
    .eq('customer_id', CUSTOMER_ID)
    .order('name')
    .order('id')), { force });
}

/**
 * Sessions with their EAV metrics.
 *
 * Two reads, not a join: PostgREST cannot page an embedded one-to-many
 * sensibly, and — more importantly — a join here is how `count(*)` starts
 * counting metric values instead of sessions. Keeping them separate makes
 * that mistake impossible to make by accident.
 *
 * Values are INTEGER CENTS. They are not converted here. Conversion happens
 * once, at the display boundary, because SAR 1.0 has defects from code that
 * converted twice and from code that never converted at all.
 */
export async function getEvents({ since = null, force } = {}) {
  const key = `events:${since ?? 'all'}`;
  return cached(key, async () => {
    const events = await all(() => {
      let q = supabase
        .from('analytics_events')
        .select('id, customer_id, location_id, event_date, event_type, day_of_week, attendance, notes, metadata, created_at, updated_at')
        .eq('customer_id', CUSTOMER_ID)
        .order('event_date', { ascending: false })
        .order('id');
      if (since) q = q.gte('event_date', since);
      return q;
    });

    if (!events.length) return { events: [], metrics: {} };

    /* Metrics: chunked so the `in` list never outgrows a URL, and the chunks
       run CONCURRENTLY.

       Measured on real data: 820 sessions carry 36,318 metric rows, ~44 each.
       Fetched one chunk after another that was roughly 37 sequential round
       trips and took ~45 seconds on first load. The latency is not ours —
       the RLS policy on this table runs

           EXISTS (SELECT 1 FROM analytics_events e
                    WHERE e.id = event_id AND analytics_has_access(e.customer_id))

       and `analytics_has_access` is a SECURITY DEFINER plpgsql function, so it
       is evaluated per row. We cannot change that policy (production is read
       only), so the lever we do have is not waiting for each request in turn.

       Concurrency is capped: enough to overlap the waiting, not so much that
       we hammer a database other people are using. */
    const metrics = {};
    const ids = events.map((e) => e.id);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));

    const LIMIT = 6;
    for (let i = 0; i < chunks.length; i += LIMIT) {
      const batches = await Promise.all(
        chunks.slice(i, i + LIMIT).map((c) => all(() => supabase
          .from('analytics_event_data')
          .select('event_id, metric_id, value')
          .in('event_id', c)
          .order('id'))),
      );
      for (const rows of batches) {
        for (const r of rows) (metrics[r.event_id] ||= {})[r.metric_id] = r.value;
      }
    }

    return { events, metrics };
  }, { force });
}

/**
 * Everything a screen needs to boot, in one call.
 *
 * Deliberately fails loudly rather than returning empty structures — see
 * assertReadable().
 */
export async function bootstrap({ since = null, force = false } = {}) {
  await assertReadable();
  const [config, metricDefs, categories, locations, events, runners] = await Promise.all([
    getConfig({ force }),
    getMetricDefinitions({ force }),
    getProductCategories({ force }),
    getLocations({ force }),
    getEvents({ since, force }),
    getRunners({ force }),
  ]);
  return {
    config: config.data,
    metricDefs: metricDefs.data,
    categories: categories.data,
    locations: locations.data,
    events: events.data.events,
    metrics: events.data.metrics,
    runners: runners.data.runners,
    runnerEvents: runners.data.events,
    stale: [config, metricDefs, categories, locations, events, runners].some((r) => r.stale),
    at: Math.min(...[config, metricDefs, categories, locations, events, runners].map((r) => r.at)),
  };
}
