import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keepDatesAsText, databaseOptions, SECRET_NAME } from './ops-read.mjs';

// The read itself lives in ops-read.mjs, shared with the Edge Function. This
// file adds only what is Node-specific: the pg driver, the CA file on disk and
// the owner's one-time Vault setup.
export {
  DATE_OID, keepDatesAsText, OPS_PROJECT, SECRET_NAME, databaseOptions,
  VALIDATOR_SQL, readValidator, readOperations, readAnthropicKey,
  HOTBALL_SQL, HOTBALL_MOVEMENTS_SQL, readHotball,
} from './ops-read.mjs';

keepDatesAsText(pg.types);

/**
 * Supabase signs its database certificates with its own root CA, which is not
 * in Node's default trust store. Rather than ever turning verification off,
 * SAR trusts that CA when its file is present: SAR_OPS_CA_FILE, or the file
 * Supabase hands out (Project Settings → Database → SSL Configuration →
 * Download certificate), saved in the sar2 folder as `prod-ca-2021.crt`.
 */
export const DEFAULT_CA_FILE = 'prod-ca-2021.crt';
export function findCaFile(env = {}, cwd = process.cwd()) {
  const file = env.SAR_OPS_CA_FILE ? resolve(cwd, env.SAR_OPS_CA_FILE) : resolve(cwd, DEFAULT_CA_FILE);
  return existsSync(file) ? file : null;
}

export function createOperationsPool(env, { cwd = process.cwd() } = {}) {
  if (!env.SAR_OPS_DATABASE_URL) return null;
  const caFile = findCaFile(env, cwd);
  const ca = caFile ? readFileSync(caFile, 'utf8') : null;
  const pool = new pg.Pool(databaseOptions(env.SAR_OPS_DATABASE_URL, { ca }));
  // Pool errors may include credentials or connection details. Never emit them.
  pool.on('error', () => console.warn('SAR Operations connection unavailable.'));
  return pool;
}

// Administrative setup only. This function is not exposed through HTTP.
export async function saveAnthropicKey(pool, key) {
  if (typeof key !== 'string' || !key.startsWith('sk-ant-') || key.length < 20) {
    throw new Error('Enter a valid Anthropic API key.');
  }
  const { rows } = await pool.query('SELECT id FROM vault.secrets WHERE name = $1', [SECRET_NAME]);
  if (rows.length) {
    await pool.query('SELECT vault.update_secret($1::uuid, $2::text)', [rows[0].id, key]);
  } else {
    await pool.query('SELECT vault.create_secret($1::text, $2::text, $3::text)',
      [key, SECRET_NAME, 'Shared Ask SAR credential; server access only']);
  }
}
