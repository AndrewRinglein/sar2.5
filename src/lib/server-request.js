// Use the existing SAR session to authorize server requests. No Operations or
// Anthropic credential is ever requested from, or returned to, this browser.
export async function serverRequest(path, { body, fetchImpl = globalThis.fetch } = {}) {
  const { supabase } = await import('./api.js');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) throw new Error('Please sign in to SAR again.');
  const response = await fetchImpl(path, {
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
