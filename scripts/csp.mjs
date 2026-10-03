/* ============================================================================
   SAR 2.0 — Content-Security-Policy for the built site

   GitHub Pages cannot send response headers, so the policy is a
   <meta http-equiv="Content-Security-Policy"> written into index.html at BUILD
   time only (vite.config.js, `apply: 'build'`). The dev server is left alone:
   Vite's HMR client injects inline scripts and a websocket that this policy
   would — correctly — refuse.

   Each source is here because the app needs it, and for no other reason:

     script-src   'self'           the bundled modules; no inline script, no CDN
     style-src    'self'           the bundled CSS (incl. Leaflet's)
                  'unsafe-inline'  the app sets style="" attributes in its
                                   markup and element.style at runtime (charts,
                                   meters, Leaflet), which CSP treats as inline
                  fonts.googleapis.com  the Inter / Newsreader stylesheet
     font-src     fonts.gstatic.com     the font files that stylesheet loads
     img-src      'self' data:     the logo, bundled images, small assets Vite
                                   inlines as data: URIs
                  tile.openstreetmap.org  Bingo Scout's map tiles (competition.js)
     connect-src  'self'
                  faoqpyjhwvwgwvmgqxjr.supabase.co (https + wss)
                                   sign-in and the analytics data (config.js)
                  lkcfbgnuodqzvowschjn.supabase.co
                                   the SAR API Edge Function (Operations,
                                   Ask SAR, Bingo Scout collection)
     base-uri 'self', form-action 'self', object-src 'none'   no plugin content,
                                   no <base> hijack, forms post nowhere else

   frame-ancestors cannot be set from a <meta> tag (browsers ignore it there),
   so clickjacking protection needs a host that can send headers.
   ========================================================================== */

export const CSP_DIRECTIVES = Object.freeze({
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ['https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:', 'https://tile.openstreetmap.org'],
  'connect-src': [
    "'self'",
    'https://faoqpyjhwvwgwvmgqxjr.supabase.co',
    'wss://faoqpyjhwvwgwvmgqxjr.supabase.co',
    'https://lkcfbgnuodqzvowschjn.supabase.co',
  ],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
});

/** The policy as one header value. */
export function cspString(directives = CSP_DIRECTIVES) {
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/** The meta tag, placed straight after <meta charset> so it governs everything after it. */
export function injectCsp(html, policy = cspString()) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  const charset = /<meta charset="[^"]*">/i;
  if (!charset.test(html)) throw new Error('index.html: <meta charset> not found (needed to place the CSP)');
  return html.replace(charset, (m) => `${m}\n${tag}`);
}

/** Vite plugin: build only, so `npm run dev` and HMR are unaffected. */
export function cspPlugin() {
  return {
    name: 'sar-csp',
    apply: 'build',
    transformIndexHtml: { order: 'post', handler: (html) => injectCsp(html) },
  };
}
