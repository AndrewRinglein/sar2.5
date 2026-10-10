# SAR 2.0 — verification log

One entry per unit. Records what was checked, what failed, and what was fixed.
The point is that "done" is evidenced rather than asserted.

---

## U1 — skeleton, Vite, single version source, token layer

**Status:** PASS
**Files:** `package.json`, `vite.config.js`, `index.html`, `src/tokens.css`, `src/styles.css`, `src/main.js`, `scripts/lint-tokens.mjs`

### Acceptance criteria

| Criterion | Result |
|---|---|
| `npm run build` produces a deployable bundle | PASS — 865 B html, 3.7 kB css, 2.1 kB js, sourcemap, logo |
| No colour literal outside `tokens.css` | PASS — enforced by `lint:tokens`, which runs as part of `build` |
| Version appears in exactly one file | PASS — `package.json` only; injected as `__APP_VERSION__` and `%APP_VERSION%` |

### Verification performed

1. **Linter proved, not assumed.** Planted three violations (`#ff0000`, `rgba(...)`, `red`) and confirmed all three are caught with file and line, exit code 1. Confirmed `#app` and `#session-detail` do *not* false-positive — the hex pattern is anchored so invalid hex is ignored.
2. **Rendered and screenshotted** at 1280×800, both with and without a token.
3. **Console clean** — zero errors, zero warnings, both states.
4. **Contrast measured on rendered pixels**, not on arithmetic: h1 14.15:1, body 5.37:1, status chip 7.08:1, version 4.63:1. All pass WCAG AA.
5. **Logo loads** (`naturalWidth > 0`), no horizontal overflow.
6. **Token states behave** — absent shows the error chip and honest guidance; present shows the confirmation chip.

### Defects found and fixed during verification

**1. Linter crashed on any path containing a space.**
`new URL('..', import.meta.url).pathname` percent-encodes the path, so this repository — which lives under `bingo-ecommerce-main (2)` — produced `%20` and every `fs` call failed `ENOENT`. Fixed with `fileURLToPath`. Would have broken for any user with a space in their path.

**2. `.version` class silently did nothing.**
`.boot p` is specificity (0,1,1); `.version` alone is (0,1,0). The paragraph rule won and the class never applied. Caught only by measuring the *rendered* colour and finding `--ink-3` where `--ink-4` was written. Fixed with `p.version, .version`.

**3. A stale build passed a check it should have failed.**
The dev server held `dist/` open, `emptyOutDir` failed, and the verification ran against the previous bundle — reporting a pass for a fix that had not been built. Caught by comparing the rendered colour to the token value rather than trusting the build succeeded. Now built to a clean directory each run.

### Accessibility corrections applied to the palette

The v9 mockup palette carried two failures. Fixed here rather than at U24, because every screen inherits from this file:

- `--ink-4` was `#a3a394` at **2.49:1** — below the 4.5:1 floor, and used for nearly every small label, axis tick and table header. Now `#6d6d61` at **4.63:1**.
- `--pos` and `--neg` were `#186b4c` and `#a53d1a`, relative luminance 0.1123 and 0.1141 — **1.01:1 apart in greyscale**, indistinguishable to a red-green colourblind reader. Now `#0f5c40` and `#b04f1d`, **1.52:1 apart**, separated in lightness as well as hue.

### Notes

- `theme-color` in `index.html` cannot reference a CSS custom property, so it is read from `tokens.css` at build time via a Vite plugin rather than duplicated. Zero colour literals exist outside the token file, including in markup.
- 64 tokens defined; 30 referenced by U1. The remainder are for screens from U8 and are deliberately present so the palette is decided once.
- `prefers-reduced-motion` is honoured at the token level.

---

## U2 — VOID. Built against the wrong database.

**Status:** WITHDRAWN, 12 August 2026.

`sar_read()` and its token table were built in `bstcgfjvtdajgcdpjisg`, which is
an **earlier demo build**, not SAR's database. SAR reads `bms-production`
(`faoqpyjhwvwgwvmgqxjr`), established by tracing the client `sar/app.html`
constructs — see SPEC §3.0.

Nothing here should be built on. The objects are additive and harm nothing, but
they read a flat `sessions` table that has no bearing on SAR. They can be
dropped with the rollback block in `migrations/sar/`.

**U2 is redefined** as the production read layer, with no migration at all:
`bms-production` is read-only to this project. See IMPL §3.

**What the wasted work did establish**, and which carried over: the negative-test
method (tests must return rows, not notices), the privilege-probe method
(`set local role anon`), payload measurement rather than estimation, and the
habit of re-running advisors before and after. Those are now IMPL §7.3.

The original entry follows, retained so the mistake stays visible.

---

### ~~U2 — `sar_read(token)` RPC + token table~~ (superseded)

**Status:** PASS *(against the wrong database)*
**Project:** `bstcgfjvtdajgcdpjisg`
**Migrations:** `sar2_access_tokens`, `sar2_read_rpc` — mirrored in `migrations/sar/001`, `002`
**Objects created:** `sar2_tokens`, `sar2_mint_token()`, `sar2_revoke_token()`, `sar2_check_token()`, `sar_read()`, `sar_read_items()`

Additive only. No existing table, column, policy, function or row was altered.

### Acceptance criteria

| Criterion | Result |
|---|---|
| Returns whole session rows for a valid token | PASS — 771 sessions, 79 columns each, 2 locations |
| Rejects a bad token | PASS — 6 of 6 negative cases (garbage, null, empty, short, revoked, expired) |
| Anon key alone reads no table | PASS — `sar2_tokens` denied to `anon` for both SELECT and DELETE |
| Verified against a known session's real figures | PASS — see below |
| Returns nothing from the §4 exclusion list | PASS — `sessions` holds no wage, PII or credential column; `profiles`, `employees`, `login_tracking`, `card_views`, `push_subscriptions` are not returned |

### Verification performed

1. **Round-tripped a known session.** Redwood City, 11 August 2026, read back through the RPC rather than from the table:

   | Field | Expected | Returned |
   |---|---|---|
   | `flash_payouts` | 11946.00 | 11946.00 |
   | `attendance` | 162 | 162 |
   | `total_sales` | 71356.00 | 71356.00 |

2. **Third jackpot survives the round trip.** Santa Clara, 27 July 2026, `gremlin_if_hit` = 13464.00 — confirming the gremlin columns are carried, not dropped by a stale column list.

3. **Negative tests as data, not as log notices.** The first attempt used `raise notice` inside a `DO` block; notices are not returned through this interface, so the test reported nothing and would have been trivially mistaken for a pass. Rewritten to return rows. All six rejections confirmed, each raising `unauthorised` with SQLSTATE 28000 — the same message for absent, revoked and expired, so probing reveals nothing.

4. **Privilege tests run as the `anon` role** via `set local role anon`:

   | Attempt | Result |
   |---|---|
   | `select * from sar2_tokens` | blocked — permission denied |
   | `delete from sar2_tokens` | blocked — permission denied |
   | `sar2_mint_token(...)` | blocked — permission denied |
   | `sar2_revoke_token(...)` | blocked — permission denied |
   | `sar2_check_token(...)` | blocked — permission denied |
   | `sar_read(<valid token>)` | **succeeds — intended.** This is the product |

5. **Payload measured, not estimated.** 1,725 kB for the full 771-session read. Item detail is excluded by design; including all 48,589 rows would roughly triple it for screens that never open them. `sar_read_items` fetches those per session, capped at 200 sessions per call.

6. **Advisors re-run before and after.** No new ERROR. Three new notices, all intentional and recorded here so they are not later mistaken for regressions:
   - `sar_read` / `sar_read_items` executable by `anon` — that *is* the access model.
   - `sar2_tokens` has RLS with no policy — that is the `short_links` pattern, and the point.
   - `sar2_check_token`, `sar2_mint_token`, `sar2_revoke_token` do **not** appear as anon-executable, confirming the revokes landed.

### Design decisions worth recording

- **Tokens stored as SHA-256 hashes.** Plaintext is returned once at mint and is not recoverable. A database dump yields no working token.
- **`search_path` pinned** on every `SECURITY DEFINER` function. Unpinned, a caller can shadow a table name and have the function read theirs.
- **Coverage is computed server-side** and returned with every read, so a screen can say "not recorded" rather than draw a zero (SPEC §3.6). 47 location-months returned.
- **`meta.money_unit` is `"dollars"`**, stated in the payload. The target stores dollars, not cents; this exists so no client ever divides by 100 again.
- **Item detail split into its own call** rather than making the main read three times heavier.

### Test data cleaned up

All three verification tokens deleted; `sar2_tokens` left with 0 rows.

### Raised, not acted on

Querying the security state before applying anything turned up a live issue in this database that is **out of scope for U2 and not mine to change unilaterally** — see SPEC §19.24. Nothing in this unit depends on its resolution, but the value of the token gate does.

---

## U3 — `ops_read(token, sections, since)` RPC

**Status:** PASS
**Project:** `lkcfbgnuodqzvowschjn`
**Migrations:** `sar2_ops_access_tokens`, `sar2_ops_read_rpc`, `sar2_ops_read_rpc_sizing` — mirrored in `migrations/ops/001`, `002`

Additive only. A **separate** token table from the SAR project's, deliberately: the two databases fail independently, and revoking Ops access must not require revoking SAR access.

### Acceptance criteria

| Criterion | Result |
|---|---|
| Returns Ops data for a valid token | PASS — 3,895 boxes, 517 products, 320 PO lines, 5 vendors, 9,202 plays, 78 staff, 49 time entries, 22 commission payouts, 9 RPA defaults |
| Rejects a bad token | PASS — garbage and revoked both rejected as `unauthorised` |
| Anon reads no table | PASS — `sar2_tokens` and all three admin functions denied to `anon` |
| Box counts match a direct query | PASS |
| PII never returned | PASS — see below |

### Redaction, tested by probing the payload rather than reading the source

| Field | Present in output? |
|---|---|
| `sched_staff.phone` | no |
| `sched_staff.email` | no |
| `vendors.email` | no |
| `settings` (holds secrets in plaintext) | no |
| `events` (audit log) | no |

Staff rows come back as name, roster status, pet and activity only. No wage, base rate or regular rate exists anywhere in this database, so none can leak (SPEC §22.1.8).

### Defect found and fixed during verification

**`p_since` was partly wired.** The first version filtered sessions, plays, assignments and time entries but **not `boxes`** — so passing `p_since` returned a partly-filtered result, which is the worst kind: it looks like the filter worked. Fixed to cover boxes, with a carve-out that always returns boxes in a live state (`in_inventory`, `opened`), because current stock is not a time-scoped question and dropping an old unopened box would understate inventory on hand.

### Sizing — the real finding

Measured, not estimated:

| Section | Payload |
|---|---|
| inventory | 2,344 kB |
| usage | 2,302 kB (913 kB at 90 days) |
| schedule | 351 kB |
| commission | 12 kB |
| **all four** | **5,009 kB** |

Five megabytes in one call is not viable in a browser. Screens must request sections. `meta.bytes` is now returned so a client can see what it pulled instead of guessing. The default remains all four so an exploratory call is never *silently truncated* — a partial answer that looks complete is worse than a large one.

### Two facts about the Ops data worth carrying into the screens

1. **Every box is dated 2026-07-01 or later.** The date window on boxes is currently a no-op because there is nothing older. The inventory system is about six weeks old, so run rates and days-of-cover rest on very little history. U13 must say so on the screen rather than projecting confidently from six weeks.

2. **Box states are `in_inventory` 2,510 · `on_order` 911 · `sold_out` 472 · `opened` 1 · `missing` 1.** The spec's "on hand = in_inventory + opened, opened valued whole" is correct but currently near-moot — exactly one box has ever been in the opened state. Worth confirming that `opened` is genuinely used before building valuation logic that leans on it.

3. **`sched_rpa_defaults` is keyed `(hall_id, dow, part)`** with `hall_id` as a short code (`rwc`), not a UUID — a third hall-key scheme, alongside SAR's `locations.name` and production's UUIDs. `join.js` now has three mappings to hold, not two. Sample: rwc / Tuesday / PM => 459.38.

### Test data cleaned up

All U3 verification tokens deleted; `sar2_tokens` left with 0 rows in the Ops project.


---

## U2 (redefined) — production read layer, `src/lib/api.js`

**Status:** PASS on everything checkable without a signed-in browser.
**Two criteria remain open** and are named below rather than glossed.

**Target:** `faoqpyjhwvwgwvmgqxjr` (`bms-production`) — **read only. No migration, no new object.**
**Files:** `src/lib/config.js`, `src/lib/api.js`, `src/main.js`, `src/styles.css`, `scripts/lint-tokens.mjs`

### The finding that changed the design

The plan was a token in a URL and no login. **It cannot work here.** Every
analytics table is gated by `analytics_has_access(customer_id)`, which resolves
to `is_superadmin()` OR a row in `user_roles` for `auth.uid()`.

Tested with the real publishable key against production, signed out:

| Table | Result signed out |
|---|---|
| `analytics_events` | **200 OK, 0 rows** |
| `analytics_event_data` | **200 OK, 0 rows** |
| `locations`, `flash_runners`, `pos_shifts` | **200 OK, 0 rows** |
| `analytics_config`, `analytics_metric_definitions`, `analytics_product_categories` | rows returned |
| `transactions` | **500 — statement timeout**, even at `limit=1` |

**Not 403. An empty array.** A no-login build would have rendered blank screens
that looked exactly like a database with no data in it, and the cause would
have surfaced around the fourth screen. This is precisely the class of failure
the loop exists to catch, caught at the first unit instead of the eighth.

Resolution, chosen by Angela: **users sign in with Google**, as SAR 1.0 already
does. Zero production changes. `assertReadable()` now converts the silent
zero-row case into a stated reason — `NotSignedIn` or `NoAccess`.

### Defects found and fixed during verification

**1. No button styles existed anywhere in the product.**
U2 introduced the first button ("Sign in with Google") and `styles.css` had no
rule for one, so it rendered as a browser default in a system font. Caught by
inspecting the rendered node rather than reading the markup. Added `button`,
`button.primary`, hover, active, `:disabled`, all on tokens.

**2. The token linter failed on prose.**
It skipped a line only if it *started* with `*`, `//` or `/*`, so a wrapped
line inside a block comment counted as code — and the word "grey", in a
sentence explaining why a button looked grey, failed the build. Rewritten to
track block-comment state across lines. **Re-proved afterwards:** planted
`#ff0000`, `rgba(...)` and `red` are all still caught, while a comment
containing both `red` and `#abcdef` passes.

**3. The access check couldn't tell "no role" from "no data".**
First version probed for one event, so an empty result meant both. Since
`user_roles` carries a "Users can view own roles" policy (`user_id = auth.uid()`),
it now reads the caller's own roles directly and says which is wrong. The event
probe survives as a fallback, because `analytics_has_access()` also passes for
`is_superadmin()`, who may hold no Vanguard row at all.

### Verified

| Check | Result |
|---|---|
| `npm run build` (lint runs as part of it) | PASS — 223 kB js / 4.3 kB css, 60 kB gzipped |
| No colour literal outside `tokens.css` | PASS, and the linter re-proved against planted violations |
| Our source performs **no** writes | PASS — zero `.insert/.update/.delete/.upsert/.rpc` in `src/` |
| Our source handles **no** password | PASS — Google collects the credential on its own domain |
| Tables touched | exactly 8, all reads: the six analytics tables, `locations`, `user_roles` |
| No service key in the bundle | PASS |
| Every list read is paged | PASS — `.range()`, 1,000 per page |
| Anon-readable set matches what production allows | PASS — measured, not assumed |

An earlier assertion run reported two failures for `signInWithPassword` and
`.insert(` in the **bundle**. Both are Supabase library code (4 occurrences in
`GoTrueClient.js`). The check was wrong, not the code; re-run against `src/`
only. Recorded because a bundle-level grep will mislead again.

### Open — not claimed as passing

1. **No screenshot.** The sandbox has no browser: `libXdamage.so.1` is missing
   and there are no apt privileges. Pulling binaries from outside a package
   manager is not something this project does, so step 2 of the loop could not
   run. **The rendered result has not been looked at.** Substituted structural
   checks on the built CSS and bundle, which are weaker and are not a
   replacement.
2. **No real-data read.** Verifying the signed-in path needs a signed-in
   browser, which needs credentials this project does not handle. The
   management connection bypasses RLS, so querying through it proves nothing
   about what the app sees — that is the whole lesson of this unit.

### CLOSED — verified in a real browser, 12 August 2026

Angela ran it locally and signed in. **Both open criteria now pass:**

| Expected | Rendered |
|---|---|
| Connected to production | yes |
| 820 sessions | **820** |
| 2 locations | **2** |
| — | 59 metrics, 5 categories, 24 months |

Screenshot reviewed. Layout correct, logo loads, status chip reads "Live",
version and tenant stamped. No console errors.

### Two defects found only by running it in a browser

**1. Sign-in was impossible without changing production config.**
Google OAuth redirects out and back, and Supabase only returns users to
addresses on its allow-list — which holds `bingobuyin.com` and nothing else.
The first attempt bounced to the live site's "Organization Not Found" page.
That is also why SAR 1.0 works and a local build does not: same database, same
key, different address.

Fixed by adding **email and password sign-in**, which uses no redirect at all
and therefore needs no Supabase setting changed. Google is retained as a
secondary option and the screen now says plainly that it only works from an
approved address, instead of silently sending the user somewhere else.

Along the way the first `<input>` in the product turned out to have no style
rule — same class of gap as the missing button rule earlier in this unit.

**2. First load took ~45 seconds.**

Measured cause, not guessed: 820 sessions carry **36,318 metric rows** (~44
each), and they were fetched in roughly **37 sequential round trips**. The
per-request latency is not ours to fix — the RLS policy on
`analytics_event_data` runs

```sql
EXISTS (SELECT 1 FROM analytics_events e
         WHERE e.id = event_id AND analytics_has_access(e.customer_id))
```

and `analytics_has_access` is a `SECURITY DEFINER` plpgsql function, so it is
evaluated **per row** — 36,318 function calls. Production is read-only to this
project, so that policy cannot be changed.

The lever available is not waiting for each request in turn. Chunks now run
concurrently, capped at 6 in flight — enough to overlap the waiting, not
enough to hammer a database other people are using. **Not yet re-measured in a
browser.**

Angela's call: acceptable for now. Recorded rather than fixed further, with
the real options if it needs to improve: load a recent window on boot and
fetch history on demand, or read `analytics_monthly_summary` for the
aggregate screens.

### A wrong diagnosis, recorded

On seeing "Loading…" with a clean console I said it was the known supabase-js
deadlock — `onAuthStateChange` holds a lock, and calling `getSession()` from
inside the callback waits on that same lock. **It was not that. It was slow,
not stuck**, and finished in ~45s.

The deadlock fix was applied anyway and kept, because the hazard is real and
the code did contain it: `onAuthChange` now defers its callback with
`setTimeout(0)` and passes the session through, so nothing needs to call
`getSession()` in response to a change.

Two lessons, both already in IMPL §7.3 and both re-earned here: a symptom that
matches a known bug is not evidence of that bug, and "no error" often means
"still working", not "broken".

---

## U4 — `src/lib/join.js`, the cross-database join

**Status:** PASS
**Files:** `src/lib/join.js`, `test/join.test.mjs`
**Tests:** 18, all passing. `npm test` now runs as part of `npm run build`, so a
broken join fails the build rather than reaching a screen.

### The problem it solves

Production analytics and the Operational DB are separate Supabase projects, so
Postgres cannot join them. Three key schemes, none of which agree — all
established from live data, none assumed:

| | Hall key | Session key |
|---|---|---|
| production `analytics_events` | `locations.id` UUID | `event_type` = `regular` / `late` |
| ops `sessions`, `sched_*` | `halls.id` code = `rwc` / `sc` | `part` = `''` / `AM` / `PM` |
| production `transactions` | its own hall UUIDs | via `pos_shifts` |

### Establishing the part mapping — measured, not guessed

Counted over 2026-01-01 to 2026-08-10 in both databases:

| Production | n | Ops | n |
|---|---|---|---|
| RWC `regular` | 92 | `rwc` blank | 92 |
| SC `late` | 59 | `sc` `PM` | 59 |
| SC `regular` | 127 | `sc` blank **+** `AM` | 67 + 60 |

So `late` ↔ `PM`, and `regular` ↔ blank **or** `AM`.

Checked whether the blank/`AM` split was a convention that changed on a date —
it is not. Blank, `AM` and `PM` appear together in every month, so a cutoff
would be wrong. Ops has always labelled the same thing two ways.

### End-to-end proof on real data

Generated the join key on both sides in SQL and fingerprinted the sorted list:

```
production   278 keys   md5 b90702ee666902620e208f8055c2e377
ops          278 keys   md5 b90702ee666902620e208f8055c2e377
```

**Identical.** Every session in the overlapping period matches, nothing
unmatched in either direction. This is the strongest check available short of
a screen, and it is what "check the numbers by hand" (IMPL §7.4) means for a
join.

### A trap found and encoded

`sched_rpa_defaults` files Redwood City's targets under `part = 'PM'`, while
ops `sessions` records that same hall's only session with a **blank** part.
Two tables, one database, two conventions. Commission lookups must go through
`rpaPartFor()` rather than the session's own part, or every RWC target silently
misses. There is a test for it.

### Design decisions

- **UUIDs are not hardcoded.** The hall index is built from live rows on both
  sides and matched on name. A baked-in UUID silently matches nothing if a hall
  is recreated, and differs per environment.
- **Unmatched rows are returned, never dropped** — `eventsOnly`, `opsOnly` and
  `opsUnkeyed` are all part of the result. A session in one database and not
  the other is a real condition worth showing.
- **`coverage.opsRange` is reported** so a screen can say "Ops data begins
  January 2026" rather than implying two years of sessions are missing
  something. Production has 24 months; Ops has 8.
- **An unrecognised `part` returns `null`** and is quarantined rather than
  bucketed as `regular`. Silently absorbing an unknown value is how two
  different sessions get merged and one of them understated.
- **Duplicate ops rows on one key are kept and flagged**, not overwritten.

### Not covered

The `transactions` / `pos_shifts` hall UUIDs are a third scheme and are not
wired in yet — that table times out under RLS even at `limit=1`, so it needs
its own approach. Deferred to the screens that need it.

---

## U5 — `src/lib/model.js`, the formula layer

**Status:** PASS
**Files:** `src/lib/model.js`, `test/model.test.mjs`
**Tests:** 35 here, 53 across the project, all passing and wired into `npm run build`.

Every formula in SPEC §16 and every threshold in §17 that the first screens
need. **No screen computes its own metric** — SAR 1.0 has two net-revenue
calculations that disagree (SPEC §19.5) because that rule did not exist.

### Fixture is real, expected values are independent

The session fixture is Redwood City, 6 August 2026, read out of production.
Expected values were computed by hand from those figures **before** running the
code, so a pass means the code agrees with arithmetic rather than with itself.

| | cents | |
|---|---|---|
| revenue | 9,191,500 | $91,915 |
| payouts | 6,736,900 | $67,369 |
| net | 2,454,600 | $24,546 |
| attendance | 191 | |
| RPA | 48,123 | $481.23 |
| margin | 0.2671 | 26.71% |

Category nets — flash 1,010,700 · strip 1,115,200 · paper 341,500 · cherries 0
· other −12,800 — sum exactly to the session net. A test asserts that identity,
because a category double-counted or orphaned shows up there first.

### The test caught my own arithmetic

The margin assertion was written as 26.70%. The true value is 26.71% —
2,454,600 / 9,191,500 = 0.26705108. **The code was right and my expected value
was wrong**, which is the entire reason expected values are derived
independently rather than by running the code and recording what it says. The
comment in the test records it.

### Independent whole-corpus anchor

Computed in SQL, straight from EAV with the same category roles, as a
regression anchor for the screens:

| | |
|---|---|
| sessions | 820 |
| revenue | 9,249,383,289 cents ($92,493,832.89) |
| payouts | 6,772,083,115 cents ($67,720,831.15) |
| net | 2,477,300,174 cents ($24,773,001.74) |
| margin | 0.2678 |

Any screen showing an all-time total must reconcile to these. Note how close
the single-session margin (0.2671) sits to the two-year figure (0.2678) — a
useful smell test.

### Decisions worth recording

- **Cents everywhere, converted once at display.** Nothing in `model.js`
  divides by 100. SAR 1.0 carries defects from code that converted twice and
  from code that never converted at all.
- **Ratios are fractions, never percentages.** `0.2671`, not `26.71`. A
  function returning one next to a function returning the other is how a chart
  ends up 100× out.
- **Missing is null, zero is zero.** `getMetric` returns `null` for an
  unrecorded metric so a screen can say "not recorded" instead of a confident
  $0. This is the same distinction that made the empty-array access failure in
  U2 so dangerous.
- **Payouts are summed as absolute values.** Sign varies with how the
  spreadsheet cell was written; honouring it would let a payout *add* to net
  revenue. Tested with a deliberately negated value.
- **Margin on zero revenue is null**, not 0% — undefined is not the same as
  none.
- **One median definition** for the whole product, averaging the middle pair,
  resolving SPEC §19.7 where the box plot disagrees with the stats table.
- **`z` of a flat series is null**, not 0.
- **Comparison pools require same location, weekday AND session type**, and
  refuse to report below `MIN_POOL = 6` rather than producing a confident
  number from four samples.
- **Direction and tone are separate fields.** `invert` marks metrics where up
  is bad — the v9 mockup showed a worsening payout ratio in green because
  these were one field.
- **Jackpot hits are derived from balance drops**, with the stored flag shown
  beside rather than replaced. SPEC §19.14 found those flags essentially never
  set in the demo database; **whether production's are reliable is not yet
  established**, and that check belongs to U17.

### Confirmed in production while building

`gremlin_hotball` is a real payout metric in the **strip** category — the third
jackpot exists in production EAV exactly as SPEC §3.2a describes. The five
active categories are flash, strip, paper, cherries, other, and `show_rpa` is
false for paper and other while `show_margin` is false for other.

### Not yet built

Deferred until the screens that need them: Welch's t-test and Cohen's d (U18),
the forecast projection (U12), California overtime and break compliance (U15),
flash paper cost (U13). Each lands with its screen so it can be verified
against something rendered.

---

## U7 — the shell: rail, router, inspector

**Status:** PASS on logic and build. **Visual check outstanding — Angela.**
**Files:** `src/lib/router.js`, `src/components/rail.js`, `src/components/inspector.js`, `src/main.js`, `src/styles.css`
**Tests:** 10 router tests; 63 across the project.

### The nav list IS the route table

One definition, in `router.js`. A screen cannot appear in the rail without
existing as a route, or the reverse. SPEC §18 records that SAR 1.0 highlighted
**four** nav items at once because saved views carried the same `data-view`
attribute as real screens, and the highlight query matched all of them — two
sources of truth for "what is selected".

Two defences here:

1. `activeItem()` returns **one id or null**. A set is not representable.
2. `setActive()` returns how many items it lit, and `main.js` warns if that is
   ever anything but 1. The invariant is checked at runtime, not assumed.

Real nav items carry `data-nav`; saved views and other links must not. That is
the discriminator SAR 1.0 lacked.

### Routing decisions

- **Hash-based**, so the app runs from any path — a GitHub Pages subdirectory
  today, `vanguard.bingobuyin.com/sar2/` later — with no server rewrite rules.
- **An unknown screen falls back to the default AND reports it.** A typo in a
  shared link renders the default screen while the inspector says
  *"No screen called 'leaderboardd'"*. Silent redirection would hide a broken
  link someone had sent to a colleague.
- **Router is DOM-free**, so it is tested without a browser. 10 tests including
  the immediate-fire behaviour and a params round trip through slashes and
  question marks.
- **`navigate()` to the current hash dispatches explicitly.** Assigning an
  identical hash fires no event, so a caller would wait forever for a
  re-render that never came.

### Inspector

- **A docked column, never an overlay** — it must not cover the thing it
  explains.
- **Never blank.** With nothing selected it names the screen, its group, and
  the filters in force. A blank third of the window reads as broken, not idle.
- **`\` toggles collapse**, matching the mockups, and is ignored while focus is
  in a text field — otherwise typing a backslash into a search box folds the
  panel.
- Collapsed keeps the bar visible so the control remains reachable.

### Unbuilt screens say so

All 16 routes work today. Fifteen render a placeholder naming the unit that
will build them (`Scheduled for U13`) plus the live data counts. **An unbuilt
screen must not look like a broken one, and must never look like an empty
database** — the same principle that made U2's silent empty array so
dangerous.

### Outstanding

**Not looked at.** No browser in this sandbox (`libXdamage.so.1` missing, no
apt). Build and lint pass, 63 tests pass, but the three-column grid, the rail
contrast on the dark region, and the collapse animation have not been seen
rendered. Needs one screenshot.

---

## U8 — Session detail

**Status:** PASS on the numbers. **Three gaps against SAR 1.0 remain open.**
**Files:** `src/screens/session.js`, `src/lib/fmt.js`, `src/styles.css`
**Tests:** 77 project-wide, including 12 formatting tests.

### The oracle check — every figure matches

Redwood City, Thursday 13 August 2026, SAR 2.0 against SAR 1.0 on the same
session (IMPL §7.4 — SAR 1.0 is the oracle):

| | SAR 1.0 | SAR 2.0 |
|---|---|---|
| Total sales | $80,632 | $80,632 |
| Payouts | $64,116 | $64,116 |
| Net | $16,516 | $16,516 |
| Margin | 20.5% | 20.5% |
| Attendance | 169 | 169 |
| RPA | $477 | $477.11 |

Category shares match to the tenth of a percent on both revenue
(36.5 / 52.3 / 11.0 / 0.1) and payouts (31.3 / 59.4 / 8.9 / 0.3).

This proves the whole chain in one comparison: EAV read, metric-key
resolution, category roles, absolute-value payout handling, the cents
boundary, and formatting.

### The defect the screenshot found, and the numbers behind it

The first build showed **all six session cards with positive deltas**. Six
consecutive above-average nights is not plausible, and that implausibility —
not an error — is what exposed the fault.

Redwood City Thursday gross, measured:

| | sessions | mean gross |
|---|---|---|
| 2024 | 16 | $46,796 |
| 2025 | 50 | $59,401 |
| 2026 | 32 | $82,002 |
| all time | 98 | $64,723 |
| trailing 90 days | 13 | $89,942 |

The business grew ~75% in two years. Against the all-time mean, 13 August's
$80,632 reads **+24.9%**. Against the trailing 90 days it is **−10%**. The
first number is arithmetically correct and tells the reader the opposite of
the truth — it measures growth, not the session.

Fixed: `DEFAULT_WINDOW_DAYS = 90`, anchored on the **target session's** date
rather than on today, so a session from last year is not compared against
nights that had not happened yet. Both behaviours have tests.

**SAR 1.0 independently confirms the fix.** Its compare control reads
*3M · Day Only · Pool: 12*, and its deltas for this session are all negative
(total ↓11.1%, net ↓23.8%, attendance ↓9.3%). A three-month same-weekday pool
is what it has always done. The original all-time baseline did not merely
mislead in principle — it disagreed with the product being replaced.

### Open against SAR 1.0

1. **Pool size 13 vs 12.** Likely three calendar months versus 90 days. Small,
   but it moves every delta (−10.0% vs −11.1%) and should be reconciled
   exactly rather than left near enough.
2. **Jackpot cap: $19,365 in SAR 1.0, $12k here.** Different basis. SAR 1.0's
   figure is labelled "Max", which may not be P90 at all.
3. **Missing from the jackpot panel:** *since hit*, *participation count and
   percentage*, *last payout*. SAR 1.0 shows all three — so hit detection and
   participation **do work** in this database.

Item 3 matters beyond this screen: **SPEC §19.14 warned that jackpot hit flags
were essentially never set. That was observed in the demo database.** SAR 1.0
displaying "Since hit: 12" against production suggests the caution may not
apply here at all. U17 must establish it from production rather than inherit
the warning.

---

## Oracle check — SAR 2.0 against SAR 1.0 v2.5.24, live production, 1 Oct 2026

Both apps open in the same browser against `bms-production`, signed in as the same
user; SAR 1.0 figures read from its own in-page objects (`EventManager`,
`LeaderboardManager`, `calculateMonthMetrics`) and rendered screens, SAR 2.0
figures from its modules run in its own tab. 881 sessions in both.

### Verified identical (before any change)

- **Data load**: 50 hall-months, session count, late count, gross and attendance
  all equal to the cent and the head.
- **Session detail** RWC Wed 30 Sep 2026: gross, net, payouts, margin,
  attendance, all five category lines, both jackpot balances, max payout, last
  payout and participation.
- **Leaderboard** 1Y / both halls / all days: top 20 by RPA, Gross and Attendance
  identical.
- **Reporting** Jul–Sep 2026 × (ALL, SC, RWC): events, gross, attendance, RPA.

### Four differences found, all explained, all fixed

1. **Net understated — `flash_payout_unclaimed` is negative on purpose.**
   `categoryRollup` took `Math.abs()` of every payout key. The only payout
   metric ever stored negative is `flash_payout_unclaimed` (178 sessions,
   $60,389 total): an unclaimed prize is money that came back and reduces
   payouts. SAR 1.0 and the sheet's TOTAL PAYOUTS sum it signed. The abs()
   flipped it into an extra payout, understating net by 2× the amount —
   ~$121k across Aug 2025–Sep 2026 — and reshuffling the Net and Margin
   leaderboards (18 and 17 of 20 rows differed). Fixed: signed sum.
   `model.test.mjs` "ORACLE: a negative payout line is a credit".
2. **Capacity**: a flat `DEFAULT_MAX_ATTENDANCE = 300` instead of
   `locations.settings.max_attendance` (SC 430, RWC 200). Reporting showed
   Santa Clara at 102% of capacity in July. Fixed: `api.getLocations` now
   selects `code, settings`; `maxAttendanceFor()` in model.js; Reporting and
   Venues use it.
3. **Per-head and margin deltas** used the mean of per-session ratios; SAR 1.0
   (and SPEC §4.2) use pool totals. +22.8% vs +23.0% on the oracle session.
   Fixed; Net delta and margin pp added to the KPI strip, as SAR 1.0 shows.
4. **Sessions since hit** counted inclusively (3, 1); SAR 1.0 counts sessions
   strictly between the hit and the viewed session (2, 0). Aligned.

### Verified identical after the changes

- All 29 hall-months Aug 2025–Sep 2026 net totals.
- Session detail RWC 30 Sep: every KPI and delta, including +14.9% net,
  +4.0% / +0.7pp margin, +23.0% per head, since-hit 2 and 0.
- Reporting Jul 2026 combined: all nine figures incl. capacity 13,120 and 75.53%.
- Leaderboard: all five universal aspects, top 20 identical.

### Not compared yet

Compare screen (SAR 1.0's cohort model differs by design), Runners tabs,
Jackpots screen hits list, projections (rebuilt deliberately). Category RPA /
margin leaderboard aspects do not exist in SAR 2.0 yet (U9 gap).

### Also found, not changed

SAR 1.0 is now v2.5.24 with a Compare tab, Runners, Settings and 50
notifications; SPEC §4–§12 documents an older version. The oracle has moved;
re-read it before the next Phase B unit.

---

## U18 Compare and U20 Runners — rebuilt and oracle-checked, 1 Oct 2026

### Compare (U18)
Rebuilt `src/screens/compare.js` to SAR 1.0's two-cohort model (SPEC §7):
shared location; per-cohort date range, weekday set generated from data with
Early/Late splits, session type; mirror-dates (off) and mirror-days (on);
six metrics in SAR 1.0's order; mean / median / Bessel SD / min / max / n /
sum; Welch t + Welch–Satterthwaite df + p; Cohen's d (pooled); accordion
cards that expand together; Delta, Day breakdown, Dot plot and Box & whisker
charts, computed once. Deviations, all recorded in the file header: one
median/quartile definition (fixes §19.7), minimum 3 sessions per side before a
verdict, session-type control, state in the hash, B's default range ends the
day before A's starts, Total Payout delta carries no good/bad tone.

**Oracle**: A = 1 Jul–30 Sep 2026, B = 1 Apr–30 Jun 2026, both halls, all
days, read from `CohortComparison` in SAR 1.0 v2.5.24. Cohorts 116 and 111 in
both. For all six metrics mean, SD, median, min, max, n, t, df and d agree
(to 5 decimals in cents / 2 in margin). One p-value differs: Total Payout,
t = −0.0625, df 218 — SAR 1.0 prints 0.792, SAR 2.0 prints 0.950. scipy gives
0.9503, so **SAR 1.0's hand-rolled p is wrong near t ≈ 0**; SAR 2.0 is
correct. Noted for SAR 1.0's own defect register.

### Runners (U20)
`src/screens/runners.js`: Expected and Over/Short columns on the Breakdown
table from `expected = (out − returned) × price`, `overShort = cash −
expected`, with the price read from `analytics_config.settings.flashTicketPrice`
or `locations[].settings.flashTicketPrice` (dollars, converted once); absent →
null and "ticket price unknown", never 1 (§19.10). SAR 1.0 v2.5.24 never
computes these — the §19.10 defect lives in the retired entry form. Breakdown
hall filter wired to both the session picker and the rows; Floor default on
all tabs; every column sorts with one indicator; back bar via `params.back`;
drill-downs comparison → profile → breakdown. Default window anchored on the
newest runner session rather than the clock (deviation, recorded).

**Oracle**: Comparison tab 1 Jul–30 Sep 2026, all locations, Floor: 111
runners in both; checksum over events, tickets sold, tickets out,
sell-through, revenue and avg per event identical (3,877,299,269). Breakdown
for SC Mon 28 Sep 2026: 9 rows, all eight numeric columns identical
(checksum 168,397,010). `flashTicketPrice` is not set in production, so
Expected/Over-Short show "—" until it is.

Tests: 484 pass (31 new compare, 23 new runners). lint-tokens clean.

---

## Dead screens + U8 Session detail — 1 Oct 2026 (evening)

### Dead screens fixed
- **Reconcile** now loads `analytics_monthly_summary` (`api.getMonthlySummary`).
  Live result: events and attendance match every month; the stored money
  columns stopped tracking the metric store in **April 2026** (Sep 2026 stored
  total sales $154,912 vs $4,918,637 recorded; stored net negative). Upstream
  data issue, not used by any other SAR screen — reported to the owner.
- **Promotions → Session notes** reads `notes` (the field `getEvents` selects).
  Production check: 0 of the 400 most recent sessions carry a note, so the tab
  is empty because the data is.
- **Dashboard** legends on Jackpot Impact and Net by Product toggle series
  (`hide` in the hash). **Data** screen has From/To date inputs.

### U8 Session detail
Pool controls (1M/3M/1Y, Day Only, Hotball band / 10% / 20%), four sub-pages
(Overview, Performance, Jackpots, Summary), bridge by driver or category,
ranked drivers with residual, findings, expected-range band, P&L ladder,
donuts with an empty state, from-date filter and "Previous" picker.

**Oracle: SC Mon 28 Sep 2026, SAR 1.0 v2.5.24, default 3M / Day Only / any.**
- Pool 12 in both. All six KPIs and deltas identical (net −7.4%, RPA +5.2%,
  gross −3.9%, margin −3.7% / −1.1pp, attendance 73%/316 −8.6%).
- Performance: Bingo panel identical to the dollar ($98,267 net bingo sales,
  −$57,698 payout, +$40,569 P/L, $310.18 / $310.97 per player); Pull Tab sales,
  prizes, net, yield and pool averages identical. Credit/cash split shows "—"
  in SAR 2.0 where SAR 1.0 shows $0 / 100% cash: `pulltab_credit_deposit` is
  not recorded for this session (missing ≠ 0, deliberate).
- Jackpots page: cards, table and totals identical.
- Summary: Bingo Register, Event P&L, Combined Over/Short (+$251) and 89.0%
  identical. SAR 1.0 prints "$40,569 **loss**" for a profitable bingo night
  (defect 19.6, live); SAR 2.0 prints "profit".
- **Explained difference — per-category deltas.** Flash net −14.1% (SAR 2.0)
  vs −12.4% (SAR 1.0); payouts −1.3% vs −2.0%. Reproduced exactly in SAR
  1.0's page: its category boxes average the pool with `|payout|`, while its
  own headline net sums payouts signed. SAR 2.0 uses the signed rule
  everywhere (the fix verified earlier today), so it is the consistent one.
- **Reconciliation note on Performance** reads +$27,087 for this session
  (bingo P&L + pull-tab net = $86,145 vs category net $59,058). Both apps show
  the same two figures; SAR 1.0 never says they disagree. The gap is
  jackpot / special-game payouts the canonical keys don't carry.
- Fixed during the check: a cash-variance finding was badged BELOW; now
  OVER / SHORT.

Tests: 538 pass. lint-tokens clean.

## 2026-10-01 — Staff Overview (U15) and Commission target, checked against Operations

**Oracle: independent read-only SQL on the Operations database
(`lkcfbgnuodqzvowschjn`), written without reference to `staff-model.js`.
Period 16–31 Aug 2026, deployed + planned sessions only.**

| Figure | SAR 2.0 screen | Independent SQL |
|---|---|---|
| Scheduled hours | 1,519.0 | 1,519.00 |
| OT at 1.5× | 155.25 | 155.25 |
| OT at 2× | 26.25 | 26.25 |
| OT by cause: daily / weekly | 166.25 / 15.25 | 166.25 / 15.25 |
| Seventh-day OT | 0 | 0 (nobody worked > 6 days in a Monday week) |
| Coverage | 189 / 194 (97%) | 189 / 194, 11 sessions, 5 short |
| Draft shifts excluded | 52 | 52 |
| Shifts missing times (counted) | 0 | 0 |

- **Explained difference that was checked and is correct:** summing each
  session separately gives 1,563.25 h. The 44.25 h gap is 18 person-days on
  16, 22 and 23 Aug where the same person is on the AM and PM session at the
  same hall and the two shifts overlap by about two hours (e.g. 10:45–18:45
  then 16:30–00:00). SAR 2.0 counts the overlap once — they can't work it
  twice — and that is also what pushes those days past 12 h into 2× OT.
- Coverage uses the hall's standing needs (`sched_hall_role_needs`) because
  `sched_session_roles` has no rows for this period; trainees don't count.
- **Commission, 27 Aug Redwood City PM (draft):** no session target; hall
  default for Thursday PM is $478.95. (150,000 − 478.95 × 100) × 0.15 =
  $15,315.75, screen shows $15,316. Stored pool $22,500 = 150,000 × 0.15
  (rate × gross, no target). Attendance 100 and sales exactly $150,000 look
  like test entries — flagged, not filtered.
- Actual hours: 51 time entries, none with hours > 0. Screen shows "not yet
  recorded"; correct.

Tests: 570 pass. lint-tokens clean. vite build OK.

## 2026-10-01 — Forecast (U12), checked against bms-production

**Oracle: independent read-only SQL on bms-production (`faoqpyjhwvwgwvmgqxjr`,
customer `vanguard`), plus arithmetic by hand. Gross = sum of active
`role='revenue'` category metrics; payout = same for `role='payout'`, signed;
net = gross − payout. "Today" = Thu 1 Oct 2026 (Pacific), data through 30 Sep.**

- **Window decision, from a 12-month backtest (Oct 2025–Sep 2026, both halls,
  each month projected as of its 1st with no data from the month itself):**
  trailing 365 days — mean miss 10.6%, low in all 12 months; 182 days 4.2%;
  91 days 2.6% (bias −0.5%); 56 days 3.3%. Forecast uses 91 days
  (`FORECAST_WINDOW_DAYS`). Managers keeps 365 (within-slot comparison).
- **Slot baselines, 3 Jul – 1 Oct 2026:** all nine match SQL to the cent
  (e.g. SC Mon regular n 13, $203,469.54 gross, $63,400.77 net; RWC Thu
  regular n 11, $87,235.45 / $19,115.71).
- **Rest of October, by hand:** Oct 2026 has 5 Thu/Fri/Sat and 4
  Sun/Mon/Tue/Wed → 40 sessions; Σ count × slot mean = $5,475,673.38.
  Screen: $5,475,673, 40 sessions. Santa Clara alone $4,404,166.89 vs
  $4,404,167.
- **Backtest actuals:** Sep 2026 SC $3,908,486 + RWC $1,010,151 =
  $4,918,637 (screen $4,918,637); Dec 2025 $4,431,378 (screen same).
- **Holiday closures, learned from the data:** Redwood City has not held a
  session on Thanksgiving, Christmas Eve, Christmas Day, New Year's Eve, New
  Year's Day or Easter whenever it was expected; Santa Clara closed Easter
  Sunday 2026 and dropped only its late session on Mother's Day and Father's
  Day 2026. Rule is per session (hall fallback), learned only from data before
  the month. Excluded for 2026: RWC 26 Nov, 24 Dec, 31 Dec. Santa Clara
  Christmas Day (Fri 25 Dec) is projected and marked "no history".
- **12-month backtest with the rule:** both halls mean miss 2.5% gross / 7.5%
  net, bias −1.4%, 11 of 12 inside the stated range (Feb 2026 −9.6% is the
  miss). Santa Clara 3.3%; Redwood City 9.4% (its Dec 2025 +24.8% and Jan 2026
  +12.3% are Christmas/New Year's Day with no prior evidence).
- **Rest of 2026:** 115 sessions, gross $15,747,173 ($14.9M–$16.6M), net
  $4,147,313. Expenses on screen are Unit Economics assumptions, marked.
- Fixed during the check: KPI tiles ran label and value together; slot table
  header said "Sessions (year)" for a 13-week count.

Tests: 599 pass. lint-tokens clean. vite build OK.

## 2026-10-01 — Data validator crew (recon_sessions), owner Christmas closure, Ops date fix

**Source:** the owner confirmed staff assignments are now saved in the data
validator, per session, in the Operational DB (`public.recon_sessions`,
`state->'staff'` = [{name, role, slot}], `state->'status'->>'staff'` =
approved | progress). The server reads a projected shape only (id, hall,
date, time, slot, status, crew name/role/slot, commission rate/target) —
never cash, paymaster or runner state. Read-only.

**Independent SQL vs SAR 2.0, Worked tab, 16–30 Sep 2026** (one row per
hall/date/time, approved preferred, blank names dropped):
19 sessions (12 SC / 7 RWC), 3 not yet approved, 302 places, 70 people;
by role MOD 20, Paymaster 18, Flash Manager 18, Opener/Swing 20,
Callers/Strip 81, Flash Runners 145 — identical on screen.

- Validator: 62 rows 12 Aug – 1 Oct; 58 join to analytics sessions (2 count
  clashes SC 15/23 Aug; RWC 10 Sep and 1 Oct have no analytics session yet).
- Managers crew source over 31 Jul – 30 Sep: validator 55 sessions, scheduler
  16, none 8. Rankable people: MOD 1 → 3, Paymaster 0 → 2, Flash Manager
  0 → 2, so all three roles now rank.
- Names: 97 distinct after normalising, 26 match a scheduler person exactly
  and uniquely; the rest are kept as their own people, never fuzzy-merged.
  20 possible duplicate pairs are listed for the owner to review.
- Owner closure: Santa Clara closed Christmas Day (confirmed 1 Oct 2026).
  Rest-of-2026 gross $15,747,173 → $15,552,259, a drop of exactly the SC
  Friday regular baseline ($194,914).
- **Bug fixed:** node-postgres returned Ops DATE columns as JS Dates, which
  reach the browser as ISO timestamps and break every join on session_date
  on a live laptop. DATE now parsed as plain text (server/database.mjs).
  Earlier live checks used SQL snapshots, so they could not see this.
- Worked tab defaults to the latest pay period with an approved crew list.

Tests: 631 pass. lint-tokens clean. vite build OK.

## 2026-10-02 — Owner name rule (merge by first name, except Flash Runners)

Owner instruction, 2 Oct 2026: outside Flash Runners, a first name is one
person unless the surname initials differ. `OWNER_NAME_RULE` in config, with
`OWNER_NAME_KEEP_APART` / `OWNER_NAME_ALIASES` to override. Live: 22 people
merged from 55 spellings, none ambiguous; Flash Runners hints still listed,
not merged. Managers rankable: MOD 3 → 5, Paymaster 2 → 3, Flash Manager
2 → 3. Merged counts equal the sums of the split rows seen on the live
screen before the change (e.g. MOD 13 + 7 = 20; Paymaster 15 + 5 = 20,
11 + 3 = 14). Also checked live in the owner's browser on 2 Oct: Sources,
Staff, Commission, Forecast and Managers render with no console errors and
match the independent SQL figures logged on 1 Oct.

Tests: 641 pass. lint-tokens clean. vite build OK.

## 2026-10-02 — Managers crew coverage drilldown (local)

Added Managers > Coverage. The default view lists sessions needing review:
scheduler fallback, missing crew, unapproved Validator staff lists, or missing
MOD / Paymaster / Flash Manager roles. All sessions uses the same crew date span
as the existing headline counts. Date buttons open Session Detail.

A separate table identifies Validator records without analytics results, unknown
halls, and differing session counts. Count conflicts are listed once per day;
the matching rule and source data are unchanged. Approved staff on an open
reconciliation stays covered; the session's open/closed label remains separate.

Regression checks cover missing roles, period boundaries, session navigation,
filter navigation, approval versus closure, conflict deduplication, unavailable
Validator data, and safe rendering of unknown hall names. Build and 681 tests
pass. Local server restarted on 127.0.0.1:5173. Browser verification was blocked
by the browser URL policy when binding the existing unreachable-page tab;
this new view has not yet been verified against live data in the browser.

## 2026-10-02 — Side by side with SAR 1.0 (v2.5.24), live data

Both apps open on the same data in the owner's browser, same filters.

| Screen | Check | SAR 1.0 | SAR 2.0 | Verdict |
|---|---|---|---|---|
| Session | RWC Thu 1 Oct: net, gross, payouts, margin, attendance, RPA | $15,898 / $86,384 / $70,486 / 18.4% / 79%·158 / $547 | identical | match |
| Session | changes vs 3M Thursday pool (11 sessions) | net −16.8%, RPA +13.1%, margin −3.5pp | identical | match |
| Session | Flash payouts vs pool | +11.6% | +12.6% | SAR 1.0's category cards take the pool's `flash_payout_unclaimed` as positive while its own session total keeps it negative; SAR 2.0 is signed throughout. Not changed. |
| Session | Hotball / Mega: balance, max, since hit, last, participation | $3,140 · $19,365 · 3 · $2,225 · 147 (93%); $2,740 · $64,030 · 1 · $21,020 · 145 (92%) | identical | match |
| Reporting | SC, every month Sep 2024 – Sep 2026: sessions, sales, payouts, net, mix, margin, RPA, profit/session, attendance and every change | — | identical | match |
| Reporting | October projection, SC | 0 + 27 · $4,370,385 (+11.8%) · net $1,221,113 | 0 + 27 · $4,386,155 (+12.2%) · net $1,223,608 | **added**; values within 0.4% (SAR 1.0 uses a 90-day average per slot, SAR 2.0 the Forecast's 13-week slot model) |
| Dashboard | 12 months combined, gross and net labels | $4.7M … $4.9M, $86k / $1.2M … $1.2M | identical | match |
| Dashboard | October projected point | $5.4M / $1.4M | $5.5M / $1.4M | **added** |
| Leaderboard | RWC, all time, Thursdays, by RPA | pool 104; 15 Jan $624 · 27 Aug $590 · 9 Oct $589 · 8 Jan $567 | identical | **Days filter added** to match; rows now show the year |
| Compare | SC, cohort A 3 Jul–3 Oct | 77 sessions; $163,655.54, $46,103.50, $117,552.04, 26.9%, $537.65, 303 | identical | match |
| Compare | cohort B | 74 sessions | 73 | deliberate: SAR 1.0 puts the boundary day (3 Jul) in both cohorts |
| Runners | 5 Jul–3 Oct, all locations, floor | Malaya 28 · 257,524 · $213,017 … Emma 16 · $84,368 | identical with the same dates | match; SAR 2.0's default window ends at the latest session (1 Oct), SAR 1.0's at today (3 Oct) — deliberate, documented in runners.js |
| Notifications | read state | latest 50, all unread | latest 500 (399 exist), all unread | match. Before today's fix SAR 2.0 showed none at all. |

Numbers fixed today and why: see the commit "Fix wrong numbers" (breaks per
workday, session prediction range: 81% → 93% measured coverage on 762 live
nights, per-session staff hours, org-wide jackpot hits, YoY partial month,
Pacific dates).

## 2026-10-09 — Hotball pots, from the developer handoff

New screen **Hotball pots** (Sessions → after Jackpots): the three pots night by
night (opening, added, Paid box, pot drop, pot after, next opening), every
night a pot dropped with its basis, and each pot's current size. Read-only:
cash movements are recorded in Session Reconciliation's hotball page and are
applied here, never written. Drops found from a lower next opening are counted
automatically and labelled as such (owner's choice, 9 Oct).

Data: `recon_sessions.hotball_ledger` and the matching `state.pm.hot` element,
each field pulled by name as text (`HOTBALL_SQL`, server/ops-read.mjs); the
validator read is unchanged and still never selects the ledger. Movements:
`hotball_cash_movements`, unvoided, without `created_by` / `voided_by`.

| Check | Expected | SAR 2.0 | Verdict |
|---|---|---|---|
| Every pot row (144) vs the handoff's reference SQL, run in the same query as the read | drop, pot after and note per row | identical, all 144 | match |
| Cut off at 8 Oct (the handoff's snapshot: 71 sessions) — pot now | Mega $23,560 · RWC $5,550 · SC $1,345 | identical | match |
| — last drop, sessions since, added since | Mega $21,020 Sep 29, 11, $23,560 · RWC $2,225 Sep 23, 7, $5,550 · SC $10,770 Oct 4, 1, $1,345 | identical | match |
| — pot drops | 16 nights, $289,210, each basis as listed | identical, same order and basis | match |
| Live (72 sessions, SC Fri 9 Oct still open) | — | Mega $9,670 · RWC $5,550 · SC $2,505; 17 drops, $305,370 | new: SC 9 Oct opened the Mega at $7,400 after RWC 8 Oct closed at $23,560, so a $16,160 pot drop is found on RWC Thu 8 Oct |
| Movements | a recorded drop replaces the derived one; a cash in balances a raise; counts compare with pot after | unit-tested on the live fixture | match |
| Screen | 1400 px and 390 px, rendered with the live fixture in headless Chromium | no page overflow; ledger scrolls inside its panel | checked by screenshot |

Not yet seen signed in on the live site: the Edge Function must be redeployed
for the read to reach the browser. On the laptop, `sar_reader` needs the two
new grants in `scripts/create-sar-reader.sql` (`hotball_ledger` on
`recon_sessions`, and `hotball_cash_movements`); until then the screen says the
pots are not connected and every other screen is unaffected.
