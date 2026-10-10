// Builds scripts/create-sar-reader.sql from the read allowlist, so the
// database login SAR uses can read exactly what SAR reads and nothing else.
//   node scripts/sar-reader-sql.mjs > scripts/create-sar-reader.sql
import {
  COLUMNS, VALIDATOR_TABLE, HOTBALL_MOVEMENTS_TABLE, HOTBALL_MOVEMENT_GRANT,
} from '../src/lib/ops-schema.js';

export const READER_ROLE = 'sar_reader';
/** recon_sessions columns the validator and hotball reads touch. `state` and
 *  `hotball_ledger` are reached only through the projected paths in
 *  server/ops-read.mjs. */
export const VALIDATOR_GRANT = ['id', 'hall_id', 'session_date', 'session_time', 'slot_name',
  'status', 'closed_at', 'updated_at', 'state', 'hotball_ledger'];

/** `game_usage` is a security-invoker view, so the login also needs the
 *  columns the view reads from its base tables (products and vendors are
 *  already granted above). Checked against pg_depend on 2 Oct 2026. */
export const VIEW_BASE_GRANTS = Object.freeze({
  session_plays: ['session_id', 'product_id', 'category', 'name_raw', 'qty', 'serial'],
  sessions: ['id', 'hall_id', 'session_date', 'part', 'weekday', 'historical'],
});

export function buildReaderSql() {
  const grant = (table, cols) => `grant select (${cols.join(', ')}) on public.${table} to ${READER_ROLE};`;
  return [
    '-- SAR 2.0 — a read-only login for the Operations database.',
    '--',
    '-- Run once in Supabase → Operational DB → SQL Editor. It creates a NEW login',
    `-- (${READER_ROLE}) with its own password. It does not touch the main postgres`,
    '-- password, any table, or any other app.',
    '--',
    '-- BEFORE RUNNING: replace CHANGE-ME on the line below with a new password',
    '-- of your own — letters and numbers only, 20+ characters. Keep it; it goes',
    '-- into .env.local. Nobody else needs it.',
    '--',
    `-- What ${READER_ROLE} can do: read only the columns listed below. Every`,
    '-- transaction is read-only. It cannot see pay rates or break-premium money,',
    '-- and cannot write, delete or change anything.',
    '-- bypassrls: these tables have row-level security with no policy for this',
    '-- login; without it every read would return zero rows. The column grants',
    '-- below are what limit it.',
    '--',
    `-- To remove it later:  drop owned by ${READER_ROLE}; drop role ${READER_ROLE};`,
    '',
    `create role ${READER_ROLE} login password 'CHANGE-ME' bypassrls;`,
    `alter role ${READER_ROLE} set default_transaction_read_only = on;`,
    `alter role ${READER_ROLE} set statement_timeout = '30s';`,
    `grant usage on schema public to ${READER_ROLE};`,
    '',
    ...Object.entries(COLUMNS).map(([t, cols]) => grant(t, cols.split(','))),
    grant(VALIDATOR_TABLE, VALIDATOR_GRANT),
    '-- Hotball pots: cash movements recorded in Session Reconciliation, without who recorded them.',
    grant(HOTBALL_MOVEMENTS_TABLE, HOTBALL_MOVEMENT_GRANT),
    '-- Base tables behind the game_usage view (it runs with the reader\'s rights).',
    ...Object.entries(VIEW_BASE_GRANTS).map(([t, cols]) => grant(t, cols)),
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(buildReaderSql());
