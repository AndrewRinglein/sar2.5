# SAR 2.0 — Data view and CSV export

Design, 17 Aug 2026, written from SAR 1.0's source.

Three sub-views behind one picker, plus an export. **Transposed throughout**:
rows are metrics, columns are sessions or months. That is unusual for a web
table and correct here — it is how the original spreadsheet reads, and the
people using it think in rows.

---

## 1. Sub-views

| view | columns | rows |
|---|---|---|
| **Daily** | one per session, newest first | every metric |
| **Monthly** | one per month | every metric, plus RPA, Payout %, per-category shares |
| **Reconcile** | one per month × (stored / computed / difference) | as Monthly |

SAR 1.0 calls the third "Data Test". Renamed, because §5 changes what it does.

---

## 2. Rows

From the metric definitions, in `display_order`, grouped:

```
Location · Date · Day
attendance metrics
—
sales metrics …            Total Sales      (bold)
—
payout metrics …           Total Payouts    (bold)
—
                           Net Sales        (bold)
                           Margin %
—
hotball metrics
```

Monthly adds `Events`, and after the hotball block: `RPA`, `Payout %`, and a
`{Category} %` / `{Category} Payout %` pair per category.

**Sales and payout rows are filtered to metrics assigned to a product
category**; hotball and attendance rows are not. That asymmetry is SAR 1.0's
and it is deliberate — the totals sum exactly the rows displayed, so the column
adds up on screen. Reproduced.

### 2.1 Row numbers

SAR 1.0 shows a spreadsheet-style row number that is **positional** —
`idx + 1` — and entirely unrelated to the `row3`/`row4`/`rowN` aliases in the
data layer, which are legacy handles for old chart code and are keyed
differently. Cell lookup is by metric **key**, never by row number. SAR 2.0
keeps the positional number for familiarity and does not build the aliases at
all; nothing in SAR 2.0 reads them.

### 2.2 Column letters

SAR 1.0 prints `String.fromCharCode(65 + idx)`, which past column 26 emits
`[`, `\`, `]`. With 558 sessions at Santa Clara that is almost every column.
SAR 2.0 uses proper spreadsheet lettering — A…Z, AA, AB — because a column
header of `\` is not a column header.

---

## 3. Columns

**Daily** header is `M/D/YYYY`, unpadded, with ` PM` appended for a late
session — SAR 1.0's format, kept, because people read these headers against
the paper sheets.

*A gap, fixed.* SAR 1.0 special-cases only `late`. There is a third event type,
`early`, which therefore gets a header identical to a regular session on the
same date — two indistinguishable columns. SAR 2.0 suffixes every non-regular
type: ` AM` for early, ` PM` for late.

**Order**: newest first, so the most recent session is the leftmost data
column. Within a date, session type ascending.

**No paging.** SAR 1.0 renders every column and lets the container scroll; with
825 events that is a wide table but it is what people expect from a sheet.
SAR 2.0 keeps it, but adds a date-range filter (§6) so the width is a choice.

---

## 4. Formatting

| kind | rendering | zero | missing |
|---|---|---|---|
| currency | `$1,234`, whole dollars | `$0` | blank |
| integer | `1,234` | `0` | blank |
| percentage | `12.3%` | **blank** | blank |
| text | as-is | — | blank |

Zero renders differently for currency than for percentages. That is SAR 1.0's
behaviour and it is defensible — a margin of exactly zero is almost always a
missing input, whereas takings of zero can be real — so it is reproduced, and
written down here because it looks like a bug and is not.

**Missing is blank, not a dash.** This differs from every other SAR 2.0 screen,
which uses an em dash. A sheet with 60 rows × 500 columns of em dashes is
unreadable; blank is what a spreadsheet does. Deliberate, and the only place in
the project where the rule is relaxed.

*One thing corrected.* SAR 1.0 formats negatives as `'$' + (-50)` → **`$-50`**.
SAR 2.0 renders `-$50`. This is a typo in the output of a number formatter, not
a convention worth preserving.

---

## 5. Reconcile — what "Data Test" should have been

SAR 1.0's Data Test puts **Manual** beside **Calc** and flags any difference.
The intent is to catch the imported monthly figures disagreeing with the sum of
the daily events.

**It cannot do that.** "Manual" is read from `monthlyToColumn`, which does not
use the monthly summary's money at all — it recomputes from the event metrics.
"Calc" sums the same event metrics. Both sides are the same arithmetic over the
same source, so every money row reads a difference of exactly zero, always.
Only `Events` and `Attendance`, which do come from the summary row, can ever
differ.

Meanwhile the comparison that *would* have mattered — the monthly summary's own
stored money columns against the events — is exactly the one that is broken:
`analytics_monthly_summary.total_sales` has not tracked the metric store since
March 2026 and now carries about 3% of actual sales.

So SAR 2.0's Reconcile compares:

```
Stored     analytics_monthly_summary.total_sales, net_sales, total_attendance,
           event_count — the columns as they actually sit in the view
Computed   the metric store, rolled up through the product categories
Difference stored − computed, flagged when it exceeds a cent
```

That surfaces the real divergence on the month it began, instead of printing a
column of guaranteed zeroes. The reconciliation is the point; a check that
cannot fail is worse than no check, because it reassures.

### 5.1 The per-session tie-out is separate and stays

The Daily view flags a cell where `source_total_sales` disagrees with the
computed total — the spreadsheet's own reported total against its line items.
That check is real, fails on 8 of 285 sessions in 2026, and is the same one the
Paymaster balance rate uses. Kept, with the same tolerance.

---

## 6. Filters

Location, sub-view, and — new — a date range.

SAR 1.0 offers no "All halls" option in this view and no date filter. SAR 2.0
adds both: a sheet of 825 columns is not usable, and the reason to open this
screen is usually to look at a specific stretch.

---

## 7. Interactions

Sticky row-number and label columns, as SAR 1.0. **Also a sticky header row**,
which SAR 1.0 lacks — it appends the header `<tr>` straight into the table with
no `<thead>`, so scrolling down loses the dates and you cannot tell which
column you are reading.

Clicking a column header opens that session. SAR 1.0 has a `console.log` stub
where this was clearly intended and never wired.

No sorting and no editing. This is a read-only sheet.

---

## 8. CSV export

### 8.1 Three bugs in SAR 1.0's export, all fixed

**It always exports Daily.** `exportSheetsView()` reads
`getElementById('dataSubviewSelector')`; the element's id is
`dataSubviewFilter`. The lookup returns null every time, so `subview` falls
back to `'daily'`. Export while looking at Monthly and you silently get Daily
data in a file named `..._daily_...`. The filename is at least honest about it.

**No quote escaping.** Every cell is wrapped with `` `"${v}"` `` and nothing
replaces `"` with `""`. One metric display name containing a quote corrupts the
file from that row on. SAR 2.0 escapes properly and quotes only when needed.

**`\n` line endings.** Excel on Windows wants CRLF. SAR 2.0 writes `\r\n` and
prefixes a UTF-8 BOM so accented names survive a double-click into Excel.

### 8.2 What is exported

The **view on screen**, with its filters applied — the same rows, the same
columns, in the same order.

Values are **raw numbers, not display strings**: `1234.5`, not `$1,235`. SAR
1.0 does this too, and it is right — a spreadsheet wants a number it can sum.
Money is exported in **dollars with two decimals**, since a CSV leaving the
system is no longer in the cents-everywhere contract, and the header row says
so.

Filename: `vanguard_{view}_{hall}_{YYYY-MM-DD}.csv`, naming the view that was
actually exported.

### 8.3 A second export, deliberately added

SAR 1.0 contains a fully written `exportToCSV()` producing a **one-row-per-
session** file — the normal orientation for anything downstream — wired to no
button and marked "old function - kept for compatibility". It is the more
useful of the two for anyone loading this into another tool.

SAR 2.0 offers both, labelled: **Sheet (rows are metrics)** and
**Table (rows are sessions)**.

---

## 9. Verification

1. Column count and order match the event list under each filter.
2. Total Sales equals the sum of the sales rows displayed, per column.
3. Net = Total Sales − Total Payouts, per column.
4. Reconcile flags March 2026 onward and not before — the known divergence.
5. CSV round-trips: parse the output back and compare against the rendered
   values, including a metric name containing a comma and one containing a
   quote.
6. Degenerate: no sessions, one session, a metric with no value anywhere, a
   category with no metrics.
