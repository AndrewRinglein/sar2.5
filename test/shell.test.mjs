import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.Node = dom.window.Node;

const { renderRail } = await import('../src/components/rail.js');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('the rail shows who is signed in and a working sign-out', async () => {
  let calls = 0;
  const rail = renderRail({ userEmail: '<b>x</b>@example.com', onSignOut: async () => { calls++; } });
  const who = rail.querySelector('.rail-user');
  assert.equal(who.textContent, '<b>x</b>@example.com', 'the email is text, never HTML');
  assert.equal(who.querySelector('b'), null);
  const out = rail.querySelector('.rail-signout');
  assert.equal(out.textContent, 'Sign out');
  out.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
});

test('the rail has no sign-out when no handler is given', () => {
  assert.equal(renderRail({}).querySelector('.rail-signout'), null);
});

test('auth events only re-boot when the signed-in user changes', () => {
  // Supabase fires on load, on every token refresh and on every tab refocus.
  // Rebooting on each one reloaded the whole app whenever the tab came back.
  assert.match(main, /onAuthChange\(\(user\) => bootFor\(user\?\.id \?\? null\)\)/);
  assert.match(main, /if \(userId === bootedFor\) return false;/);
  assert.doesNotMatch(main, /onAuthChange\(\(\) => boot\(\)\)/);
});

test('a stale boot cannot mount over a newer one, and old listeners are released', () => {
  assert.match(main, /const seq = \+\+bootSeq;/);
  assert.match(main, /teardown\(\);/);
  assert.match(main, /stopRouter = startRouter\(/);
  assert.match(main, /disposeShell = wireInspector\(/);
});

test('every screen render is contained, built and lazy alike', () => {
  assert.match(main, /mountScreen\(safeRender\(BUILT\[route\.screen\], props, screen\)\)/);
  assert.match(main, /mountScreen\(safeRender\(render, props, screen\)\)/);
  assert.doesNotMatch(main, /mountScreen\(BUILT\[/);
});

test('startup does not wait for Operations', () => {
  const bootFn = main.slice(main.indexOf('export async function boot()'));
  const mountAt = bootFn.indexOf('mount(buildShell(data))');
  const opsAt = bootFn.indexOf('await loadManagers(data)');
  assert.ok(mountAt > 0 && opsAt > mountAt, 'the shell must mount before Operations is awaited');
});

test('cached reads are unwrapped before screens see them', () => {
  // getNotifications() returns { data, stale, at }. Reading .notifications
  // straight off it left the Notifications and Promotions screens empty.
  assert.match(main, /unwrap\(notes\.value\)/);
  assert.match(main, /unwrap\(promotions\.value\)/);
});

test('a saved copy up to a day old opens the app; older than five minutes refreshes behind it', () => {
  assert.match(main, /bootstrap\(\{ maxAge: SAVED_MAX_AGE_MS \}\)/);
  assert.match(main, /Date\.now\(\) - data\.at > CACHE_TTL_MS\s*\? refreshInBackground\(data, current\)/);
  const api = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
  assert.match(api, /const fresh = hit && \(Date\.now\(\) - hit\.at\) < maxAge;/);
});
