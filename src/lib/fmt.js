/* ============================================================================
   SAR 2.0 — formatting

   THE CENTS BOUNDARY LIVES HERE, AND NOWHERE ELSE.

   `model.js` works in integer cents from end to end and never divides by 100.
   Every conversion to dollars happens in this file, at the moment a number
   becomes text. SAR 1.0 carries defects from code that converted twice and
   from code that never converted at all; keeping the boundary in one place is
   the fix.

   Likewise ratios: `model.js` returns fractions (0.2671), and `pct()` is the
   only thing that turns one into "26.7%".

   NULL IS NOT ZERO. Every formatter returns an em dash for null, so an
   unrecorded metric reads as "not recorded" rather than as a confident $0.
   ========================================================================== */

const DASH = '—';

const money0 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const money2 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** Cents -> "$92,494". The whole-dollar form, for headline figures. */
export function usd(cents, { decimals = 0 } = {}) {
  if (!isNum(cents)) return DASH;
  const dollars = Number(cents) / 100;
  return (decimals ? money2 : money0).format(dollars);
}

/** Cents -> "$481.23". For per-head figures, where cents genuinely matter. */
export const usd2 = (cents) => usd(cents, { decimals: 2 });

/**
 * Cents -> "$92.5k" / "$1.2M". For axis ticks and dense tables only.
 *
 * Never for a figure someone might quote. An abbreviated number in a report is
 * how "$92.5k" gets repeated as "$92,500" when it was $92,493.83.
 */
export function usdShort(cents) {
  if (!isNum(cents)) return DASH;
  const d = Number(cents) / 100;
  const a = Math.abs(d);
  const sign = d < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a)}`;
}

/** Fraction -> "26.7%". Takes 0.2671, never 26.71. */
export function pct(fraction, { decimals = 1 } = {}) {
  if (!isNum(fraction)) return DASH;
  return `${(Number(fraction) * 100).toFixed(decimals)}%`;
}

/** Fraction -> "+4.2%" with an explicit sign, for changes. */
export function pctDelta(fraction, { decimals = 1 } = {}) {
  if (!isNum(fraction)) return DASH;
  const v = Number(fraction) * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(decimals)}%`;
}

export function int(n) {
  if (!isNum(n)) return DASH;
  return new Intl.NumberFormat('en-US').format(Math.round(Number(n)));
}

/**
 * Arrow glyph for a direction.
 *
 * Colour never carries meaning alone in this product — a delta always has a
 * glyph and a sign as well, so it survives colourblindness and monochrome
 * printing.
 */
export const arrow = (dir) => (dir > 0 ? '▲' : dir < 0 ? '▼' : '·');

/** "23rd", "1st". SPEC §19 — the v1 mockup rendered "23th". */
export function ordinal(n) {
  if (!isNum(n)) return DASH;
  const i = Math.round(Number(n));
  const rem100 = i % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${i}th`;
  return `${i}${['th', 'st', 'nd', 'rd'][i % 10] ?? 'th'}`;
}

/**
 * Dates.
 *
 * Event dates are date-only strings. They are parsed as UTC deliberately: a
 * local-time parse shifts "2026-08-06" to the 5th for anyone west of Greenwich,
 * which silently moves a session to the wrong day — and therefore into the
 * wrong weekday comparison pool.
 */
function asDate(d) {
  if (d instanceof Date) return d;
  return new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 6 Aug 2026" */
export function dateLong(d) {
  if (!d) return DASH;
  const x = asDate(d);
  return `${DOW[x.getUTCDay()].slice(0, 3)} ${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

/** "6 Aug" — for dense card headers. */
export function dateShort(d) {
  if (!d) return DASH;
  const x = asDate(d);
  return `${x.getUTCDate()} ${MON[x.getUTCMonth()]}`;
}

export function weekday(d) {
  if (!d) return DASH;
  return DOW[asDate(d).getUTCDay()];
}

/** "Aug 2026" */
export function monthLabel(ym) {
  if (!ym) return DASH;
  const [y, m] = String(ym).split('-');
  return `${MON[Number(m) - 1]} ${y}`;
}

/** `regular` -> "Regular". Session types are lowercase in the database. */
export const sessionType = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : DASH);

/**
 * Escape text for interpolation into innerHTML.
 *
 * Every screen builds rows from template literals, which is safe for numbers
 * and for admin-managed names — but session notes and promotion notes are FREE
 * TEXT typed by a manager. Without this, a note containing
 * `<img src=x onerror=...>` executes for everyone who opens the Leaderboard.
 *
 * Applied at the point of interpolation, not at read: escaping on the way in
 * means the same string is stored escaped and double-escapes the next time
 * somebody displays it properly.
 */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { DASH };
