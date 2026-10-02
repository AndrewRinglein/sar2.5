/*
 * The Supabase Edge Function adapter for the SAR API (function `sar2-api`
 * on the Operations project). Runtime-neutral like api-core.mjs: it uses
 * only Web-standard Request/Response, so the test suite runs it under Node
 * exactly as Deno runs it. The Deno-only glue (Deno.env, Deno.serve, the
 * npm:pg import) is the few lines in server/edge-entry.mjs.
 *
 * Routes, same as the local server but under the function's own path:
 *   GET  /sar2-api/operations     POST /sar2-api/ask-sar     GET /sar2-api/competitive
 *   OPTIONS on any of them        CORS preflight for the origins below
 *
 * The function is deployed with verify_jwt = false because the caller's token
 * comes from a different project (bms-production). The token check inside
 * api-core.mjs (authorize) is therefore the ONLY gate, and it runs on every
 * non-preflight request before any data is read or any key is used.
 */
import { createApiCore, DEFAULT_MODEL, MAX_KNOWLEDGE_CHARS } from './api-core.mjs';
import { databaseOptions, keepDatesAsText } from './ops-read.mjs';

/** Browser origins allowed to call the function. The one list. */
export const EDGE_ALLOWED_ORIGINS = Object.freeze([
  'https://andrewringlein.github.io',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

/** Supabase hands the function its path as /sar2-api/...; the full public
 *  path is accepted too in case a proxy forwards it unchanged. */
export const EDGE_PREFIXES = Object.freeze(['/sar2-api', '/functions/v1/sar2-api']);

/** Read a JSON body from a Web Request, refusing more than maxBytes. */
export async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('payload');
  if (!request.body) throw new Error('empty');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('payload'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return JSON.parse(new TextDecoder().decode(all));
}

/** Request -> Response around the shared core. */
export function createEdgeHandler(options = {}) {
  const handle = createApiCore({ prefixes: EDGE_PREFIXES, cors: { origins: EDGE_ALLOWED_ORIGINS }, ...options });
  return async (request) => {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers); // keys arrive lower-case
    const result = await handle({ method: request.method, url: url.pathname + url.search, headers,
      readBody: maxBytes => readJsonBody(request, maxBytes) });
    if (!result) {
      const origin = headers.origin;
      const cors = origin && EDGE_ALLOWED_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {};
      return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', ...cors } });
    }
    return new Response(result.body === null ? null : JSON.stringify(result.body),
      { status: result.status, headers: result.headers });
  };
}

/**
 * Wire the handler to the function's environment. Called once per isolate,
 * so the pool and the Ask SAR rate limits live as long as the isolate does.
 *
 *   env(name)  reads an environment variable (Deno.env.get in production)
 *   pg         the node-postgres module (npm:pg@8 in production)
 *   knowledge  the bundled text of knowledge/bingo-knowledge.md
 *   ca         the Supabase root CA (server/supabase-ca.mjs)
 *
 * Environment:
 *   SUPABASE_DB_URL         provided by Supabase to every edge function
 *   SAR_ANTHROPIC_API_KEY   Edge Function secret set by the owner (optional:
 *                           without it the shared Vault secret is read, as the
 *                           local server does when it has a database pool)
 *   SAR_ANTHROPIC_MODEL     optional; defaults to DEFAULT_MODEL
 */
export function createEdgeServer({ env, pg, knowledge = '', ca = null, ...overrides }) {
  let pool = null;
  const dbUrl = env('SUPABASE_DB_URL');
  if (dbUrl) {
    try {
      keepDatesAsText(pg.types);
      // databaseOptions keeps the Operations-project allowlist, strips any
      // sslmode from the URL and always verifies the certificate.
      pool = new pg.Pool(databaseOptions(dbUrl, { ca }));
      // Pool errors may include credentials or connection details. Never emit them.
      pool.on('error', () => console.warn('SAR Operations connection unavailable.'));
    } catch {
      pool = null;
      console.warn('SAR: invalid Operations connection.');
    }
  } else {
    console.warn('SAR: Operations connection not configured.');
  }
  const rawKey = env('SAR_ANTHROPIC_API_KEY') ?? '';
  const apiKey = /^sk-ant-/.test(rawKey) ? rawKey : null;
  const text = String(knowledge ?? '').slice(0, MAX_KNOWLEDGE_CHARS);
  return createEdgeHandler({ pool, apiKey, model: env('SAR_ANTHROPIC_MODEL') || DEFAULT_MODEL,
    knowledge: () => text, ...overrides });
}
