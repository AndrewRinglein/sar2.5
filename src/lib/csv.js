/* ============================================================================
   SAR 2.0 — CSV

   Small, and every line of it exists because SAR 1.0's export gets one of
   these wrong. DESIGN §8.1:

     · it wraps every cell in quotes and never escapes an embedded quote, so a
       single `"` in a metric name corrupts the file from that row onward
     · it writes bare \n, which Excel on Windows does not treat as a row break
     · it has no BOM, so an accented name arrives as mojibake
     · it always exports the Daily view whatever is on screen, because it looks
       up an element id that does not exist

   Money leaving the system is in DOLLARS, not cents. Everywhere else in SAR
   2.0 money is integer cents; a CSV is the boundary where that contract ends,
   and the column header says so.
   ========================================================================== */

/** Excel wants CRLF. */
export const EOL = '\r\n';
/** Without this, Excel mis-decodes anything non-ASCII on a double-click. */
export const BOM = '﻿';

/**
 * Quote a single field, and only when it needs it.
 *
 * A quote inside a quoted field is escaped by doubling it — RFC 4180. SAR 1.0
 * omits this entirely.
 */
export function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s === '') return '';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells) => cells.map(csvField).join(',');

export function toCsv(rows, { bom = true } = {}) {
  return (bom ? BOM : '') + rows.map(csvRow).join(EOL) + EOL;
}

/**
 * Cents to a plain decimal for export. No symbol, no separators.
 *
 * A spreadsheet wants a number it can sum, not `$1,235`. Two decimals because
 * the underlying value has them; rounding here would silently lose money.
 */
export function csvMoney(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2);
}

/** A ratio as a plain percentage number, e.g. 26.71 — no `%`. */
export function csvPct(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '';
  return (fraction * 100).toFixed(2);
}

/**
 * Trigger a download.
 *
 * Revokes the object URL — SAR 1.0 does not, so every export leaks a blob for
 * the life of the tab. Returns the filename so tests can assert on it without
 * a DOM.
 */
export function download(filename, text, { doc = globalThis.document } = {}) {
  if (!doc || typeof Blob === 'undefined') return filename;
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body?.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}

/** `vanguard_daily_santa-clara_2026-08-17.csv` — names the view ACTUALLY exported. */
export function csvFilename({ view, hall = 'all', date = new Date() }) {
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `vanguard_${slug(view)}_${slug(hall)}_${date.toISOString().slice(0, 10)}.csv`;
}

/**
 * Parse CSV back, for the round-trip test.
 *
 * Deliberately a real parser, handling doubled quotes and embedded newlines —
 * a test that used `split(',')` would pass on exactly the input the writer
 * gets wrong.
 */
export function parseCsv(text) {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = []; let field = ''; let quoted = false; let i = 0;

  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' && src[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 2; continue;
    }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
