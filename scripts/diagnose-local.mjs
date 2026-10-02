// Diagnose the local server configuration with real error messages.
// Prints WHY something fails (configure-local.mjs hides the reason).
// Credentials are never printed: passwords are masked, the key is never echoed.
import { loadEnv } from 'vite';
import { createOperationsPool, readAnthropicKey, readValidator, findCaFile, DEFAULT_CA_FILE, SECRET_NAME, OPS_PROJECT } from '../server/database.mjs';
import { COLUMNS } from '../src/lib/ops-schema.js';

const env = loadEnv('development', process.cwd(), 'SAR_');
const mask = s => String(s).replace(/(:\/\/[^:]+:)[^@]+@/, '$1****@');
const ok = m => console.log('  ✓ ' + m);
const bad = (m, e) => { console.log('  ✗ ' + m); if (e) console.log('    → ' + (e.code ? e.code + ': ' : '') + mask(e.message)); };

console.log('New SAR local configuration check\n');
console.log('1. .env.local');
const localKey = /^sk-ant-/.test(env.SAR_ANTHROPIC_API_KEY ?? '');
console.log('   SAR_ANTHROPIC_MODEL = ' + (env.SAR_ANTHROPIC_MODEL || '(unset → claude-sonnet-5-5)'));
if (localKey) ok(`SAR_ANTHROPIC_API_KEY is set (${env.SAR_ANTHROPIC_API_KEY.length} chars) → Ask SAR will use it`);
else console.log('   SAR_ANTHROPIC_API_KEY not set → Ask SAR needs the Operations Vault secret instead');
if (!env.SAR_OPS_DATABASE_URL) {
  bad('SAR_OPS_DATABASE_URL is not set → Managers, Inventory, Commission, Staff Overview will show "Scheduler not connected".');
  console.log('    To fix: npm run configure:local  (needs the Operations database password)');
  console.log('\nE-commerce analytics data needs no setup here; it is unlocked by signing in to the app.');
  process.exit(localKey ? 0 : 1);
}
ok('SAR_OPS_DATABASE_URL = ' + mask(env.SAR_OPS_DATABASE_URL));

let pool;
console.log('\n2. Connection string shape');
try { pool = createOperationsPool(env); ok(`host accepted for project ${OPS_PROJECT}`);
  const ca = findCaFile(env);
  ok(ca ? `Supabase certificate found: ${ca}` : `no Supabase certificate file (${DEFAULT_CA_FILE}) — fine unless step 3 says "certificate"`); }
catch (e) { bad('rejected', e); process.exit(1); }

console.log('\n3. Postgres connection');
try { const r = await pool.query('select current_user, version()'); ok(`connected as ${r.rows[0].current_user}`); }
catch (e) { bad('cannot connect', e);
  if (/ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(e.code || e.message)) console.log('    Hint: the direct db.* host is IPv6-only. Use the Session pooler string from Supabase → Connect.');
  if (/password/i.test(e.message)) console.log('    Hint: URL-encode special characters in the password (e.g. @ → %40, # → %23).');
  if (/certificate|self[- ]signed/i.test(e.message)) console.log(`    Hint: download Supabase's certificate (Project Settings → Database → SSL Configuration → Download certificate) and save it in this folder as ${DEFAULT_CA_FILE}.`);
  if (/Tenant or user not found/i.test(e.message)) console.log('    Hint: with the pooler, the user name must be sar_reader.lkcfbgnuodqzvowschjn (role, dot, project id).');
  await pool.end(); process.exit(1); }

console.log('\n4. Allowlisted Operations tables');
let tableFail = 0;
for (const [table, cols] of Object.entries(COLUMNS)) {
  const sel = cols.split(',').map(c => `"${c}"`).join(',');
  try { const r = await pool.query(`select count(*)::int as n from (select ${sel} from public."${table}" limit 1) s`); ok(`${table} (${r.rows[0].n ? 'readable' : 'readable, empty'})`); }
  catch (e) { tableFail++; bad(table, e); }
}

console.log('\n4b. Data validator (recon_sessions)');
{ const c = await pool.connect();
  try { await c.query('BEGIN READ ONLY'); const v = await readValidator(c);
    (v.ok ? ok : bad)(v.ok ? `readable — ${v.rows.length} sessions` : 'not readable (see warning above)'); }
  finally { await c.query('ROLLBACK').catch(() => {}); c.release(); } }

console.log('\n5. Vault secret ' + SECRET_NAME + (localKey ? ' (optional: a local key is set)' : ''));
try { const key = await readAnthropicKey(pool);
  if (key) ok(`present (${key.slice(0, 7)}…, ${key.length} chars)`);
  else (localKey ? ok : bad)('not stored in Vault' + (localKey ? '; the local key will be used' : '. Run npm run configure:local and enter the key.'));
} catch (e) { (localKey ? ok : bad)('cannot read vault.decrypted_secrets' + (localKey ? '; the local key will be used' : ''), localKey ? null : e);
  if (!localKey) console.log('    Hint: Vault must be enabled on the project and this role needs access to the vault schema.'); }

await pool.end();
console.log('\nDone.' + (tableFail ? ` ${tableFail} table(s) not readable.` : ''));
