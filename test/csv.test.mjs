/* ============================================================================
   Tests for lib/csv.js and the Data view's export

   Every test here corresponds to something SAR 1.0's export gets wrong, or to
   a round trip: write the file, parse it back with a real parser, and compare.
   A test that split on commas would pass on exactly the input the writer
   breaks.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvField, csvRow, toCsv, csvMoney, csvPct, csvFilename, parseCsv, EOL, BOM,
} from '../src/lib/csv.js';
import { columnLetter, dayHeader, formatCell, differs } from '../src/screens/data.js';

/* ---------------------------------------------------------------------------
   Quoting — SAR 1.0 wraps everything and escapes nothing
--------------------------------------------------------------------------- */

test('a quote inside a field is doubled, not left to corrupt the file', () => {
  assert.equal(csvField('He said "hi"'), '"He said ""hi"""');
  const back = parseCsv(toCsv([['a', 'He said "hi"'], ['b', 'plain']]));
  assert.deepEqual(back[0], ['a', 'He said "hi"']);
  assert.deepEqual(back[1], ['b', 'plain']);
});

test('a comma inside a field is quoted', () => {
  assert.equal(csvField('Flash, late'), '"Flash, late"');
  assert.deepEqual(parseCsv(toCsv([['Flash, late', '1']]))[0], ['Flash, late', '1']);
});

test('a newline inside a field survives the round trip', () => {
  const back = parseCsv(toCsv([['two\nlines', 'x']]));
  assert.deepEqual(back[0], ['two\nlines', 'x']);
});

test('fields that need no quoting are not quoted', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(1234), '1234');
  assert.equal(csvRow(['a', 'b']), 'a,b');
});

test('null and undefined become empty, not the strings', () => {
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvRow([null, 'x', undefined]), ',x,');
});

/* ---------------------------------------------------------------------------
   Line endings and encoding — SAR 1.0 writes bare \n and no BOM
--------------------------------------------------------------------------- */

test('rows are separated by CRLF, which is what Excel expects', () => {
  const out = toCsv([['a'], ['b']], { bom: false });
  assert.equal(out, `a${EOL}b${EOL}`);
  assert.ok(out.includes('\r\n'));
});

test('a BOM is written so accented names survive a double-click into Excel', () => {
  assert.ok(toCsv([['Renée']]).startsWith(BOM));
  // And the parser strips it again, so a round trip is clean.
  assert.deepEqual(parseCsv(toCsv([['Renée']]))[0], ['Renée']);
});

/* ---------------------------------------------------------------------------
   Numbers
--------------------------------------------------------------------------- */

test('money exports as plain dollars — a number a spreadsheet can sum', () => {
  assert.equal(csvMoney(123456), '1234.56');
  assert.equal(csvMoney(0), '0.00');
  assert.equal(csvMoney(-5000), '-50.00');
  assert.equal(csvMoney(null), '');
  assert.equal(csvMoney(undefined), '');
});

test('money keeps its cents rather than rounding them away', () => {
  assert.equal(csvMoney(1), '0.01');
  assert.equal(csvMoney(99), '0.99');
});

test('a ratio exports as a percentage number, without a sign', () => {
  assert.equal(csvPct(0.2671), '26.71');
  assert.equal(csvPct(null), '');
  assert.equal(csvPct(0), '0.00');
});

/* ---------------------------------------------------------------------------
   Filename — SAR 1.0 always says "daily" because it reads a wrong element id
--------------------------------------------------------------------------- */

test('the filename names the view that was actually exported', () => {
  const d = new Date('2026-08-17T12:00:00Z');
  assert.equal(csvFilename({ view: 'monthly', hall: 'Santa Clara', date: d }),
    'vanguard_monthly_santa-clara_2026-08-17.csv');
  assert.equal(csvFilename({ view: 'daily', hall: 'All halls', date: d }),
    'vanguard_daily_all-halls_2026-08-17.csv');
});

/* ---------------------------------------------------------------------------
   Column letters — SAR 1.0 emits '[' and '\' past column 26
--------------------------------------------------------------------------- */

test('column letters carry properly past Z', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(27), 'AB');
  assert.equal(columnLetter(51), 'AZ');
  assert.equal(columnLetter(52), 'BA');
  assert.equal(columnLetter(701), 'ZZ');
  assert.equal(columnLetter(702), 'AAA');
});

test('no column letter is a punctuation mark', () => {
  // Santa Clara has 558 sessions; SAR 1.0 labels most of them '[', '\', ']'…
  for (let i = 0; i < 600; i += 1) {
    assert.match(columnLetter(i), /^[A-Z]+$/, `column ${i} produced a non-letter`);
  }
});

/* ---------------------------------------------------------------------------
   Headers
--------------------------------------------------------------------------- */

test('the date header is unpadded, as on the paper sheets', () => {
  assert.equal(dayHeader('2026-08-06', 'regular'), '8/6/2026');
  assert.equal(dayHeader('2026-12-25', 'regular'), '12/25/2026');
});

test('every non-regular session type is distinguishable in the header', () => {
  // SAR 1.0 suffixes only `late`, so an `early` session gets a header identical
  // to the regular session on the same date — two indistinguishable columns.
  const d = '2026-08-08';
  const all = ['regular', 'late', 'early'].map((t) => dayHeader(d, t));
  assert.equal(all[1], '8/8/2026 PM');
  assert.equal(all[2], '8/8/2026 AM');
  assert.equal(new Set(all).size, 3, 'three session types, three distinct headers');
});

/* ---------------------------------------------------------------------------
   Cell formatting — DESIGN §4
--------------------------------------------------------------------------- */

test('missing renders blank on this screen, not an em dash', () => {
  for (const v of [null, undefined, '']) {
    assert.equal(formatCell(v, { format: 'money' }), '');
  }
});

test('zero is $0 for money but blank for a percentage', () => {
  // Looks inconsistent, is SAR 1.0's behaviour, and is defensible: takings of
  // nothing can be real, a margin of exactly zero almost never is.
  assert.equal(formatCell(0, { format: 'money' }), '$0');
  assert.equal(formatCell(0, { format: 'percent' }), '');
  assert.equal(formatCell(0, { format: 'integer' }), '0');
});

test('a negative amount reads -$50, not $-50', () => {
  const out = formatCell(-5000, { format: 'money' });
  assert.ok(!out.includes('$-'), `SAR 1.0 renders "$-50"; got ${out}`);
  assert.match(out, /^-\$/);
});

test('a percentage is a fraction in and a percent out', () => {
  assert.equal(formatCell(0.2671, { format: 'percent' }), '26.7%');
});

/* ---------------------------------------------------------------------------
   Reconcile
--------------------------------------------------------------------------- */

test('a difference under a cent is not a difference', () => {
  assert.equal(differs(0), false);
  assert.equal(differs(1), false);
  assert.equal(differs(2), true);
  assert.equal(differs(-500), true);
  assert.equal(differs(null), false, 'nothing stored is not a mismatch');
});
