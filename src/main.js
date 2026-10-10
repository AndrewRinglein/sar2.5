import './styles.css';
import {
  currentUser, onAuthChange, sendSignInLink, signOut,
  bootstrap, getPromotions, getMonthlySummary, getNotifications, currentUser as whoami, NotSignedIn, NoAccess,
} from './lib/api.js';
import { CUSTOMER_ID, CACHE_TTL_MS } from './lib/config.js';
import { esc } from './lib/fmt.js';
import { startRouter, navigate, activeItem, SCREENS } from './lib/router.js';
import { renderRail, setActive } from './components/rail.js';
import { renderInspector, setInspector, inspectorIdle, wireInspector } from './components/inspector.js';
import { indexMetrics } from './lib/model.js';
import { renderSession } from './screens/session.js';
import { renderLeaderboard } from './screens/leaderboard.js';
import { renderJackpots } from './screens/jackpots.js';
import { renderHotball } from './screens/hotball.js';
import { renderMonthlyPL } from './screens/monthly-pl.js';
import { renderCompare } from './screens/compare.js';
import { renderVenues } from './screens/venues.js';
import { renderAnomaly } from './screens/anomaly.js';
import { renderReporting } from './screens/reporting.js';
import { renderRunners } from './screens/runners.js';
import { renderManagers, makeValuesOf } from './screens/managers.js';
import { renderDashboard } from './screens/dashboard.js';
import { renderData } from './screens/data.js';
import { renderInventory } from './screens/inventory.js';
import { renderCommission } from './screens/commission.js';
import { renderStaff } from './screens/staff.js';
import { renderSources } from './screens/sources.js';
import { renderPromotions } from './screens/promotions.js';
import { renderUnitEconomics } from './screens/unit-economics.js';
import { renderForecast } from './screens/forecast.js';
import { renderAsk } from './screens/ask.js';
import { renderNotifications } from './screens/notifications.js';
import { getSchedule } from './lib/ops.js';
import { buildManagerModel } from './lib/managers.js';
import { buildCrewModel } from './lib/crew-model.js';
import { hallMapFromLocations } from './lib/forecast-model.js';

/** Injected by Vite from package.json. The only version in the project. */
export const VERSION = __APP_VERSION__;

const el = (html) => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

/* ---------------------------------------------------------------------------
   Screens shown before the app proper
--------------------------------------------------------------------------- */
/**
 * The tenant's display name, once known.
 *
 * NOT a constant. The boot screens hardcoded "Vanguard Music & Performing
 * Arts" until the rail — which reads `analytics_config.name` — rendered
 * "Vanguard Charity Bingo" beside it. Caught by looking at the screenshot,
 * not by reading the code. The pre-auth screens cannot know the name yet, so
 * they say nothing rather than guessing.
 */
let orgName = null;

function shell({ title, body, status, statusKind = '', action }) {
  return el(`
    <div class="boot">
      <div class="boot-inner">
        <img src="./vanguard_logo.png" alt="">
        <h1>SAR</h1>
        <p><strong>Session Analysis Reporting</strong>${orgName ? `<br>${esc(orgName)}` : ''}</p>
        ${title ? `<p class="semi">${title}</p>` : ''}
        ${body ? `<p>${body}</p>` : ''}
        ${action ? `<p style="margin-top:var(--s-5)">${action}</p>` : ''}
        ${status ? `<div class="boot-status ${statusKind}" role="status"><span class="dot"></span>${esc(status)}</div>` : ''}
        <p class="version" style="margin-top:var(--s-6)">v${VERSION} · tenant <code>${esc(CUSTOMER_ID)}</code></p>
      </div>
    </div>`);
}

function signInScreen(err) {
  const v = shell({
    body: 'Enter your approved email address. We will email you a secure sign-in link.',
    action: `<form id="email-login" style="display:grid;gap:var(--s-3);max-width:19rem;margin:0 auto;text-align:left">
      <label style="display:grid;gap:var(--s-1)"><span class="dim">Email</span>
        <input id="email" type="email" autocomplete="email" required></label>
      <button id="go" class="primary" type="submit">Send sign-in link</button>
    </form>
    <p class="dim" style="font-size:var(--t-sm)">No Google login or password needed.</p>`,
    status: err || null, statusKind: err ? 'err' : '',
  });
  v.querySelector('#email-login').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = v.querySelector('#go');
    btn.disabled = true; btn.textContent = 'Sending…';
    const status = v.querySelector('.boot-status') || v.querySelector('.boot-inner').appendChild(el('<div class="boot-status" role="status"></div>'));
    try {
      status.textContent = await sendSignInLink(v.querySelector('#email').value);
      status.className = 'boot-status';
      btn.textContent = 'Link requested';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Send another link'; }, 60000);
    } catch (error) {
      status.textContent = error.message; status.className = 'boot-status err';
      btn.disabled = false; btn.textContent = 'Send sign-in link';
    }
  });
  return v;
}

function noAccessScreen(user) {
  const v = shell({
    title: 'Signed in, but no SAR access',
    body: `<code>${esc(user.email)}</code> has not been approved for SAR access. Ask Andrew to add this email, then reload.`,
    action: '<button id="out">Sign out</button>',
    status: 'Email not on the SAR access list',
    statusKind: 'err',
  });
  v.querySelector('#out').addEventListener('click', async () => {
    await signOut();
    mount(signInScreen());
  });
  return v;
}

function errorScreen(err) {
  return shell({
    title: 'Could not load',
    body: 'Nothing is cached yet, so there is nothing to show. This is a real failure, not an empty database.',
    status: err.message || String(err),
    statusKind: 'err',
  });
}

/* ---------------------------------------------------------------------------
   The shell — rail, content, docked inspector.

   Built once and kept. Route changes swap the content and move the highlight;
   they do not rebuild the rail, which would drop scroll position and focus.
--------------------------------------------------------------------------- */
let shellEl = null;
let railEl = null;
let inspectorEl = null;
let contentEl = null;
let disposeShell = null;

function buildShell(data) {
  shellEl = document.createElement('div');
  shellEl.className = 'shell';

  railEl = renderRail({
    customerName: data.config?.name,
    userEmail: data.userEmail,
    onNavigate: (id) => navigate(id),
    onSignOut: async () => {
      await signOut(); // onAuthChange sees the user leave and shows sign-in
    },
  });

  contentEl = document.createElement('main');
  contentEl.className = 'content';

  inspectorEl = renderInspector();

  // Saved data stands in when the database cannot be reached. Say so, with
  // its age, rather than presenting old figures as current.
  if (data.stale) {
    const when = new Date(data.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const banner = document.createElement('div');
    banner.className = 'stale-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = `Showing data saved ${when}: the database could not be reached. Reload to try again.`;
    // Fixed-position, so it takes no cell in the shell's grid.
    shellEl.append(railEl, contentEl, inspectorEl, banner);
  } else {
    shellEl.append(railEl, contentEl, inspectorEl);
  }
  disposeShell = wireInspector(shellEl, inspectorEl);
  return shellEl;
}

/**
 * Render one screen.
 *
 * Screens land from U8. Until a screen exists it says so explicitly, naming
 * the unit that will build it — an unbuilt screen must not look like a broken
 * one, and must never look like an empty database.
 */
let currentRoute = null;
let mounted = null;

/**
 * Screens loaded on first use, with their own styles. Bingo Scout carries
 * ~200 KB of hall data and Leaflet, which the other screens never need.
 */
const LAZY = {
  competition: () => Promise.all([
    import('./screens/competition.js'),
    import('./competition.css'),
    import('leaflet/dist/leaflet.css'),
  ]).then(([m]) => m.renderCompetition),
};

/** Release the previous screen (maps, timers) before showing the next one. */
function unmount() {
  try { mounted?.dispose?.(); } catch { /* a screen's cleanup must not block navigation */ }
  mounted = null;
}

function mountScreen(node) {
  mounted = node;
  contentEl.replaceChildren(node);
  contentEl.scrollTop = 0;
}

/**
 * Screens that cannot show anything meaningful until Operations arrives.
 * They show a loading note instead, and render once it lands. Screens not
 * listed here render at once; those in OPS_REFRESH re-render when it lands.
 */
const OPS_WAIT = new Set(['managers', 'staff-overview', 'commission', 'inventory', 'forecast', 'unit-economics', 'sources', 'hotball']);
const OPS_REFRESH = new Set(['session']);

/**
 * Render a screen, containing any error to that screen. One broken screen
 * (bad data, a bad link parameter) must not take the rail and every other
 * screen down with it.
 */
function safeRender(render, props, screen) {
  try {
    return render(props);
  } catch (err) {
    console.error(`SAR: ${screen.label} failed to render`, err);
    const box = document.createElement('div');
    box.className = 'placeholder';
    box.innerHTML = `<p class="semi">${esc(screen.label)} could not be shown</p>
      <p class="dim">${esc(err?.message || String(err))}</p>
      <p style="margin-top:var(--s-4)"><button type="button" class="btn">Open with default settings</button></p>`;
    box.querySelector('button').addEventListener('click', () => navigate(screen.id));
    return box;
  }
}

function renderScreen(route, data) {
  currentRoute = route;
  unmount();
  const screen = SCREENS[route.screen];

  // Exactly one nav item active — asserted at runtime, not assumed. SPEC §18.
  const lit = setActive(railEl, activeItem(route.screen));
  if (lit !== 1) console.warn(`SAR: ${lit} nav items active for "${route.screen}"`);

  const BUILT = {
    session: renderSession,
    leaderboard: renderLeaderboard,
    jackpots: renderJackpots,
    hotball: renderHotball,
    'monthly-pl': renderMonthlyPL,
    compare: renderCompare,
    venues: renderVenues,
    anomaly: renderAnomaly,
    reporting: renderReporting,
    runners: renderRunners,
    managers: renderManagers,
    dashboard: renderDashboard,
    data: renderData,
    inventory: renderInventory,
    commission: renderCommission,
    'staff-overview': renderStaff,
    sources: renderSources,
    promotions: renderPromotions,
    'unit-economics': renderUnitEconomics,
    forecast: renderForecast,
    ask: renderAsk,
    notifications: renderNotifications,
  };

  const props = {
    data,
    params: route.params,
    onNavigate: (id, params) => navigate(id, params),
    setInspectorContent: (html) => setInspector(inspectorEl, html),
  };

  if (BUILT[route.screen]) {
    if (OPS_WAIT.has(route.screen) && data.opsLoading) {
      const waiting = document.createElement('div');
      waiting.className = 'placeholder';
      waiting.innerHTML = `<p class="semi">Loading operations data…</p>
        <p class="dim">${esc(screen.label)} needs the scheduler and data validator. It appears as soon as they arrive.</p>`;
      mountScreen(waiting);
      return;
    }
    mountScreen(safeRender(BUILT[route.screen], props, screen));
    return;
  }

  if (LAZY[route.screen]) {
    const waiting = document.createElement('div');
    waiting.className = 'placeholder';
    waiting.innerHTML = '<p class="semi">Loading…</p>';
    mountScreen(waiting);
    LAZY[route.screen]().then((render) => {
      if (currentRoute !== route) return; // the user has moved on
      mountScreen(safeRender(render, props, screen));
    }).catch(() => {
      if (currentRoute !== route) return;
      waiting.innerHTML = `<p class="semi">${esc(screen.label)} could not be loaded</p>
        <p class="dim">Check the connection and reload the page.</p>`;
    });
    return;
  }

  const head = document.createElement('div');
  head.className = 'screen-head';
  head.innerHTML = `<h2>${esc(screen.label)}</h2>`;

  const body = document.createElement('div');
  body.className = 'placeholder';
  body.innerHTML = `
    <p class="semi">${esc(screen.label)} is not built yet</p>
    <p>Scheduled for <code>${esc(screen.unit)}</code>.</p>
    <p class="dim" style="margin-top:var(--s-4)">
      ${data.events.length.toLocaleString()} sessions loaded ·
      ${data.locations.length} locations ·
      ${data.metricDefs.length} metrics
    </p>`;

  contentEl.replaceChildren(head, body);

  setInspector(inspectorEl, inspectorIdle({
    screenLabel: screen.label,
    description: route.unknown
      ? `No screen called "${route.unknown}". Showing ${screen.label} instead.`
      : `${screen.group} · ${screen.unit}`,
    filters: [
      { label: 'Tenant', value: CUSTOMER_ID },
      ...(data.snapshotAt ? [{ label: 'Analytics copied', value: new Date(data.snapshotAt).toLocaleString() }] : []),
      { label: 'Sessions', value: data.events.length.toLocaleString() },
      { label: 'Range', value: data.events.length
        ? `${data.events[data.events.length - 1].event_date} to ${data.events[0].event_date}`
        : 'none' },
    ],
  }));
}

/**
 * Load the roster and build the manager model.
 *
 * Uses the shared local server connection after the SAR session is available.
 */
export async function loadManagers(data, known = null) {
  try {
    const schedule = known ?? await getSchedule();
    data.schedule = schedule;
    // The data validator arrives with Operations but can fail on its own; the
    // crew model then says "not connected" and the scheduler carries on.
    data.crew = buildCrewModel({
      validator: schedule.ok ? schedule.validator : null,
      staff: schedule.staff ?? [],
      schedule: schedule.ok ? schedule : null,
      events: data.events,
      hallMap: hallMapFromLocations(data.locations ?? []).map,
    });
    data.managers = schedule.ok
      ? buildManagerModel({
          events: data.events,
          locations: data.locations,
          schedule,
          valuesOf: makeValuesOf(data),
          crew: data.crew,
        })
      : {
          ok: false, reason: schedule.reason, people: [], crewOf: new Map(), report: null,
        };
  } catch (err) {
    console.warn('SAR: scheduler unavailable', err);
    data.crew = buildCrewModel({});
    data.managers = {
      ok: false, reason: err.message,
      people: [], crewOf: new Map(), report: null,
    };
  }
  return data.managers;
}

function mount(node) {
  document.getElementById('app').replaceChildren(node);
}

/** Tear down the previous boot's router and global listeners. */
let stopRouter = null;
function teardown() {
  unmount();
  try { stopRouter?.(); } catch { /* ignore */ }
  try { disposeShell?.(); } catch { /* ignore */ }
  stopRouter = null; disposeShell = null; currentRoute = null;
}

/** Unwrap a cached read ({ data, stale, at }) or pass a plain value through. */
const unwrap = (r) => (r && typeof r === 'object' && 'data' in r && 'at' in r ? r.data : r);

/** How old saved session data may be and still open the app at once. */
const SAVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Re-read everything from the database while the app stays usable on the
 * saved copy, then swap the fresh figures in and redraw the screen in view.
 * A note in the corner says it is happening; if the read fails, the saved
 * copy stays and the note says how old it is.
 */
async function refreshInBackground(data, current) {
  const note = document.createElement('div');
  note.className = 'stale-banner is-updating';
  note.setAttribute('role', 'status');
  const when = new Date(data.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  note.textContent = `Showing figures saved ${when} · updating…`;
  shellEl?.append(note);
  try {
    const fresh = await bootstrap({ force: true });
    if (!current()) return;
    for (const k of ['config', 'metricDefs', 'categories', 'locations', 'events', 'metrics', 'runners', 'runnerEvents', 'snapshotAt', 'stale', 'at']) {
      data[k] = fresh[k];
    }
    data.idx = indexMetrics(data.metricDefs);
    // The crew and manager models are built from the sessions: rebuild them
    // on the fresh ones once Operations is in.
    if (!data.opsLoading && data.schedule) {
      const schedule = data.schedule;
      data.schedule = undefined;
      await loadManagers(data, schedule);
      if (!current()) return;
    }
    note.remove();
    const r = currentRoute;
    if (r && r.screen !== 'ask') {
      const top = contentEl.scrollTop;
      renderScreen(r, data);
      contentEl.scrollTop = top;
    }
  } catch {
    if (!current()) return;
    note.className = 'stale-banner';
    note.textContent = `Showing figures saved ${when}: the database could not be reached. Reload to try again.`;
  }
}

/**
 * Each boot gets a number. A boot that has been overtaken (the user signed
 * out, or in as someone else, while it was still loading) stops at its next
 * await instead of mounting a screen over the newer one.
 */
let bootSeq = 0;

/* ---------------------------------------------------------------------------
   Entry
--------------------------------------------------------------------------- */
export async function boot() {
  const seq = ++bootSeq;
  const current = () => seq === bootSeq;
  teardown();
  mount(shell({ status: 'Loading…' }));

  try {
    // Open on saved data up to a day old; anything older than the usual five
    // minutes is refreshed behind the open app (refreshSoon, below) instead of
    // holding the whole app on "Loading…" for the 20 s a full read takes.
    const data = await bootstrap({ maxAge: SAVED_MAX_AGE_MS });
    if (!current()) return;
    orgName = data.config?.name ?? null;
    // Metric definitions are indexed once, not per screen render: 59 defs
    // rebuilt on every navigation is pure waste.
    data.idx = indexMetrics(data.metricDefs);

    // Side reads from the analytics project, together. Each can fail alone.
    const [promotions, summary, notes, user] = await Promise.allSettled([
      getPromotions(), getMonthlySummary(), getNotifications(), whoami(),
    ]);
    if (!current()) return;
    data.promotions = promotions.status === 'fulfilled' ? unwrap(promotions.value) ?? [] : [];
    data.monthlySummary = summary.status === 'fulfilled' ? unwrap(summary.value) ?? [] : [];
    const n = notes.status === 'fulfilled' ? unwrap(notes.value) : null;
    data.notifications = n?.notifications ?? [];
    data.notificationReads = n?.reads ?? [];
    data.userId = user.status === 'fulfilled' ? user.value?.id ?? null : null;
    data.userEmail = user.status === 'fulfilled' ? user.value?.email ?? null : null;
    data.version = VERSION;

    // Operations (scheduler + validator) can take a while. The app opens
    // without it; the screens that need it wait for it on their own.
    data.opsLoading = true;
    data.schedule = undefined;

    mount(buildShell(data));
    stopRouter = startRouter((route) => renderScreen(route, data));
    window.SAR = Object.freeze({ version: VERSION, customer: CUSTOMER_ID, data });

    const refreshing = Date.now() - data.at > CACHE_TTL_MS
      ? refreshInBackground(data, current) : null;

    await loadManagers(data);
    if (!current()) return;
    data.opsLoading = false;
    const r = currentRoute;
    if (r && (OPS_WAIT.has(r.screen) || OPS_REFRESH.has(r.screen))) {
      const top = contentEl.scrollTop;
      renderScreen(r, data);
      contentEl.scrollTop = top;
    }
    await refreshing;
  } catch (err) {
    if (!current()) return;
    if (err instanceof NotSignedIn) return mount(signInScreen());
    if (err instanceof NoAccess)    return mount(noAccessScreen(await currentUser()));
    console.error('SAR boot failed', err);
    mount(errorScreen(err));
  }
}

/**
 * Boot once per signed-in identity. Supabase announces the session on load,
 * on every token refresh (including each time the tab regains focus) and on
 * sign-in/out; only a CHANGE of who is signed in should rebuild the app.
 */
let bootedFor; // undefined until the first boot; null means signed out
export function bootFor(userId) {
  if (userId === bootedFor) return false;
  bootedFor = userId;
  boot();
  return true;
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  // Re-boot on sign-in/out so the OAuth round trip lands on the real app
  // rather than leaving the sign-in screen up behind a valid session — but
  // only when the user actually changes (see bootFor).
  onAuthChange((user) => bootFor(user?.id ?? null));
  currentUser().then((u) => bootFor(u?.id ?? null), () => bootFor(null));
}
