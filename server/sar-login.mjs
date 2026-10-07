import { SUPABASE_URL } from '../src/lib/config.js';

export const SAR_RETURN_URL = 'https://andrewringlein.github.io/sar2.5/';
export const LOGIN_MESSAGE = 'If this email has SAR access, a sign-in link is on its way. Check your inbox and spam folder. Please wait a minute before requesting another.';

// Atomic, persistent limits: at most one email per minute and five per hour.
// Unknown/disabled addresses never create Auth users or send mail.
export const LOGIN_SLOT_SQL = `UPDATE sar_bms.members SET
  requested_at = now(),
  requests = CASE WHEN window_start IS NULL OR window_start <= now() - interval '1 hour' THEN 1 ELSE requests + 1 END,
  window_start = CASE WHEN window_start IS NULL OR window_start <= now() - interval '1 hour' THEN now() ELSE window_start END
WHERE email = $1 AND enabled
  AND (requested_at IS NULL OR requested_at <= now() - interval '1 minute')
  AND (window_start IS NULL OR window_start <= now() - interval '1 hour' OR requests < 5)
RETURNING email`;

export function createLoginSender({ pool, serviceKey, mailKey, fetchImpl = fetch }) {
  return async (email) => {
    if (!pool || !serviceKey || !mailKey) throw Error('Login unavailable');
    const slot = await pool.query(LOGIN_SLOT_SQL, [email]);
    if (!slot.rows.length) return;
    const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/admin/generate_link?redirect_to=${encodeURIComponent(SAR_RETURN_URL)}`, {
      method: 'POST', headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error('Login unavailable');
    const generated = await response.json();
    const link = new URL(generated.action_link);
    if (link.origin !== SUPABASE_URL || link.pathname !== '/auth/v1/verify'
      || link.searchParams.get('redirect_to') !== SAR_RETURN_URL) throw Error('Invalid login destination');
    // Send directly: the general Operations email function logs message bodies,
    // and an authentication link must never appear in that log or API responses.
    const sent = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${mailKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'SAR <inventory@frontiergamingsystems.com>', to: [email],
        subject: 'Your SAR sign-in link',
        text: `Sign in to Session Analysis Reporting:\n\n${link.href}\n\nUse this single-use link soon. If you did not request it, you can ignore this email.`,
      }), signal: AbortSignal.timeout(15000),
    });
    if (!sent.ok) throw Error('Email unavailable');
  };
}
