# Bingo knowledge for Ask SAR

You can edit this file in Notepad. Plain sentences and short bullet lists work best.
Ask SAR reads the whole file before answering every question, so what you write here shapes every answer.

## How Vanguard runs bingo

Vanguard Music & Performing Arts runs charity bingo at two halls in California: Santa Clara (SC) and Redwood City (RWC). Each hall is tracked separately.

A session is one bingo event at one hall on one date. Every number in the app belongs to a session. There are two session types:

- Regular: the main session of the day.
- Late: a second session held the same day, after the regular one, with its own sales, payouts and attendance.

In the data seen so far, a weekday has one session (Regular) and a weekend day can have two (Regular then Late). Santa Clara sessions have appeared on Mondays, Fridays, Saturdays and Sundays; Redwood City on Tuesdays, Wednesdays and Thursdays. Treat this as what the records show, not a fixed rule, and never assume a session happened on a day with no record.

## Glossary

- Flash: a card product with its own sales and payout category.
- Strips: strip cards. The Strip category also includes "All Number Games" payouts, refunds and the Gremlin payout.
- Paper: paper bingo sheets. The Paper category includes payouts for the Double Action, Winnemucca and RWB (Red White Blue) games and "rounding up" splits.
- Cherries: cherry cards, with their own sales and redemption lines.
- Pull tabs: a separate product that appears in some records. Only discuss it if the period's data contains it.
- Hotball: a progressive jackpot pot at each hall that builds until someone wins it.
- Mega Hotball: a larger progressive jackpot shared by both halls.
- Gremlin: a payout that occasionally happens. Not a pot; no balance, no carry-over.
- $75 B-Day Redeemed: a birthday promotion line recorded alongside sales.
- Merch: merchandise sales.
- Paymaster: the person responsible for the cash, deposit and reconciliation at a session.
- MOD (Manager on Duty): the person running the whole session.
- Flash Manager: the person who runs the flash operation.
- Flash Runner: a floor seller of flash tickets.
- Gross: total sales for the session before prizes.
- Payouts: all prize money paid to players.
- Net: gross minus payouts, what the session kept.
- Margin: net as a percentage of gross.
- RPA (revenue per attendee): gross sales divided by attendance. Gross, not net.
- Attendance %: attendance as a share of hall capacity.
- Over/short: actual cash deposited minus the cash that should have been there. Positive is over, negative is short.
- Comparison pool: the past sessions a session is fairly compared against (see "Comparing sessions fairly").
- Slot: a hall, weekday and session type together, for example "Santa Clara, Saturday, Late".
- Day-normalized score: how a session did against a typical session in its own slot, in standard deviations (a measure of how unusual a result is). Zero is typical; +1 is clearly above a normal night of that kind.

## How the numbers are calculated

- Net = Gross − Payouts.
- Margin = Net ÷ Gross × 100.
- RPA = Gross ÷ Attendance.
- Attendance % = Attendance ÷ Capacity × 100. Capacity defaults to 300 if not set.
- Gross and payout totals come from the hall's spreadsheet, not from adding the lines. If the lines and the total disagree, say so rather than trusting either.
- Category net = category sales − category payouts; category margin = that net ÷ category sales. A category margin outside 0 to 50 percent is treated as not meaningful.
- Margin and RPA for a group of sessions come from the group's totals, not from averaging each session.
- Commission pool = (RPA − target RPA) × Attendance × commission rate, never below zero, split by each person's share weight. Target RPA is set per hall and weekday in the scheduler.
- Over/short: expected cash = cash and card takings − starting cash; over/short = actual deposit − expected.
- Forecasts add each remaining session's slot average over the trailing year. The app never invents a session that is not on the roster or in the slot's history.
- An anomaly is a session unlike its own slot's last 90 days on gross, attendance, RPA or payout ratio, by two or more standard deviations. Plain data faults are flagged separately: negative sales or payouts, payouts with no sales, sales with zero attendance, or payouts over 150 percent of sales.

## Jackpots

There are three jackpots, not two.

- Hotball: one pot per hall. Configured cap $5,000, participation $500 (the amount collected toward the pot).
- Mega Hotball: one pot shared by both halls (organization-wide). Cap $15,000, participation $1,000. Never show it per hall.
- Gremlin: a payout only, with no pot, cap or carry-over. Report it as an amount on the session where it happened.

A hit is recognized by a paid amount on the session (the jackpot's paid line is greater than zero), not by a stored flag. In the data package, a value in a "… paid" column means that jackpot hit that night. Fill level is balance ÷ cap, highlighted at 33, 66 and 90 percent.

## Typical ranges

Rough sanity-check ranges from earlier Vanguard data. They are not targets, and a session outside them is not automatically wrong.

- Flash payouts: roughly 47 to 52 percent of flash sales.
- Strip payouts: roughly 28 to 65 percent of strip sales.
- Overall margin: roughly 45 to 55 percent.
- Premium games, if present, pay out around 94 percent and are shown as a separate line, never blended into flash.

## Comparing sessions fairly

Only compare like with like: same hall, same weekday, same session type. A Monday at Santa Clara has taken over three times as much as a Tuesday at Redwood City, and a Saturday Regular differs from a Saturday Late by about a fifth. Comparing a Saturday to a Tuesday measures the calendar, not the session.

- The default pool is the same slot over the previous 90 days, counted from the session's own date, excluding the session itself. Halls are never compared against each other.
- The business has grown quickly, so comparing against all-time history measures growth, not the night. Keep windows recent.
- Fewer than six comparable sessions: say the pool is too small instead of giving a number.
- Manager scoring uses the trailing 365 days in the same slot, with at least eight sessions, because slot averages shift over time.

## Who runs a session

Roles come from the scheduler: MOD, Opener/Swing Shift, Paymaster, Flash Manager, Callers/Strip and Flash Runners. A person is linked to a session by matching the roster to the session records for that hall and date; if the session counts differ on a day, nobody is credited for it.

- MOD is scored on gross, not net, because payouts depend on who wins.
- Paymaster is scored on how often the cash balances (deposit within $5, sales lines tying to the sheet total), as a plain percentage.
- Flash Manager is scored on flash sales.
- Scores are day-normalized and corrected for the level of business in the surrounding two weeks, so a strong month does not flatter whoever worked it. A person holding two roles is scored separately in each.
- There is no time clock; hours are pre-entered totals.
- The app never holds wage rates, base pay or total pay. Commission, shifts, hours and overtime hours are fine. If asked about anyone's pay, say it is not in the data.

## California rules (general background)

General background only. Confirm with counsel before relying on it.

- Charity bingo is governed by California Penal Code section 326.5, licensed by the city or county where it is held, with registration at the Attorney General's Registry of Charitable Trusts.
- Only a licensed charitable organization may run it, at premises it owns or leases.
- No one may receive a profit, wage or salary from a bingo game; operation and staffing are volunteer, with security staff the noted exception. Paying promotional staff from non-bingo funds is a contested interpretation.
- Prize limits are per game, with a state baseline and local overrides; Santa Clara County jurisdictions commonly allow $500 per game.
- At least 90 percent of net proceeds must go to charitable purposes. Detailed records of receipts, prizes and expenses are required, with annual reporting to the state.

## How to answer

- Use only the numbers supplied with the question. Never estimate a figure the data does not contain.
- State the period and the hall or halls every figure covers.
- Prefer net over gross unless asked for gross or sales.
- If a comparison is unfair (different hall, weekday or session type), say why and offer the fair version.
- If the data cannot answer, say exactly what would be needed.
- Keep answers short: the number, what it means, one caveat if needed.
- Do not discuss wages or pay; say it is not in the data.
- End every answer with a line starting "Basis:" naming the sessions, months and halls used.

## Owner notes

Add anything you want Ask SAR to know below this line.
