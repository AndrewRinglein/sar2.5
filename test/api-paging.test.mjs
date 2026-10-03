import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');

/** The text of every `all(() => …)` builder, up to its closing paren. */
function pagedQueries(text) {
  const out = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf('all(() =>', at);
    if (start < 0) return out;
    let depth = 0;
    let i = text.indexOf('(', start);
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out.push(text.slice(start, i + 1));
    at = i + 1;
  }
}

test('every paged read has an order ending in a unique key', () => {
  // Paging with .range() over an unordered (or non-unique ordered) query lets
  // Postgres hand back rows in a different order per page, so a row can be
  // read twice and another never. Every paged query ends with a unique key.
  const queries = pagedQueries(src);
  assert.ok(queries.length >= 10, `found ${queries.length} paged queries`);
  for (const q of queries) {
    const orders = [...q.matchAll(/\.order\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(orders.length, `paged query has no order:\n${q}`);
    const last = orders.at(-1);
    const unique = last === 'id' || (orders.includes('location_id') && last === 'month')
      || (orders.includes('notification_id') && last === 'user_id');
    assert.ok(unique, `paged query does not end with a unique key (${orders.join(', ')}):\n${q}`);
  }
});

test('notifications are read in one bounded page, not through all()', () => {
  const fn = src.slice(src.indexOf('export async function getNotifications'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /\.range\(0, NOTIFICATION_LIMIT - 1\)/);
  assert.doesNotMatch(body, /\.limit\(/, '.limit() is overridden by all()\'s .range()');
  assert.match(body, /ID_CHUNK/, 'read state must be fetched in chunks');
});
