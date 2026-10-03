/* ============================================================================
   scripts/owner-security.sql — the owner-run clean-up

   The owner pastes this into the Supabase SQL editor with full rights, so it
   is checked like code: it touches only the objects it says it does, grants
   nothing to the public roles, matches the function signatures the
   migrations actually created, and creates exactly the table the server's
   quota statement writes.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASK_USAGE_SQL } from '../server/api-core.mjs';

const raw = readFileSync(new URL('../scripts/owner-security.sql', import.meta.url), 'utf8');
/** The SQL with every comment line removed: what actually runs. */
const sql = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const migrations = ['ops/002-sar2-ops-read-rpc.sql', 'sar/002-sar2-read-rpc.sql']
  .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')).join('\n');

test('the script grants nothing to anyone, and never to anon or authenticated', () => {
  assert.doesNotMatch(sql, /\bgrant\b/i);
  assert.doesNotMatch(sql, /\bcreate\s+policy\b/i, 'no policy: only the server role uses the table');
  assert.match(sql, /revoke all on public\.sar2_ask_usage from public, anon, authenticated;/);
});

test('the script touches only the objects its header names', () => {
  const objects = new Set([...sql.matchAll(/public\.(\w+)/g)].map((m) => m[1]));
  assert.deepEqual([...objects].sort(),
    ['ops_read', 'sar2_ask_usage', 'sar2_tokens', 'sar_read', 'sar_read_items', 'sched_sessions'].sort());
  // sched_sessions is only probed, to recognise the Operational DB.
  assert.deepEqual([...sql.matchAll(/[^\n]*public\.sched_sessions[^\n]*/g)].map((m) => m[0].trim()),
    ["if to_regclass('public.sched_sessions') is not null then"]);
  for (const forbidden of [/\bdelete\b/i, /\btruncate\b/i, /\bdrop\s+(table|role|schema|owned)\b/i,
    /\balter\s+role\b/i, /\bpassword\b/i, /\bsecurity\s+definer\b/i, /\bcreate\s+(or\s+replace\s+)?function\b/i]) {
    assert.doesNotMatch(sql, forbidden);
  }
  // Tokens are revoked, not deleted, and a second run changes nothing.
  assert.match(sql, /update public\.sar2_tokens\s+set revoked_at = now\(\)\s+where revoked_at is null;/);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
});

test('every dropped function matches a signature the migrations created, IF EXISTS', () => {
  const drops = [...sql.matchAll(/drop function (if exists )?public\.(\w+)\(([^)]*)\);/g)];
  assert.equal(drops.length, 3);
  for (const [, ifExists, name, args] of drops) {
    assert.ok(ifExists, `${name}: idempotent`);
    assert.ok(migrations.includes(`function public.${name}(${args})`),
      `${name}(${args}) is not a signature the migrations created`);
  }
});

test('the usage table is exactly what the server quota statement writes, with RLS on', () => {
  const table = /create table if not exists public\.sar2_ask_usage \(([\s\S]*?)\n\s*\);/.exec(sql)?.[1];
  assert.ok(table, 'the table is created idempotently');
  const cols = [...table.matchAll(/^\s*(\w+)\s+(uuid|date|int|bigint)\b/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(cols, ['user_id uuid', 'day date', 'calls int', 'chars bigint']);
  assert.match(table, /primary key \(user_id, day\)/);
  assert.match(ASK_USAGE_SQL, /public\.sar2_ask_usage AS u \(user_id, day, calls, chars\)/);
  assert.match(ASK_USAGE_SQL, /ON CONFLICT \(user_id, day\)/);
  assert.match(sql, /alter table public\.sar2_ask_usage enable row level security;/);
  // Created only in the Operational DB, where the Edge Function's pool connects.
  assert.ok(sql.indexOf("to_regclass('public.sched_sessions')") < sql.indexOf('create table'));
});
