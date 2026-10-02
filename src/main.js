/* ============================================================================
   SAR 2.0 — boot

   U1 built the skeleton. U2 adds the production read layer and the sign-in
   boundary.

   WHY THERE IS A SIGN-IN AT ALL
   The original design was a link with a token and no login. That is not
   possible against this database. Every analytics table is gated by
   `analytics_has_access(customer_id)`, which needs `auth.uid()` and a role in
   `user_roles`. Signed out, PostgREST returns 200 with an empty array — so a
   no-login build would have rendered blank screens and looked like a database
   with no data in it. Verified against production, 12 Aug 2026. SAR 1.0 signs
   people in for exactly this reason; SAR 2.0 does the same, with Google.
   ========================================================================== */

import './styles.css';
import {
  currentUser, onAuthChange, signInWithGoogle, signInWithPassword, signOut,
  bootstrap, getPromotions, getMonthlySummary, getNotifications, currentUser as whoami, NotSignedIn, NoAccess,
} from './lib/api.js';
import { CUSTOMER_ID } from './lib/config.js';
import { startRouter, navigate, activeItem, SCREENS } from './lib/router.js';
import { renderRail, setActive } from './components/rail.js';
import { renderInspector, setInspector, inspectorIdle, wireInspector } from './components/inspector.js';
import { indexMetrics } from './lib/model.js';
import { renderSession } from './screens/session.js';
import { renderLeaderboard } from './screens/leaderboard.js';
import { renderJackpots } from './screens/jackpots.js';
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
        <p><strong>Session Analysis Reporting</strong>${orgName ? `<br>${orgName}` : ''}</p>
        ${title ? `<p class="semi">${title}</p>` : ''}
        ${body ? `<p>${body}</p>` : ''}
        ${action ? `<p style="margin-top:var(--s-5)">${action}</p>` : ''}
        ${status ? `<div class="boot-status ${statusKind}" role="status"><span class="dot"></span>${status}</div>` : ''}
        <p class="version" style="margin-top:var(--s-6)">v${VERSION} · tenant <code>${CUSTOMER_ID}</code></p>
      </div>
    </div>`);
}

/**
 * Sign-in.
 *
 * Email and password is the primary route because it needs no redirect and
 * therefore no Supabase configuration — it works from localhost and from any
 * host. Google is offered second, and is honest about only working from an
 * approved address rather than silently bouncing the user to another site,
 * which is exactly what it did the first time it was tried.
 */
function signInScreen(err) {
  const v = shell({
    body: 'Sign in with the account that has your SAR access.',
    action: `
      <form id="pw" style="display:grid;gap:var(--s-3);max-width:19rem;margin:0 auto;text-align:left">
        <label style="display:grid;gap:var(--s-1)">
          <span class="dim" style="font-size:var(--t-sm)">Email</span>
          <input id="email" type="email" autocomplete="username" required>
        </label>
        <label style="display:grid;gap:var(--s-1)">
          <span class="dim" style="font-size:var(--t-sm)">Password</span>
          <input id="password" type="password" autocomplete="current-password" required>
        </label>
        <button id="go" class="primary" type="submit">Sign in</button>
      </form>
      <p class="dim" style="font-size:var(--t-sm);margin-top:var(--s-4)">
        <button id="google" type="button">Sign in with Google</button><br>
        <span style="display:inline-block;margin-top:var(--s-2)">
          Google only works when this app is served from an approved address.
        </span>
      </p>`,
    status: err || null,
    statusKind: err ? 'err' : '',
  });

  v.querySelector('#pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = v.querySelector('#go');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await signInWithPassword(v.querySelector('#email').value, v.querySelector('#password').value);
      // onAuthChange re-boots; nothing to do here.
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      const s = v.querySelector('.boot-status') || v.querySelector('.boot-inner').appendChild(el('<div class="boot-status err" role="status"><span class="dot"></span></div>'));
      s.className = 'boot-status err';
      s.innerHTML = `<span class="dot"></span>${ex.message}`;
    }
  });

  v.querySelector('#google').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Redirecting…';
    try {
      await signInWithGoogle();
    } catch (ex) {
      e.target.disabled = false;
      e.target.textContent = 'Sign in with Google';
      mount(signInScreen(ex.message));
    }
  });

  return v;
}

function noAccessScreen(user) {
  const v = shell({
    title: 'Signed in, but no SAR access',
    body: `<code>${user.email}</code> has no Vanguard SAR role. Ask an administrator
           to grant one, then reload.`,
    action: '<button id="out">Sign out</button>',
    status: 'No role in user_roles for this account',
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

function buildShell(data) {
  shellEl = document.createElement('div');
  shellEl.className = 'shell';

  railEl = renderRail({
    customerName: data.config?.name,
    onNavigate: (id) => navigate(id),
  });

  contentEl = document.createElement('main');
  contentEl.className = 'content';

  inspectorEl = renderInspector();

  shellEl.append(railEl, contentEl, inspectorEl);
  wireInspector(shellEl, inspectorEl);
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

function renderScreen(route, data) {
  currentRoute = route;
  const screen = SCREENS[route.screen];

  // Exactly one nav item active — asserted at runtime, not assumed. SPEC §18.
  const lit = setActive(railEl, activeItem(route.screen));
  if (lit !== 1) console.warn(`SAR: ${lit} nav items active for "${route.screen}"`);

  const BUILT = {
    session: renderSession,
    leaderboard: renderLeaderboard,
    jackpots: renderJackpots,
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

  if (BUILT[route.screen]) {
    contentEl.replaceChildren(BUILT[route.screen]({
      data,
      params: route.params,
      onNavigate: (id, params) => navigate(id, params),
      setInspectorContent: (html) => setInspector(inspectorEl, html),
    }));
    contentEl.scrollTop = 0;
    return;
  }

  const head = document.createElement('div');
  head.className = 'screen-head';
  head.innerHTML = `<h2>${screen.label}</h2>`;

  const body = document.createElement('div');
  body.className = 'placeholder';
  body.innerHTML = `
    <p class="semi">${screen.label} is not built yet</p>
    <p>Scheduled for <code>${screen.unit}</code>.</p>
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
export async function loadManagers(data) {
  try {
    const schedule = await getSchedule();
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

/* ---------------------------------------------------------------------------
   Entry
--------------------------------------------------------------------------- */
export async function boot() {
  mount(shell({ status: 'Loading…' }));

  try {
    const data = await bootstrap();
    orgName = data.config?.name ?? null;
    // Metric definitions are indexed once, not per screen render: 59 defs
    // rebuilt on every navigation is pure waste.
    data.idx = indexMetrics(data.metricDefs);

    // Operations is loaded automatically through the local server.
    try { data.promotions = await getPromotions(); }
    catch { data.promotions = []; }

    // Only the Reconcile view uses it; a failure leaves that view's own notice.
    try { data.monthlySummary = (await getMonthlySummary()).data; }
    catch { data.monthlySummary = []; }

    try {
      const n = await getNotifications();
      data.notifications = n.notifications;
      data.notificationReads = n.reads;
      data.userId = (await whoami())?.id ?? null;
    } catch {
      data.notifications = []; data.notificationReads = []; data.userId = null;
    }
    data.version = VERSION;

    await loadManagers(data);

    mount(buildShell(data));
    startRouter((route) => renderScreen(route, data));

    window.SAR = Object.freeze({ version: VERSION, customer: CUSTOMER_ID, data });
  } catch (err) {
    if (err instanceof NotSignedIn) return mount(signInScreen());
    if (err instanceof NoAccess)    return mount(noAccessScreen(await currentUser()));
    console.error('SAR boot failed', err);
    mount(errorScreen(err));
  }
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  boot();
  // Re-boot on sign-in/out so the OAuth round trip lands on the real app
  // rather than leaving the sign-in screen up behind a valid session.
  onAuthChange(() => boot());
}
