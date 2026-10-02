/* ============================================================================
   lib/join.js is RETIRED.

   It used to export a second `joinSessions` that matched Ops sessions to
   analytics events through a STATIC part->event_type map. Nothing imported it
   and it was wrong twice over: `PM -> late` fails on a weekday, and it fails
   for Redwood City, which runs one `regular` session a night that the roster
   calls `PM`.

   Two exported functions with the same name, the same apparent purpose and
   opposite algorithms is how a screen silently gets different answers. These
   tests hold the module retired.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('join.js re-exports the one real joinSessions, not a second one', async () => {
  const join = await import('../src/lib/join.js');
  const managers = await import('../src/lib/managers.js');
  assert.equal(join.joinSessions, managers.joinSessions,
    'there must be exactly one joinSessions in the project');
  assert.equal(join.resolveHalls, managers.resolveHalls);
});

test('the old static part map is gone and fails loudly if called', async () => {
  const join = await import('../src/lib/join.js');
  assert.throws(() => join.partToEventType('PM'), /position within the day/);
});

test('no screen imports join.js', async () => {
  const fs = await import('node:fs/promises');
  const dir = new URL('../src/screens/', import.meta.url);
  for (const f of await fs.readdir(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = await fs.readFile(new URL(f, dir), 'utf8');
    assert.ok(!/from '\.\.\/lib\/join\.js'/.test(src), `${f} imports the retired join.js`);
  }
});
