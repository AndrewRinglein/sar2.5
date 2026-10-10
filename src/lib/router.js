/* ============================================================================
   SAR 2.0 — routing

   Hash-based, so the app can be served from any path — a GitHub Pages
   subdirectory today, `vanguard.bingobuyin.com/sar2/` later — without server
   rewrite rules.

   Kept free of DOM so it can be tested without a browser. The shell reads the
   result; this file never touches an element.

   THE NAV LIST IS THE ROUTE TABLE. There is one definition of what screens
   exist and it lives here. SPEC §18 records that SAR 1.0 highlighted four nav
   items at once because saved views shared a `data-view` attribute with real
   screens — two sources of truth for "what is selected". One source here.
   ========================================================================== */

/**
 * Every screen, grouped as the rail shows them.
 *
 * `id` is the route. `unit` records which implementation unit builds it, so an
 * unbuilt screen can say so honestly instead of rendering an empty page.
 */
export const NAV = Object.freeze([
  {
    group: 'Sessions',
    items: [
      { id: 'dashboard',   label: 'Dashboard',      unit: 'U25' },
      { id: 'session',     label: 'Session detail', unit: 'U8' },
      { id: 'leaderboard', label: 'Leaderboard',    unit: 'U9' },
      { id: 'compare',     label: 'Compare',        unit: 'U18' },
      { id: 'jackpots',    label: 'Jackpots',       unit: 'U17' },
      { id: 'hotball',     label: 'Hotball pots',   unit: 'Hotball handoff' },
      { id: 'promotions',  label: 'Promotions',     unit: 'U31' },
      { id: 'runners',     label: 'Runners',        unit: 'U20' },
      { id: 'anomaly',     label: 'Anomalies',      unit: 'U21' },
      { id: 'reporting',   label: 'Reporting',      unit: 'U10b' },
    ],
  },
  {
    group: 'Plan & P&L',
    items: [
      { id: 'monthly-pl',      label: 'Monthly P&L',    unit: 'U10' },
      { id: 'unit-economics',  label: 'Unit economics', unit: 'U32' },
      { id: 'forecast',        label: 'Forecast',       unit: 'U33' },
      { id: 'venues',          label: 'Venues',         unit: 'U16' },
      { id: 'competition',     label: 'Competition',    unit: 'Competitive intelligence' },
    ],
  },
  {
    group: 'Operations',
    items: [
      { id: 'inventory',      label: 'Inventory',      unit: 'U27' },
      { id: 'commission',     label: 'Commission',     unit: 'U28' },
      { id: 'managers',       label: 'Managers',       unit: 'U24' },
      { id: 'staff-overview', label: 'Staff overview', unit: 'U29' },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'notifications', label: 'Notifications', unit: 'U35' },
      { id: 'data',    label: 'Data',         unit: 'U26' },
      { id: 'sources', label: 'Data sources', unit: 'U30' },
      { id: 'ask',     label: 'Ask SAR',      unit: 'U34' },
    ],
  },
]);

/** Flat lookup, derived — never maintained separately. */
export const SCREENS = Object.freeze(
  Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, { ...i, group: g.group }]))),
);

export const DEFAULT_SCREEN = 'session';

/**
 * Parse a location hash into a screen id and its parameters.
 *
 * `#/session?date=2026-08-06&hall=rwc` -> { screen, params }
 *
 * An unknown screen falls back to the default AND says so, rather than
 * silently redirecting — a typo in a shared link should be visible, not
 * disguised as a working page.
 */
export function parseHash(hash = '') {
  const raw = String(hash).replace(/^#/, '').replace(/^\//, '');
  if (!raw) return { screen: DEFAULT_SCREEN, params: {}, unknown: null };

  const [path, query = ''] = raw.split('?');
  const id = decodeURIComponent(path.split('/')[0] || '').trim();
  const params = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;

  if (!SCREENS[id]) return { screen: DEFAULT_SCREEN, params, unknown: id };
  return { screen: id, params, unknown: null };
}

/** Build a hash from a screen and params. Empty values are omitted, not `=`. */
export function buildHash(screen, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return `#/${screen}${s ? `?${s}` : ''}`;
}

/**
 * Which nav item is active.
 *
 * Returns **exactly one id or null**. SPEC §18: SAR 1.0 lit up four items
 * because several elements shared a `data-view` value. The signature makes
 * that impossible — there is one answer, not a set.
 */
export function activeItem(screen) {
  return SCREENS[screen] ? screen : null;
}

/**
 * Start listening. Calls `onRoute` immediately with the current route, then on
 * every change.
 */
export function startRouter(onRoute, win = globalThis) {
  const fire = () => onRoute(parseHash(win.location?.hash ?? ''));
  win.addEventListener?.('hashchange', fire);
  fire();
  return () => win.removeEventListener?.('hashchange', fire);
}

export function navigate(screen, params = {}, win = globalThis) {
  const next = buildHash(screen, params);
  if (win.location) {
    // Assigning an identical hash fires no event, so callers would hang
    // waiting for a re-render that never comes. Dispatch explicitly.
    if (win.location.hash === next) win.dispatchEvent?.(new win.Event('hashchange'));
    else win.location.hash = next;
  }
  return next;
}
