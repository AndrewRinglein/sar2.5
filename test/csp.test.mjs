/* ============================================================================
   Content-Security-Policy and what the site publishes

   The policy is a <meta> tag injected at build time (scripts/csp.mjs). These
   tests keep it honest in both directions: nothing the app needs is missing
   (every host it talks to is derived from the source and checked against the
   policy), and nothing it does not need has crept in. Verified in Chromium on
   the built site on 2 Oct 2026: the sign-in page and the Bingo Scout map
   (Leaflet tiles) run with zero violations, and an inline script and a fetch
   to an unlisted host are both refused.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CSP_DIRECTIVES, cspString, injectCsp, cspPlugin } from '../scripts/csp.mjs';
import { SUPABASE_URL, OPS_URL } from '../src/lib/config.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const origin = (url) => new URL(url).origin;

test('the policy is injected at build only, so the dev server and HMR are untouched', () => {
  const plugin = cspPlugin();
  assert.equal(plugin.apply, 'build');
  assert.match(read('vite.config.js'), /cspPlugin\(\)/);
  const html = injectCsp(read('index.html'));
  const lines = html.split('\n');
  const at = lines.findIndex((l) => l.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(at > 0 && /<meta charset=/.test(lines[at - 1]), 'straight after <meta charset>, before any resource');
  assert.equal(injectCsp(html), html, 'idempotent');
  assert.throws(() => injectCsp('<html><head></head></html>'), /charset/);
});

test('scripts are the bundle only: no inline script, no eval, no CDN, no plugins', () => {
  assert.deepEqual(CSP_DIRECTIVES['script-src'], ["'self'"]);
  assert.deepEqual(CSP_DIRECTIVES['object-src'], ["'none'"]);
  assert.deepEqual(CSP_DIRECTIVES['base-uri'], ["'self'"]);
  assert.deepEqual(CSP_DIRECTIVES['form-action'], ["'self'"]);
  assert.doesNotMatch(cspString(), /unsafe-eval|\*|http:/);
  assert.ok(!('frame-ancestors' in CSP_DIRECTIVES), 'ignored in <meta>; would only mislead');
});

test('every host the app talks to is allowed, and no other', () => {
  const connect = CSP_DIRECTIVES['connect-src'];
  for (const url of [SUPABASE_URL, OPS_URL]) assert.ok(connect.includes(origin(url)), url);
  assert.ok(connect.includes(origin(SUPABASE_URL).replace('https:', 'wss:')), 'Supabase realtime');
  assert.deepEqual(connect.filter((s) => s !== "'self'").map((s) => new URL(s).hostname).sort(),
    [new URL(OPS_URL).hostname, new URL(SUPABASE_URL).hostname, new URL(SUPABASE_URL).hostname].sort());

  // Map tiles: the host competition.js asks Leaflet for.
  const tiles = /tileLayer\('([^']+)'/.exec(read('src/screens/competition.js'))[1];
  assert.deepEqual(CSP_DIRECTIVES['img-src'], ["'self'", 'data:', origin(tiles.replace(/\{[a-z]\}/g, '0'))]);

  // Fonts: the stylesheet index.html links, and the host that serves its files.
  const fonts = [...read('index.html').matchAll(/href="(https:\/\/fonts\.[^"]+)"/g)].map((m) => origin(m[1]));
  assert.ok(fonts.every((f) => [...CSP_DIRECTIVES['style-src'], ...CSP_DIRECTIVES['font-src']].includes(f)));
  assert.deepEqual(CSP_DIRECTIVES['font-src'], ['https://fonts.gstatic.com']);
});

test('inline styles are allowed because the app really uses them', () => {
  // Remove 'unsafe-inline' only once nothing sets style="" or element.style.
  const src = ['src/main.js', 'src/screens/session.js', 'src/screens/competition.js'].map(read).join('\n');
  assert.match(src, /style="|\.style\./);
  assert.ok(CSP_DIRECTIVES['style-src'].includes("'unsafe-inline'"));
});

test('public/ holds only static assets: no HTML page is published beside the app', () => {
  const walk = (dir) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const files = walk('public');
  assert.deepEqual(files.filter((f) => /\.(html?|js|mjs)$/i.test(f)), [],
    'an HTML or script file in public/ is deployed unauthenticated on the app origin');
  // The historical Bingo Scout export (third-party contact details, CDN scripts
  // without SRI) is kept for reference only, outside the deployed tree.
  assert.ok(read('docs/reference/bingo-scout-v2.html').length > 1000);
  for (const f of ['src', 'index.html']) {
    const text = f === 'src' ? walk('src').map(read).join('\n') : read(f);
    assert.doesNotMatch(text, /reference\/bingo-scout-v2/, `${f} must not link the reference copy`);
  }
});
