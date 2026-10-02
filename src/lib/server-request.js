import { apiBase, LOCAL_API_BASE } from './config.js';

/**
 * The URL a SAR API path is fetched from. Callers name routes the local way,
 * '/api/operations', '/api/competitive?hall=…'; apiBase (config.js) decides
 * whether that stays on this server or goes to the Edge Function.
 */
export function apiUrl(path, hostname) {
  if (!path.startsWith(`${LOCAL_API_BASE}/`)) return path;
  return apiBase(hostname) + path.slice(LOCAL_API_BASE.length);
}

// Use the existing SAR session to authorize server requests. No Operations or
// Anthropic credential is ever requested from, or returned to, this browser.
export async function serverRequest(path, { body, fetchImpl = globalThis.fetch, hostname } = {}) {
  const { supabase } = await import('./api.js');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) throw new Error('Please sign in to SAR again.');
  const response = await fetchImpl(apiUrl(path, hostname), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${data.session.access_token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The service is temporarily unavailable.');
  return result;
}
