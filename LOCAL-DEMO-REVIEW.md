# New SAR / SAR 2.0 — local demo review

Historical inspection from 8 September 2026; the findings below describe that version.

Update, 16 September 2026: the running app reads authenticated ecom analytics (862 sessions observed). Settings has been removed, leaving 21 routes. Operations login and Anthropic key entry have been removed from the app. Both now use a local server; Operations credentials remain to be configured outside the app, and the shared Anthropic key is read from Operations Vault. Build and 417 tests pass. See DEPLOY.md for the current local setup. Live Operations and Anthropic calls are still unverified until credentials are configured.

## Project and references

The current implementation is this `sar2` folder inside the ecom checkout. `C:/Users/aring/Desktop/New SAR` is empty. `C:/Users/aring/Desktop/SAR v2` contains the older March implementation.

The rebuild specification and implementation plan are `../sar/SAR-DESIGN-SPEC.md` and `../sar/SAR2-IMPLEMENTATION.md`. Earlier visual iterations are in `../sar/mockups/`, through `v9-atrium.html`. The August chart, data, manager and remaining-screen design documents are in this folder.

The documents are not fully synchronized: the implementation plan still describes no-login access, while the current app and DEPLOY.md require authentication. The remaining-eight-screens document contains only Inventory, including superseded design text. Route unit numbers also differ from the implementation plan. Use executable behavior and explicit acceptance criteria to track completion.

## Verified now

- All 22 navigation routes have screen renderers connected in `src/main.js`.
- The screen gallery contains 46 screen/subview examples with generated data.
- Browser inspection covered the gallery's session detail, managers overview, dashboard revenue chart and inventory on-hand layouts, plus the actual application's sign-in screen.
- The actual app boots at `http://127.0.0.1:5173/` and requires SAR credentials. Operations reads require separate Ops authentication.
- After repairing the missing jsdom installation and synchronizing package-lock.json, `npm run build` passes: token lint, 413 tests, and Vite compilation. Full output is in `local-build.log`.
- No live credentials were entered and no production data was changed. Authenticated production behavior was not reverified in this review.

## Gaps for a demo

1. **The gallery is static.** `scripts/preview.mjs` serializes DOM to HTML, removes anchor destinations, passes a no-op navigation callback and disables buttons. Removing its CSS restriction will not restore event listeners. The demo needs to run the actual screen functions and router with a local dataset.
2. **The first sample session loses its metrics.** The preview generator renames the first event from `e0` to `RE` for the runners example but leaves its metrics under `e0`. The first session consequently displays $0 and a false -100% comparison. Fix the shared fixture's identity before reusing it.
3. **Sample coverage is thin.** It spans only April–August 2026, so year-over-year panels cannot show meaningful comparisons. Promotion notes/catalogue are empty. Manager cash reconciliation has insufficient fixture data. A complete walkthrough needs deliberate examples for these states and every operations tab.
4. **Screen presence is not specification completion.** Session detail currently renders the picker, crew, KPIs, category table and jackpots, but not the planned bridge, ranked drivers, findings or expected-range analysis. Forecast renders a slot-based month projection, without the planned driver sliders or saved scenarios. Monthly P&L deliberately stops before expenses because expense data is unavailable; an expense scenario requires clearly identified local assumptions.
5. **End-to-end verification remains.** Existing automated tests do not establish that every browser control, cross-screen link and responsive layout works. An authenticated Ops walkthrough is also still unverified.

## Completion sequence

1. Extract and repair the generated fixture into a reusable local data module; add sufficient historical and operations examples.
2. Add an explicit local demo entry using the real application shell, renderer functions, router and inspector. Clearly identify generated data and keep demo startup independent of database credentials.
3. Exercise all 22 routes and their subviews, filters, sorting, drilldowns, exports, local assumptions and Ask SAR's local answers. Fix broken behavior as it is found.
4. Complete the remaining session-analysis and forecast interactions against the specification. Record deliberate scope differences such as read-only configuration and missing expense data.
5. Verify totals across screens and desktop/responsive layouts, then provide a repeatable local launch command and walkthrough.

## Running the current code

From this folder: `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`.

App: `http://127.0.0.1:5173/` (sign-in required).

Static gallery: `http://127.0.0.1:5173/preview.html` (generated numbers, controls inactive).
