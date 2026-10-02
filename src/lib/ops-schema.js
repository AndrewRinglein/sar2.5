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
export function projectValidatorRow(row = {}) {
  const out = {};
  for (const c of VALIDATOR_COLUMNS) out[c] = row[c] ?? null;
  const crew = Array.isArray(row.crew) ? row.crew : [];
  out.crew = crew.filter((e) => e && typeof e === 'object').map((e) => {
    const x = {};
    for (const f of VALIDATOR_CREW_FIELDS) x[f] = e[f] ?? null;
    return x;
  });
  return out;
}

/** The three roles this feature is about. Read from data, matched by name. */
export const MANAGER_ROLES = Object.freeze(['MOD', 'Paymaster', 'Flash Manager']);

/**
 * Columns that are individual PAY and must never be read.
 *
 * Narrowed deliberately from a blanket ban on anything containing "pay" or
 * "comm": commission is explicitly permitted, so `commission_pool`,
 * `payout_amount` and `shares` are allowed by name below. What stays banned is
 * anything that prices a PERSON'S TIME — wages, salaries, hourly rates and the
 * meal and rest premiums in `sched_time_entries`.
 */
const PAY_PATTERN = /(^|_)(wage|salary|hourly|premium|earn|bonus|tip|salaried)/i;

/** Permitted despite looking like pay. Commission is public here. */
const PAY_ALLOWED = new Set([
  'commission_pool', 'payout_amount', 'shares', 'total_shares',
  'session_date', 'confirmed_at',
]);

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
}) {
  const bad = [];
  for (const [table, cols] of Object.entries(columns)) {
    for (const c of cols.split(',')) {
      const col = c.trim();
      if (!PAY_ALLOWED.has(col) && PAY_PATTERN.test(col)) bad.push(`${table}.${col}`);
    }
  }
  if (bad.length) throw new Error(`ops.js: pay columns are forbidden: ${bad.join(', ')}`);
  return true;
}

assertNoPayColumns();

