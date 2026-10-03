# Running SAR 2.0

SAR runs in two places, with the same code behind both:

- **Hosted:** https://andrewringlein.github.io/sar2.5/ — works from any computer, no laptop needed.
- **Local:** http://127.0.0.1:5173/ on the owner's laptop (`npm run dev`), unchanged.

## Hosted version (GitHub Pages + Supabase Edge Function)

The website itself is static and is published by GitHub Pages on every push to `main` (`.github/workflows/pages.yml`). Three things need a server — Operations data (Managers, Inventory, Commission, Staff Overview), Ask SAR and Bingo Scout — and on the hosted site they are answered by a Supabase Edge Function called **`sar2-api`** on the **Operational DB** project (`lkcfbgnuodqzvowschjn`):

| Browser asks for | Served by |
| --- | --- |
| `…/functions/v1/sar2-api/operations` | read-only Operations data (same allowlist as locally, no pay columns) |
| `…/functions/v1/sar2-api/ask-sar` | Ask SAR |
| `…/functions/v1/sar2-api/competitive` | Bingo Scout's public text/email monitor |

The page decides by its address: on `localhost` / `127.0.0.1` it calls the laptop's own `/api/...`; anywhere else it calls the Edge Function (`apiBase` in `src/lib/config.js`). Either way it sends only the person's normal SAR sign-in. The function checks that sign-in with the analytics project and requires Vanguard access before it does anything; without it the answer is "Please sign in". Only the hosted site and the local dev address may call it from a browser.

### The one owner step

Ask SAR needs the Anthropic key stored as a secret on the function. Once:

1. Open Supabase and choose the **Operational DB** project.
2. Go to **Edge Functions → Secrets**.
3. Add a secret named `SAR_ANTHROPIC_API_KEY` with the Anthropic key (it starts `sk-ant-`) as its value. Save.

That is all. The key stays on Supabase; it is never sent to the browser. (Optional: a secret `SAR_ANTHROPIC_MODEL` changes the model; it defaults to `claude-sonnet-5-5`. If `SAR_ANTHROPIC_API_KEY` is missing, the function falls back to the shared `sar2-anthropic-key` Vault secret, the same as the laptop does.)

The database connection needs no setup: Supabase gives every Edge Function its own project's connection (`SUPABASE_DB_URL`). The function reads only the allowlisted columns, in a read-only transaction, over a verified TLS connection.

### Security clean-up and the Ask SAR daily limit (owner, once)

Open **SQL Editor** in each of the two Supabase projects, the **Operational DB** (`lkcfbgnuodqzvowschjn`) and **Vanguard SAR + Com + Finances** (`bstcgfjvtdajgcdpjisg`), paste `scripts/owner-security.sql` and run it. It is safe to run twice. It removes the old link-token read functions (`ops_read`, `sar_read`, `sar_read_items`), which SAR 2.0 no longer uses but which still answer anyone holding an old link; marks every old link token revoked (nothing is deleted); and, in the Operational DB only, creates `sar2_ask_usage`, the table that makes the Ask SAR daily limit (100 questions and 3,000,000 characters per person per Pacific day, `src/lib/ask-limits.js`) survive restarts. Until it exists — and always on the laptop, whose `sar_reader` login is read-only — the same limit is counted in memory instead.

### What is deployed (for whoever deploys)

- `supabase/functions/sar2-api/index.ts` — the whole function in one generated file (entrypoint `index.ts`). It is built from `server/edge-entry.mjs`, the shared server code (`server/api-core.mjs`, `server/edge-api.mjs`, `server/ops-read.mjs`, `server/competitive.mjs`, `src/lib/ops-schema.js`, `src/lib/ask-limits.js`, `src/lib/config.js`) and `knowledge/bingo-knowledge.md`. Its only import is `npm:pg@8`.
- `supabase/config.toml` — sets `verify_jwt = false` for `sar2-api`. This is required: the sign-in token comes from the analytics project, not the Operational DB, so Supabase's own check would refuse every request. The function does its own check instead.

After changing anything under `server/`, `src/lib/config.js`, `src/lib/ops-schema.js`, `src/lib/ask-limits.js` or `knowledge/`, run `npm run build:edge`, commit the regenerated `index.ts`, and redeploy (for example `supabase functions deploy sar2-api --project-ref lkcfbgnuodqzvowschjn --no-verify-jwt`). `npm test` fails if the committed bundle is out of date. **Editing the knowledge file changes the hosted Ask SAR only after a rebuild and redeploy**; the laptop picks it up immediately.

## Running SAR locally (the laptop)

**Bingo Scout:** Choose Plan & P&L → Bingo Scout after signing in. It uses the server's read-only `/api/competitive` route to the existing public text/email monitor. See [BINGO-SCOUT-INTEGRATION.md](BINGO-SCOUT-INTEGRATION.md) for the data boundary, model assumptions and standalone local review (`npm run preview:scout`).

The application runs at http://127.0.0.1:5173/. It needs an internet connection to read the remote databases, but no public deployment is required. Settings and database/key setup controls are intentionally absent from the app.

## Quick start (e-commerce analytics only)

Nothing to configure. `npm run dev`, open http://127.0.0.1:5173/, sign in with the SAR analytics account. Every screen except Managers, Inventory, Commission and Staff Overview works from the e-commerce analytics project.

To enable Ask SAR without the Operations setup below, put the Anthropic key in `.env.local` (server-only, never served to the browser):

```
SAR_ANTHROPIC_API_KEY=sk-ant-...
```

`npm run diagnose:local` prints what is and is not configured, with real error messages.

## One-time owner setup (Operations screens)

From this sar2 folder, run:

```powershell
npm run configure:local
```

The terminal asks for two hidden values:

1. The PostgreSQL connection URI for the **Operations** Supabase project `lkcfbgnuodqzvowschjn`, obtained from that project's Connect panel. Use the session pooler if direct IPv6 connectivity is unavailable. Substitute the database password and URL-encode special characters in it. This is a database credential, not an app login or publishable API key.
2. The shared Anthropic API key. Enter leaves an existing database secret unchanged.

The script checks database access, saves the connection URI only in the ignored `.env.local` file, and creates or updates `sar2-anthropic-key` in Operations Supabase Vault. Vault must already be available, and the setup credential must have permission to manage that secret. No ecom database data is modified.

The runtime database role needs SELECT access to the allowlisted Operations tables in `src/lib/ops-schema.js` and access to the shared Vault secret through `vault.decrypted_secrets`. The application reads only the listed columns. The secret never goes to the browser. `SAR_ANTHROPIC_MODEL` can be set in `.env.local` by the owner; it defaults to `claude-sonnet-5-5`.

Do not use `VITE_` variables for either credential, and do not put credentials in frontend source files. The Operations project identity is fixed in the server implementation.

## Start the app

Restart the running server after setup:

```powershell
npm run dev
```

Open http://127.0.0.1:5173/ and use the existing SAR analytics sign-in. Managers, Inventory, Commission and Staff overview load Operations automatically through the local server. Ask SAR uses the shared database key automatically. Users never configure either connection.

The server verifies the existing SAR identity and Vanguard analytics access before serving Operations data or answering an AI request. It connects to Operations using TLS with certificate verification.

## Verify

```powershell
npm run build
```

This runs token checks, automated tests and the frontend build. Live database and Anthropic behavior still require valid owner credentials. If Operations is unavailable, inspect the local server configuration and database connectivity; there is deliberately no in-app setup prompt. Ask SAR can still give its limited local summary answers when the AI service is unavailable.

`preview.html` is a generated screen gallery, not the interactive application. The hosted site gets its server routes from the `sar2-api` Edge Function described above; the laptop does not need to be running for it.
