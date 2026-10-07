import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnalytics, ANALYTICS_QUERIES } from '../server/analytics-read.mjs';
import { mapSnapshot } from '../src/lib/analytics-snapshot.js';

// Direct PostgreSQL replaces REST paging. Keep the completeness regression.
test('analytics reads over 1000 rows without truncation in a read-only snapshot', async () => {
  const calls = [];
  const rows = Array.from({ length: 2501 }, (_, i) => ({ event_id: 'e', metric_id: 'm' + i, value: i }));
  let released = false;
  const data = await readAnalytics({ connect: async () => ({
    query: async sql => {
      calls.push(sql);
      return { rows: sql.includes('import_manifest') ? [{ verified_at: '2026-10-07' }]
        : sql === ANALYTICS_QUERIES.metricRows ? rows : [] };
    }, release: () => { released = true; },
  }) });
  assert.equal(data.metricRows.length, 2501);
  assert.equal(new Set(data.metricRows.map(r => r.metric_id)).size, 2501);
  assert.match(calls[0], /REPEATABLE READ READ ONLY/);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(released, true);
  for (const [key, sql] of Object.entries(ANALYTICS_QUERIES)) {
    assert.doesNotMatch(sql, /SELECT \*|password|email|phone/);
    assert.match(sql, /customer_id = 'vanguard'/);
    if (key !== 'notifications') assert.doesNotMatch(sql, /LIMIT|OFFSET/);
  }
});

test('notifications stay bounded and exclude private messages and user read state', () => {
  assert.match(ANALYTICS_QUERIES.notifications, /user_id IS NULL/);
  assert.match(ANALYTICS_QUERIES.notifications, /ORDER BY created_at DESC, id LIMIT 500/);
  assert.ok(!Object.values(ANALYTICS_QUERIES).some(q => q.includes('notification_reads')));
});

test('an unverified copy rolls back and releases its connection', async () => {
  const calls = [];
  await assert.rejects(readAnalytics({ connect: async () => ({
    query: async sql => { calls.push(sql); return { rows: [] }; },
    release: () => calls.push('released'),
  }) }), /No verified snapshot/);
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'released']);
});

test('snapshot mapping preserves cents, date filters and category signs', () => {
  const raw = { config: [{ name: 'Vanguard' }], metricDefs: [], locations: [],
    events: [{ id: 'a', event_date: '2026-10-01' }, { id: 'b', event_date: '2026-09-01' }],
    metricRows: [{ event_id: 'a', metric_id: 'm', value: 12345 }, { event_id: 'b', metric_id: 'm', value: 999 }],
    categories: [{ id: 'c' }], categoryMetrics: [{ category_id: 'c', role: 'revenue', metric_key: 'sales' }, { category_id: 'c', role: 'payout', metric_key: 'prizes' }],
    runners: [], runnerEvents: [], snapshotAt: '2026-10-07' };
  const mapped = mapSnapshot(raw, '2026-10-01');
  assert.equal(mapped.events.length, 1);
  assert.deepEqual(mapped.metrics, { a: { m: 12345 } });
  assert.deepEqual(mapped.categories[0].revenue_keys, ['sales']);
  assert.deepEqual(mapped.categories[0].payout_keys, ['prizes']);
  assert.equal(mapped.snapshotAt, raw.snapshotAt);
});
