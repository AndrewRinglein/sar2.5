import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, createApiCore } from '../server/api-core.mjs';
import { createLoginSender, SAR_RETURN_URL, LOGIN_SLOT_SQL } from '../server/sar-login.mjs';
import { SUPABASE_URL } from '../src/lib/config.js';

test('only verified Auth email plus enabled server membership authorizes data', async () => {
  const verified = { id: 'viewer', email: 'Andrew@frontiergamingsystems.com', email_confirmed_at: '2026-10-07' };
  const fetchUser = identity => async url => {
    assert.equal(url, SUPABASE_URL + '/auth/v1/user');
    return { ok: true, json: async () => identity };
  };
  const pool = { query: async (sql, args) => {
    assert.match(sql, /sar_bms.members.*email = \$1 AND enabled/);
    assert.deepEqual(args, ['andrew@frontiergamingsystems.com']); return { rows: [{}] };
  } };
  assert.equal(await authorize('Bearer token', fetchUser(verified), pool), 'viewer');
  assert.equal(await authorize('Bearer token', fetchUser(verified), { query: async () => ({ rows: [] }) }), null);
  assert.equal(await authorize('Bearer token', fetchUser({ ...verified, email_confirmed_at: null }), pool), null);
  assert.equal(await authorize('Bearer token', fetchUser({ id: 'bad', user_metadata: verified }), pool), null);
  await assert.rejects(authorize('Bearer token', fetchUser(verified)), /unavailable/);
});

test('unknown or rate-limited emails cannot create users or send messages', async () => {
  const sender = createLoginSender({ pool: { query: async () => ({ rows: [] }) },
    serviceKey: 'secret', mailKey: 'mail', fetchImpl: () => assert.fail('must not call provider') });
  await sender('unknown@example.com');
  assert.match(LOGIN_SLOT_SQL, /requests < 5/);
  assert.match(LOGIN_SLOT_SQL, /interval '1 minute'/);
  assert.match(LOGIN_SLOT_SQL, /email = \$1 AND enabled/);
});

test('approved login emails a fixed-destination link without returning credentials', async () => {
  const calls = [];
  const sender = createLoginSender({ pool: { query: async () => ({ rows: [{}] }) },
    serviceKey: 'secret', mailKey: 'mail', fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ action_link: `${SUPABASE_URL}/auth/v1/verify?token=test-only&redirect_to=${encodeURIComponent(SAR_RETURN_URL)}` }) };
    } });
  assert.equal(await sender('brandon@frontiergamingsystems.com'), undefined);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /admin\/generate_link/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { type: 'magiclink', email: 'brandon@frontiergamingsystems.com' });
  assert.equal(calls[1].url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(calls[1].options.body).to, ['brandon@frontiergamingsystems.com']);
});

test('wrong redirects and provider failures fail closed', async () => {
  for (const wrong of [true, false]) {
    const sender = createLoginSender({ pool: { query: async () => ({ rows: [{}] }) },
      serviceKey: 'secret', mailKey: 'mail', fetchImpl: async () => ({ ok: wrong,
        json: async () => ({ action_link: 'https://evil.example/signin' }) }) });
    await assert.rejects(sender('andrew@frontiergamingsystems.com'));
  }
});

test('login validates input, blocks foreign origins and returns only a generic receipt', async () => {
  const sent = [];
  const handle = createApiCore({ sendLogin: async e => sent.push(e) });
  const call = (email, origin) => handle({ method: 'POST', url: '/api/login', headers: { host: 'localhost:5173', origin }, readBody: async () => ({ email }) });
  assert.equal((await call('bad')).status, 400);
  assert.equal((await call('andrew@frontiergamingsystems.com', 'https://evil.example')).status, 403);
  const result = await call(' ANDREW@frontiergamingsystems.com ');
  assert.equal(result.status, 200);
  assert.deepEqual(sent, ['andrew@frontiergamingsystems.com']);
  assert.deepEqual(Object.keys(result.body).sort(), ['message', 'ok']);
});

test('access and analytics never read reporting data before authentication', async () => {
  for (const path of ['access', 'analytics']) {
    const handle = createApiCore({ authenticate: async () => null, loadAnalytics: () => assert.fail('data read') });
    assert.equal((await handle({ method: 'GET', url: '/api/' + path })).status, 401);
  }
});
