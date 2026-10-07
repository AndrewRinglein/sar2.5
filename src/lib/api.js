// Operations Auth + the private reporting snapshot, served only after membership checks.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, CACHE_TTL_MS, EDGE_API_BASE } from './config.js';
import { serverRequest } from './server-request.js';
import { mapSnapshot } from './analytics-snapshot.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
export class NotSignedIn extends Error {
  constructor(msg = 'Sign in to see session data') { super(msg); this.name = 'NotSignedIn'; }
}
export class NoAccess extends Error {
  constructor(msg = 'This email has not been approved for SAR access') { super(msg); this.name = 'NoAccess'; }
}
export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user ?? null;
}
export async function sendSignInLink(email) {
  const response = await fetch(EDGE_API_BASE + '/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: String(email ?? '').trim() }), signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Unable to send a sign-in link.');
  return result.message;
}
export function onAuthChange(fn) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    // Leave the Supabase callback lock before calling getSession during boot.
    setTimeout(() => fn(session?.user ?? null, event, session), 0);
  });
  return () => data?.subscription?.unsubscribe();
}
export async function signOut() {
  await supabase.auth.signOut();
  await clearCache();
}
export async function hasAccess() {
  try { return (await serverRequest('/api/access')).allowed === true; }
  catch (error) { if (error.status === 401 || error.status === 403) return false; throw error; }
}
export async function assertReadable() {
  const user = await currentUser();
  if (!user) throw new NotSignedIn();
  if (!(await hasAccess())) throw new NoAccess();
  return user;
}
const inFlight = new Map();
const DB_NAME = 'sar2-operations';
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
  inFlight.clear();
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
async function cached(key, loader, { force = false, maxAge = CACHE_TTL_MS } = {}) {
  const user = await currentUser();
  if (!user) throw new NotSignedIn();
  key = user.id + ':' + key;
  const hit = await cacheGet(key);
  const fresh = hit && (Date.now() - hit.at) < maxAge;
  if (fresh && !force) return { data: hit.value, stale: false, at: hit.at };

  try {
    const data = await loader();
    await cachePut(key, data);
    return { data, stale: false, at: Date.now() };
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new NoAccess();
    if (hit) return { data: hit.value, stale: true, at: hit.at, error: err };
    throw err;
  }
}


async function snapshot(options = {}) {
  const user = await currentUser();
  if (!user) throw new NotSignedIn();
  if (inFlight.has(user.id)) return inFlight.get(user.id);
  const pending = cached('analytics', () => serverRequest('/api/analytics'), options);
  inFlight.set(user.id, pending);
  try { return await pending; } finally { inFlight.delete(user.id); }
}
async function selectSnapshot(select, options) {
  const result = await snapshot(options);
  return { ...result, data: select(result.data) };
}
export const getConfig = options => selectSnapshot(r => r.config[0] ?? null, options);
export const getMetricDefinitions = options => selectSnapshot(r => r.metricDefs, options);
export const getProductCategories = options => selectSnapshot(r => mapSnapshot(r).categories, options);
export const getLocations = options => selectSnapshot(r => r.locations, options);
export const getRunners = options => selectSnapshot(r => ({ runners: r.runners, events: r.runnerEvents }), options);
export const getEvents = (options = {}) => selectSnapshot(r => {
  const { events, metrics } = mapSnapshot(r, options.since); return { events, metrics };
}, options);
export const getPromotions = options => selectSnapshot(r => r.promotions, options);
export const getMonthlySummary = options => selectSnapshot(r => r.monthlySummary, options);
// BMS account IDs do not represent Operations users; do not copy another user's read state.
export const getNotifications = options => selectSnapshot(r => ({ notifications: r.notifications, reads: [] }), options);
export async function bootstrap({ since = null, force = false, maxAge = CACHE_TTL_MS } = {}) {
  await assertReadable();
  const result = await snapshot({ force, maxAge });
  return { ...mapSnapshot(result.data, since), stale: result.stale, at: result.at };
}
