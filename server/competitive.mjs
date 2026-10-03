// Fixed, public, read-only source. Never forward SAR's bearer token upstream.
export const MONITOR_URL = 'https://frontier-bingo-text-monitor.andrew595321.chatgpt.site/api/monitor';
export async function readCompetitive(query, fetchImpl = fetch) {
  const input = new URL(query, 'https://sar.invalid');
  const url = new URL(MONITOR_URL);
  const hall = input.searchParams.get('hall');
  const day = input.searchParams.get('day');
  if (day !== null && !hall) {
    // One day's updates. A real calendar date only; anything else is refused
    // before any request leaves the server.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('Invalid day');
    const d = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw Error('Invalid day');
    url.searchParams.set('day', day);
  }
  if (hall) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(hall)) throw Error('Invalid hall');
    const offset = Number(input.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid offset');
    url.searchParams.set('hall', hall);
    url.searchParams.set('offset', String(offset));
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw Error('Competitive source unavailable');
  const result = await response.json();
  if (hall ? !Array.isArray(result.messages) : !Array.isArray(result.halls)) throw Error('Invalid competitive response');
  return result;
}
