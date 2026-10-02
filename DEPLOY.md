# Running New SAR locally

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

`preview.html` is a generated screen gallery, not the interactive application. The former static GitHub Pages deployment instructions are superseded: a static-only host cannot run the Operations or Ask SAR API. Keep the local Node server running for this demo.
