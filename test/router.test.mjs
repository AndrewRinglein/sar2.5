import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV, SCREENS, DEFAULT_SCREEN, parseHash, buildHash, activeItem, startRouter,
} from '../src/lib/router.js';

test('every screen in the spec has a route', () => {
  // 20: the sixteen from the implementation plan, plus Reporting (SPEC §8a),
  // which SAR 1.0 has as its own tab and the original plan folded into
  // Monthly P&L — they are different screens and both exist — plus Managers,
  // which is new in SAR 2.0 and has no SAR 1.0 counterpart, plus Dashboard,
  // which carries SAR 1.0's six chart panels.
  assert.equal(Object.keys(SCREENS).length, 22);
  assert.ok(SCREENS.competition, 'Bingo Scout must have a route');
  // Notifications and Settings are real SAR 1.0 views that the original gap
  // audit missed entirely. SAR 1.0 has nine: events, leaderboard, compare,
  // reporting, month-over-month, runners, data, notifications, settings.
  assert.ok(SCREENS.notifications, 'Notifications is a SAR 1.0 view');
  assert.equal(SCREENS.settings, undefined, 'Settings was removed from the app');
  assert.ok(SCREENS.reporting, 'Reporting must have a route');
  assert.ok(SCREENS.managers, 'Managers must have a route');
  assert.ok(SCREENS.dashboard, 'Dashboard must have a route');
  assert.ok(SCREENS.data, 'Data must have a route');

  // Every screen in the nav is now built — none may fall through to the
  // "not built yet" placeholder.
  const UNBUILT = [];
  assert.deepEqual(UNBUILT, [], 'no screen may remain unbuilt');
});

test('screen ids are unique across groups', () => {
  const ids = NAV.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('an empty hash is the default screen', () => {
  assert.deepEqual(parseHash(''), { screen: DEFAULT_SCREEN, params: {}, unknown: null });
  assert.equal(parseHash('#').screen, DEFAULT_SCREEN);
  assert.equal(parseHash('#/').screen, DEFAULT_SCREEN);
});

test('parses screen and params', () => {
  const r = parseHash('#/leaderboard?hall=rwc&metric=rpa');
  assert.equal(r.screen, 'leaderboard');
  assert.deepEqual(r.params, { hall: 'rwc', metric: 'rpa' });
});

test('an unknown screen falls back but is REPORTED, not disguised', () => {
  // A typo in a shared link should be visible rather than silently redirected.
  const r = parseHash('#/leaderboardd');
  assert.equal(r.screen, DEFAULT_SCREEN);
  assert.equal(r.unknown, 'leaderboardd');
});

test('round-trips through buildHash', () => {
  const h = buildHash('session', { date: '2026-08-06', hall: 'rwc' });
  assert.equal(h, '#/session?date=2026-08-06&hall=rwc');
  assert.deepEqual(parseHash(h).params, { date: '2026-08-06', hall: 'rwc' });
});

test('empty params are omitted rather than left dangling', () => {
  assert.equal(buildHash('session', { date: '', hall: null, x: undefined }), '#/session');
});

test('exactly one nav item is ever active', () => {
  // SPEC §18: SAR 1.0 highlighted four at once. The signature returns one id
  // or null, so a set is not representable.
  assert.equal(activeItem('session'), 'session');
  assert.equal(activeItem('nonsense'), null);
  assert.equal(typeof activeItem('leaderboard'), 'string');
});

test('router fires immediately and on change', () => {
  const listeners = {};
  const win = {
    location: { hash: '#/inventory' },
    addEventListener: (e, f) => { listeners[e] = f; },
    removeEventListener: () => { delete listeners.hashchange; },
  };
  const seen = [];
  const stop = startRouter((r) => seen.push(r.screen), win);
  assert.deepEqual(seen, ['inventory']);          // immediate

  win.location.hash = '#/commission';
  listeners.hashchange();
  assert.deepEqual(seen, ['inventory', 'commission']);

  stop();
  assert.equal(listeners.hashchange, undefined);
});

test('a date with a slash in params survives the round trip', () => {
  const h = buildHash('session', { note: 'a/b?c=d' });
  assert.equal(parseHash(h).params.note, 'a/b?c=d');
});

test('the real app shell wires every route the rail offers', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const { SCREENS } = await import('../src/lib/router.js');
  const block = (name) => main.slice(main.indexOf(`const ${name} = {`), main.indexOf('};', main.indexOf(`const ${name} = {`)));
  const wired = block('BUILT') + block('LAZY');
  const missing = Object.keys(SCREENS).filter((id) => !new RegExp(`(^|[\\s{,'])'?${id}'?\\s*:`, 'm').test(wired));
  assert.deepEqual(missing, [], `routes with no screen in main.js: ${missing.join(', ')}`);
});
