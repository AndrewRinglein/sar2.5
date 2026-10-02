// Owner-only setup, run in a terminal. Nothing in this script is served to users.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadEnv } from 'vite';
import { createOperationsPool, saveAnthropicKey } from '../server/database.mjs';

const env = loadEnv('development', process.cwd(), 'SAR_');
let muted = false;
const output = new Writable({ write(chunk, encoding, callback) {
  if (!muted) process.stdout.write(chunk, encoding);
  callback();
} });
const rl = createInterface({ input: process.stdin, output, terminal: true });
async function hidden(prompt) {
  process.stdout.write(prompt);
  muted = true;
  try { return (await rl.question('')).trim(); }
  finally { muted = false; process.stdout.write('\n'); }
}
let pool;
try {
  console.log('New SAR: one-time local server setup. Values are hidden while you type.');
  const connection = await hidden('Operations Postgres connection string (Enter keeps the existing one): ');
  const url = connection || env.SAR_OPS_DATABASE_URL;
  if (!url) throw new Error('Operations connection is required.');
  // Validate the dotenv representation before making any database change.
  if (/[\r\n'\s]/.test(url)) throw new Error('Use a URL-encoded PostgreSQL connection string.');
  pool = createOperationsPool({ SAR_OPS_DATABASE_URL: url });
  await pool.query('SELECT 1 FROM public.sched_roles LIMIT 1');
  const key = await hidden('Shared Anthropic key (Enter leaves the database secret unchanged): ');
  if (key) await saveAnthropicKey(pool, key);
  const path = '.env.local';
  let contents = existsSync(path) ? readFileSync(path, 'utf8') : '';
  contents = contents.replace(/^SAR_OPS_DATABASE_URL=.*\r?\n?/gm, '');
  writeFileSync(path, contents.trimEnd() + "\nSAR_OPS_DATABASE_URL='" + url + "'\n", { mode: 0o600 });
  console.log('Operations connection saved locally.' + (key ? ' Shared Anthropic key saved in Operations Vault.' : ''));
  console.log('Restart npm run dev to use the connection.');
} catch {
  console.error('Setup did not finish. Check the Operations connection string, database permissions and Vault availability.');
  process.exitCode = 1;
} finally {
  rl.close();
  await pool?.end();
}
