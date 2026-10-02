# SAR 2.0 — Manager Attribution and Day-Normalized Scoring

Design document, written 16 Aug 2026, against production.

Two deliverables:

1. **Attribution.** Every session shows who ran it — MOD, Paymaster, Flash Manager.
2. **A Managers dashboard.** Performance by person, normalized so that a Friday is
   judged against Fridays and a Monday against Mondays.

Everything below was measured against the real databases before it was designed.
Section 9 lists what is not yet possible and why.

---

## 1. The data lives in two separate Supabase projects

| | project | what it holds |
|---|---|---|
| SAR analytics | `faoqpyjhwvwgwvmgqxjr` | `analytics_events`, the EAV metric store |
| Operational | `lkcfbgnuodqzvowschjn` | `sched_sessions`, `sched_assignments`, `sched_staff`, `sched_roles` |

**These are different Postgres instances.** There is no foreign key between them
and no SQL join is possible. The join happens in the browser, in `managers.js`,
over two independently fetched result sets.

This is the single most important structural fact in this document. It means:

- The join key must be derivable from columns that exist on both sides.
- The join must be **verified at runtime**, not assumed, because nothing in
  either database enforces it.
- Either side may be missing for a given day, and the screen must say which.

### 1.1 Role names

Read out of `sched_roles`, not invented:

```
MOD · Opener/Swing Shift · Paymaster · Flash Manager · Callers/Strip · Flash Runners
```

The three this document is about are `MOD`, `Paymaster`, `Flash Manager`.
`Flash Runners` is already covered by the Runners screen (SPEC §9) and is read
from `flash_runners` in the analytics database, which is a different table with a
different lineage. **The two must not be conflated.**

---

## 2. The join rule — ordinal position within the day

The two sides describe the same session with different vocabularies:

| | Ops | SAR |
|---|---|---|
| hall | `hall_id` — text slug, `sc` / `rwc` | `location_id` — uuid |
| which session | `part` — `AM` / `PM` | `event_type` — `regular` / `late` |

The obvious mapping — `AM→regular`, `PM→late` — **is wrong**, and the data says so.

Observed 31 Jul – 16 Aug 2026:

| date | day | Ops parts | SAR event types |
|---|---|---|---|
| 2026-08-03 | Mon | `PM` | `regular` |
| 2026-08-07 | Fri | `PM` | `regular` |
| 2026-08-08 | Sat | `AM`, `PM` | `regular`, `late` |
| 2026-08-11 | Tue | `PM` | `regular` |

On a **weekday** the hall runs one session. Ops calls it `PM`; SAR calls it
`regular`. A static `PM→late` map matches nothing on those days — it would have
silently dropped **eight of the sixteen** attributable Santa Clara sessions and
left the rest looking like a partial-coverage problem rather than a bug.

On a **weekend** the hall runs two, and `AM→regular`, `PM→late` is correct.

### 2.1 The rule

> Within each `(date, hall)`, sort both sides by their natural session order and
> match the *n*th to the *n*th.
>
> Ops order: `AM` before `PM`.
> SAR order: `regular` before `late`.

One session each side → position 0 matches position 0, whatever it is called.
Two each side → 0↔0 and 1↔1. Both cases fall out of the same rule.

### 2.2 The guard

Ordinal matching is only valid when **both sides have the same number of sessions
that day**. When the counts differ, the correspondence is genuinely unknown and
guessing would attribute a session's revenue to the wrong person.

> When the counts differ, **no assignment is made for that day**, and the day is
> recorded in `joinReport.mismatched` with both counts.

The screen surfaces the count of mismatched days. Silent partial joins are how a
dashboard ends up quietly libelling somebody.

### 2.3 The hall map

There is no shared identifier, so the slug↔uuid map is resolved by name from
`data.locations` at load:

```
sc  → the location whose name matches /santa\s*clara/i
rwc → the location whose name matches /redwood/i
```

If either fails to resolve, the manager layer reports itself unavailable rather
than falling back to a hardcoded uuid. A hardcoded uuid is correct until the day
somebody adds a third hall, and then it is wrong in a way nobody notices.

---

## 3. Why raw comparison is meaningless — measured, not asserted

Mean gross per session, indexed against the all-hall mean of the same period,
over two consecutive twelve-month eras (~50 sessions per slot per era):

| hall | day | session | index era A | index era B | drift |
|---|---|---|---|---|---|
| SC | Mon | regular | 1.608 | 1.551 | −0.057 |
| SC | Fri | regular | 1.357 | 1.426 | +0.069 |
| SC | Sun | regular | 1.320 | 1.235 | −0.085 |
| SC | Sat | regular | 1.224 | 1.160 | −0.064 |
| SC | Sun | late | 0.916 | 0.926 | +0.010 |
| SC | Sat | late | 0.631 | 0.953 | **+0.322** |
| RWC | Thu | regular | 0.561 | 0.611 | +0.050 |
| RWC | Tue | regular | 0.490 | 0.556 | +0.066 |

Two conclusions, and the whole design rests on them.

**A Monday at Santa Clara is worth 3.2 times a Tuesday at Redwood City.** Ranking
managers on raw takings would rank them by *which shifts they were given*. The
roster would be doing the scoring, not the people.

**Day shape is stable but not fixed.** Seven of eight slots moved less than 0.09
across two years — the structural shape of the week is a real, persistent
property. But Saturday-late moved **+0.32**, from 0.63 to 0.95, on ~50 sessions
each side. That is a genuine change in the business, not noise.

So the baseline may not be estimated from all history — it would understate
Saturday-late by a third and hand every Saturday-late manager an unearned score.

### 3.1 The window follows from the drift

Each slot sees roughly 50 sessions a year. That is the tension:

- long enough to estimate the slot mean precisely,
- short enough to track a real move like Saturday-late.

**A trailing 365 days** gives ~50 same-slot observations and tracks change within
a year. That is the window. `SLOT_WINDOW_DAYS = 365`.

The overall *level* also drifts — mean gross rose 34% between the two eras — so
the baseline is re-estimated per session from its own trailing window, never
computed once for the whole dataset.

---

## 4. The score

### 4.1 Slot

```
slot = (location_id, weekday, event_type)
```

Not `day_type` (`weekday`/`weekend`) from Ops — too coarse. Monday 1.55 and
Friday 1.43 are both "weekday" and differ by 8%, and Saturday-regular 1.16 and
Saturday-late 0.95 are both "weekend" and differ by 22%.

### 4.2 Baseline

For a session on date *d* in slot *s*, over sessions in *s* with
`d − 365 ≤ date < d`:

```
μ = mean, σ = sample standard deviation
```

**Strictly earlier than *d*, so a session never contributes to its own
baseline.** With ~50 in a window the effect is small, but a score that is
partly computed from the thing being scored is not a score, and the exclusion
costs nothing.

Baselines need `MIN_SLOT_SESSIONS = 8`. Below that, **the score is null** and
prints as an em dash. It does not print as zero.

### 4.3 Session score

```
z = (actual − μ) / σ
```

Reported alongside the plain-language reading `actual / μ − 1`, e.g.
"+0.8σ · 14% above a typical Friday".

**Why z and not the percentage alone.** Within-slot coefficient of variation,
measured over the trailing year:

| slot | n | CV gross | CV flash | CV attendance |
|---|---|---|---|---|
| SC Sat regular | 53 | 0.200 | 0.197 | 0.154 |
| SC Mon regular | 52 | 0.237 | 0.250 | 0.212 |
| SC Fri regular | 52 | 0.157 | 0.153 | 0.172 |
| SC Sun regular | 52 | 0.199 | 0.209 | 0.148 |
| RWC Tue regular | 51 | 0.233 | 0.263 | 0.224 |
| SC Sat late | 51 | 0.144 | 0.168 | 0.127 |
| RWC Wed regular | 49 | 0.230 | 0.267 | 0.174 |
| RWC Thu regular | 49 | 0.217 | 0.235 | 0.184 |
| SC Sun late | 49 | 0.165 | 0.185 | 0.131 |

Spread runs 0.144 to 0.237 — a **1.6× range**. A Friday is a far steadier night
than a Monday. So +10% on a Friday (0.157 CV) is a 0.64σ result, while +10% on a
Monday (0.237 CV) is 0.42σ. Percentages alone would call those equal. They are
not, and this is exactly the distinction between "above average for a Friday"
and "average for its Monday".

Dividing by σ makes scores from different nights **addable**. That is the whole
point of normalizing.

### 4.4 Which metric belongs to which role

A generic "revenue score" for every role would be lazy. The roles do different
jobs and the data can tell them apart.

| role | primary | direction | why |
|---|---|---|---|
| **MOD** | net sales | higher better | runs the whole session |
| **Paymaster** | \|`bingo_variance`\| | **lower better** | cash reconciliation accuracy — their actual job |
| **Flash Manager** | flash sales | higher better | owns the flash operation |

`bingo_variance` is present on 449 sessions, all 285 of 2026, mean absolute
$683, max $28,077. It is the till being over or short at the end of the night —
the closest thing in the database to a direct measure of whether the Paymaster
did their job well.

Secondary metrics are shown for every role — net, gross, flash, RPA, attendance,
margin — so the reader can look past the primary. As on the Leaderboard, **each
metric card is the sort control**.

### 4.6 Correcting for the trend — added after verification

Scoring the real roster window showed **nineteen of twenty-two sessions
positive, mean +0.671σ**: the whole business was up, so a raw score ranks
whoever happened to work during a good month. §12.2 has the figures.

For each session, take the mean z of every session within **±14 days**, across
both halls, and score the difference:

```
adj = z − (concurrent level)
```

`z` answers *"how did this night compare with a typical night like it?"*
`adj` answers *"how did it compare with everything else happening then?"*

The second is the one a person can be held to, so it is what the screen ranks
on. Both are shown — a fortnight where the whole business is up is worth
knowing about.

### 4.5 Rolling up to a person

```
score  = mean of that person's session z-scores in the role
se     = 1 / √n            (z has unit variance by construction)
ci95   = score ± 1.96 / √n
```

**Per `(person, role)`, never per person.** Sagit was MOD *and* Paymaster on 3
and 10 August; Paolo has been Paymaster and Flash Manager. One session's outcome
cannot be attributed to one person when they held two jobs, so it is counted
once under each role and the person's page lists every role separately.

---

## 5. When a ranking may be shown at all

The evidence base today, from production:

- Assignments exist **31 Jul – 27 Aug 2026** only. Nothing earlier.
- Analytics runs to **16 Aug 2026** (today).
- Overlap: **16 sessions** carry both a manager and a result.
- Distinct people: **4 MODs, 8 Paymasters, 7 Flash Managers.**

Largest single sample: **Sagit, 9 sessions as MOD.** At n=9 the 95% interval is
±1.96/3 = **±0.65σ** — around ±13% of a session's takings. Two managers a full
0.5σ apart are statistically indistinguishable.

> **`MIN_RANK_SESSIONS = 10`.** Below it, scores are shown but the list is not
> ordered by them and no rank number is printed.

Today **nobody qualifies**. The screen says so in plain words, shows the
attribution and the per-session scores — which are useful immediately — and
displays a progress line: *"Sagit, 9 of 10 sessions needed to rank."*

The interval is shown at every sample size, never hidden. A number without its
uncertainty is how a dashboard gets somebody managed out on nine nights of noise.

---

## 6. The session crew line

On session detail, above the metric bridge:

```
Crew   MOD Sagit · Paymaster Paolo · Flash Manager Esther
```

Each name links to that person's page on the Managers screen. Roles with no
assignment print an em dash and are not omitted — a missing Paymaster is
information.

When the day failed the §2.2 count guard, the line says
*"Crew not matched — 2 scheduled sessions, 1 with results"* rather than
showing nothing.

---

## 7. The Managers screen

Three tabs, following the Runners pattern so the two screens read the same way.

**Overview** — one block per role. Within it, one row per person: name, sessions,
score with its interval, primary metric average, and a sparkline of session
scores in date order. Sorted by score when the role has enough data, otherwise by
session count with rank suppressed.

**Person** — one person, every role they hold, every session with its own score,
and their day-slot mix. The mix matters: it shows *which* nights they get, which
is the thing the normalization is correcting for. A manager who only ever works
Mondays should be visibly identified as such.

**Day shape** — the §3 table as a screen: every slot, its index, its CV, its
sample count, and its drift against the previous year. This is the machinery made
inspectable. Without it the scores are unfalsifiable, and Saturday-late is the
proof that the baseline moves.

---

## 8. Privacy

Per standing instruction, this feature reads **no pay data of any kind**.

Read from Ops: `sched_sessions`, `sched_assignments` (role, session, slot),
`sched_staff` (`id`, `name`, `first_name`, `active` **only**), `sched_roles`.

**Never read:** `sched_staff.phone`, `sched_staff.email`, `sched_commission_payouts`,
`sched_session_shares`, `sched_time_entries`, or any column of any table with
`pay`, `wage`, `salary`, `rate` or `commission` in its name. `ops.js` carries an
explicit column allowlist and a denylist assertion that throws in tests rather
than failing quietly in production.

Who worked which shift, and commission and hours as a business total, are
explicitly permitted. Individual pay is not, and none of it is read here.

---

## 9. Access — an open decision, not a silent one

`sched_*` RLS grants `ALL` to the `authenticated` role with `qual = true`. SAR 2.0
authenticates against the **analytics** project, and a Supabase session from one
project is not valid in another. As it stands the Ops client is anonymous, and
anonymous reads return **200 with an empty array** — the manager screen would
render blank and look like a scheduler with nothing in it.

Three ways forward, all requiring a decision that is not mine to take:

1. **Anon read policy on Ops**, limited to the four tables and the six columns
   in §8. A schema change to the Operational database. Nothing is written and no
   existing policy is dropped. Lowest friction; the roster becomes world-readable
   to anyone holding the publishable key.
2. **A second sign-in** against the Ops project. No database change at all; costs
   the user a second set of credentials.
3. **A read-only view** in Ops exposing exactly the allowed columns, with anon
   select on the view alone. Most precise, most work.

Until one is chosen the screen is built, tested and reachable, and reports
*"Scheduler not connected"* with the reason. **No policy has been changed and
nothing has been written to any database.**

---

## 10. Constants

```js
SLOT_WINDOW_DAYS       = 365   // §3.1, from the Saturday-late drift
TREND_HALF_WINDOW_DAYS = 14    // §4.6, added after verification
MIN_SLOT_SESSIONS  = 8     // §4.2, below this the baseline is null
MIN_RANK_SESSIONS  = 10    // §5,   below this scores show but do not rank
Z_95               = 1.96
```

## 11. Verification

1. The §2 join reproduces all 16 attributable sessions and flags the rest.
2. `AM→regular`/`PM→late` as a static map is asserted to *fail*, so the
   regression is caught if anyone simplifies it back.
3. Slot indices recomputed through the app's own `sessionTotals` — the SQL in §3
   used a rough gross that double-counts `paper` against `paper_sales`, which is
   fine for shape and wrong for money.
4. A session excluded from its own baseline, checked on a hand-built fixture.
5. Degenerate cases: one session in a slot, zero σ, a manager with one session,
   a person in two roles on one night.
6. No pay column appears in any query in `ops.js`.

---

## 12. Verification against production — 16 Aug 2026

Run through the shipped code, not re-derived: `verify.mjs` feeds the real
roster and the real trailing-365 z-scores into `joinSessions`, `trendLevels`
and `rollup`.

### 12.1 The join

```
matched 18 · roster-only 0 · results-only 3 · count clash 1
      clash 2026-08-16  ops 2  events 1
```

Exactly as §2 predicts. The three results-only sessions are Redwood City on
4–6 August, which the roster does not cover. The single clash is today: two
sessions are rostered at Santa Clara and only the matinee has been ingested,
so **the whole day is skipped** rather than crediting the evening's takings to
the morning's crew.

### 12.2 The finding that changed the design

**Nineteen of the twenty-two sessions in the window beat their own trailing
year, and the mean across all of them is +0.671σ.** Both halls were running
well above normal — on nights with a named MOD and on nights without one.

Raw scores therefore flattered everybody:

| role | person | raw | corrected | n |
|---|---|---|---|---|
| MOD | Sagit | +0.75 | **+0.09** | 9 |
| MOD | Gina | +0.46 | **−0.20** | 4 |
| MOD | Rachel | +0.24 | **−0.43** | 2 |
| Paymaster | Nancy | +1.26 | **+0.60** | 3 |
| Flash Manager | Wayne | +1.63 | **+0.97** | 3 |

Every raw figure is positive. Every one of them is mostly the fortnight. §4.6
subtracts the concurrent level, and what is left is the part attributable to
the person.

### 12.3 The honest conclusion

**No manager is distinguishable from any other, in any role.** Every 95%
interval spans zero, no adjacent pair is separable, and nobody has reached
`MIN_RANK_SESSIONS`. Largest sample: Sagit, 9 sessions as MOD, +0.09σ with an
interval of [−0.57, +0.74].

The screen says exactly this. It is not a placeholder and it is not a failure —
it is the correct reading of sixteen days of roster data, and it will change on
its own as the scheduler fills in.

### 12.4 Arithmetic checked by hand

Sagit's nine MOD sessions, summed independently: 1.448 − 0.002 + 0.569 + 1.883
+ 0.164 + 0.343 + 0.158 + 1.570 + 0.626 = 6.759, over 9 = **0.751**. The code
returns 0.75. Gina 0.459 against 0.46, Rachel 0.242 against 0.24, period mean
0.671 against 0.671.

---

## 13. Revisions — 17 Aug 2026

### 13.1 The MOD is scored on gross, not net

Net subtracts payouts, and payouts turn on **who wins**. A jackpot landing on a
Tuesday is luck. Scoring a MOD on net credits and blames them for the outcome
of the games; gross is what the room actually sold, and it is the part a manager
can move. `ROLE_METRIC.MOD = 'gross'`, and gross now leads the card order.

Re-run on the roster window, gross instead of net, corrected for the period:

| person | raw | corrected | n |
|---|---|---|---|
| Sagit | +0.61 | −0.03 | 9 |
| Gina | +0.79 | +0.15 | 4 |
| Rachel | +0.44 | −0.20 | 2 |

The order changes — Gina moves above Sagit — which is the point. Net was
ranking them partly on payout luck. Neither ordering is significant at these
sample sizes; both remain unrankable.

### 13.2 The Paymaster is scored on how often the pieces balance

Not on the size of the variance — on the **rate**. Two checks per session
survived testing against the 285 sessions of 2026:

| check | what it compares | clean |
|---|---|---|
| **Deposit** | `bingo_variance` within $5 | 64 / 285 |
| **Sales tie** | line items against the sheet's own total | 277 / 285 |

Two were tested and discarded, and it is worth recording why:

- **Pull-tab** — `pulltab_sales − pulltab_payouts` against `pulltab_net`:
  **285 / 285**. It never fails, so it measures nothing and would only inflate
  every rate.
- **Payouts** — the payout metrics overlap one another, so their sum is not
  comparable to `source_total_payouts`. 0 / 285. The check is wrong, not the books.

The rate is a **plain percentage, not a sigma**, and is deliberately not
day-normalized: a till either reconciles or it does not, and that is no harder
on a busy Friday than a quiet Tuesday. The interval is **Wilson**, because the
normal approximation gives zero width at three-from-three and would claim
certainty from three nights.

Per-check rates are shown beside the combined one. The sales tie passes 97% of
the time, so a combined-only score would be half constant and would compress
everybody toward the middle.

### 13.3 An open question the data raised

In the roster fortnight the deposit balanced on only **3 of 22** sessions, and
**two of the three were late sessions** — 1 August and 9 August. The late
session may simply reconcile differently from the main one.

If that holds up, the deposit check needs normalizing by session type after
all, or the $5 tolerance is too tight for the main session. Both would be
premature to fix on 22 observations, so what the screen does today is show the
per-check rate and the counts behind it rather than roll a confounded number
into a headline. Worth revisiting once there are a few months of roster data.

### 13.4 Access — built

Chosen and implemented: **a second sign-in against the Operational project.**
No policy was added, no schema changed, nothing written to either database.

SAR now holds **two sessions at once**: the analytics one that gates every
number on every other screen, and an Operational one that gates the roster.

**The trap, and the guard.** Both clients live on one origin and therefore share
`localStorage`. supabase-js derives a storage key from the project ref, so these
two happen not to collide — but that is a library implementation detail, not a
guarantee, and if it changed, signing in to the roster would overwrite the
analytics token and quietly sign the user out of SAR itself. The Ops client
names its key explicitly (`sar2-ops-auth-token`) and a test asserts the two
differ. `detectSessionInUrl` is off on the Ops client for the same class of
reason: the analytics client owns the URL, and two parsers racing for one hash
fragment means the loser logs an error on every page load.

**Three states, three different screens**, because they need different actions:

| state | what the screen does |
|---|---|
| no Ops session | offers the sign-in form |
| signed in, no rows readable | says so and names the account — signing in again would not help, so no form is offered |
| connected | renders, and footers the account it is reading as, with a disconnect |

Signing in rebuilds the manager model and repaints in place. It does **not**
re-boot the app: the analytics session is a different session and re-fetching
two years of events to pick up a roster would be absurd.

Wrong credentials get a specific message rather than Supabase's "Invalid login
credentials", which is returned identically for a bad password and for an
account that simply does not exist in that project — a real possibility here,
since a SAR login does not carry over.

**Not yet verified against a live Ops account.** The code path is tested against
fixtures; the sign-in itself needs a real Operational credential to exercise,
and no password has been entered anywhere in this work.
