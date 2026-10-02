import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIVERSAL, categoryAspects, allAspects, sortByAspect, DEFAULT_ASPECT, BETTER } from '../src/lib/aspects.js';
import { sessionTotals } from '../src/lib/model.js';

const CATEGORIES = [
  { key: 'flash', display_name: 'Flash', show_rpa: true, show_margin: true,
    revenue_keys: ['flash'], payout_keys: ['flash_payout'] },
  { key: 'strip', display_name: 'Strip', show_rpa: true, show_margin: true,
    revenue_keys: ['strips'], payout_keys: ['strips_payout'] },
];

const totals = (flash, strips, att) => sessionTotals(
  { flash, strips, flash_payout: 0, strips_payout: 0, attendance: att }, CATEGORIES);

test('ten universal aspects, three per category', () => {
  assert.equal(UNIVERSAL.length, 10);
  assert.equal(categoryAspects(CATEGORIES).length, 6);
  assert.equal(allAspects(CATEGORIES).length, 16);
  // Production has five categories: 10 + 15 = 25.
  const five = [...CATEGORIES, ...['paper', 'cherries', 'other'].map((k) => ({
    key: k, display_name: k, revenue_keys: [], payout_keys: [] }))];
  assert.equal(allAspects(five).length, 25);
});

test('aspect keys are unique', () => {
  const keys = allAspects(CATEGORIES).map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('the default aspect exists', () => {
  assert.ok(allAspects(CATEGORIES).some((a) => a.key === DEFAULT_ASPECT));
});

test('payout ratio is marked as better when lower', () => {
  // A rising payout ratio is not good news. SPEC §19 — the v9 mockup showed
  // exactly this metric in green while it worsened.
  const a = UNIVERSAL.find((x) => x.key === 'payoutRatio');
  assert.equal(a.better, BETTER.DOWN);
});

test('sorting is descending or ascending on demand', () => {
  const rows = [
    { id: 'a', totals: totals(100, 0, 10) },
    { id: 'c', totals: totals(300, 0, 10) },
    { id: 'b', totals: totals(200, 0, 10) },
  ];
  const gross = UNIVERSAL.find((x) => x.key === 'gross');
  assert.deepEqual(sortByAspect(rows, gross, true).map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(sortByAspect(rows, gross, false).map((r) => r.id), ['a', 'b', 'c']);
});

test('unmeasured sessions sort LAST in both directions', () => {
  // A session with no recorded attendance is not the worst-attended session,
  // it is unmeasured. Floating it to either end would be a claim the data
  // does not support.
  const rows = [
    { id: 'has', totals: totals(100, 0, 10) },
    { id: 'none', totals: totals(100, 0, 0) },   // attendance 0 -> rpa null
    { id: 'has2', totals: totals(200, 0, 20) },
  ];
  const rpa = UNIVERSAL.find((x) => x.key === 'rpa');
  assert.equal(sortByAspect(rows, rpa, true).at(-1).id, 'none');
  assert.equal(sortByAspect(rows, rpa, false).at(-1).id, 'none');
});

test('category aspects read the right category', () => {
  const t = totals(500, 900, 10);
  const flashRev = categoryAspects(CATEGORIES).find((a) => a.key === 'cat:flash:revenue');
  const stripRev = categoryAspects(CATEGORIES).find((a) => a.key === 'cat:strip:revenue');
  assert.equal(flashRev.value(t), 500);
  assert.equal(stripRev.value(t), 900);
});

test('category spread reports the largest single share', () => {
  const spread = UNIVERSAL.find((x) => x.key === 'grossPerCat');
  // 800 of 1000 came from strips.
  assert.equal(spread.value(totals(200, 800, 10)), 0.8);
});

test('sorting never mutates the input', () => {
  const rows = [
    { id: 'a', totals: totals(100, 0, 10) },
    { id: 'b', totals: totals(300, 0, 10) },
  ];
  const before = rows.map((r) => r.id);
  sortByAspect(rows, UNIVERSAL[0], true);
  assert.deepEqual(rows.map((r) => r.id), before);
});
