/* ============================================================================
   SAR 2.0 — Notifications

   A REAL SAR 1.0 SCREEN THAT THE GAP AUDIT MISSED. `notifications-view` is one
   of SAR 1.0's nine views and it was never on my list. Production holds 311
   notifications for Vanguard across ten event types, May to August 2026.

   READ ONLY, AND THAT CHANGES THE SCREEN. SAR 1.0 marks notifications read by
   writing to `notification_reads`. SAR 2.0 writes to nothing, by standing
   instruction, so it cannot mark anything read. Rather than show a button that
   silently does nothing, the screen reads the existing read state, shows it,
   and says plainly that reading here does not clear anything in SAR 1.0.

   SAR 1.0's `addNotification` is a no-op with a comment saying so — everything
   now flows from the database — so there is no in-memory path to reproduce.
   ========================================================================== */

import { dateShort, esc, DASH } from '../lib/fmt.js';
import { play } from '../lib/sound.js';

const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

/** The severities SAR 1.0 uses, worst first. */
export const SEVERITIES = Object.freeze(['alert', 'warning', 'success', 'info']);

/**
 * Event types seen in production, grouped for the filter.
 *
 * The list is not hardcoded as the only possibility — an unknown type falls
 * into "Other" rather than being dropped, because a notification nobody
 * anticipated is exactly the one worth seeing.
 */
export const TYPE_GROUPS = Object.freeze([
  { id: 'all', label: 'Everything', match: () => true },
  { id: 'problem', label: 'Problems',
    match: (t) => /impossible_value|ingestion_error|reconciliation_mismatch|stale_location|worst_day/.test(t) },
  { id: 'jackpot', label: 'Jackpots', match: (t) => /jackpot/.test(t) },
  { id: 'record', label: 'Records', match: (t) => /high_water/.test(t) },
  { id: 'access', label: 'Access', match: (t) => /^auth\./.test(t) },
]);

/** `sar.new_high_water` -> `New high water`. */
export function humanType(t) {
  const bare = String(t ?? '').replace(/^[a-z]+\./, '').replace(/_/g, ' ');
  return bare ? bare[0].toUpperCase() + bare.slice(1) : 'Unknown';
}

/**
 * Notifications with their read state attached.
 *
 * A notification with no matching read row is unread. `archived_at` hides it,
 * matching SAR 1.0, which archives rather than deletes.
 */
export function withReadState(notifications = [], reads = [], { userId = null } = {}) {
  const mine = new Map();
  for (const r of reads) {
    if (userId && r.user_id !== userId) continue;
    mine.set(r.notification_id, r);
  }
  return notifications
    .map((n) => {
      const r = mine.get(n.id);
      return { ...n, read: Boolean(r?.read_at), archived: Boolean(r?.archived_at) };
    })
    .filter((n) => !n.archived)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

export const unreadCount = (rows) => rows.filter((n) => !n.read).length;

export function filterRows(rows, { group = 'all', severity = 'all', unreadOnly = false }) {
  const g = TYPE_GROUPS.find((x) => x.id === group) ?? TYPE_GROUPS[0];
  return rows.filter((n) => g.match(String(n.event_type ?? ''))
    && (severity === 'all' || n.severity === severity)
    && (!unreadOnly || !n.read));
}

/** Counts per group, so a filter that would show nothing says so before it is clicked. */
export function groupCounts(rows) {
  return Object.fromEntries(TYPE_GROUPS.map((g) =>
    [g.id, rows.filter((n) => g.match(String(n.event_type ?? ''))).length]));
}

/* ---------------------------------------------------------------------------
   Screen
--------------------------------------------------------------------------- */

export function renderNotifications({ data, params, onNavigate, setInspectorContent }) {
  const root = h('div', 'screen');
  const group = TYPE_GROUPS.find((g) => g.id === params.group)?.id ?? 'all';
  const severity = SEVERITIES.includes(params.severity) ? params.severity : 'all';
  const unreadOnly = params.unread === 'on';

  const rows = withReadState(data.notifications ?? [], data.notificationReads ?? [],
    { userId: data.userId ?? null });
  const counts = groupCounts(rows);
  const shown = filterRows(rows, { group, severity, unreadOnly });

  /* ---- filters ---- */
  const bar = h('div', 'filter-bar');
  for (const g of TYPE_GROUPS) {
    const b = h('button', `chip${group === g.id ? ' is-active' : ''}`);
    b.type = 'button';
    b.textContent = `${g.label}${counts[g.id] ? ` ${counts[g.id]}` : ''}`;
    b.disabled = counts[g.id] === 0 && g.id !== 'all';
    b.addEventListener('click', () => { play('select'); onNavigate('notifications', { ...params, group: g.id }); });
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  for (const s of ['all', ...SEVERITIES]) {
    const b = h('button', `chip${severity === s ? ' is-active' : ''}`);
    b.type = 'button'; b.textContent = s === 'all' ? 'Any severity' : s;
    b.addEventListener('click', () => onNavigate('notifications', { ...params, severity: s }));
    bar.append(b);
  }
  bar.append(h('span', 'filter-sep'));
  const ub = h('button', `chip${unreadOnly ? ' is-active' : ''}`);
  ub.type = 'button';
  ub.textContent = `Unread only (${unreadCount(rows)})`;
  ub.addEventListener('click', () => onNavigate('notifications',
    { ...params, unread: unreadOnly ? 'off' : 'on' }));
  bar.append(ub);
  root.append(bar);

  const panel = h('section', 'panel');
  panel.append(h('h3', 'panel-title', 'Notifications'));

  if (!rows.length) {
    panel.append(h('div', 'placeholder',
      '<p class="semi">No notifications</p>'
      + '<p class="dim">Nothing has been raised for this tenant.</p>'));
    root.append(panel);
    return root;
  }

  panel.append(h('p', 'muted',
    `${unreadCount(rows)} unread of ${rows.length}. Read state is whatever SAR 1.0 `
    + 'recorded — SAR 2.0 writes to nothing, so opening one here does not mark it '
    + 'read anywhere.'));

  if (!shown.length) {
    panel.append(h('div', 'placeholder', '<p class="semi">Nothing matches these filters</p>'));
  } else {
    const list = h('div', 'notif-list');
    for (const n of shown) {
      const item = h('div', `notif notif-${n.severity ?? 'info'}${n.read ? ' is-read' : ''}`);
      item.innerHTML = `
        <div class="notif-head">
          <span class="notif-sev">${esc(n.severity ?? 'info')}</span>
          <span class="notif-type">${esc(humanType(n.event_type))}</span>
          <span class="dim notif-when">${n.created_at ? dateShort(String(n.created_at).slice(0, 10)) : DASH}</span>
          ${n.read ? '' : '<span class="notif-dot" title="unread"></span>'}
        </div>
        <p class="notif-title">${esc(n.title ?? humanType(n.event_type))}</p>
        ${n.body ? `<p class="muted notif-body">${esc(n.body)}</p>` : ''}`;

      // Link through to the thing it is about, where the notification names one.
      if (n.entity_type === 'event' && n.entity_id) {
        const go = h('button', 'mg-name');
        go.type = 'button';
        go.textContent = 'Open that session';
        go.addEventListener('click', () => onNavigate('session', { id: n.entity_id }));
        item.append(go);
      }
      list.append(item);
    }
    panel.append(list);
    panel.append(h('p', 'muted', `${shown.length} shown of ${rows.length}.`));
  }

  root.append(panel);

  setInspectorContent?.(`
    <p class="semi">Notifications</p>
    <p class="muted">${unreadCount(rows)} unread of ${rows.length}</p>
    <p class="inspector-section-label">Why nothing can be marked read</p>
    <p class="muted">Marking read writes a row to <code>notification_reads</code>.
      SAR 2.0 writes to no database at all, so it shows the read state SAR 1.0
      recorded and leaves it alone. A button that silently did nothing would be
      worse than no button.</p>
    <p class="inspector-section-label">What raises these</p>
    <p class="muted">Jackpot hits and state changes, new high-water marks, worst-day
      alerts, and the data problems — impossible values, reconciliation
      mismatches, ingestion errors and locations that have gone stale.</p>`);

  return root;
}
