# Bingo Scout in SAR2

Added October 1, 2026 (Pacific), using the user-supplied `C:/Users/aring/Desktop/Competition/bingo-scout-v2.html`. An unchanged reference copy is retained at `docs/reference/bingo-scout-v2.html` (SHA256 E886653B72DBB3792040E5F8A11D0F01C34FA1BD1886C182411F13762FB3E89A). It was moved out of `public/` on 2 October 2026 so it is no longer deployed: it lists third-party halls' phone numbers and emails and loads CDN scripts without integrity hashes, which must not be served from the app's own origin without sign-in. That reference is historical and includes other states; the integrated screen uses the California collection.

## Open

Start SAR normally with `npm run dev`, sign in, then choose **Plan & P&L → Bingo Scout** (`#/competition`). Existing SAR authentication and access checks remain in place.

For a review without private SAR session data, run `npm run preview:scout` and open http://127.0.0.1:5174/scout-preview.html. This uses the same screen with the already-public competitive collection. It does not sign in to SAR or expose its financial/operations data. The preview page and public preview API are not part of the production build.

## Included

### Hall inbox (2 Oct 2026, from the Bingo Monitor brief)

- **Inbox** is Scout's first view: one card per stable hall ID, texts and emails together. Each card shows the monitor's own counts (total, texts, emails), the latest update with its Pacific time and, for an email, its subject. Cards are newest first.
- Opening a card loads the hall's full history from the monitor, newest first and paged (`offset`), with Text/Email labels and email subjects. The collection inbox's Google Group footer is cut from emails. A message sent to a shared list appears under each hall and names the others; two messages with the same words stay two rows.
- Attribution is by `hallIds` only. The sender (e.g. the shared short code 70503) identifies nothing.
- Welcome, verification and enrollment messages are hidden (`isProcedural`: by kind, or by narrow wording when no kind is set). Calls are not collected.
- **Every hall, one day** reads `?day=` across all halls, including messages not yet matched to a hall.
- **Directory** lists every listing with its eligibility, separate from the maps: on the maps (qualified), schedule to verify, not a competitor.
- Maps count qualified programs only, say how many physical locations they occupy (several charities can share a building), list uncertain-schedule listings separately without counting them, and show address, website, signup state, platforms (BSeenNow, BingoMe Now…), presales and source links.
- Verified live on 2 Oct: Vanguard Santa Clara shows 20 updates — 19 texts and 1 email (the 2 Oct $30,000 House Hot Ball email, in place between the 12:02 PM and older texts); history shows "20 of 20 — the full history".

### Earlier

- All-California directory plus Salinas/Monterey Bay, North Bay, Sacramento, Hawaiian Gardens, and whole Bay Area views. Santa Clara and Redwood City Vanguard retain distinct IDs and comparison origins.
- Landing gallery contains five separate maps. Each area uses a 50-mile straight-line radius, shown as a dashed boundary. Actual hall coordinates determine membership; unlocated halls use the Census place center for list inclusion only, never a fabricated hall pin.
- October 1 discovery ledger covers 651 unique Census cities/communities. Initial queries completed for 365; 65 were actual Google browser searches, the rest use the web-search tool. 286 places still have no completed discovery query. Google paused at a CAPTCHA, and web search reached rate limits. The expandable area checklist shows both general discovery and Google status; neither implies a complete hall inventory.
- The city expansion added 28 program listings and reviewed six existing records. Categories distinguish charity/casino, senior, and social programs; uncertain current operation remains labeled. Santa Cruz Portuguese Hall is suspended according to its official site. See local `sms-monitor/research-oct1-*-city-expansion.json` evidence and pending leads.
- Map, source-linked program evidence, business model, and growth projection views. Search, days, historical-listing toggle, payout bands, estimated drive time and modeled audience crossover filters.
- Live hall directory, collection counts, latest messages, and paginated full hall history from the existing monitor. Website programs and older Scout schedules are labeled separately from texts/emails.
- Conservative extraction of game counts, buy-ins and fixed prize groups, including Vanguard's `FOUR-5Ks`, `(4) 5Ks`, and `str!pz` shorthand. Conditional jackpots are excluded. This is a partial extraction, not a complete reconstruction of every program.
- An explicit selection takes one offer into a scenario and retains its source ID/title/date. Different messages and session variants are never added together. Unknown session frequency must be supplied by the analyst; number of operating days is not assumed to equal sessions per week.
- Scout's payout ratio, realization and optional margin inputs; monthly horizon, low/middle/high feature lifts, rollout delays, exponential ramps, optional seasonal curve and combined lift cap. Loyalty alternatives are mutually exclusive.
- Scenarios persist in this browser and export as JSON, including source identity, assumptions and calculated results. They are not yet shared database records.

## Data connection / deployment

`server/competitive.mjs` reads the public monitor at https://frontier-bingo-text-monitor.andrew595321.chatgpt.site/api/monitor. It has a fixed upstream host, validates hall/offset queries, does not forward SAR credentials, and does not perform writes or trigger subscriptions. `/api/competitive` uses the existing server authorization boundary. Both Vite dev and Vite preview register that route through `server/local-api.mjs`.

The collectors and Supabase remain the source of truth. Opening or refreshing the screen retrieves the latest stored collection. The new module does not replace their scheduled SMS/email ingestion and requires the monitor service to be reachable. The directory currently contains aliases, shared venues, historic entries and incomplete research; counts are program listings, not verified unique operating halls.

In production the same handler runs in the `sar2-api` Edge Function (Operations project), behind SAR sign-in; the GitHub Pages site calls it. No new database key is in the frontend. `?day=YYYY-MM-DD` is forwarded only when it is a real calendar date; `?hall=` and `?offset=` as before.

## Interpretation

Amounts in the competitive model are dollars. They convert to cents only at SAR's shared formatter boundary. Revenue less prizes is labeled **before expenses**, not profit. Profit requires an explicit assumed margin. Ad copy is not measured sales, attendance or actual payouts.

The source Scout's distance-to-drive and exponential crossover formulas are retained as heuristic estimates, not routing or measured shared-player percentages. Feature lifts and seasonality are hypothetical scenario assumptions. Avoid enabling a feature already incorporated into the baseline. Reference import dates do not establish that a program is current. Historical dated specials require review before being treated as recurring sessions.

The map uses normal browser tile loading with visible OpenStreetMap attribution and no prefetch/download feature. [Leaflet API](https://leafletjs.com/reference.html) and [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) were checked during implementation.

## Verification

`npm run build` runs all tests, design-token lint, and Vite production build. Competition tests cover cents/dollars display, source escaping, multi-message history and pagination, conditional jackpots, shorthand extraction, unknown values, scenario arithmetic, feature ramps/caps, exclusive loyalty, and restricted upstream requests. Public upstream reads and the browser preview are also checked. Private SAR sign-in and a production deployment are not validated by the public-data preview.

October 1 radius revision: 643 tests passed, token lint passed, production build passed. Radius test verifies coordinate precedence over city/county and keeps both Vanguard cities in the Bay Area. Catalog version 11 was published to the existing monitor (commit `33ce646552b1abde872cafb20df870b1a08c2e62`). Monitor ingestion/intelligence/email tests and production build passed. Broad monitor ESLint still reports pre-existing React effect errors and ignored runtime-helper import errors; this catalog-only change did not alter those files. Windows Sites build/package wrappers failed on command/path handling, so the same project build and official build-preparation script were run directly to create the validated deployment archive.
