# Forecasting context for Ask SAR

Editable owner context. Include this file only when the Forecasting toggle is on. Updated from Andrew's account on October 6, 2026. Observations below are hypotheses and business context, not measured causal coefficients or an approved budget.

## What a forecast must cover

A full forecast includes session revenue, prizes, staffing/payroll, goods, and other operating expenses. Revenue minus prizes is net gaming revenue, not final profit. Do not describe a session-revenue projection as the full business forecast.

The session-based forecast's expense mode has only Unit Economics assumptions (staff hours and blended hourly cost, fixed cost per session) plus estimated linked goods costs. Those are not recovered accountant figures. Historical monthly expense information was found in the older SAR accountant implementation: payroll by SC/RWC and shared other expenses allocated by hall revenue share, with commission separated from payroll for reporting, not subtracted twice. The source database was paused when investigated. Amounts have not been recovered or verified; never substitute zeros or invented estimates for them.

Keep recorded expenses, approved budgets, and scenario assumptions separate. Monthly fixed costs should not automatically disappear when a night is cancelled. Avoid counting goods costs twice if already included in a shared expense total. Show the period, hall allocation, missing categories and whether each figure is actual or assumed. Forecasting knowledge does not itself add expense records to the numeric data payload.

## Editable 12-month plans

The primary Forecast planner covers the next 12 full calendar months and supports named browser-local saves and Excel downloads with formulas. Existing halls start from a frozen snapshot of the 13-week slot model, with schedule and closure information. New halls have an explicit opening month and user-entered sessions per month, attendance per session, RPA, and margin. No historical data is invented for them.

Attendance, RPA, and Margin are the three key drivers. Margin means revenue less prizes, divided by revenue; operating expenses are separate. A change entered in a month carries forward for that metric until a later explicit override. Changes do not compound. Clearing an override restores its inherited value. Each hall can have an explicit monthly operating expense budget; blank budgets leave profit unknown. These budgets are assumptions, not recovered accountant figures. The Ask SAR data payload does not currently include the user's locally saved forecast; ask for those assumptions before referring to a particular plan.

## Attendance and RPA are distinct drivers

RPA means revenue per attendee: gross revenue divided by attendance. Gross revenue = attendance × RPA. Do not call RPA spend per player. Separate attendance effects from sales per attendee, product mix, prizes and expenses.

Owner observations about attendance:

- Special events and advertised premium strips are important. Capture the number of premium strips, prize per strip, total advertised premium payout, message date and session date. Four strips at $5,000 mean $20,000 of advertised premium prizes, not $20,000 of revenue or profit. Do not add separate messages or session variants together as one offer.
- High Hotball and Mega Hotball balances tend to draw more attendance. Treat that as an observed association to test, not a proven lift percentage.
- The shared Mega Hopper promotion draws some Santa Clara players to Redwood City. Confirm its identifier and relationship to Mega Hotball in the records rather than silently merging similarly named games.

Owner observations about RPA and product mix:

- What is sold, who runs the floor, how many Flash games are open, and how late the night runs matter.
- The Flash Manager and Manager on Duty can influence sales effort and sales results. The Paymaster is not expected to have much effect on sales during the night. Avoid crediting the Paymaster for effects attributable to the sales managers.
- Which high-spending attendees ("whales") attend can materially affect sales. The supplied SAR question payload contains no player identities or spend records; do not claim to identify these effects from attendance totals alone.
- Flash and Strip account for most of the business attention. Paper and Cherries are relatively minor in the owner's assessment; retain their real financial amounts rather than discarding them.
- Strip has a higher profit margin than Flash in the owner's assessment. Santa Clara has recently pushed Strip more on higher-attendance nights. Quantify the margin difference from actual product data when available.

## Hall maturity, expansion and structural changes

Santa Clara is the established hall. Redwood City is younger, runs three nights, and is described by the owner as slightly above break-even. Andrew believes its third night was added in the last year; verify the exact date from the schedule and records. Do not assume that both halls have the same mature economics.

Additional halls are being considered. Model each hall separately with an explicit opening date, sessions per week, attendance ramp, RPA, product mix, prizes, startup costs, staffing and fixed expenses. New halls may start slowly and build. Separate genuinely new attendance from visitors shifting from another Vanguard hall. No opening dates, approved budgets or ramp coefficients were supplied.

The owner recalls roughly $24 million in annual bingo revenue several years ago, before the COVID shutdown disrupted bingo and the charity's activities. This is historical context, not a current baseline or target. Do not extrapolate it into present forecasts without comparable periods and scope.

The ecommerce platform changed a few months before October 2026 and supports advance seat reservations. Verify the transition date and whether definitions or coverage changed. Reservations are a leading indicator, not guaranteed attendance or booked revenue; cancellations, no-shows and walk-ins matter.

## Analysis discipline

Compare like halls, weekdays and session types; account for changing schedules, holidays, promotions, jackpots, hall maturity and product mix. Avoid counting a promotion's effect both in attendance and again in RPA without evidence. Backtest using only information available at the forecast date. Offer transparent scenarios or ranges when assumptions are supplied; explain what is missing when they are not. Never invent causal coefficients, staff effects, player identities, expense amounts or expansion plans.
