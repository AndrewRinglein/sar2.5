// Shared read allowlist. No credentials or database client belong here.
export const COLUMNS = Object.freeze({
  sched_roles: 'id,name,color,sort,active',
  // on_roster separates "on the books" from "active"; still no phone, email,
  // employee_ref or last_name.
  sched_staff: 'id,name,first_name,active,on_roster',
  // total_sales / attendance / comm_rate / target_rpa are what the Commission
  // screen recomputes the pool from. They were omitted originally, so every
  // Sales, Rate and Recomputed cell was blank and the disagreement check could
  // never fire — a screen built around a comparison that could not happen.
  sched_sessions:
    'id,hall_id,session_date,part,day_type,status,total_sales,attendance,comm_rate,target_rpa,actual_rpa',
  // scheduled_start / scheduled_end are what Staff Overview (§22.1) measures
  // scheduled hours from. Times of day, not money.
  sched_assignments: 'id,session_id,role_id,staff_id,slot_index,is_training,scheduled_start,scheduled_end',
  // Commission and hours are explicitly permitted; salary is not, and no wage,
  // rate or premium column appears anywhere here. `sched_time_entries` carries
  // `meal_premium_owed` and `rest_premium_owed`, which ARE pay, and neither is
  // read.
  sched_commission_payouts:
    'id,session_id,staff_id,session_date,shares,total_shares,commission_pool,payout_amount,confirmed_at',
  sched_session_shares: 'session_id,staff_id,shares',
  // The break flags are what §22.1.5 tests compliance from. The PREMIUM columns
  // (meal_premium_owed, rest_premium_owed) stay out: Staff Overview computes
  // premium HOURS from these flags itself.
  sched_time_entries: 'id,staff_id,hall_id,work_date,hours_worked,category,is_walk_up,'
    + 'clock_in,clock_out,meal_taken,meal_start,meal_waived,second_meal_taken,'
    + 'second_meal_waived,rest_breaks_taken,is_worked_time,assignment_id',
  sched_staff_role_capability: 'staff_id,role_id,can_do,is_deputy',
  sched_staff_availability: 'staff_id,dow,part,available',
  // Staff Overview (§22.1): template shift times (fallback when an assignment
  // has none), staffing needs per slot, and per-session overrides.
  sched_hall_role_times: 'hall_id,role_id,dow,part,start_time,end_time,is_placeholder',
  sched_hall_role_needs: 'hall_id,role_id,dow,part,needed,min_on_floor',
  sched_session_roles: 'session_id,role_id,needed',
  // Commission: the hall-day default RPA target, used when a session has none.
  // Dollars per attendee — a sales target, not anybody's pay.
  sched_rpa_defaults: 'hall_id,dow,part,target_rpa',
  // Inventory. Ops owns this, not the analytics project — see inventory.js.
  products: 'id,vendor_id,name,type,cost,tickets,price_per_ticket,active,stock_unit',
  boxes: 'id,hall_id,product_id,serial,cost,state,session_tag,received_at,opened_at,sold_out_at,tickets_remaining,session_id',
  game_usage: 'hall_id,session_date,part,category,name_raw,product_id,game,game_type,vendor_id,distributor,still_stocked,qty',
  purchase_orders: 'id,num,hall_id,vendor_id,status,subtotal,tax,total,sent_at,archived_at',
  vendors: 'id,name,active',
});

/**
 * The data validator — Operations `public.recon_sessions`, the nightly
 * reconciliation app where staff assignments are now entered.
 *
 * NOT a plain column list. The table's `state` jsonb also holds cash counts,
 * paymaster lines and runner cash, and `figures`, `totals`, `payout_lines` and
 * `hotball_ledger` are money. None of it is read. The server builds each
 * projected field below from exactly one path, in SQL, so the rest of `state`
 * never leaves the database:
 *
 *   staff_status       state -> status -> staff      'approved' | 'progress'
 *   crew               state -> staff[]              rebuilt as {name, role, slot} ONLY
 *   commission_rate    state -> commission -> rate   a session's commission rate, not a wage
 *   commission_target  state -> commission -> target
 *
 * There are no start or end times per person in the validator, so hours can
 * never come from here.
 */
export const VALIDATOR_TABLE = 'recon_sessions';
export const VALIDATOR_COLUMNS = Object.freeze([
  'id', 'hall_id', 'session_date', 'session_time', 'slot_name', 'status', 'closed_at',
  'updated_at', 'staff_status', 'crew', 'commission_rate', 'commission_target',
]);
/** The only `state` paths read, per projected field. */
export const VALIDATOR_STATE_PATHS = Object.freeze({
  staff_status: ['status', 'staff'],
  crew: ['staff'],
  commission_rate: ['commission', 'rate'],
  commission_target: ['commission', 'target'],
});
/** The only keys kept from each `state.staff[]` element. */
export const VALIDATOR_CREW_FIELDS = Object.freeze(['name', 'role', 'slot']);
/** Columns of recon_sessions that must never be selected. */
export const VALIDATOR_FORBIDDEN = Object.freeze([
  'state', 'figures', 'totals', 'payout_lines', 'hotball_ledger', 'ecom_session_ids',
  'resolution', 'created_by', 'updated_by',
]);

/**
 * Keep only the allowlisted shape of one validator row. Applied on the server
 * after the query as a second line of defence, so even a future edit to the SQL
 * that selected more could not ship it to the browser.
 */
/**
 * A crew slot as an integer, or null. The SQL reads it as text ('3'); anything
 * that is not a whole number — an object, an array, '2.5', '' — is null.
 */
export function slotOf(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function projectValidatorRow(row = {}) {
  const out = {};
  for (const c of VALIDATOR_COLUMNS) out[c] = row[c] ?? null;
  const crew = Array.isArray(row.crew) ? row.crew : [];
  out.crew = crew.filter((e) => e && typeof e === 'object').map((e) => ({
    // Text is text: a nested value is dropped, not passed through.
    name: typeof e.name === 'string' ? e.name : null,
    role: typeof e.role === 'string' ? e.role : null,
    slot: slotOf(e.slot),
  }));
  return out;
}

/**
 * Hotball pots — the one part of `recon_sessions` money that IS read.
 *
 * The validator read above leaves `hotball_ledger` and `state` out because
 * they hold cash counts and paymaster lines. The Hotball screen needs the pot
 * figures, which are the HALL'S money (what a progressive holds), not anyone's
 * pay, and SAR already shows jackpot balances from the analytics project. So
 * this read takes exactly the per-pot fields below and nothing else:
 *
 *   hotball_ledger[]     one element per pot, fields in HOTBALL_LEDGER_FIELDS
 *   state -> pm -> hot[] the matching element only, fields in HOTBALL_TYPED_FIELDS
 *
 * Each field is pulled by name as TEXT in SQL (server/ops-read.mjs), so no
 * nested object, no other pot (Gremlin) and no other part of `state` leaves
 * the database. `projectHotballRow` re-applies the shape on the server.
 *
 * Cash movements are read from `hotball_cash_movements`, unvoided only, and
 * WITHOUT `created_by` / `voided_by` (email addresses). SAR never writes them;
 * they are recorded in the Session Reconciliation hotball page.
 */
export const HOTBALL_POTS = Object.freeze(['hotball', 'mega_hotball']);
/** hotball_ledger element key → projected field. */
export const HOTBALL_LEDGER_FIELDS = Object.freeze({
  key: 'pot', carry_over: 'opening', added: 'added', total: 'total',
  paid_out: 'paid_ledger', was_hit: 'hit_ledger', carry_forward: 'closing_ledger',
  overridden: 'overridden', override_reason: 'override_reason',
});
/** state.pm.hot element key → projected field. What the paymaster typed. */
export const HOTBALL_TYPED_FIELDS = Object.freeze({
  hit: 'typed_hit', paid: 'typed_paid', carryEdited: 'carry_edited',
});
export const HOTBALL_ROW_FIELDS = Object.freeze([
  'hall_id', 'session_date', 'session_time', 'slot_name', 'status',
  ...Object.values(HOTBALL_LEDGER_FIELDS), ...Object.values(HOTBALL_TYPED_FIELDS),
  'typed_hits_any',
]);
export const HOTBALL_MOVEMENTS_TABLE = 'hotball_cash_movements';
export const HOTBALL_MOVEMENT_FIELDS = Object.freeze([
  'id', 'pot_key', 'movement_date', 'session_time', 'kind', 'amount', 'note',
]);
/** Columns of hotball_cash_movements that the read filters and orders on. */
export const HOTBALL_MOVEMENT_GRANT = Object.freeze([
  ...HOTBALL_MOVEMENT_FIELDS, 'created_at', 'voided_at',
]);

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const boolOf = (v) => v === true || v === 'true';
const textOf = (v) => (typeof v === 'string' ? v : null);

/** Keep only the allowlisted, typed shape of one hotball row. */
export function projectHotballRow(row = {}) {
  return {
    hall_id: textOf(row.hall_id),
    session_date: textOf(row.session_date),
    session_time: textOf(row.session_time),
    slot_name: textOf(row.slot_name),
    status: textOf(row.status),
    pot: HOTBALL_POTS.includes(row.pot) ? row.pot : null,
    opening: numOrNull(row.opening),
    added: numOrNull(row.added),
    total: numOrNull(row.total),
    paid_ledger: numOrNull(row.paid_ledger),
    hit_ledger: boolOf(row.hit_ledger),
    closing_ledger: numOrNull(row.closing_ledger),
    overridden: boolOf(row.overridden),
    override_reason: textOf(row.override_reason),
    typed_hit: boolOf(row.typed_hit),
    typed_paid: numOrNull(row.typed_paid),
    carry_edited: boolOf(row.carry_edited),
    typed_hits_any: boolOf(row.typed_hits_any),
  };
}

export const MOVEMENT_KINDS = Object.freeze(['payout', 'cash_out', 'cash_in', 'count']);
/** Keep only the allowlisted shape of one cash movement. */
export function projectMovementRow(row = {}) {
  return {
    id: row.id === null || row.id === undefined ? null : String(row.id),
    pot_key: textOf(row.pot_key),
    movement_date: textOf(row.movement_date),
    session_time: textOf(row.session_time),
    kind: MOVEMENT_KINDS.includes(row.kind) ? row.kind : null,
    amount: numOrNull(row.amount),
    note: textOf(row.note),
  };
}

/** The three roles this feature is about. Read from data, matched by name. */
export const MANAGER_ROLES = Object.freeze(['MOD', 'Paymaster', 'Flash Manager']);

/**
 * Columns that are individual PAY and must never be read.
 *
 * Narrowed deliberately from a blanket ban on anything containing "pay" or
 * "comm": commission is explicitly permitted, so `commission_pool`,
 * `payout_amount` and `shares` are allowed by name below. What stays banned is
 * anything that prices a PERSON'S TIME — wages, salaries, hourly and base
 * rates, overtime pay and the meal and rest premiums in `sched_time_entries`.
 *
 * Matched by TOKEN, not by prefix. The first version, /(^|_)(wage|salary|...)/,
 * let `pay_rate`, `base_rate`, `regular_rate`, `overtime_rate`, `gross_pay`,
 * `ot_pay`, `pay` and `compensation` through: none of them starts with a
 * banned word. Now a column is split on `_` and banned if ANY token is a pay
 * word — and the unambiguous words are banned even inside a token, so
 * `basepay`, `payrate` and `hourlywage` are caught too.
 *
 * This is the one definition. The reader-login SQL test and the server read
 * both go through `isPayColumn`.
 */
/** Banned when they are a whole `_`-separated token. Short, so token-only. */
export const PAY_TOKENS = Object.freeze([
  'pay', 'pays', 'rate', 'rates', 'tip', 'tips', 'comp', 'earn', 'earns', 'earned',
  'wage', 'wages', 'salary', 'salaries', 'salaried', 'hourly', 'premium', 'premiums',
  'earning', 'earnings', 'bonus', 'bonuses', 'compensation',
]);
/** Banned anywhere in the name: no legitimate column contains them. */
const PAY_WORDS = /wage|salar|hourly|premium|bonus|compensation|earning|payroll|payrate|paycheck|basepay|grosspay|netpay/i;
const TOKENS = new Set(PAY_TOKENS);

/**
 * Permitted despite matching: each is a SESSION or SALES figure, or the
 * commission this app is allowed to show — never what a person is paid for
 * their time. Adding to this list is a privacy decision; say why beside it.
 */
export const PAY_ALLOWED = Object.freeze(new Set([
  'comm_rate',          // sched_sessions: the session's commission RATE (a percentage of sales)
  'commission_rate',    // recon_sessions projection: the same rate as the validator records it
  'commission_target',  // recon_sessions projection: the RPA target the rate applies above
  'target_rpa',         // revenue per attendee target — a sales figure
  'actual_rpa',         // revenue per attendee — a sales figure
  'price_per_ticket',   // products: the price a customer pays for a ticket
  'commission_pool', 'payout_amount', 'shares', 'total_shares',   // commission, permitted
  'session_date', 'confirmed_at',
]));

/** Is this column individual pay? The single test every guard uses. */
export function isPayColumn(column) {
  const col = String(column).trim().toLowerCase();
  if (!col || PAY_ALLOWED.has(col)) return false;
  return PAY_WORDS.test(col) || col.split(/[^a-z0-9]+/).some((t) => TOKENS.has(t));
}

/**
 * Assert the allowlist contains no pay column. Called by the test suite.
 *
 * A denylist checked in tests, not a comment hoping to be read. `paymaster`
 * is a ROLE NAME, not a column, and does not appear in COLUMNS — the check
 * below would catch it if someone added a `paymaster_pay` column tomorrow.
 */
export function assertNoPayColumns(columns = {
  ...COLUMNS, [VALIDATOR_TABLE]: VALIDATOR_COLUMNS.join(','),
  [`${VALIDATOR_TABLE}.crew`]: VALIDATOR_CREW_FIELDS.join(','),
  [`${VALIDATOR_TABLE}.hotball`]: HOTBALL_ROW_FIELDS.join(','),
  [HOTBALL_MOVEMENTS_TABLE]: HOTBALL_MOVEMENT_GRANT.join(','),
}) {
  const bad = [];
  for (const [table, cols] of Object.entries(columns)) {
    for (const c of cols.split(',')) {
      const col = c.trim();
      if (isPayColumn(col)) bad.push(`${table}.${col}`);
    }
  }
  if (bad.length) throw new Error(`ops.js: pay columns are forbidden: ${bad.join(', ')}`);
  return true;
}

assertNoPayColumns();

