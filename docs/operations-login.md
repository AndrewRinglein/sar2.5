# Operations login and reporting copy

Implemented 2026-10-06 (Pacific). This supersedes older BMS runtime-login guidance.

SAR uses Operations Auth and the private `sar_bms.members` access list. The owner-approved addresses are held in that private table, not the public website. Google and BMS passwords are not used. Approved users request a single-use email link; the backend generates it with Operations Auth and sends it through the existing Operations Resend integration. The return address is exactly `https://andrewringlein.github.io/sar2.5/`, added to Operations' redirect list. The shared default Site URL was preserved.

Every data endpoint verifies the bearer token with Operations Auth and requires a confirmed email matching an enabled member. User-editable metadata never grants access. Login mail is capped at one request per minute and five per hour per approved address. Unknown addresses receive a generic response without creating an account or sending email. Auth links, service keys and mail keys never enter responses or the Operations email-body log.

## Reporting data

The owner authorized a one-time complete Vanguard reporting copy from BMS. BMS production was read only throughout; its schema, settings, users and data were not modified.

The copy contains 46,263 records across 13 tables, with source/destination counts and full-row fingerprints verified. The manifest was verified at `2026-10-07T00:34:02Z`. SAR reads explicit reporting columns inside a read-only repeatable-read transaction, including 888 sessions and 40,333 metric rows. Direct PostgreSQL reads avoid REST's 1,000-row limit. All private tables use RLS with no browser grants. Notification messages targeted at individual BMS users and their read receipts are excluded from the SAR response because Operations identities are different.

This is a snapshot, not an automatic BMS sync. The Sources screen identifies the copy, and the inspector shows the copy timestamp. A browser reload refreshes from Operations only. The existing live Operations scheduler, inventory and validator APIs retain their column allowlists.

## Deployment and validation

- `npm run build:edge` generates the Edge bundle; deploy `sar2-api` on Operations with `verify_jwt=false`. The function handles authentication itself; `/login` is the only public functional route.
- Required existing server environment: `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`. No secrets belong in this repository or Pages.
- `npm run build` passed token lint, 847 tests, the same 847 tests under the future-date clock, and Vite production build.
- Read queries executed against Operations returned all expected counts. Tests cover denied/unconfirmed/unlisted identities, foreign origins, fixed login destination, email rate limits, no token response, rollback, complete large reads, and unchanged integer cents.
- Existing `sar_reader` local database credentials need separately scoped access to the private reporting schema before local API development can use this path. Online deployment uses the Edge database connection.

The Operations security advisor reported intentional RLS-without-policy notices for the private snapshot and membership tables. Existing unrelated public-schema findings (security-definer views/functions, mutable search paths and public extensions) were not changed as part of SAR login. See [Supabase advisor guidance](https://supabase.com/docs/guides/database/database-linter) for those existing findings.
