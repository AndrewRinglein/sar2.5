# SAR 2.0 — The six chart panels

Design document. Written 17 Aug 2026 against SAR 1.0's source and production data.

SAR 1.0 has **six** charts, not five. The sixth — Jackpot Impact (30 Days) — was
missed in the original gap audit. All six live behind one `<select>` inside a
collapsible "Revenue Overview" accordion, sharing one container, one hall filter
and one data-labels toggle.

---

## 0. A correction, recorded because it nearly changed the build

I reported that four of SAR 1.0's six charts were reading a broken materialized
view and had been showing revenue ~96% too low since April 2026. **That was
wrong, and the charts are fine.** The record of why matters, because the near
miss shaped this document.

What is true: `analytics_monthly_summary` is a materialized view whose money
columns sum denormalised columns on `analytics_events` (`e.total_sales`,
`e.net_sales`, …). Those columns stopped being maintained around March 2026:

| month | matview money | metric store | matview as % |
|---|---|---|---|
| Jun 2025 – Feb 2026 | — | — | **100.0%** |
| Mar 2026 | $4,945,319 | $5,030,772 | 98.3% |
| Apr 2026 | $354,784 | $4,481,199 | 7.9% |
| Aug 2026 | $94,414 | $3,132,768 | **3.0%** |

August 2026 comes out of that view at **−2982% margin** for Santa Clara.

**But SAR 1.0 never reads those columns.** `monthlyToColumn()` takes the matview
row *and* a second argument, `monthlyMetricAggs`, built by summing
`this.eventMetrics` — the EAV store — per month. The money is then recomputed:

```js
let totalSales = 0, totalPayouts = 0;
this.forEachCategory((cat, metrics) => {
  for (const key of metrics.revenue) totalSales  += mv(key);
  for (const key of metrics.payout)  totalPayouts += mv(key);
});
const netSales = totalSales - totalPayouts;
```

`mv()` reads the aggregated EAV values. That is the same arithmetic as SAR 2.0's
`categoryRollup`. From the matview row SAR 1.0 uses only three fields:

| field | used for | correct? |
|---|---|---|
| `month` | the month key and axis label | yes |
| `event_count` | the "Events" row | yes — 825 both sides |
| `total_attendance` | attendance, and the RPA denominator | yes — identical every month |

Verified: legacy and EAV attendance agree exactly, all 825 events, every month.

**Consequences for this build.** SAR 2.0 must match SAR 1.0's numbers, not
"correct" them — there is nothing to correct. And the matview's money columns
are a **latent** hazard, not an active one: nothing reads them today, and
anything that starts to will get numbers 25× too small without any error.

**The lesson applied below.** I established that the matview was broken and
inferred the charts were broken, without reading the function that consumes it.
Every §4 panel therefore records the *actual* source field for each series, and
§6 reconciles each one against a figure computed independently in SQL.

---

## 1. What all six share

**Container.** One panel. A `<select>` chooses the chart; the hall filter and
data-labels toggle apply to whichever is showing.

**Hall filter.** `combined` (default) sums every hall; otherwise one hall. In
SAR 1.0 the same four-way condition is repeated in every chart:

```js
if (f && f !== 'combined' && f !== 'all' && f !== code) return;
```

`combined` and `all` mean the same thing. SAR 2.0 has **one** filter helper, not
six copies.

**Drawing.** SAR 1.0 hand-builds SVG strings, with the layout maths duplicated in
each of the six functions. SAR 2.0 keeps hand-rolled SVG — no charting library,
consistent with the rest of the project — but the axes, scales and legend live
in `charts.js` and are written once.

**Data labels.** Every numeric annotation carries `class="data-label"`. The
toggle sets `display` on all of them. Kept, because it is genuinely useful on a
dense bar chart and costs nothing.

**Money.** SAR 1.0 converts cents to dollars deep inside `monthlyToColumn`, so
its chart code works in dollars and floats. SAR 2.0 keeps **integer cents all
the way to the axis formatter**, per SPEC §3. This is the single biggest
internal difference and the most likely source of an off-by-100.

---

## 2. The monthly rollup — one function, not four

Charts 1, 2, 3 and 5 all need the same thing: money per month per hall, from the
metric store, through the product categories. SAR 1.0 builds this four times.

```
monthlyRollup(events, ctx, { hall })
  -> [{ key: '2026-08', label: 'Aug-2026', year, month,
        eventCount, gross, payout, net, attendance, rpa, margin,
        categories: Map(key -> { revenue, payout, net }) }]
```

Built on the existing `sessionTotals(metricsFor(...), categories)` — the same
path the session screen, Reporting and the Managers screen already use, and the
one verified against SAR 1.0 on U8 ($80,632 / $64,116 / $16,516 / 20.5% / 169 /
$477, every figure matching).

**Sorted ascending, oldest first.** Charts read left to right.

**"Total" and "Average" columns.** SAR 1.0 filters out monthly columns whose
header contains `total` or `average`, because its monthly sheet carries
pre-aggregated summary columns. SAR 2.0 groups events by date and cannot
produce such a column, so the filter is unnecessary — **and must not be
reimplemented**, or a hall legitimately named "Total…" would vanish.

**Missing months.** SAR 1.0 renders only months that exist; a hall closed for a
month produces no point and the line joins straight across the gap. SAR 2.0 does
the same — a zero would assert takings of nothing, which is a different claim
from "no sessions". §4.1 makes the gap visible instead.

---

## 3. Projection — deliberately not built

Charts 1, 3 and 5 overlay a dashed "Projected" series for the current month,
from `getMissingEventsForMonth()`: it reads a configured *expected event
schedule*, finds scheduled sessions with no event yet, and adds each one's
historical average for its event type.

**Not built in this pass.** It depends on an "Expected Event Schedule" config
that must be checked for existence in production first, and it returns `[]` when
none is configured — so for a tenant without one, SAR 1.0 draws no projection
either. Recorded here so it is a decision and not an omission. §7 carries it.

The in-progress month is instead marked as such on the axis, as Reporting
already does (SPEC §8a.5) — an honest partial month rather than a guessed whole
one.

---

## 4. The six panels

### 4.1 Twelve Months Revenue

Line chart. **X**: the last 12 months present in the data, ascending; label is
the 3-letter month only. **Y**: dollars, zero-based, `ceil(max × 1.1)`.

Two series: **Gross** = `Σ category revenue`; **Net** = `gross − payout`.

*Loop 2 changed this.* SAR 1.0 labels the axis `Jan`, `Feb`, … with no year, so
a 12-month window spanning a year boundary shows two `Jan`s. SAR 2.0 prints the
year on the first month and on every January. The month **key** stays
`YYYY-MM` — SAR 1.0 keys on the display string `"Jan-2026"`, which is why it
needs the fragile three-format `includes()` test in chart 3.

### 4.2 Year over Year

Grouped bars plus two lines on a right axis.

**X**: the last 12 months **that have a same-month counterpart a year earlier**.
Months without a prior-year match are dropped entirely.

**Bars**: prior gross, current gross, prior net, current net.
**Lines**: current margin %, prior margin %, on a right axis that is **not
zero-based** — `floor(min/5)*5` to `ceil(max/5)*5 + 5`, so a negative margin
month is drawn honestly.

```
margin = gross > 0 ? net / gross : null
```

*Loop 2 changed this.* SAR 1.0 uses `curr.gross > 0 ? net/gross*100 : 0` — a
month with no sales plots a margin of **0%**, which reads as break-even rather
than "no data". SAR 2.0 returns null and breaks the line. Ratios stay fractions
until the formatter (SPEC §3).

Three stat cards above: gross, net, and average margin, current versus prior,
with the margin delta in **percentage points**, not percent.

### 4.3 YTD Gross and Net

Two cumulative filled areas, running totals from January of the display year.

**Display year**: the current calendar year if it has any data, else the
previous year with a banner saying so.

*Loop 3 changed this.* SAR 1.0 selects a year with
`header.includes('-26') || header.includes('-2026') || header.includes('/2026')`.
`includes('-26')` also matches `"Dec-26"` — fine — but equally `"Jan-2026"`
contains `-20`, and a header like `"26-Jan"` would match the wrong year
entirely. SAR 2.0 compares the parsed integer year. The three-format string test
exists only because the key is a display string; §2 fixes the cause.

Gross area is drawn first and beneath; net over it. Because net ≤ gross always,
the visible blue band between them is **cumulative payouts** — worth labelling,
and SAR 1.0 does not.

### 4.4 Jackpot Impact (30 days)

The panel missing from the gap audit. Reads events, not the monthly rollup.

**X**: one slot per **event** in the last 30 days, chronological — not per day.
Santa Clara runs two sessions on a weekend day and both appear.

**Bars**: each configured jackpot's balance, per event.
**Lines**: net revenue and RPA (left/dollar), attendance and one participation
line per jackpot (right).

"Impact" means **estimated participating players**:

```
added = balance − collected            // how much the jackpot grew
players = added > 0 && cost > 0 ? round(added / cost) : null
```

`cost` is the per-event `participationCostKey` metric if recorded, else the
configured `participationCost`. SAR 2.0 already has this exact calculation in
`model.jackpotParticipation` (SPEC §17) — **reused, not rewritten**.

*Loop 2 changed this.* SAR 1.0 puts attendance and RPA on one physical right
axis with two different scales, printing ticks as `"220 / $477"`. Two scales on
one axis makes the crossing point of two lines meaningless. SAR 2.0 shows
attendance on the right axis and moves RPA to its own toggle, so any two lines
sharing an axis share a scale.

*Loop 3 changed this.* SAR 1.0 returns `0` players when no cost is configured
and draws a flat line along zero. Null, and no line.

### 4.5 Net Revenue by Product

Stacked bars with **signed stacking** — categories with positive net stack up
from zero, negative net stack down — plus a net-total line.

Per category per month: `revenue − |payout|`, over that category's configured
metric keys. Payouts absolute, matching `categoryRollup` (SPEC §16), because
some payout metrics are stored negative and some positive.

Hiding a category via the legend removes it from the stack offset, so the stack
recollapses rather than leaving a hole. Zero line drawn whenever any value is
negative.

*Loop 2 kept one thing and dropped another.* Kept: SAR 1.0's label-collision
pass, which sorts labels by y and pushes any pair closer than 11px apart — a
real fix for a real problem on a dense stack. Dropped: the chart height being
recomputed from the resolved label positions, which makes the panel jump as
labels move. Labels are clipped to the plot instead.

**The net line will not equal the stack**, and this is correct: `net_sales`
includes metrics belonging to no configured category. SAR 1.0 draws both and
says nothing. SAR 2.0 labels the line "Net (all products)" and shows the
uncategorised remainder in the tooltip.

### 4.6 Flash Runner Correlation

Scatter, one point per **event** that has at least one runner recorded.

**X**: distinct runners on that event. **Y**: one of net revenue, net flash
revenue, or RPA — a three-way toggle.

Ordinary least squares line plus R², computed over the plotted points:

```
slope = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)
r2    = 1 − ssRes/ssTot
```

Points coloured **by hall** — the only chart that does. Kept.

*Loop 2 changed this.* SAR 1.0 prints R² and a trend line for any n ≥ 2. Two
points give R² = 1.000 and a line through both, which is meaningless. SAR 2.0
requires `MIN_FIT = 8` points before drawing either, consistent with
`MIN_SLOT_SESSIONS` on the Managers screen.

*Loop 3 changed this.* The x axis is a **count**, and runners per session barely
varies — the whole point may be a near-vertical stripe with no usable slope.
SAR 2.0 therefore also prints Spearman's ρ, which does not assume linearity,
and states the x range. If every event has the same runner count the fit is
undefined and the panel says so rather than dividing by a zero denominator.

**A caution the screen must carry.** More runners on a busy night is a roster
decision, not a cause of the takings. The correlation is real and the causation
runs the other way; the panel says so in the inspector.

---

## 5. Constants

```js
MONTHS_BACK    = 12    // §4.1, §4.2, §4.5
JACKPOT_DAYS   = 30    // §4.4
MIN_FIT        = 8     // §4.6, below this no trend line and no R²
LABEL_MIN_GAP  = 11    // §4.5, pixels
```

## 6. Verification

Each panel's series reconciled against a figure computed independently in SQL,
not against another part of the app:

1. Twelve-month gross and net per month, against a SQL rollup over the metric
   store.
2. Year-over-year pairs: the same month a year earlier, and the pair count.
3. YTD cumulative net at the latest month equals the sum of monthly nets.
4. Jackpot participation for one event, computed by hand from balance,
   collected and cost.
5. Category nets for one month sum to the stack, and the gap to `net_sales`
   equals the uncategorised metrics.
6. R² recomputed by hand on the plotted points.

Plus: every panel through the jsdom harness for NaN, Infinity, `$NaN`,
unformatted cents and unwired controls; and the degenerate cases — one month,
one point, a category that is all zero, a jackpot with no cost, a hall with no
sessions in the window.

## 7. Not built, on purpose

- **Projected overlays** (§3) — needs the expected-schedule config verified in
  production first.
- **Per-chart legend hide/show state persisting across chart switches** — SAR
  1.0 keeps `_jiHidden` and `_pnrHidden` outside the render function, so a
  series hidden on one chart stays hidden after switching away and back. Worth
  keeping; deferred to the URL params so it survives a reload too.
