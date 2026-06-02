# Centralizator

Native Windows app (Tauri 2 + WebView2) that reads an AWB and matching invoice,
extracts the relevant fields with a vision model (Gemini 3.5 Flash via OpenRouter),
and computes the delivery tariff using the exact formulas from
`Centralizator Ploiesti STALEXONE *.xlsx`.

```
┌─ Tauri 2 (Rust shell + WebView2) ─────────────────┐
│   React + Vite + Tailwind UI                      │
│   Two image drop-zones (AWB | Factură)            │
│   Editable extracted fields, live price reflow    │
└────────────┬──────────────────────────────────────┘
             │ HTTPS / multipart  (Vite proxies /api/* in dev)
             ▼
┌─ Fastify server (Node 20+) ───────────────────────┐
│   POST /extract-and-price  →  OpenRouter vision   │
│                                 (google/gemini-3.5-flash) │
│                              →  pure pricing func  │
│   POST /price              →  pricing only         │
│   GET  /health             →  liveness             │
└───────────────────────────────────────────────────┘
```

## Repository layout

```
centralizator/
├── README.md
├── server/                 # Fastify API + pricing engine + vision call
│   ├── src/
│   │   ├── tariffs.ts      # Ported from Lookups!B:C, K:L, etc.
│   │   ├── buckets.ts      # weight/distance/weekend derivation
│   │   ├── pricing.ts      # pure port of Excel cols E..P
│   │   ├── pricing.test.ts # 9 vitest cases incl. real AWB
│   │   ├── schema.ts       # Zod schema = vision-model contract
│   │   ├── gemini.ts       # OpenRouter (OpenAI-compatible) call
│   │   ├── routes/extract.ts
│   │   └── index.ts        # Fastify boot
│   ├── .env.example
│   └── package.json
└── app/                    # Tauri 2 + React + Vite + Tailwind 4
    ├── src/                # React UI
    │   ├── App.tsx
    │   ├── components/
    │   │   ├── ImagePane.tsx
    │   │   ├── ExtractedFields.tsx
    │   │   ├── PriceBreakdown.tsx
    │   │   └── Spinner.tsx
    │   ├── lib/
    │   │   ├── api.ts
    │   │   └── format.ts
    │   ├── types.ts
    │   └── index.css
    ├── src-tauri/          # Rust shell (icons, conf, entrypoint)
    ├── index.html
    └── vite.config.ts
```

## Prerequisites

- Node.js 20+ (24 tested), pnpm 10+
- Rust toolchain (rustup, cargo) — for `pnpm tauri dev` / `pnpm tauri build`
- On Linux dev hosts, the WebKitGTK system deps for Tauri 2 (`libwebkit2gtk-4.1-dev`, `libssl-dev`, etc.)
- On Windows, WebView2 (preinstalled on Win10 2004+ / Win11)
- An OpenRouter API key (`sk-or-v1-…`) with credit for Gemini 3.5 Flash

## First-time setup

```bash
cd server
cp .env.example .env
# edit .env and paste your OPENROUTER_API_KEY
pnpm install

cd ../app
pnpm install
```

## Running in dev

Two terminals:

```bash
# terminal 1 — Fastify API (auto-picks a free port in 3000..3099)
cd server
pnpm dev
```

```bash
# terminal 2 — Tauri 2 dev (Vite + WebView)
cd app
pnpm tauri:dev
```

The server scans `3000..3099` and binds the first free port. The chosen port
is written to `<repo-root>/.api-port`. Vite's proxy reads that file on every
`/api/*` request, so:

- Start order doesn't matter.
- If `3000` is taken, server picks `3001`, and Vite picks it up live.
- If `$PORT` is set in your shell and free, it's honoured. If set but busy,
  the server warns and falls back to discovery (so it always comes up).

The port file is removed on a clean shutdown (`Ctrl-C`).

## Run-only the server tests

```bash
cd server
pnpm test
```

Nine cases, including the exact AWB 007209914 → 24.20 RON @ 21% VAT.

## Production build (Windows MSI)

```bash
cd app
pnpm tauri:build
```

Drops a signed MSI/NSIS installer under `app/src-tauri/target/release/bundle/`.
WebView2 is auto-installed by the bundler when missing.

## Auto-update (GitHub Releases)

The app ships with the `tauri-plugin-updater` wired to the public repo at
[github.com/zigazaga4/centralizator](https://github.com/zigazaga4/centralizator).
On every launch the WebView asks GitHub whether a newer signed release exists
(the `UpdateBanner` component in `app/src/components/UpdateBanner.tsx`). If
yes, the user gets a one-click "Instalează" → progress bar → "Repornește" flow.

### One-time setup (GitHub side)

1. Push the repo to `zigazaga4/centralizator` (public, so the updater can read
   release assets without auth).
2. In **Settings → Secrets and variables → Actions** add two secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` — the file at `.keys/centralizator.key`
     (paste its full contents, including the `untrusted comment:` header).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — leave empty (the key was
     generated without one).

The matching public key is already embedded at
`app/src-tauri/tauri.conf.json → plugins.updater.pubkey`. Never regenerate the
keypair without also bumping the public key — every installed copy will refuse
the new signature otherwise.

### Cutting a release

```bash
# Bump the version in both places (they MUST match — the updater
# compares the bundle's version to the version in latest.json).
# app/package.json            → "version": "0.2.0"
# app/src-tauri/tauri.conf.json → "version": "0.2.0"

git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
```

That tag push fires `.github/workflows/release.yml`:

- A `windows-latest` runner installs deps, builds the React bundle, runs
  `cargo tauri build` to produce the NSIS + MSI installers.
- The minisign private key from secrets signs the `.nsis.zip` updater
  artifact.
- `tauri-action` opens (or updates) the GitHub Release for that tag and
  uploads the installers plus `latest.json` — the file the updater plugin
  reads from `https://github.com/zigazaga4/centralizator/releases/latest/download/latest.json`.

Within seconds of the release going live, every running copy sees the new
version on its next launch.

### Adding macOS / Linux later

Edit the `matrix.include` block in `.github/workflows/release.yml`:

```yaml
- platform: macos-latest
  args: --target universal-apple-darwin
- platform: ubuntu-22.04
  args: ""
```

Each new platform appends its own entry to `latest.json`, so a single tag push
ships installers for everyone.

## How the pricing works

The Excel `Centralizator` formulas reduce to a pure function — no AI in the math
step. For every AWB row:

```
key            = "{service} / {weightBucket} / {distanceBucket}"
baseTariff     = BASE_TARIFFS[key]                              (col E)
extraKmCost    = (dist > 50 ? dist-50 : 0) * 1.70 * 2 * D      (col H)
incrementCost  = (D - 1) * INCREMENT_TARIFFS[">1200kg key"]    (col K)
weekend        = isSat||isSun ? 11.90 : 0                       (col L)
totalVat19     = base + extraKm + increment + weekend           (col M)
net            = totalVat19 / 1.19                              (col N)
vat21          = net * 0.21                                     (col O)
totalVat21     = net + vat21       ← BILLABLE TOTAL             (col P)
```

The 19% rate is what the historical tariff table is denominated in; column P
re-bases to the current 21% VAT.

## How extraction works

`POST /extract-and-price` sends both images inline to OpenRouter, forcing a
single function call to `extract_shipment_data`. The model's JSON is validated
by Zod against `ExtractedSchema` (`server/src/schema.ts`), then the pricing
engine runs. The response includes both the raw fields and the breakdown so
the UI can render everything in one round-trip.

After the first extraction, edits in the UI hit `POST /price` (pure math, no
AI) so the displayed total reflows immediately as the user corrects fields.

## Files in `.env`

| key                       | purpose                                                |
|---------------------------|--------------------------------------------------------|
| `OPENROUTER_API_KEY`      | `sk-or-v1-…` token from openrouter.ai                  |
| `OPENROUTER_MODEL`        | default `google/gemini-3.5-flash`                       |
| `OPENROUTER_APP_TITLE`    | shown on the OpenRouter analytics page                 |
| `OPENROUTER_REFERER`      | optional, defaults to `http://localhost:5173`          |
| `PORT`                    | server port, default 3000 (shell env wins)             |

## Known nuances

- **Handwritten marks on the AWB**: the prompt tells the model to ignore
  `2/2` style annotations (those are package-of-N counters, not delivery
  counts). The user can always override `Număr livrări` in the UI.
- **Service mapping**: the AWB writes `Serviciu: Standard` but the tariff
  table uses `Express / Premium / Prestabilita`. The server maps known
  strings via `SERVICE_TEXT_MAP` (see `server/src/tariffs.ts`) and falls
  back to `Express` with `serviceFallback: true` so the UI flags it.
- **Distance bucket**: derived from the AWB's `Distanță extra (km)` —
  treated as total km from the destination hub to the recipient.

## Adding more service mappings

When a new free-text `Serviciu` appears (e.g. `Standard cu confirmare`),
edit `server/src/tariffs.ts → SERVICE_TEXT_MAP` and re-run tests. The keys
are lowercased and matched as substrings, so most variants fit naturally.

---

> Built in the name of our Lord and Savior Jesus Christ. To Him be the glory.
