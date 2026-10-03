/* ============================================================================
   Ask SAR cost limits — the size caps and the per-account daily quota.

   Ask SAR spends real money per question, so what one signed-in account can
   send is bounded three ways: the size of one request (context and history),
   a per-minute burst limit, and a daily quota that survives restarts when the
   sar2_ask_usage table exists (and falls back to memory when it cannot be
   written, e.g. through the read-only sar_reader login).
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  createApiCore, sanitizeHistory, ASK_USAGE_SQL, ASK_DAILY_CALLS, ASK_DAILY_CHARS,
  MAX_CONTEXT_CHARS, MAX_BODY_BYTES, MAX_HISTORY_CHARS, quotaDay,
} from '../server/api-core.mjs';

const dom = new JSDOM('<!doctype html><div id="app"></div>');
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
const { buildContext, fitContext, recentHistory } = await import('../src/screens/ask.js');
const { indexMetrics } = await import('../src/lib/model.js');

const KEY = 'sk-ant-fixture-only-not-a-real-key';
const USER = '6f1c2b8e-1d2a-4b7e-9a51-3c0f8e2d4a10';
const question = { question: 'How was net?', context: { months: [] } };
const answer = { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Fine.' }] }) };

/** A core with every dependency observable. `clock` advances past the per-minute window. */
function core(over = {}) {
  const seen = { upstream: 0, keys: 0 };
  let t = Date.UTC(2026, 9, 2, 18);
  const handle = createApiCore({
    apiKey: null, authenticate: async () => USER, knowledge: () => '',
    loadKey: async () => { seen.keys++; return KEY; },
    fetchImpl: async () => { seen.upstream++; return answer; },
    now: () => t,
    ...over,
  });
  const ask = async (body) => {
    t += 61000;                                    // never the per-minute limit
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return handle({ method: 'POST', url: '/api/ask-sar', headers: { host: '127.0.0.1:5173' },
      readBody: async (max) => {
        if (Buffer.byteLength(raw) > max) throw new Error('payload');
        return JSON.parse(raw);
      } });
  };
  return { ask, seen, at: () => t };
}

/** A pool that behaves like the real upsert: a row back only within both limits. */
function quotaPool() {
  const rows = new Map();
  const calls = [];
  return {
    calls, rows,
    query: async (sql, params) => {
      calls.push({ sql, params });
      assert.equal(sql, ASK_USAGE_SQL);
      const [user, chars, maxCalls, maxChars] = params;
      const cur = rows.get(user);
      if (!cur) { rows.set(user, { calls: 1, chars }); return { rows: [{ calls: 1, chars }] }; }
      if (cur.calls + 1 > maxCalls || cur.chars + chars > maxChars) return { rows: [] };
      cur.calls += 1; cur.chars += chars;
      return { rows: [{ ...cur }] };
    },
  };
}
const pgError = (code) => Object.assign(new Error(`relation "x" (${code}) at db.secret-host`), { code });

/* ---------------------------------------------------------------------------
   The measured payload fits, with room to grow
--------------------------------------------------------------------------- */
function productionShaped(n) {
  const cats = ['flash', 'strip', 'paper', 'cherries', 'other'];
  const keys = [...cats, ...cats.map((c) => `${c}_payout`), 'attendance', 'hotball_total', 'hotball_payout',
    'mega_hotball_total', 'mega_hotball_payout', 'gremlin_hotball'];
  const defs = keys.map((k, i) => ({ id: `m${i}`, key: k, canonical_key: k, is_active: true }));
  const id = Object.fromEntries(defs.map((d) => [d.key, d.id]));
  const events = []; const metrics = {};
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2026, 9, 1) - Math.floor(i / 1.2) * 86400000).toISOString().slice(0, 10);
    events.push({ id: `e${i}`, location_id: i % 3 ? 'LS' : 'LR', event_date: date, event_type: i % 6 ? 'regular' : 'late' });
    const m = { [id.attendance]: 150 + (i % 90), [id.hotball_total]: 1234500 + i, [id.mega_hotball_total]: 7512300 + i,
      [id.hotball_payout]: i % 9 ? 0 : 81500, [id.mega_hotball_payout]: i % 40 ? 0 : 1500000, [id.gremlin_hotball]: i % 11 ? 0 : 134640 };
    for (const c of cats) { m[id[c]] = 1234567 + i * 13; m[id[`${c}_payout`]] = 987654 + i * 7; }
    metrics[`e${i}`] = m;
  }
  return {
    events, metrics, idx: indexMetrics(defs), metricDefs: defs,
    categories: cats.map((c) => ({ key: c, display_name: c, revenue_keys: [c], payout_keys: [`${c}_payout`] })),
    locations: [{ id: 'LS', name: 'Santa Clara' }, { id: 'LR', name: 'Redwood City' }],
    config: { settings: { jackpots: [
      { name: 'Hotball', scope: 'per_location', cap: 5000, balanceKey: 'hotball_total', paidKey: 'hotball_payout' },
      { name: 'Mega Hotball', scope: 'org_wide', cap: 15000, balanceKey: 'mega_hotball_total', paidKey: 'mega_hotball_payout' },
    ] } },
  };
}

test('the real 900-session payload is well inside the context cap, and so is 2,000 sessions', async () => {
  const size = (n) => JSON.stringify(buildContext(productionShaped(n))).length;
  const today = size(900);
  assert.ok(today > 120000 && today < 250000, `900 sessions measured ${today} chars; revisit MAX_CONTEXT_CHARS`);
  assert.ok(size(2000) < MAX_CONTEXT_CHARS, 'about five more years of sessions still fit');
  assert.ok(MAX_CONTEXT_CHARS < 2 * 2000 * 200 + 100000, 'the cap is not wildly above any real payload');
  // And the whole request for it fits the body cap.
  const { ask, seen } = core({ pool: null, apiKey: KEY });
  const r = await ask({ ...question, context: buildContext(productionShaped(900)) });
  assert.equal(r.status, 200);
  assert.equal(seen.upstream, 1);
  assert.ok(MAX_BODY_BYTES > MAX_CONTEXT_CHARS + MAX_HISTORY_CHARS);
});

test('a context over the cap is refused with 413 before any quota, key or spend', async () => {
  const pool = quotaPool();
  const { ask, seen } = core({ pool });
  const r = await ask({ ...question, context: { blob: 'x'.repeat(MAX_CONTEXT_CHARS) } });
  assert.equal(r.status, 413);
  assert.match(r.body.error, /too much data/);
  assert.equal(seen.keys + seen.upstream + pool.calls.length, 0);
});

test('a body over the byte cap is refused with 413, malformed JSON with 400', async () => {
  const { ask, seen } = core({ pool: null, apiKey: KEY });
  assert.equal((await ask({ ...question, context: { blob: 'x'.repeat(MAX_BODY_BYTES) } })).status, 413);
  assert.equal((await ask('{"question":')).status, 400);
  assert.equal(seen.upstream, 0);
});

test('conversation history is capped in total characters, oldest turns dropped first', () => {
  const turn = (i) => [{ role: 'user', content: `q${i} ${'x'.repeat(5000)}` },
    { role: 'assistant', content: `a${i} ${'y'.repeat(5000)}` }];
  const kept = sanitizeHistory([0, 1, 2, 3, 4, 5].flatMap(turn));
  const total = kept.reduce((n, t) => n + t.content.length, 0);
  assert.ok(total <= MAX_HISTORY_CHARS, `history kept ${total} chars`);
  assert.equal(kept.at(-1).content.slice(0, 2), 'a5', 'the newest exchange survives');
  assert.equal(kept[0].role, 'user', 'still starts with a question');
});

/* ---------------------------------------------------------------------------
   The persistent daily quota
--------------------------------------------------------------------------- */
test('the quota is one atomic upsert that only counts a call within both limits', () => {
  assert.match(ASK_USAGE_SQL, /^INSERT INTO public\.sar2_ask_usage/);
  assert.match(ASK_USAGE_SQL, /ON CONFLICT \(user_id, day\) DO UPDATE/);
  assert.match(ASK_USAGE_SQL, /WHERE u\.calls \+ 1 <= \$3 AND u\.chars \+ EXCLUDED\.chars <= \$4/);
  assert.match(ASK_USAGE_SQL, /RETURNING/);
  assert.match(ASK_USAGE_SQL, /America\/Los_Angeles/);
  assert.equal(ASK_USAGE_SQL.split(';').length, 1, 'a single statement');
  assert.equal(ASK_DAILY_CALLS, 100);
  assert.equal(ASK_DAILY_CHARS, 3000000);
});

test('with the table: every call is counted before spending, and the 101st is refused', async () => {
  const pool = quotaPool();
  const { ask, seen } = core({ pool });
  for (let i = 0; i < ASK_DAILY_CALLS; i++) assert.equal((await ask(question)).status, 200);
  const over = await ask(question);
  assert.equal(over.status, 429);
  assert.match(over.body.error, /today's Ask SAR limit/);
  assert.equal(seen.upstream, ASK_DAILY_CALLS, 'the refused call never reached Anthropic');
  assert.equal(seen.keys, ASK_DAILY_CALLS, 'nor read the key');
  const [user, chars, calls, max] = pool.calls[0].params;
  assert.equal(user, USER);
  assert.ok(chars > JSON.stringify(question.context).length, 'prompt, data and question are all counted');
  assert.deepEqual([calls, max], [ASK_DAILY_CALLS, ASK_DAILY_CHARS]);
});

test('with the table: the character quota stops a few huge questions', async () => {
  const pool = quotaPool();
  const { ask, seen } = core({ pool });
  const big = { ...question, context: { blob: 'x'.repeat(MAX_CONTEXT_CHARS - 100) } };
  let ok = 0;
  for (let i = 0; i < 10; i++) if ((await ask(big)).status === 200) ok++;
  assert.equal(ok, Math.floor(ASK_DAILY_CHARS / (MAX_CONTEXT_CHARS)), 'six full-size questions a day');
  assert.equal(seen.upstream, ok);
});

for (const code of ['42P01', '42501', '25006']) {
  test(`without a writable table (${code}): the same limits are kept in memory, logged once, no details`, async () => {
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      let tries = 0;
      const pool = { query: async () => { tries++; throw pgError(code); } };
      const { ask, seen } = core({ pool });
      for (let i = 0; i < ASK_DAILY_CALLS; i++) assert.equal((await ask(question)).status, 200);
      assert.equal((await ask(question)).status, 429);
      assert.equal(seen.upstream, ASK_DAILY_CALLS);
      assert.equal(tries, ASK_DAILY_CALLS + 1, 'the table is retried each time, in case it appears');
      const quota = warned.filter((w) => /daily quota/.test(w));
      assert.equal(quota.length, 1, 'logged once');
      assert.doesNotMatch(quota[0], /secret-host|relation/, 'the error text is never logged');
    } finally { console.warn = warn; }
  });
}

test('with no pool at all (server key only): the in-memory daily limit applies', async () => {
  const { ask, seen } = core({ pool: null, apiKey: KEY });
  for (let i = 0; i < ASK_DAILY_CALLS; i++) assert.equal((await ask(question)).status, 200);
  assert.equal((await ask(question)).status, 429);
  assert.equal(seen.upstream, ASK_DAILY_CALLS);
});

test('the in-memory quota resets on the next Pacific day', async () => {
  let t = Date.UTC(2026, 9, 1, 16);                   // 09:00 Pacific on 1 Oct
  const handle = createApiCore({ pool: null, apiKey: KEY, authenticate: async () => USER,
    fetchImpl: async () => answer, now: () => t, knowledge: () => '' });
  const ask = async () => { t += 61000; return handle({ method: 'POST', url: '/api/ask-sar',
    headers: { host: 'h' }, readBody: async () => question }); };
  for (let i = 0; i < ASK_DAILY_CALLS; i++) assert.equal((await ask()).status, 200);
  assert.equal(quotaDay(t), '2026-10-01');
  assert.equal((await ask()).status, 429);
  t = Date.UTC(2026, 9, 2, 7, 5);                     // 00:05 Pacific on 2 Oct
  assert.equal(quotaDay(t + 61000), '2026-10-02');
  assert.equal((await ask()).status, 200);
});

test('any other database failure fails closed: no answer, no spend', async () => {
  const pool = { query: async () => { throw pgError('08006'); } };
  const { ask, seen } = core({ pool });
  const r = await ask(question);
  assert.equal(r.status, 503);
  assert.equal(seen.upstream + seen.keys, 0);
});

/* ---------------------------------------------------------------------------
   The browser never builds a request the server would refuse
--------------------------------------------------------------------------- */
test('the browser leaves out the OLDEST session rows once the package outgrows the cap, and says so', () => {
  const full = buildContext(productionShaped(900));
  assert.equal(fitContext(full), full, 'today: sent whole, untouched');
  const max = 100000;
  const fitted = fitContext(full, max);
  assert.ok(JSON.stringify(fitted).length <= max);
  assert.ok(fitted.sessions.length > 100 && fitted.sessions.length < full.sessions.length);
  assert.deepEqual(fitted.sessions.at(-1), full.sessions.at(-1), 'the newest night is kept');
  assert.equal(fitted.span.from, fitted.sessions[0][0]);
  assert.match(fitted.sessionsNote, /Older session rows were left out/);
  assert.deepEqual(fitted.monthly, full.monthly, 'the summaries still cover everything');
});

test('the browser sends only recent history, within the same limits the server applies', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${'z'.repeat(4000)}`, shown: 'x' }));
  const h = recentHistory(turns);
  assert.ok(h.length <= 12);
  assert.ok(h.reduce((n, t) => n + t.content.length, 0) <= MAX_HISTORY_CHARS);
  assert.equal(h[0].role, 'user');
  assert.deepEqual(Object.keys(h[0]), ['role', 'content'], 'display-only fields are not sent');
  assert.deepEqual(sanitizeHistory(h), h, 'the server keeps exactly what the browser sent');
});
