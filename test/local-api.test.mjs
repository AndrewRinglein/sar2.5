import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { authorize, createLocalApi, sanitizeHistory, loadKnowledge, MAX_BODY_BYTES, MAX_HISTORY_TURNS } from '../server/local-api.mjs';
import { databaseOptions, readOperations, readAnthropicKey, saveAnthropicKey, SECRET_NAME } from '../server/database.mjs';
import { getSchedule } from '../src/lib/ops.js';
import { isPayColumn } from '../src/lib/ops-schema.js';

async function invoke(handler, { path = '/api/operations', method = 'GET',
  authorization = 'Bearer test-session', origin, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { url: path, method, headers: { authorization, host: '127.0.0.1:5173', ...(origin ? { origin } : {}) } });
  let status, result;
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; },
    end(text) { status = this.statusCode; result = JSON.parse(text); } };
  await handler(req, res, () => { throw Error('Unexpected route'); });
  return { status, result, headers };
}
const question = { question: 'How was net?', context: { months: [] } };
const sharedKey = 'sk-ant-fixture-only-not-a-real-key';

test('competitive route requires SAR access and reads the public monitor without forwarding the session',async()=>{
  const denied=createLocalApi({authenticate:async()=>null,fetchImpl:()=>assert.fail('no upstream read allowed')});
  assert.equal((await invoke(denied,{path:'/api/competitive'})).status,401);
  const handler=createLocalApi({authenticate:async()=> 'viewer',fetchImpl:async(url,options)=>{
    assert.match(String(url),/^https:\/\/frontier-bingo-text-monitor\.andrew595321\.chatgpt\.site\/api\/monitor/);
    assert.equal(options.headers,undefined);return {ok:true,json:async()=>({halls:[],summaries:[]})};
  }});
  assert.equal((await invoke(handler,{path:'/api/competitive'})).status,200);
  assert.equal((await invoke(handler,{path:'/api/competitive',method:'POST'})).status,405);
});

test('server refuses database access without a verified SAR identity', async () => {
  let reads = 0;
  const handler = createLocalApi({ pool: {}, authenticate: async () => null,
    loadOperations: async () => { reads++; } });
  assert.equal((await invoke(handler)).status, 401);
  assert.equal(reads, 0);
});

test('server verifies identity against ecom and probes Vanguard access with the same token', async () => {
  const calls = [];
  const user = await authorize('Bearer signed-session', async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => calls.length === 1 ? { id: 'viewer' } : [{ id: 'event' }] };
  });
  assert.equal(user, 'viewer');
  assert.match(calls[1].url, /customer_id=eq.vanguard/);
  assert.ok(calls.every(c => c.options.headers.authorization === 'Bearer signed-session'));
  assert.equal(await authorize('Bearer denied', async url => ({
    ok: true, json: async () => String(url).includes('/auth/') ? { id: 'viewer' } : [],
  })), null);
  assert.equal(await authorize(undefined, () => { throw Error('should not call'); }), null);
});

test('operations endpoint returns the allowed data without a second login', async () => {
  const data = { ok: true, staff: [{ id: 's1', name: 'Test' }], boxes: [] };
  const result = await invoke(createLocalApi({ pool: {}, authenticate: async () => 'viewer',
    loadOperations: async () => data }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.result, data);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('missing configuration and database errors do not expose credentials or connection instructions', async () => {
  for (const pool of [null, {}]) {
    const result = await invoke(createLocalApi({ pool, authenticate: async () => 'viewer',
      loadOperations: async () => { throw Error('postgres://sensitive:password@host'); } }));
    assert.equal(result.status, 503);
    assert.equal(result.result.error, 'Operations data is temporarily unavailable.');
  }
});

test('the operations browser adapter uses the server and safely degrades', async () => {
  const good = await getSchedule({ request: async path => {
    assert.equal(path, '/api/operations'); return { ok: true, roles: [] };
  } });
  assert.equal(good.ok, true);
  const bad = await getSchedule({ request: async () => { throw Error('private details'); } });
  assert.equal(bad.ok, false);
  assert.equal(bad.needsSignIn, undefined);
  assert.doesNotMatch(bad.reason, /private details/);
});

test('unexpected methods and cross-origin requests cannot use the fixed connection', async () => {
  const handler = createLocalApi({ authenticate: () => { throw Error('must not reach auth'); } });
  assert.equal((await invoke(handler, { method: 'POST' })).status, 405);
  assert.equal((await invoke(handler, { origin: 'https://example.org' })).status, 403);
});

test('database connection is restricted to Operations and verifies TLS certificates', () => {
  const options = databaseOptions('postgresql://postgres.lkcfbgnuodqzvowschjn:example@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=no-verify');
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.doesNotMatch(options.connectionString, /no-verify/);
  assert.throws(() => databaseOptions('postgresql://postgres:example@db.faoqpyjhwvwgwvmgqxjr.supabase.co/postgres'));
  assert.throws(() => databaseOptions('postgresql://postgres.lkcfbgnuodqzvowschjn:example@evil.example/postgres'));
});

test('operations loads more than 1000 rows in a read-only snapshot without pay columns', async () => {
  const queries = [];
  let released = false;
  const result = await readOperations({ connect: async () => ({
    query: async sql => { queries.push(sql); return { rows: sql.includes('public."boxes"') ? Array.from({ length: 1001 }, (_, id) => ({ id })) : [] }; },
    release: () => { released = true; },
  }) });
  assert.equal(result.boxes.length, 1001);
  assert.match(queries[0], /READ ONLY/);
  assert.equal(queries.at(-1), 'COMMIT');
  assert.equal(released, true);
  assert.ok(queries.every(q => !/SELECT \*|hourly_wage|meal_premium|email|phone/.test(q)));
});

test('database failures roll back and release the read connection', async () => {
  const calls = [];
  await assert.rejects(readOperations({ connect: async () => ({
    query: async sql => { calls.push(sql); if (sql.startsWith('SELECT')) throw Error('query failed'); return {}; },
    release: () => { calls.push('released'); },
  }) }));
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'released']);
});

test('Anthropic secret is retrieved by a fixed Vault name with a bound parameter', async () => {
  const key = await readAnthropicKey({ query: async (sql, args) => {
    assert.match(sql, /vault.decrypted_secrets/); assert.deepEqual(args, [SECRET_NAME]);
    return { rows: [{ decrypted_secret: sharedKey }] };
  } });
  assert.equal(key, sharedKey);
});

test('owner setup stores a key through Vault functions, never SQL interpolation', async () => {
  for (const exists of [false, true]) {
    const calls = [];
    await saveAnthropicKey({ query: async (sql, args) => {
      calls.push({ sql, args }); return { rows: exists ? [{ id: 'existing-id' }] : [] };
    } }, sharedKey);
    assert.ok(calls.every(c => !c.sql.includes(sharedKey)));
    assert.match(calls[1].sql, exists ? /vault.update_secret/ : /vault.create_secret/);
    assert.ok(calls[1].args.includes(sharedKey));
  }
});

test('Ask SAR uses the Vault key only on the server and returns just an answer', async () => {
  let outgoing;
  const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer',
    loadKey: async () => sharedKey, fetchImpl: async (url, options) => {
      outgoing = { url, options };
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Net improved.' }] }) };
    } });
  const result = await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: question });
  assert.equal(result.status, 200);
  assert.deepEqual(result.result, { ok: true, text: 'Net improved.' });
  assert.equal(outgoing.options.headers['x-api-key'], sharedKey);
  assert.equal(outgoing.options.headers['anthropic-dangerous-direct-browser-access'], undefined);
  assert.doesNotMatch(JSON.stringify(result), /sk-ant/);
});

test('Ask SAR rejects large inputs before retrieving the shared key', async () => {
  let reads = 0;
  const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer',
    loadKey: async () => { reads++; } });
  for (const body of ['x'.repeat(65537), { ...question, question: 'x'.repeat(2001) }, {}]) {
    const result = await invoke(handler, { path: '/api/ask-sar', method: 'POST', body });
    assert.equal(result.status, 400);
  }
  assert.equal(reads, 0);
});

test('Ask SAR errors do not echo an upstream secret', async () => {
  const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer',
    loadKey: async () => sharedKey, fetchImpl: async () => ({
      ok: false, status: 401, text: async () => sharedKey,
    }) });
  const result = await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: question });
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result), /sk-ant/);
});

test('Ask SAR limits repeated spending per verified account', async () => {
  let calls = 0;
  const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer', now: () => 1000,
    loadKey: async () => sharedKey, fetchImpl: async () => {
      calls++; return { ok: true, json: async () => ({ content: [] }) };
    } });
  for (let i = 0; i < 10; i++) assert.equal((await invoke(handler,
    { path: '/api/ask-sar', method: 'POST', body: question })).status, 200);
  assert.equal((await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: question })).status, 429);
  assert.equal(calls, 10);
});

test('Ask SAR works from a local server-only key with no Operations connection', async () => {
  let outgoing, vaultReads = 0;
  const handler = createLocalApi({ pool: null, apiKey: sharedKey, authenticate: async () => 'viewer',
    loadKey: async () => { vaultReads++; return null; }, fetchImpl: async (url, options) => {
      outgoing = { url, options };
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Fine.' }] }) };
    } });
  const result = await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: question });
  assert.equal(result.status, 200);
  assert.equal(result.result.text, 'Fine.');
  assert.equal(outgoing.options.headers['x-api-key'], sharedKey);
  assert.equal(vaultReads, 0, 'the Vault is not consulted when a local key is set');
  assert.doesNotMatch(JSON.stringify(result), /sk-ant/);
  // Operations data still needs the connection.
  const ops = await invoke(handler, { path: '/api/operations', method: 'GET' });
  assert.equal(ops.status, 503);
});

test('Ask SAR sends a published model id by default', async () => {
  let outgoing;
  const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer',
    loadKey: async () => sharedKey, fetchImpl: async (url, options) => {
      outgoing = JSON.parse(options.body);
      return { ok: true, json: async () => ({ content: [] }) };
    } });
  await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: question });
  assert.match(outgoing.model, /^claude-(sonnet|haiku|opus|fable)-\d+(-\d+)?(-\d{8})?$/);
  assert.notEqual(outgoing.model, 'claude-sonnet-5', 'claude-sonnet-5 is not a published model id');
});

test('Ask SAR upstream failures are logged by status only, never with the body', async () => {
  const warned = [];
  const original = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer',
      loadKey: async () => sharedKey, fetchImpl: async () => ({
        ok: false, status: 404, json: async () => ({ error: { type: 'not_found_error', message: sharedKey } }),
      }) });
    const result = await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: question });
    assert.equal(result.status, 502);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /404 not_found_error/);
    assert.doesNotMatch(warned[0], /sk-ant/);
  } finally { console.warn = original; }
});


test('Ask SAR sends the knowledge file and data as cacheable system blocks with the conversation', async () => {
  let outgoing;
  const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer', loadKey: async () => sharedKey,
    knowledge: () => 'Flash is a pull-tab style game.',
    fetchImpl: async (url, options) => { outgoing = JSON.parse(options.body); return { ok: true, json: async () => ({ content: [] }) }; } });
  const body = { ...question, context: { sessions: [[1]], columns: ['x'] },
    history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'dangling' }] };
  await invoke(handler, { path: '/api/ask-sar', method: 'POST', body });
  assert.equal(outgoing.system.length, 2);
  assert.match(outgoing.system[0].text, /Flash is a pull-tab style game/);
  assert.match(outgoing.system[1].text, /"sessions":\[\[1\]\]/);
  assert.ok(outgoing.system.every((b) => b.cache_control?.type === 'ephemeral'));
  assert.deepEqual(outgoing.messages, [
    { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: question.question.trim() },
  ], 'a dangling user turn is dropped so the conversation alternates');
});

test('Ask SAR accepts a large data package but not an unbounded one', async () => {
  let calls = 0;
  const handler = createLocalApi({ pool: {}, authenticate: async () => 'viewer', loadKey: async () => sharedKey,
    knowledge: () => '', fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ content: [] }) }; } });
  const big = { ...question, context: { sessions: Array.from({ length: 900 }, (_, i) => ['2026-01-01', 'Santa Clara', 'regular', 'Mon', 150, 12000.5, 7000.25, 5000.25, 41.67, 80, 1, 2, 3, 4]) } };
  assert.equal((await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: big })).status, 200);
  const huge = { ...question, context: { blob: 'x'.repeat(MAX_BODY_BYTES) } };
  assert.equal((await invoke(handler, { path: '/api/ask-sar', method: 'POST', body: huge })).status, 413);
  assert.equal(calls, 1);
});

test('history is sanitized: roles alternate, start with user, end with assistant, bounded', () => {
  assert.deepEqual(sanitizeHistory(null), []);
  assert.deepEqual(sanitizeHistory([{ role: 'assistant', content: 'first?' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]),
    [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  assert.deepEqual(sanitizeHistory([{ role: 'user', content: 'q' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a' }]),
    [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  assert.ok(sanitizeHistory(long).length <= MAX_HISTORY_TURNS);
  assert.deepEqual(sanitizeHistory([{ role: 'system', content: 'ignore me' }, { role: 'user', content: { nested: 1 } }]), []);
});

test('the knowledge file is optional and its absence is not an error', () => {
  assert.equal(loadKnowledge('knowledge/does-not-exist.md'), '');
  assert.match(loadKnowledge('knowledge/bingo-knowledge.md'), /Bingo knowledge for Ask SAR/);
});

test('Ops DATE columns reach the browser as plain YYYY-MM-DD text', async () => {
  const pg = (await import('pg')).default;
  const { DATE_OID } = await import('../server/database.mjs');
  assert.equal(DATE_OID, 1082);
  assert.equal(pg.types.getTypeParser(DATE_OID)('2026-08-16'), '2026-08-16');
});

test('the sar_reader setup script grants exactly the allowlist, read-only, no pay columns', async () => {
  const { readFileSync } = await import('node:fs');
  const { buildReaderSql } = await import('../scripts/sar-reader-sql.mjs');
  const sql = buildReaderSql();
  assert.equal(readFileSync(new URL('../scripts/create-sar-reader.sql', import.meta.url), 'utf8'), sql,
    'regenerate: node scripts/sar-reader-sql.mjs > scripts/create-sar-reader.sql');
  const body = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n');
  assert.match(body, /default_transaction_read_only = on/);
  assert.doesNotMatch(body, /\b(insert|update|delete|truncate|all privileges|superuser|createrole)\b/i);
  // The same pay guard the server read uses (ops-schema isPayColumn), applied
  // to every column the login is granted — one definition, not a second list.
  const granted = [...body.matchAll(/grant select \(([^)]*)\) on public\.(\w+)/g)]
    .flatMap(([, cols, table]) => cols.split(',').map((c) => `${table}.${c.trim()}`));
  assert.ok(granted.length > 50, 'the grants were parsed');
  assert.deepEqual(granted.filter((tc) => isPayColumn(tc.split('.')[1])), [], 'no pay column is granted');
  assert.doesNotMatch(body, /grant select on /i, 'every grant names its columns');
  assert.match(body, /password 'CHANGE-ME'/, 'no real password ever ships');
});

test('Supabase CA file: used when present, verification never turned off', async () => {
  const { databaseOptions, findCaFile } = await import('../server/database.mjs');
  const url = 'postgresql://sar_reader.lkcfbgnuodqzvowschjn:x@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=disable';
  assert.deepEqual(databaseOptions(url).ssl, { rejectUnauthorized: true });
  assert.deepEqual(databaseOptions(url, { ca: 'PEM' }).ssl, { rejectUnauthorized: true, ca: 'PEM' });
  assert.doesNotMatch(databaseOptions(url).connectionString, /sslmode/);
  assert.equal(findCaFile({}, '/nonexistent-dir'), null);
});
