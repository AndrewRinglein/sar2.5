#!/usr/bin/env node
/* ============================================================================
   lint-tokens — fails the build if a colour literal appears outside tokens.css

   WHY THIS EXISTS
   SAR 1.0 has no token layer. Every colour is a repeated literal across 20,416
   lines, and there are four different greens that all mean "good" (SPEC §2.4).
   Changing "the green" means finding four values in an unknown number of
   places, and missing one is invisible until someone notices two shades of
   success on the same screen.

   This runs as part of `npm run build`, so the rule cannot quietly rot.

   ONE LEGITIMATE EXCEPTION
   Product category colours come from the database per tenant
   (`analytics_product_categories.color_*`). Those arrive as runtime values and
   are applied inline from data — they are content, not design. This linter only
   catches *literals*, so data-driven colour passes automatically and correctly.
   ========================================================================== */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* fileURLToPath, not `.pathname` — a URL percent-encodes characters that are
   legal in a path, so a directory containing a space arrives as `%20` and every
   fs call fails with ENOENT. This repository lives under
   "bingo-ecommerce-main (2)", which has one. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/** The only file permitted to hold colour literals. */
const ALLOWED = ['src' + sep + 'tokens.css'];

/** #rgb #rgba #rrggbb #rrggbbaa — anchored so `#app` and `#session-detail`
 *  (invalid hex) never match, and `#abcdefff` is not truncated to a false 6. */
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FUNC = /\b(?:rgba?|hsla?|color|oklch|lab|lch)\s*\(/g;

/** Named CSS colours that are easy to reach for and just as unmanageable. */
const NAMED = /(?<![\w-])(?:red|green|blue|orange|purple|pink|yellow|cyan|magenta|teal|olive|navy|maroon|lime|aqua|fuchsia|silver|gray|grey|black|white)(?![\w-])\s*(?=[;,)\]}"']|$)/gm;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(css|js|mjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Blank out comments while preserving line numbering and length.
 *
 * The first version skipped a line only if it *started* with `*`, `//` or
 * `/*`. Any wrapped line inside a block comment was therefore treated as
 * code, and the word "grey" in a sentence explaining why a button looked grey
 * failed the build. Prose about colour is not a colour.
 *
 * Tracks block-comment state across lines rather than guessing per line.
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let res = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { res += ' '.repeat(line.length - i); break; }
        res += ' '.repeat(end + 2 - i); i = end + 2; inBlock = false;
      } else {
        const b = line.indexOf('/*', i);
        const l = line.indexOf('//', i);
        // Whichever comment opener comes first, if either does.
        if (b !== -1 && (l === -1 || b < l)) {
          res += line.slice(i, b); i = b; inBlock = true;
        } else if (l !== -1) {
          res += line.slice(i, l) + ' '.repeat(line.length - l); break;
        } else { res += line.slice(i); break; }
      }
    }
    out.push(res);
  }
  return out;
}

const violations = [];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOWED.includes(rel)) continue;

  const raw = readFileSync(file, 'utf8').split('\n');
  const lines = stripComments(readFileSync(file, 'utf8'));
  lines.forEach((line, i) => {
    const t = raw[i].trim();

    for (const [re, label] of [[HEX, 'hex'], [FUNC, 'colour function'], [NAMED, 'named colour']]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        violations.push({ file: rel, line: i + 1, text: m[0], label, src: t.slice(0, 90) });
      }
    }
  });
}

if (violations.length === 0) {
  console.log('✓ lint-tokens: no colour literals outside tokens.css');
  process.exit(0);
}

console.error(`\n✗ lint-tokens: ${violations.length} colour literal(s) outside tokens.css\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.label} "${v.text}"`);
  console.error(`    ${v.src}`);
}
console.error(`
  Every colour belongs in src/tokens.css as a custom property.
  If this is a per-tenant category colour from the database, it should be a
  runtime value applied inline — not a literal.
`);
process.exit(1);
