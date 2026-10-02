// The SAR API on both runtimes: the local Vite middleware and the Supabase
// Edge Function share api-core.mjs; these tests run the same scenarios through
// both adapters, then cover what is Edge-only (CORS, env wiring, the bundle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createLocalApi } from '../server/local-api.mjs';
import { matchRoute, MAX_BODY_BYTES } from '../server/api-core.mjs';
import {
  createEdgeHandler, createEdgeServer, EDGE_ALLOWED_ORIGINS, EDGE_PREFIXES,
} from '../server/edge-api.mjs';
import { apiBase, EDGE_API_BASE, LOCAL_API_BASE, SUPABASE_URL, SUPABASE_KEY } from '../src/lib/config.js';
import { apiUrl } from '../src/lib/server-request.js';
import { SUPABASE_ROOT_CA } from '../server/supabase-ca.mjs';

const PAGES = 'https://andrewringlein.github.io';
const EDGE = 'https://lkcfbgnuodqzvowschjn.supabase.co';
const sharedKey = 'sk-ant-fixture-only-not-a-real-key';
const question = { question: 'How was net?', context: { months: [] } };

/** Call the local middleware the way Vite does. */
async function callLocal(options, { path, method = 'GET', authorization, origin, body } = {}) {
  const handler = createLocalApi(options);
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { url: `/api/${path}`, method,
    headers: { host: '127.0.0.1:5173', ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}) } });
  let status, text;
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    end(t) { status = this.statusCode; text = t; } };
  let passed = false;
  await handler(req, res, () => { passed = true; });
  if (passed) return { status: 'next' };
  return { status, headers, result: text ? JSON.parse(text) : null };
}

/** Call the Edge handler with a Web Request, as Deno.serve does. */
async function callEdge(options, { path, method = 'GET', authorization, origin, body, prefix = '/sar2-api', headers: extra = {} } = {}) {
  const handler = createEdgeHandler(options);
  const response = await handler(new Request(`${EDGE}${prefix}/${path}`, { method,
    headers: { ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}), ...extra },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }));
  const text = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers), result: text ? JSON.parse(text) : null };
}

const runtimes = [['local', callLocal], ['edge', callEdge]];
const ok = (json) => ({ ok: true, json: async () => json });

for (const [name, call] of runtimes) {
  test(`${name}: every route refuses a request without a token, before any read`, async () => {
    const options = { pool: {}, loadOperations: () => assert.fail('no read'), loadKey: () => assert.fail('no key'),
      fetchImpl: () => assert.fail('no upstream call without a token') };
    for (const [path, method] of [['operations', 'GET'], ['competitive', 'GET'], ['ask-sar', 'POST']]) {
      const r = await call(options, { path, method, ...(method === 'POST' ? { body: question } : {}) });
      assert.equal(r.status, 401, `${path}`);
      assert.equal(r.result.error, 'Please sign in to SAR with an authorized account.');
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test(`${name}: a token that bms-production rejects, or without Vanguard access, is 401`, async () => {
    for (const fetchImpl of [
      async () => ({ ok: false, status: 401, json: async () => ({}) }),
      async (url) => String(url).includes('/auth/v1/user') ? ok({ id: 'u1' }) : ok([]),
    ]) {
      const r = await call({ pool: {}, fetchImpl, loadOperations: () => assert.fail('no read') },
        { path: 'operations', authorization: 'Bearer some-token' });
      assert.equal(r.status, 401);
    }
  });

  test(`${name}: the token is verified at bms-production with the publishable key`, async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      return String(url).includes('/auth/v1/user') ? ok({ id: 'viewer' }) : ok([{ id: 'e1' }]);
    };
    const r = await call({ pool: {}, fetchImpl, loadOperations: async () => ({ ok: true, staff: [] }) },
      { path: 'operations', authorization: 'Bearer good-token' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.result, { ok: true, staff: [] });
    assert.equal(calls[0].url, `${SUPABASE_URL}/auth/v1/user`);
    assert.equal(SUPABASE_URL, 'https://faoqpyjhwvwgwvmgqxjr.supabase.co');
    assert.match(calls[1].url, /\/rest\/v1\/analytics_events\?.*customer_id=eq\.vanguard/);
    for (const c of calls) {
      assert.equal(c.options.headers.apikey, SUPABASE_KEY);
      assert.equal(c.options.headers.authorization, 'Bearer good-token');
    }
  });

  test(`${name}: wrong methods are 405 without authenticating`, async () => {
    const options = { authenticate: () => assert.fail('must not reach auth') };
    for (const [path, method] of [['operations', 'POST'], ['competitive', 'DELETE'], ['ask-sar', 'GET']]) {
      assert.equal((await call(options, { path, method })).status, 405, `${method} ${path}`);
    }
  });

  test(`${name}: database errors and missing configuration stay generic`, async () => {
    for (const pool of [null, {}]) {
      const r = await call({ pool, authenticate: async () => 'viewer',
        loadOperations: async () => { throw Error('postgres://sensitive:password@host'); } }, { path: 'operations' });
      assert.equal(r.status, 503);
      assert.deepEqual(r.result, { error: 'Operations data is temporarily unavailable.' });
    }
    const ask = await call({ pool: null, apiKey: null, authenticate: async () => 'viewer' },
      { path: 'ask-sar', method: 'POST', body: question });
    assert.deepEqual([ask.status, ask.result.error], [503, 'Ask SAR is temporarily unavailable.']);
  });

  test(`${name}: Ask SAR answers with the server key, rejects oversize bodies and rate-limits`, async () => {
    let calls = 0, outgoing;
    const options = { pool: null, apiKey: sharedKey, authenticate: async () => 'viewer', now: () => 5000,
      knowledge: () => 'Flash is a card product.',
      fetchImpl: async (url, o) => { calls++; outgoing = { url: String(url), body: JSON.parse(o.body), key: o.headers['x-api-key'] };
        return ok({ content: [{ type: 'text', text: `Net improved. ${sharedKey}` }] }); } };
    // One handler instance per runtime so the per-account limit is shared.
    const handler = name === 'local' ? createLocalApi(options) : createEdgeHandler(options);
    const send = async (body) => {
      if (name === 'edge') {
        const res = await handler(new Request(`${EDGE}/sar2-api/ask-sar`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
        return { status: res.status, result: await res.json() };
      }
      const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
      Object.assign(req, { url: '/api/ask-sar', method: 'POST', headers: { host: '127.0.0.1:5173' } });
      let status, text;
      await handler(req, { setHeader() {}, end(t) { status = this.statusCode; text = t; } }, () => assert.fail('route'));
      return { status, result: JSON.parse(text) };
    };
    const first = await send(question);
    assert.equal(first.status, 200);
    assert.equal(first.result.text, 'Net improved. [redacted]');
    assert.equal(outgoing.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(outgoing.key, sharedKey);
    assert.match(outgoing.body.system[0].text, /Flash is a card product/);
    assert.equal((await send({ ...question, context: { blob: 'x'.repeat(MAX_BODY_BYTES) } })).status, 400);
    assert.equal((await send('not json')).status, 400);
    for (let i = 1; i < 10; i++) assert.equal((await send(question)).status, 200);
    assert.equal((await send(question)).status, 429);
    assert.equal(calls, 10);
  });

  test(`${name}: competitive reads the public monitor, never forwarding the token`, async () => {
    const r = await call({ authenticate: async () => 'viewer', fetchImpl: async (url, o) => {
      assert.match(String(url), /^https:\/\/frontier-bingo-text-monitor\.andrew595321\.chatgpt\.site\/api\/monitor\?hall=h1&offset=20$/);
      assert.equal(o.headers, undefined);
      return ok({ messages: [] });
    } }, { path: 'competitive?hall=h1&offset=20', authorization: 'Bearer t' });
    assert.equal(r.status, 200);
  });
}

test('route matching: local /api and the Edge function path, nothing else', () => {
  assert.equal(matchRoute('/api/operations', ['/api']), 'operations');
  assert.equal(matchRoute('/sar2-api/ask-sar', EDGE_PREFIXES), 'ask-sar');
  assert.equal(matchRoute('/functions/v1/sar2-api/competitive', EDGE_PREFIXES), 'competitive');
  for (const path of ['/api/operations', '/sar2-api', '/sar2-api/', '/sar2-api/operations/', '/sar2-api/constructor',
    '/sar2-api/__proto__', '/other/operations', '/sar2-apix/operations']) {
    assert.equal(matchRoute(path, EDGE_PREFIXES), null, path);
  }
  assert.equal(matchRoute('/sar2-api/operations', ['/api']), null);
});

test('edge: unknown paths are 404 JSON; local passes them on', async () => {
  const r = await callEdge({}, { path: 'nope' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.result, { error: 'Not found.' });
  assert.equal((await callLocal({}, { path: 'nope' })).status, 'next');
  assert.equal((await callEdge({ authenticate: async () => null }, { path: 'operations', prefix: '/functions/v1/sar2-api' })).status, 401);
});

test('edge CORS: the allowed origins get a preflight and CORS headers; others are refused', async () => {
  assert.deepEqual([...EDGE_ALLOWED_ORIGINS],
    ['https://andrewringlein.github.io', 'http://127.0.0.1:5173', 'http://localhost:5173']);
  for (const origin of EDGE_ALLOWED_ORIGINS) {
    for (const path of ['operations', 'ask-sar', 'competitive']) {
      const r = await callEdge({ authenticate: () => assert.fail('preflight never authenticates') },
        { path, method: 'OPTIONS', origin, headers: { 'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type' } });
      assert.equal(r.status, 204);
      assert.equal(r.headers['access-control-allow-origin'], origin);
      assert.match(r.headers['access-control-allow-methods'], /^GET, POST, OPTIONS$/);
      assert.equal(r.headers['access-control-allow-headers'], 'authorization, content-type');
      assert.equal(r.headers.vary, 'Origin');
    }
  }
  for (const origin of ['https://evil.example', 'https://andrewringlein.github.io.evil.example', 'null', 'http://127.0.0.1:4173']) {
    const pre = await callEdge({ authenticate: () => assert.fail('no auth') }, { path: 'operations', method: 'OPTIONS', origin });
    assert.equal(pre.status, 403, origin);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    const get = await callEdge({ authenticate: () => assert.fail('no auth') },
      { path: 'operations', origin, authorization: 'Bearer t' });
    assert.equal(get.status, 403, origin);
    assert.equal(get.headers['access-control-allow-origin'], undefined);
  }
  // A preflight with no Origin is not a browser preflight.
  assert.equal((await callEdge({}, { path: 'operations', method: 'OPTIONS' })).status, 403);
  // Errors carry CORS headers so the page can show the message.
  const denied = await callEdge({ authenticate: async () => null }, { path: 'operations', origin: PAGES });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['access-control-allow-origin'], PAGES);
});

test('local: still same-origin only, and OPTIONS is not served', async () => {
  const options = { authenticate: () => assert.fail('no auth') };
  assert.equal((await callLocal(options, { path: 'operations', origin: PAGES })).status, 403);
  assert.equal((await callLocal(options, { path: 'operations', method: 'OPTIONS', origin: 'http://127.0.0.1:5173' })).status, 405);
  const same = await callLocal({ authenticate: async () => null }, { path: 'operations', origin: 'http://127.0.0.1:5173' });
  assert.equal(same.status, 401);
  assert.equal(same.headers['access-control-allow-origin'], undefined);
});

test('edge: a declared Content-Length over the cap is refused before reading', async () => {
  const r = await callEdge({ pool: null, apiKey: sharedKey, authenticate: async () => 'viewer',
    fetchImpl: () => assert.fail('no upstream') },
  { path: 'ask-sar', method: 'POST', body: JSON.stringify(question), headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
  assert.equal(r.status, 400);
});

/* ---- Edge environment wiring --------------------------------------------- */

function fakePg() {
  const made = [];
  const parsers = {};
  class Pool {
    constructor(options) { this.options = options; this.handlers = {}; made.push(this); }
    on(event, fn) { this.handlers[event] = fn; }
  }
  return { made, parsers, pg: { Pool, types: { setTypeParser: (oid, fn) => { parsers[oid] = fn; } } } };
}
const envOf = (vars) => (name) => vars[name];
const DB_URL = 'postgresql://postgres.lkcfbgnuodqzvowschjn:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=disable';

test('edge env: SUPABASE_DB_URL becomes a verified-TLS pool for the Operations project only', async () => {
  const { made, parsers, pg } = fakePg();
  createEdgeServer({ env: envOf({ SUPABASE_DB_URL: DB_URL }), pg, ca: SUPABASE_ROOT_CA });
  assert.equal(made.length, 1);
  const o = made[0].options;
  assert.deepEqual(o.ssl, { rejectUnauthorized: true, ca: SUPABASE_ROOT_CA });
  assert.doesNotMatch(o.connectionString, /sslmode/);
  assert.ok(o.max <= 2);
  assert.equal(parsers[1082]('2026-08-16'), '2026-08-16', 'DATE stays text');
  assert.equal(typeof made[0].handlers.error, 'function');
  assert.match(SUPABASE_ROOT_CA, /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/);

  // Another project's database is refused: no pool, a generic 503.
  const other = fakePg();
  const warn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const handler = createEdgeServer({ env: envOf({ SUPABASE_DB_URL: 'postgresql://postgres:pw@db.faoqpyjhwvwgwvmgqxjr.supabase.co:5432/postgres' }),
      pg: other.pg, authenticate: async () => 'viewer' });
    assert.equal(other.made.length, 0);
    const res = await handler(new Request(`${EDGE}/sar2-api/operations`));
    assert.equal(res.status, 503);
    assert.ok(warned.every((w) => !/pw|faoqpyjhwvwgwvmgqxjr/.test(w)), 'no connection details logged');
  } finally { console.warn = warn; }
});

test('edge env: the Anthropic key comes from SAR_ANTHROPIC_API_KEY, else the Vault, and is never returned', async () => {
  const send = (handler) => handler(new Request(`${EDGE}/sar2-api/ask-sar`, { method: 'POST', body: JSON.stringify(question) }));
  let used, model;
  const fetchImpl = async (url, o) => { used = o.headers['x-api-key']; model = JSON.parse(o.body).model;
    return ok({ content: [{ type: 'text', text: 'Fine.' }] }); };
  const { pg } = fakePg();
  // 1. Edge Function secret.
  let vaultReads = 0;
  let handler = createEdgeServer({ env: envOf({ SUPABASE_DB_URL: DB_URL, SAR_ANTHROPIC_API_KEY: sharedKey, SAR_ANTHROPIC_MODEL: 'claude-haiku-4-5' }),
    pg, authenticate: async () => 'viewer', fetchImpl, loadKey: async () => { vaultReads++; return null; } });
  let res = await send(handler);
  assert.equal(res.status, 200);
  assert.equal(used, sharedKey);
  assert.equal(model, 'claude-haiku-4-5');
  assert.equal(vaultReads, 0);
  assert.doesNotMatch(await res.text(), /sk-ant/);
  // 2. No secret: the shared Vault key, read through the pool (as locally).
  handler = createEdgeServer({ env: envOf({ SUPABASE_DB_URL: DB_URL }), pg, authenticate: async () => 'viewer', fetchImpl,
    loadKey: async (pool) => { assert.ok(pool.options); return `${sharedKey}-vault`; } });
  res = await send(handler);
  assert.equal(res.status, 200);
  assert.equal(used, `${sharedKey}-vault`);
  assert.equal(model, 'claude-sonnet-5-5');
  // 3. Neither: the existing "temporarily unavailable".
  handler = createEdgeServer({ env: envOf({ SAR_ANTHROPIC_API_KEY: 'not-a-key' }), pg, authenticate: async () => 'viewer',
    fetchImpl: () => assert.fail('no upstream') });
  res = await send(handler);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Ask SAR is temporarily unavailable.' });
});

test('edge env: the bundled knowledge text reaches the prompt, bounded', async () => {
  let system;
  const handler = createEdgeServer({ env: envOf({ SAR_ANTHROPIC_API_KEY: sharedKey }), pg: fakePg().pg,
    knowledge: `Owner note. ${'k'.repeat(70000)}`, authenticate: async () => 'viewer',
    fetchImpl: async (u, o) => { system = JSON.parse(o.body).system; return ok({ content: [] }); } });
  await handler(new Request(`${EDGE}/sar2-api/ask-sar`, { method: 'POST', body: JSON.stringify(question) }));
  assert.match(system[0].text, /# Knowledge\nOwner note\./);
  assert.ok(system[0].text.length < 61000 + 2000);
});

/* ---- Browser API base ----------------------------------------------------- */

test('browser: localhost keeps the local /api; every other host uses the Edge Function', () => {
  assert.equal(EDGE_API_BASE, 'https://lkcfbgnuodqzvowschjn.supabase.co/functions/v1/sar2-api');
  assert.equal(apiBase('localhost'), LOCAL_API_BASE);
  assert.equal(apiBase('127.0.0.1'), '/api');
  for (const host of ['andrewringlein.github.io', 'vanguard.bingobuyin.com', '192.168.1.20', '']) {
    assert.equal(apiBase(host), EDGE_API_BASE, host);
  }
  assert.equal(apiUrl('/api/operations', '127.0.0.1'), '/api/operations');
  assert.equal(apiUrl('/api/competitive?hall=a&offset=0', 'andrewringlein.github.io'),
    `${EDGE_API_BASE}/competitive?hall=a&offset=0`);
  assert.equal(apiUrl('/api/ask-sar', 'andrewringlein.github.io'), `${EDGE_API_BASE}/ask-sar`);
});

test('browser: serverRequest sends the bms-production token to the chosen base', async () => {
  const { serverRequest } = await import('../src/lib/server-request.js');
  const { supabase } = await import('../src/lib/api.js');
  const original = supabase.auth.getSession;
  supabase.auth.getSession = async () => ({ data: { session: { access_token: 'tok' } }, error: null });
  try {
    const seen = [];
    const fetchImpl = async (url, o) => { seen.push({ url, o }); return { ok: true, json: async () => ({ ok: true }) }; };
    await serverRequest('/api/operations', { fetchImpl, hostname: 'andrewringlein.github.io' });
    await serverRequest('/api/ask-sar', { fetchImpl, hostname: 'localhost', body: { q: 1 } });
    assert.equal(seen[0].url, `${EDGE_API_BASE}/operations`);
    assert.equal(seen[0].o.method, 'GET');
    assert.equal(seen[0].o.headers.authorization, 'Bearer tok');
    assert.equal(seen[1].url, '/api/ask-sar');
    assert.equal(seen[1].o.method, 'POST');
    assert.equal(seen[1].o.headers.authorization, 'Bearer tok');
  } finally { supabase.auth.getSession = original; }
});

/* ---- The deploy bundle ---------------------------------------------------- */

test('the committed Edge bundle is exactly what npm run build:edge produces', async () => {
  const { buildEdgeBundle, EDGE_OUTPUT } = await import('../scripts/build-edge.mjs');
  const committed = readFileSync(EDGE_OUTPUT, 'utf8').replace(/\r\n?/g, '\n');
  assert.ok(committed === await buildEdgeBundle(),
    'supabase/functions/sar2-api/index.ts is stale: run npm run build:edge and commit it');
});

test('the Edge bundle is self-contained: only npm: imports, knowledge inlined, no secrets', () => {
  const bundle = readFileSync(new URL('../supabase/functions/sar2-api/index.ts', import.meta.url), 'utf8');
  const imports = [...bundle.matchAll(/^\s*import\s[^'"]*?["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['npm:pg@8']);
  assert.doesNotMatch(bundle, /\brequire\(|from ["']node:|import\(["'](?!npm:)/);
  assert.match(bundle, /Bingo knowledge for Ask SAR/);
  assert.match(bundle, /Deno\.serve\(/);
  assert.match(bundle, /Deno\.env\.get/);
  assert.doesNotMatch(bundle, /sk-ant-[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(bundle, /SUPABASE_SERVICE_ROLE|service_role/);
  assert.match(readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8'),
    /\[functions\.sar2-api\]\s*\n(?:#.*\n)*verify_jwt = false/);
});

test('shared server modules are runtime-neutral (no Node-only or driver imports)', () => {
  for (const file of ['server/api-core.mjs', 'server/edge-api.mjs', 'server/ops-read.mjs', 'server/competitive.mjs',
    'server/supabase-ca.mjs', 'src/lib/ops-schema.js', 'src/lib/config.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // code, not comments
    const imports = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of imports) assert.match(spec, /^\.\.?\//, `${file} imports ${spec}`);
    assert.doesNotMatch(src, /\b(process\.|Buffer\.|Deno\.|require\()/, file);
  }
});
