/* ============================================================================
   SAR 2.0 — sound

   SAR 1.0 plays a short tone when a reporting box expands (`AppSounds.play`).
   It is a small thing that makes the screen feel responsive, and it is carried
   over.

   Synthesised with WebAudio rather than shipped as audio files: three short
   tones cost nothing to download and never 404.

   THREE RULES, all deliberate:

     · OFF BY DEFAULT is wrong here — SAR 1.0 has it on, and this is a rebuild.
       But it is muted the moment the user asks, and the choice persists.
     · `prefers-reduced-motion` implies a preference for a calmer interface;
       sound respects it and stays silent.
     · The AudioContext is created lazily on the first real gesture. Browsers
       block it otherwise, and constructing one at load produces a console
       warning on every visit.
   ========================================================================== */

const STORAGE_KEY = 'sar2.sound';

let ctx = null;
let enabled = null;

function prefersCalm() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function isEnabled() {
  if (enabled !== null) return enabled;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) enabled = saved === 'on';
    else enabled = !prefersCalm();
  } catch {
    enabled = !prefersCalm();
  }
  return enabled;
}

export function setEnabled(on) {
  enabled = Boolean(on);
  try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
  return enabled;
}

/** Short, quiet, and shaped so it never clicks at the edges. */
const TONES = {
  expand:   { freq: 660, to: 880, ms: 90,  gain: 0.045 },
  collapse: { freq: 880, to: 620, ms: 80,  gain: 0.035 },
  scroll:   { freq: 520, to: 520, ms: 45,  gain: 0.025 },
  select:   { freq: 740, to: 740, ms: 55,  gain: 0.03 },
};

export function play(name = 'select') {
  if (!isEnabled()) return;
  const t = TONES[name] ?? TONES.select;

  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;                       // no WebAudio: silence, not an error
    ctx = ctx ?? new AC();
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(t.freq, now);
    if (t.to !== t.freq) osc.frequency.exponentialRampToValueAtTime(t.to, now + t.ms / 1000);

    // Ramped in and out — a square edge on the envelope is what makes a click.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(t.gain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t.ms / 1000);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + t.ms / 1000 + 0.02);
  } catch {
    // Audio is a nicety. It must never break a screen.
  }
}
