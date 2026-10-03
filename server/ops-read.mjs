/*
 * The Operations read, runtime-neutral: no Node-only API and no database
 * driver is imported here, so the same code runs in the local Vite server
 * (server/database.mjs supplies node-postgres) and in the Supabase Edge
 * Function (server/edge-entry.mjs supplies npm:pg). One implementation.
 */
import {
  COLUMNS, assertNoPayColumns, VALIDATOR_TABLE, VALIDATOR_STATE_PATHS,
  VALIDATOR_CREW_FIELDS, projectValidatorRow,
} from '../src/lib/ops-schema.js';

/*
 * Postgres DATE columns come back as plain 'YYYY-MM-DD' text, never as a JS
 * Date. node-postgres turns a DATE into local midnight by default, which
 * reaches the browser as an ISO timestamp ('2026-08-16T07:00:00.000Z') and
 * silently breaks every join on session_date / work_date. Found 1 Oct 2026.
 * Each runtime calls keepDatesAsText(pg.types) on the driver it loads.
 */
export const DATE_OID = 1082;
export function keepDatesAsText(types) {
  types.setTypeParser(DATE_OID, (value) => value);
}

export const OPS_PROJECT = 'lkcfbgnuodqzvowschjn';
export const SECRET_NAME = 'sar2-anthropic-key';

// Accept only the intended Operations project, including its shared pooler.
// Strip SSL URL options so they cannot turn off certificate verification.
export function databaseOptions(connectionString, { ca = null } = {}) {
  const url = new URL(connectionString);
  const direct = url.hostname === `db.${OPS_PROJECT}.supabase.co`;
  const pooled = url.hostname.endsWith('.pooler.supabase.com')
    && decodeURIComponent(url.username).endsWith(`.${OPS_PROJECT}`);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !pooled)) {
    throw new Error('Use the connection string for the Operations project.');
  }
  for (const name of [...url.searchParams.keys()]) {
    if (name.toLowerCase().startsWith('ssl')) url.searchParams.delete(name);
  }
  return { connectionString: url.toString(),
    ssl: ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true },
    max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
    statement_timeout: 30000, query_timeout: 35000 };
}

const TABLES = Object.freeze({
  roles: 'sched_roles', staff: 'sched_staff', sessions: 'sched_sessions',
  assignments: 'sched_assignments', commissionPayouts: 'sched_commission_payouts',
  sessionShares: 'sched_session_shares', timeEntries: 'sched_time_entries',
  capability: 'sched_staff_role_capability', availability: 'sched_staff_availability',
  hallRoleTimes: 'sched_hall_role_times', hallRoleNeeds: 'sched_hall_role_needs',
  sessionRoles: 'sched_session_roles', rpaDefaults: 'sched_rpa_defaults',
  products: 'products', boxes: 'boxes', gameUsage: 'game_usage',
  purchaseOrders: 'purchase_orders', vendors: 'vendors',
});

/**
 * The data validator read. Every field is named; `state` is only ever reached
 * through the paths in VALIDATOR_STATE_PATHS, and the crew array is rebuilt
 * element by element from VALIDATOR_CREW_FIELDS — so cash counts, paymaster
 * lines and runner cash in the same jsonb never leave the database. Dates and
 * times are cast to text so the browser gets 'YYYY-MM-DD' and 'HH:MM', not a
 * timezone-shifted Date.
 */
const path = (p) => `'{${p.join(',')}}'`;
export const VALIDATOR_SQL = [
  'SELECT r.id, r.hall_id, r.session_date::text AS session_date,',
  "  to_char(r.session_time, 'HH24:MI') AS session_time, r.slot_name, r.status,",
  '  r.closed_at, r.updated_at,',
  `  r.state #>> ${path(VALIDATOR_STATE_PATHS.staff_status)} AS staff_status,`,
  // Every crew field is read as TEXT (->>), never as jsonb (->): a nested
  // object under `slot` can then never reach the browser. projectValidatorRow
  // turns slot back into an integer, or null.
  `  COALESCE((SELECT jsonb_agg(jsonb_build_object(${VALIDATOR_CREW_FIELDS.map((f) =>
    `'${f}', e.value ->> '${f}'`).join(', ')}) ORDER BY e.ord)`,
  `    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.state #> ${path(VALIDATOR_STATE_PATHS.crew)}) = 'array'`,
  `      THEN r.state #> ${path(VALIDATOR_STATE_PATHS.crew)} ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)), '[]'::jsonb) AS crew,`,
  `  r.state #>> ${path(VALIDATOR_STATE_PATHS.commission_rate)} AS commission_rate,`,
  `  r.state #>> ${path(VALIDATOR_STATE_PATHS.commission_target)} AS commission_target`,
  `FROM public."${VALIDATOR_TABLE}" r`,
  'ORDER BY r.session_date, r.session_time',
].join('\n');

/**
 * Read the validator inside the caller's transaction, behind a savepoint, so a
 * failure here (table renamed, permission revoked) leaves the rest of the
 * Operations snapshot intact. Returns `{ ok, rows }`; never throws.
 */
export async function readValidator(connection) {
  try {
    await connection.query('SAVEPOINT validator');
    const { rows } = await connection.query(VALIDATOR_SQL);
    await connection.query('RELEASE SAVEPOINT validator');
    return { ok: true, rows: (rows ?? []).map(projectValidatorRow) };
  } catch {
    await connection.query('ROLLBACK TO SAVEPOINT validator').catch(() => {});
    // No details: an error here may carry connection or schema specifics.
    console.warn('SAR: data validator unavailable; other Operations data still loaded.');
    return { ok: false, rows: [] };
  }
}

export async function readOperations(pool) {
  assertNoPayColumns();
  const connection = await pool.connect();
  try {
    // A consistent snapshot, read-only even when the configured DB role can write.
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = { ok: true };
    for (const [name, table] of Object.entries(TABLES)) {
      const columns = COLUMNS[table].split(',').map(c => `"${c}"`).join(',');
      const { rows } = await connection.query(`SELECT ${columns} FROM public."${table}"`);
      result[name] = rows; // Direct SQL has no PostgREST 1,000-row truncation.
    }
    result.validator = await readValidator(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// Read the encrypted central secret only in the server process.
export async function readAnthropicKey(pool) {
  const { rows } = await pool.query(
    'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1',
    [SECRET_NAME],
  );
  return rows[0]?.decrypted_secret || null;
}
