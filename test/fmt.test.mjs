import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usd, usd2, usdShort, pct, pctDelta, int, arrow, ordinal,
  dateLong, dateShort, weekday, monthLabel, sessionType, DASH,
} from '../src/lib/fmt.js';

test('cents become dollars exactly once', () => {
  // 9,191,500 cents is the real revenue of RWC 2026-08-06.
  assert.equal(usd(9191500), '$91,915');
  assert.equal(usd2(48123), '$481.23');
});

test('null formats as a dash, never as zero', () => {
  // An unrecorded metric must not read as a confident $0.
  for (const f of [usd, usd2, usdShort, pct, pctDelta, int, ordinal]) {
    assert.equal(f(null), DASH, `${f.name}(null)`);
    assert.equal(f(undefined), DASH, `${f.name}(undefined)`);
  }
  assert.equal(usd(0), '$0');           // zero is still zero
});

test('NaN and Infinity are dashes, not "NaN"', () => {
  assert.equal(usd(NaN), DASH);
  assert.equal(pct(Infinity), DASH);
});

test('short form abbreviates but keeps the sign', () => {
  assert.equal(usdShort(9249383289), '$92M');
  assert.equal(usdShort(150000), '$1.5k');
  assert.equal(usdShort(-150000), '-$1.5k');
  assert.equal(usdShort(4500), '$45');
});

test('percentages take fractions, not percentages', () => {
  // model.js returns 0.2671. Passing 26.71 here would print 2671%.
  assert.equal(pct(0.26705108), '26.7%');
  assert.equal(pct(0.26705108, { decimals: 2 }), '26.71%');
});

test('deltas carry an explicit sign', () => {
  assert.equal(pctDelta(0.042), '+4.2%');
  assert.equal(pctDelta(-0.042), '-4.2%');
  assert.equal(pctDelta(0), '0.0%');
});

test('direction always has a glyph, so colour never carries meaning alone', () => {
  assert.equal(arrow(1), '▲');
  assert.equal(arrow(-1), '▼');
  assert.equal(arrow(0), '·');
});

test('ordinals handle the teens', () => {
  // SPEC §19 — the v1 mockup rendered "23th".
  assert.equal(ordinal(23), '23rd');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
});

test('dates are parsed as UTC so a session never shifts a day', () => {
  // A local-time parse moves "2026-08-06" to the 5th west of Greenwich, which
  // silently puts the session in the wrong weekday comparison pool.
  assert.equal(dateLong('2026-08-06'), 'Thu 6 Aug 2026');
  assert.equal(weekday('2026-08-06'), 'Thursday');
  assert.equal(dateShort('2026-08-06'), '6 Aug');
  assert.equal(weekday('2026-01-01'), 'Thursday');
});

test('a timestamp is truncated to its date rather than shifted', () => {
  assert.equal(dateLong('2026-08-06T23:30:00Z'), 'Thu 6 Aug 2026');
});

test('month labels and session types', () => {
  assert.equal(monthLabel('2026-08'), 'Aug 2026');
  assert.equal(sessionType('regular'), 'Regular');
  assert.equal(sessionType('late'), 'Late');
  assert.equal(sessionType(null), DASH);
});

test('integers get thousands separators', () => {
  assert.equal(int(820), '820');
  assert.equal(int(36318), '36,318');
});
