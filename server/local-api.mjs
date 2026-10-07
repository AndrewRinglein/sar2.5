import { readFileSync, statSync } from 'node:fs';
import { createOperationsPool, readOperations, readAnthropicKey } from './database.mjs';
import { createApiCore, authorize, DEFAULT_MODEL, MAX_KNOWLEDGE_CHARS } from './api-core.mjs';

// The routes themselves live in api-core.mjs, shared with the Supabase Edge
// Function. This file is only the Node/Vite adapter: it reads the knowledge
// file from disk, reads request bodies from a Node stream and writes the
// result to a Node response.
export {
  SYSTEM_PROMPT, MAX_BODY_BYTES, MAX_HISTORY_TURNS, sanitizeHistory, authorize, validQuestion,
} from './api-core.mjs';

/** The owner-editable knowledge file, re-read when it changes on disk. */
export const KNOWLEDGE_PATH = 'knowledge/bingo-knowledge.md';
const knowledgeCache = new Map();
export function loadKnowledge(path = KNOWLEDGE_PATH) {
  try {
    const mtime = statSync(path).mtimeMs;
    if (mtime !== knowledgeCache.get(path)?.mtime) {
      knowledgeCache.set(path, { mtime, text: readFileSync(path, 'utf8').slice(0, MAX_KNOWLEDGE_CHARS) });
    }
    return knowledgeCache.get(path).text;
  } catch { return ''; }
}

async function readBody(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new Error('payload');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
}

export function createLocalApi({ pool = null, fetchImpl = fetch,
  loadOperations = readOperations, loadKey = readAnthropicKey, apiKey = null,
  authenticate = authorize, model = DEFAULT_MODEL, now = Date.now,
  knowledge = () => ({ general: loadKnowledge(), forecasting: loadKnowledge('knowledge/forecasting.md') }), ...extras } = {}) {
  // Same-origin only (cors: null): the browser reaches this through Vite.
  const handle = createApiCore({ prefixes: ['/api'], cors: null, pool, fetchImpl,
    loadOperations, loadKey, apiKey, authenticate, model, now, knowledge, ...extras });
  return async (req, res, next) => {
    const result = await handle({ method: req.method, url: req.url ?? '', headers: req.headers ?? {},
      readBody: maxBytes => readBody(req, maxBytes) });
    if (!result) return next();
    res.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.end(result.body === null ? '' : JSON.stringify(result.body));
  };
}

export function localApiPlugin(env) {
  let pool;
  try { pool = createOperationsPool(env); }
  catch { console.warn('SAR: invalid Operations connection. Run npm run configure:local.'); }
  if (!pool) console.warn('SAR: Operations connection not configured. Run npm run configure:local.');
  const apiKey = /^sk-ant-/.test(env.SAR_ANTHROPIC_API_KEY ?? '') ? env.SAR_ANTHROPIC_API_KEY : null;
  if (!apiKey && !pool) console.warn('SAR: Ask SAR has no key. Set SAR_ANTHROPIC_API_KEY in .env.local or run npm run configure:local.');
  const handler = createLocalApi({ pool, apiKey, model: env.SAR_ANTHROPIC_MODEL || DEFAULT_MODEL });
  const attach = server => {
    server.middlewares.use(handler);
    server.httpServer?.once('close', () => { pool?.end().catch(() => {}); });
  };
  return { name: 'sar-local-api', configureServer: attach, configurePreviewServer: attach };
}
