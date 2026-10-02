# SAR 2.0 — the remaining eight screens

Design, 17 Aug 2026. One document, one section per screen, each written in three
passes against SAR 1.0's source and against production data.

Order is by data readiness, not by menu position.

---

## 1. Inventory

### 1.1 Pass one — what does SAR 1.0 do?

**Nothing.** There is no inventory view in `sar/app.html`; the only matches for
`inventory` are in unrelated code. This screen is new, so there is nothing to
match and the question is what it should be.

### 1.2 Pass two — CORRECTED: I looked in the wrong database

I first built this against `flash_games` and `flash_runner_inventory` in the
**analytics** project, having searched for tables whose names contain
"inventory". The real system is in **Ops** and not one of its tables is named
that way:

| table | rows | what it is |
|---|---|---|
| `products` | 517 (439 active) | catalogue, with **cost** per box |
| `boxes` | 4,206 | every physical box: serial, cost, state, tickets left |
| `game_usage` | 9,360 | what was played, per hall per session, Jan–Aug 2026 |
| `purchase_orders` / `po_lines` / `deliveries` / `vendors` | 16 / 365 / 5 / 5 | procurement |
| `stock_adjustments` | 1 | write-offs |

Searching by name was the mistake — the same class as the wrong-database
episode, and the fix is the same: look at the whole schema, not for the word
you expect.

**The state machine is the screen.** `boxes.state` is `on_order`,
`in_inventory`, `opened`, `sold_out` or `missing`. On hand is
`in_inventory + opened` and nothing else. Production, 17 Aug 2026:

| | boxes on hand | at cost |
|---|---|---|
| Santa Clara | 1,916 | $224,057.79 |
| Redwood City | 1,189 | $61,940.93 |
| **Total** | **3,105** | **$285,998.72** |

Counting `on_order` would add $46,410.96 of stock that has not arrived;
counting `sold_out` another $71,327.72 that is gone.

**Cost is not retail.** A box costs about $192 and holds ~1,795 tickets at
~$1.03 — roughly $1,850 at the counter, nine times cost. That is not margin:
most of it goes straight back out as prizes. The two figures are shown apart
and never summed.

**`still_stocked` is the useful alert.** A game played regularly that can no
longer be ordered is worth knowing about before the last box is opened.

### 1.2a Pass two, original (superseded) — the analytics-side tracker

| table | rows | what it is |
|---|---|---|
| `flash_games` | 105 (103 active) | the catalogue — name, barcode, tickets per box, ticket price |
| `flash_runner_inventory` | 42 | tickets out / sold / returned / burned, per runner per game per session |
| `flash_inventory_transfers` | 45 | movements: `distribute`, `redistribute`, `return` |

Catalogue: average ticket price **$1.07**, average **1,750 tickets per box** —
so a typical box is worth about **$1,870** at face value. That is the number a
hall manager wants and it is computable for all 103 games today.

### 1.3 Pass three — the trap

`flash_runner_inventory` covers **2 sessions**. `tickets_out` totals 6,829,
`tickets_sold_so_far` 320, `tickets_returned` 320.

**This is a different system from the Runners screen.** Runners reads
`flash_runner_events` — 825 sessions, complete, sell-through around 100%.
Inventory reads `flash_runner_inventory` — the live POS ticket tracker, in use
for a few weeks. Its sell-through reads **4.7%**, because the sessions are
part-recorded, not because anybody sold nothing.

> Put both numbers on one screen without saying this and Inventory appears to
> contradict Runners by a factor of twenty.

So: the two are **never** mixed, the screen names its source, and any
sell-through from `flash_runner_inventory` is labelled as live-POS coverage
with its session count beside it.

### 1.4 Shape

Three tabs, following Runners and Managers so the three read alike.

**Catalogue** — every game: name, ticket price, tickets per box, box face
value, active. Sortable, every column. The default sort is box value, because
that is what makes one game matter more than another.

**Stock** — per session, per runner, per game: out, sold, returned, burned,
and unaccounted. **Unaccounted** = `out − sold − returned − burned`, and it is
the point of the tab: 6,509 of 6,829 tickets are currently unaccounted for,
which is either a session in progress or a gap. The screen says which it cannot
tell.

**Movement** — the transfer log, newest first, with `distribute` /
`redistribute` / `return` as coloured kinds. A redistribution between runners
mid-session is the interesting one.

### 1.5 Rules

- Money in cents everywhere; `ticket_price` is `numeric` **dollars** in the
  database, so it is converted **once**, on read, and never again.
- `tickets_per_box × ticket_price` is face value, not revenue. Named "Box face
  value" so nobody reports it as sales.
- A discontinued game is shown, greyed, not hidden — stock outlives the
  listing.
- Zero is zero; missing is a dash. Unaccounted may be negative (more sold than
  issued, as on Runners) and that is shown, not clamped.

---

## Forecast (U12) — scope decisions

Recorded 1 Oct 2026 with the rebuild (`src/lib/forecast-model.js`, `src/screens/forecast.js`,
`test/forecast.test.mjs`).

- **The slot model is THE model.** The plan says U12 is "built from scratch — the existing
  projection logic is explicitly not a model to follow", which refers to SAR 1.0's projection
  (SPEC §8.3). The slot model (hall × weekday × session type, trailing `SLOT_WINDOW_DAYS` = 365,
  `MIN_SLOT_SESSIONS` = 8) is new to SAR 2.0 and already proven on Managers, so it is kept. The
  v9 mockup's driver method (attendance, spend per head, payout ratio) is applied as multipliers
  on each slot's baseline — not a second model.
- **SAR 1.0 guardrails kept** (§8.3/§19a): a day more than one day in the past with no data is
  *missing / not yet entered* — counted and listed, never projected (yesterday and today stay
  projectable for ingestion lag); a session whose slot has too little history goes to a visible
  *unprojectable* bucket; the averages and sample counts behind every projection are on screen.
- **Today comes from the clock** in the tenant's timezone (`config.timezone`), not from the last
  data date.
- **Which sessions are still to come**: the Ops roster where it reaches (deployed and planned only;
  drafts excluded and reported — the Staff Overview rule), otherwise a calendar walk of each slot
  that is *currently running*: at least `RUNNING_MIN_SESSIONS` = 2 sessions in the trailing
  `RUNNING_WINDOW_WEEKS` = 8 weeks. A slot that stopped is listed as stopped, not projected. The
  scheduler currently has no future sessions, so in practice the pattern drives everything; the
  screen says which source each projected session came from.
- **Halls**: Ops `hall_id` maps to analytics `locations` by `settings.ops_hall_id`, else
  `code` lower-cased (SC → `sc`, RWC → `rwc`); the shared `resolveHalls()` name match is only a
  fallback when no location carries a code.
- **Horizons** all start with the current month: *Rest of this month*; *Next 3 months* = this
  month and the next two; *Rest of year* = through 31 Dec; *Next 12 months* = this month and the
  next eleven. (In October, "Next 3 months" and "Rest of year" coincide.)
- **Range**: night-to-night noise (per-slot SD in quadrature, `Z_95`) *widened* by the level drift
  the backtest observed — √max(0, mean(relative error²) − mean(noise²)) — growing with √(months
  ahead) and added linearly across months. With fewer than 3 backtestable months the range is
  noise only and the screen says so.
- **Backtest**: last 12 completed months (`BACKTEST_MONTHS`, so December and the holidays are in
  the drift estimate and the in-range count), each as of its 1st, using only data strictly before
  that date and no roster. Reports error %, mean absolute error, bias, and how many months landed
  inside the range stated at the time (and, flagged in-sample, inside the widened range).
- **Holidays — evidence, not a hard-coded "closed".** Calendar (`holidaysForYear`): New Year's Day,
  Easter Sunday (computus), Mother's Day, Memorial Day, Independence Day, Father's Day, Labor Day,
  Thanksgiving, Christmas Eve, Christmas Day, New Year's Eve. For an expected session on a holiday,
  the record on the same holiday decides, PER SESSION with the hall as fallback: first the same
  session type at that hall (was it running that weekday then, and was it held?), else the hall
  as a whole (held anything, or a slot was running and nothing was held). Not held → *closed*, not
  projected, listed (e.g. "Late session not held last Mother's Day"), re-openable per session
  (`open=date|location|type` in the link); held → projected; no evidence → projected and marked
  "holiday, no history". Keyed by session type, not weekday, because fixed-date holidays move
  weekday. A deployed/planned roster session always counts. The backtest uses the same rule with
  only earlier data.
- **Expenses** reuse Unit Economics' stored assumptions (`sar2-assumptions`): staff = hours per
  session × blended cost per hour, plus fixed cost per session, applied to every done and
  projected session and marked *assumed*; goods only when boxes are linked, marked *estimated*.
  No individual pay anywhere.
- **Saved scenarios** live in `localStorage` under `sar2-forecast-scenarios` (name, drivers,
  switched-off slots, mode, horizon, hall) with an in-session fallback when storage is missing.
  The comparison table re-runs baseline and every saved scenario on the current hall and horizon.
