/* ============================================================================
   Hotball pots — the derivation, the server read and the screen

   The fixture is the live Operations read of 9 Oct 2026 (144 pot rows, 72
   sessions), and the reference file is the handoff's reference SQL run in the
   SAME query, so both describe one snapshot. The model must reproduce the SQL
   row for row, and, cut off at 8 Oct, the handoff's own verification figures.
   ========================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { buildHotball, walkChain, wholeUsd } from '../src/lib/hotball-model.js';
import {
  projectHotballRow, projectMovementRow, assertNoPayColumns, HOTBALL_ROW_FIELDS,
  HOTBALL_MOVEMENT_FIELDS, VALIDATOR_FORBIDDEN,
} from '../src/lib/ops-schema.js';
import { HOTBALL_SQL, HOTBALL_MOVEMENTS_SQL, readHotball, readOperations, VALIDATOR_SQL } from '../server/database.mjs';

const dom = new JSDOM('<!doctype html><div id="app"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderHotball } = await import('../src/screens/hotball.js');

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const ROWS = JSON.parse(readFileSync(fixture('hotball-2026-10-09.json'), 'utf8')).map(projectHotballRow);
const REFERENCE = readFileSync(fixture('hotball-2026-10-09.reference.txt'), 'utf8').trim().split('\n').map((l) => l.trimEnd());

const line = (r) => `${r.potKey}|${r.date}|${r.time} ${r.drop} ${r.potAfter} ${r.notes.join("; ")}`.trimEnd();
const pot = (model, key) => model.pots.find((p) => p.key === key);
const sorted = (a) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/* ---------------------------------------------------------------------------
   1. The derivation
--------------------------------------------------------------------------- */

test('reproduces the reference SQL for every pot row: drop, pot after and note', () => {
  const model = buildHotball({ rows: ROWS });
  const ours = sorted(model.pots.flatMap((p) => p.rows.map(line)));
  assert.equal(ours.length, 144);
  assert.deepEqual(ours, sorted(REFERENCE));
});

test('cut off at 8 Oct, matches the handoff verification figures exactly', () => {
  const m = buildHotball({ rows: ROWS, through: '2026-10-08' });
  assert.equal(m.sessions, 71);
  const figures = Object.fromEntries(m.pots.map((p) => [p.key,
    [p.now, `${p.asOf.hall} ${p.asOf.date}`, p.lastDrop.drop, p.lastDrop.date, p.sessionsSince, p.addedSince]]));
  assert.deepEqual(figures, {
    mega:        [23560, 'RWC 2026-10-08', 21020, '2026-09-29', 11, 23560],
    rwc_hotball: [5550,  'RWC 2026-10-08', 2225,  '2026-09-23', 7,  5550],
    sc_hotball:  [1345,  'SC 2026-10-05',  10770, '2026-10-04', 1,  1345],
  });
  // Acceptance: every pot emptied at its last drop, so added since = pot now.
  for (const p of m.pots) assert.equal(p.addedSince, p.now, p.key);
  assert.equal(m.drops.length, 16);
  assert.equal(m.totalDropped, 289210);
  assert.deepEqual(m.drops.map((r) => [r.date.slice(5), r.potKey, r.total, r.drop, r.basis]), [
    ['10-04', 'sc_hotball', 10770, 10770, 'Paid box'],
    ['10-03', 'sc_hotball', 36560, 30000, 'Paid box'],
    ['09-29', 'mega', 21020, 21020, 'Paid box (state only)'],
    ['09-23', 'rwc_hotball', 2225, 2225, 'Next opening, hit ticked'],
    ['09-22', 'mega', 9330, 9330, 'Paid box (state only)'],
    ['09-19', 'mega', 7380, 7380, 'Next opening, hit ticked (credited back)'],
    ['09-18', 'mega', 32200, 30000, 'Paid box'],
    ['09-16', 'rwc_hotball', 680, 680, 'Paid box'],
    ['09-15', 'rwc_hotball', 4770, 4770, 'Paid box'],
    ['09-07', 'mega', 35170, 30000, 'Next opening, hit ticked'],
    ['08-31', 'sc_hotball', 12660, 12660, 'Next opening'],
    ['08-30', 'sc_hotball', 41700, 30000, 'Next opening, net of +$300'],
    ['08-28', 'mega', 59560, 59560, 'Next opening'],
    ['08-27', 'rwc_hotball', 16675, 16675, 'Paid box'],
    ['08-22', 'mega', 68660, 21620, 'Next opening'],
    ['08-19', 'mega', 65660, 2520, 'Next opening'],
  ]);
});

test('each balanced night closes on the next night\'s opening', () => {
  for (const p of buildHotball({ rows: ROWS }).pots) {
    p.rows.forEach((r, i) => {
      if (r.balanced && i < p.rows.length - 1) assert.equal(r.closing, p.rows[i + 1].opening, `${p.key} ${r.date}`);
    });
  }
});

test('the Mega pot is one chain across both halls', () => {
  const mega = pot(buildHotball({ rows: ROWS }), 'mega');
  assert.deepEqual([...new Set(mega.rows.map((r) => r.hall))].sort(), ['RWC', 'SC']);
  assert.equal(mega.shared, true);
});

test('a later opening equal to the app default is real money, not startup', () => {
  const row = (date, opening, added, extra = {}) => ({ pot: 'hotball', hall_id: 'rwc', session_date: date,
    session_time: '18:30', opening, added, total: opening + added, paid_ledger: 0,
    closing_ledger: opening + added, ...extra });
  const before = walkChain([row('2026-08-12', 9820, 500), row('2026-08-13', 9000, 500)]);
  assert.equal(before[0].startup, true);
  assert.equal(before[0].drop, 0, 'a gap out of a default opening is not money');
  const after = walkChain([row('2026-09-01', 9820, 500), row('2026-09-02', 9000, 500)]);
  assert.equal(after[0].startup, false);
  assert.equal(after[0].drop, 1320);
});

/* ---------------------------------------------------------------------------
   2. Cash movements (recorded elsewhere, applied here)
--------------------------------------------------------------------------- */

const move = (kind, amount, date, time = '18:30', extra = {}) => ({
  id: String(Math.random()), pot_key: 'mega', movement_date: date, session_time: time, kind, amount, note: null, ...extra,
});

test('a recorded pot drop replaces the derived one; leaving it out brings the gap back', () => {
  const plain = pot(buildHotball({ rows: ROWS }), 'mega');
  const oct8 = plain.rows.find((r) => r.date === '2026-10-08');
  assert.equal(oct8.gap, -16160);
  assert.equal(oct8.basis, 'Next opening');

  const moved = pot(buildHotball({ rows: ROWS, movements: [move('payout', 16160, '2026-10-08')] }), 'mega');
  const m8 = moved.rows.find((r) => r.date === '2026-10-08');
  assert.equal(m8.gap, 0);
  assert.equal(m8.balanced, true);
  assert.equal(m8.drop, 16160, 'counted once, not twice');
  assert.equal(m8.basis, 'Recorded pot drop');
  assert.equal(moved.totalDropped, plain.totalDropped);
});

test('a cash in balances a raise; an untimed movement lands after the day\'s last session', () => {
  const plain = pot(buildHotball({ rows: ROWS }), 'sc_hotball');
  const raise = plain.rows.find((r) => r.date === '2026-08-22' && r.time === '18:30');
  assert.equal(raise.gap, 4735);
  const fixed = pot(buildHotball({ rows: ROWS, movements: [
    move('cash_in', 4735, '2026-08-22', null, { pot_key: 'sc_hotball' })] }), 'sc_hotball');
  const r = fixed.rows.find((x) => x.date === '2026-08-22' && x.time === '18:30');
  assert.equal(r.balanced, true);
  assert.equal(fixed.rows.find((x) => x.date === '2026-08-22' && x.time === '13:00').moves.length, 0);
});

test('an envelope count is compared with pot after and moves nothing', () => {
  const m = buildHotball({ rows: ROWS, movements: [move('count', 9600, '2026-10-09')] });
  const mega = pot(m, 'mega');
  assert.equal(mega.count.amount, 9600);
  assert.equal(mega.count.overShort, 9600 - mega.now);
  assert.equal(mega.now, pot(buildHotball({ rows: ROWS }), 'mega').now);
});

/* ---------------------------------------------------------------------------
   3. The server read
--------------------------------------------------------------------------- */

test('the hotball SQL reads only named fields: no whole jsonb, no other pot, no emails', () => {
  assert.doesNotMatch(HOTBALL_SQL, /SELECT \*|s\.state\s*(,|AS|\n)|s\.hotball_ledger\s*(,|AS|\n)/);
  assert.match(HOTBALL_SQL, /#> '\{pm,hot\}'/);
  assert.equal([...HOTBALL_SQL.matchAll(/s\.state\b/g)].length, 2, 'state reached only at pm.hot');
  assert.match(HOTBALL_SQL, /IN \('hotball', 'mega_hotball'\)/);
  for (const banned of ['figures', 'totals', 'payout_lines', 'created_by', 'updated_by', 'email']) {
    assert.doesNotMatch(HOTBALL_SQL, new RegExp(`\\b${banned}\\b`));
    assert.doesNotMatch(HOTBALL_MOVEMENTS_SQL, new RegExp(`\\b${banned}\\b`));
  }
  assert.doesNotMatch(HOTBALL_MOVEMENTS_SQL, /voided_by|SELECT \*/);
  assert.match(HOTBALL_MOVEMENTS_SQL, /WHERE voided_at IS NULL/);
  // The validator read is unchanged: it still never selects the ledger.
  assert.ok(VALIDATOR_FORBIDDEN.includes('hotball_ledger'));
  assert.doesNotMatch(VALIDATOR_SQL, /hotball_ledger/);
  assert.equal(assertNoPayColumns(), true);
});

test('the projections keep the allowlisted shape only', () => {
  const r = projectHotballRow({ ...ROWS[0], pot: 'mega_hotball', cash: 500, state: { x: 1 }, opening: { nested: 1 } });
  assert.deepEqual(Object.keys(r).sort(), [...HOTBALL_ROW_FIELDS].sort());
  assert.equal(r.opening, null, 'a nested value never passes through as a number');
  assert.equal(projectHotballRow({ pot: 'gremlin_hotball' }).pot, null);
  const m = projectMovementRow({ id: 7, pot_key: 'mega', movement_date: '2026-10-08', kind: 'payout',
    amount: '120.50', note: 'x', created_by: 'someone@example.com', voided_by: 'x' });
  assert.deepEqual(Object.keys(m), [...HOTBALL_MOVEMENT_FIELDS]);
  assert.equal(m.amount, 120.5);
  assert.equal(projectMovementRow({ kind: 'delete' }).kind, null);
});

test('a failed hotball read leaves the rest of Operations intact and says so', async () => {
  const calls = [];
  const conn = (fail) => ({ query: async (sql) => {
    calls.push(sql);
    if (fail.test(sql)) throw new Error('permission denied');
    return { rows: [] };
  } });
  const none = await readHotball(conn(/recon_sessions/));
  assert.deepEqual(none, { ok: false, rows: [], movements: [], movementsOk: false });
  assert.ok(calls.includes('ROLLBACK TO SAVEPOINT hotball'));
  const pots = await readHotball(conn(/hotball_cash_movements/));
  assert.equal(pots.ok, true);
  assert.equal(pots.movementsOk, false);

  // Through the whole snapshot: a hotball failure does not fail Operations.
  const result = await readOperations({ connect: async () => ({
    query: async (sql) => { if (sql.includes('hotball_ledger')) throw new Error('nope'); return { rows: [] }; },
    release: () => {},
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.hotball.ok, false);
});

/* ---------------------------------------------------------------------------
   4. The screen
--------------------------------------------------------------------------- */

const screenData = (hotball) => ({ schedule: { ok: true, hotball } });
function render(data, params = {}) {
  let inspector = '';
  const calls = [];
  const node = renderHotball({ data, params, onNavigate: (id, p) => calls.push([id, p]),
    setInspectorContent: (x) => { inspector = x; } });
  return { node, inspector, calls, text: node.textContent.replace(/\s+/g, ' ') };
}
const LIVE = { ok: true, rows: ROWS, movements: [], movementsOk: true };

test('the screen shows three pots, the drop list and the selected pot\'s ledger', () => {
  const { node, calls } = render(screenData(LIVE));
  const cards = [...node.querySelectorAll('.hb-card')];
  assert.deepEqual(cards.map((c) => c.dataset.pot), ['mega', 'rwc_hotball', 'sc_hotball']);
  assert.ok(cards[0].classList.contains('is-active'));
  assert.match(cards[0].textContent, /\$9,670/);
  assert.equal(node.querySelectorAll('[data-section="drops"] tbody tr').length, 18); // 17 + total
  assert.match(node.querySelector('[data-section="drops"] .total-row').textContent, /\$305,370/);
  const ledger = node.querySelectorAll('[data-section="ledger"] tbody tr');
  assert.equal(ledger.length, 72, 'Mega: every session, newest first');
  assert.equal(ledger[0].dataset.key, 'mega|2026-10-09|18:30');
  assert.match(ledger[0].textContent, /still open/);
  cards[2].click();
  assert.deepEqual(calls.at(-1), ['hotball', { pot: 'sc_hotball' }]);
  assert.equal(render(screenData(LIVE), { pot: 'sc_hotball' })
    .node.querySelectorAll('[data-section="ledger"] tbody tr').length, 46);
});

test('the screen never says "paid out", and prints no raw values', () => {
  for (const params of [{}, { pot: 'rwc_hotball' }, { pot: 'sc_hotball' }, { pot: 'nonsense' }]) {
    const { text, inspector } = render(screenData(LIVE), params);
    assert.doesNotMatch(`${text} ${inspector}`, /paid out/i);
    assert.doesNotMatch(text, /\bNaN\b|\bundefined\b|\bnull\b|\$-/);
    assert.doesNotMatch(text, /\$\d{5,}(?!,)/, 'unformatted money');
  }
});

test('the screen degrades honestly: no Operations, no pots, no movements', () => {
  assert.match(render({ schedule: { ok: false } }).text, /Hotball pots not connected/);
  assert.match(render(screenData({ ok: false, rows: [] })).text, /not connected/);
  assert.match(render(screenData({ ok: true, rows: [], movements: [], movementsOk: true })).text,
    /No reconciled sessions yet/);
  assert.match(render(screenData({ ...LIVE, movementsOk: false })).text, /Cash movements could not be read/);
});

test('hostile text from the database is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const rows = ROWS.map((r, i) => (i === ROWS.length - 1 ? { ...r, slot_name: evil, override_reason: evil, overridden: true } : r));
  const { node } = render(screenData({ ok: true, rows, movements: [
    projectMovementRow({ id: 1, pot_key: 'mega', movement_date: '2026-10-09', kind: 'cash_in', amount: '1', note: evil }),
  ], movementsOk: true }));
  assert.equal(node.querySelector('img'), null);
  assert.match(node.textContent, /onerror/);
});

test('wholeUsd matches the SQL to_char format', () => {
  assert.equal(wholeUsd(4240), '$4,240');
  assert.equal(wholeUsd(300), '$300');
});
