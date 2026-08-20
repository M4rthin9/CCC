# CCC Backend — Prison Visitor Reservation System

A serverless backend for the prison visitor reservation system, migrated from the legacy
Google Apps Script + Sheets implementation to **Cloudflare Workers (Hono) + D1 + KV**.

It serves both the public booking flow (visitors reserving a visit) and the admin dashboard
(approvals, payments, prisoners, users, event logs, settings).

> **Security note:** this repository contains no credentials. Real values (Cloudflare
> account ID, D1 database ID, KV namespace ID, API tokens, JWT/Turnstile secrets) live in
> `wrangler.toml`, `wrangler login` sessions, `wrangler secret` storage, GitHub Actions
> secrets, and the git-ignored `.dev.vars`. See [Secrets & credentials](#secrets--credentials).

---

## Tech stack

| Piece              | Choice                                           |
| ------------------ | ------------------------------------------------ |
| Runtime            | Cloudflare Workers (TypeScript, `nodejs_compat`) |
| Web framework      | Hono (`hono`)                                    |
| Database           | Cloudflare D1 (SQLite) — `DB` binding            |
| Cache / rate limit | Cloudflare KV — `CACHE_KV` binding               |
| Auth               | JWT (`jose`) — access + rotating refresh tokens  |
| Bot protection     | Cloudflare Turnstile                             |
| Deploy tooling     | Wrangler v4, GitHub Actions CI/CD                |

---

## What this backend does

### Public (no login required)

- **Book a visit** — `saveReservation` with visitor / prisoner / extra-visitor details,
  visit date, counts and computed totals.
- **Look up a booking by ref or prisoner ID** — `lookupByRef` (cached, TTL 15s).
- **Cancel a booking** — `publicCancelBooking` (public-facing cancel flow).
- **Upload a payment slip** — `uploadSlip` (base64 data URI, max ~2 MB in D1).
- **Live daily counts per visit date** — `getCountsByDate`.
- **Prisoner list** — `getPrisoners` (minified, cached 5 min).
- **Login** — `login` returns JWT access token + refresh token.

### Admin (JWT or legacy `username`+`pass` auth)

- **Reservations** — list, list with archive, archived list, per-date counts,
  dedupe/find-duplicate scans, cancel, update status, update visitor approval,
  update/edit a booking, create a booking, update slip + status.
- **Prisoners** — import (up to 5,000 rows), sync wings onto active reservations,
  re-check discipline status.
- **Users** — list, create, update, delete (Superadmin / `manage_users` permission).
- **Roles** — list, create custom roles with a permission matrix.
- **Notes** — add notes to a booking, get notes.
- **Settings** — save/get settings, read the data version counter.
- **Event log** — full audit trail of actions (login, bookings, approvals, errors…),
  plus client-side event logging.

### Auth & security

- Passwords hashed with `sha256$<salt>$<hash>`; legacy plaintext passwords are
  automatically re-hashed on first successful login.
- Default accounts are flagged and **forced to change password** on first login.
- Login rate limiting: max 5 attempts / 5 minutes per user (KV-backed).
- Access tokens live 15 min; refresh tokens 7 days (stored hashed, revocable).
- Turnstile server-side verification gates submissions (fail-closed).
- CORS restricted to `ALLOWED_ORIGINS` (comma-separated; `*` allowed in dev only).

### Rules & business logic

- Thai pricing: main visitor 2,000 THB, each approved extra visitor 1,000 THB,
  children under 5 free, children ≤ 8 pay 500 THB (`pricing.ts`).
- **Discipline status** (`ติดวินัย งดเยี่ยม`): prisoners with this status are blocked
  from new bookings; status auto-expires after 1 year (`disciplineService.ts`).
- **Archiving**: reservations older than 3 months are moved to the archive table
  (cron, 1st of every 3rd month).

### Slip verification & auto-approval (no bank API)

Thailand's banks print a **Mini-QR** on every transfer slip carrying the sending bank code and
a transaction reference. `services/slipverify.ts` scans the uploaded image (`upng-js` /
`jpeg-js` → `jsqr`, two passes because a slip usually carries both the Mini-QR and our own
payment QR), parses it with `@thai-qr-payment/payload`, and refuses a slip whose transaction —
or whose exact image bytes — already paid another booking (`slip_fingerprint` /
`slip_image_hash`).

That proves a slip is genuine and unused, but the Mini-QR carries no amount and no payee. Those
are printed as text, so a Workers AI vision model transcribes them (`services/slipOcr.ts`) and
`services/slipMatch.ts` matches them against the booking:

| Check          | Rule                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `authentic`    | a genuine bank / TrueMoney Mini-QR was found                               |
| `notDuplicate` | the transaction and image have not paid another booking                    |
| `amount`       | within 0.50 THB of the booking total                                       |
| `ref1`         | the slip's Reference 1 equals the configured biller `ref1`                 |
| `payee`        | receiving account tail or account name matches the configured payee        |
| `time`         | the printed timestamp is after the booking and within `SLIP_MAX_AGE_HOURS` |

All of `authentic`, `notDuplicate`, `amount` and `time` must pass, plus **either** `ref1` or
`payee` (a plain credit transfer prints no Ref1, so that check reads "not applicable"). Only
then, and only with `SLIP_AUTO_APPROVE_ENABLED="true"`, does an upload move the booking from
`รอชำระเงิน` to `ชำระแล้ว` on its own — everything else lands in the existing manual queue with
`slip_decision_json.blockedBy` naming what failed.

**Ref1/Ref2 are fixed by the biller agreement** — the bank assigns them, and a QR carrying
anything else is refused, so they are identical on every booking and identify the _payee_, never
the booking. Nothing printed on a slip names the booking it belongs to; what separates two
bookings of the same price is the amount, the printed time, and the transaction-reuse check —
a genuine transaction can settle exactly one booking, ever.

Cost: OCR runs **only** for slips that already passed the Mini-QR and duplicate checks, behind a
per-UTC-day budget (`SLIP_OCR_DAILY_MAX`) that fails closed. Workers AI includes 10,000 free
Neurons per day.

### Notifications

Web Push (RFC 8291, hand-rolled in `services/push.ts` — no `web-push` dependency) and the LINE
Messaging API (`services/line.ts`) both deliver through `services/notifications.ts`, which
writes an outbox row per recipient and retries pending rows from the daily cron.

Two knobs keep this inside the free tiers:

- `NOTIFY_EVENT_ALLOWLIST` — defaults to `payment_due` alone, the one moment a visitor has to
  act. Every other call site stays in the code and costs nothing.
- `NOTIFY_LINE_FALLBACK_ONLY` — LINE is only used for a booking that push did not reach, so the
  200-message monthly LINE allowance is spent only where it is the only option.

The frontend needs three calls: `GET /api/notify/publicKey` for the VAPID key, then
`POST /api/notify/subscribe` with `{ ref, endpoint, p256dh, auth }` from
`pushManager.subscribe`, and `POST /api/notify/unsubscribe` with `{ endpoint }`. LINE users
instead add the Official Account and reply with their booking ref, which
`POST /api/line/webhook` binds to their LINE user id.

### Scheduled tasks (cron, UTC)

| Schedule        | Bangkok time          | Job                                                             |
| --------------- | --------------------- | --------------------------------------------------------------- |
| `0 17 * * *`    | 00:00 daily           | Clear expired discipline status + delete expired refresh tokens |
| `15 17 1 */3 *` | 00:15, 1st of quarter | Archive reservations older than 3 months                        |

### Observability

- `/health` — human-readable HTML health page with D1, KV, and per-table row counts.
- `/api/health` — same data as JSON.
- Workers Observability is enabled in `wrangler.toml`.

---

## API surface

Two calling conventions are supported:

1. **Legacy action protocol** (1:1 with the old Apps Script backend):
   - `GET /?action=<name>&param=value…`
   - `POST /` or `POST /api` with JSON/form body `{ action, ...params }`
2. **REST aliases** (new-frontend friendly):
   - `GET /api/reservations`, `/api/reservations/archive`, `/api/reservations/counts`
   - `GET /api/lookup?ref=…`, `/api/prisoners`, `/api/roles`, `/api/users`, `/api/eventlog`,
     `/api/settings`, `/api/version`, `/api/ping`
   - `POST /api/login`, `/api/refresh`, `/api/reservations`, `/api/reservations/cancel`,
     `/api/reservations/slip`, `/api/notes`

See `src/routes/dispatcher.ts` for the full action → handler map and which actions
require authentication.

### Bulk actions

Every action is batchable through the single `bulk` action — `POST /api/bulk`, or
`{ action: 'bulk', … }` on the legacy endpoints. There is no per-action bulk handler:
a new action is bulk-capable the moment it lands in the dispatcher.

```jsonc
POST /api/bulk
{
  "status": "อนุมัติ",           // outer fields are defaults for every item
  "stopOnError": false,          // optional; default false = run them all
  "items": [
    { "action": "updateStatus", "ref": "VIS-0001" },
    { "action": "updateStatus", "ref": "VIS-0002", "status": "ปฏิเสธ" }, // item wins
    { "action": "addNote", "params": { "ref": "VIS-0003", "text": "…" } } // or nest under params
  ]
}
```

The response reports each item separately, so one bad row never sinks the batch:

```jsonc
{
  "status": "partial",           // "success" | "partial" | "error"
  "requested": 3, "processed": 3, "succeeded": 2, "failed": 1,
  "results": [
    { "index": 0, "action": "updateStatus", "status": "success", "result": { … } },
    { "index": 1, "action": "updateStatus", "status": "error", "message": "Unauthorized" }
  ]
}
```

Rules: at most 50 items per request; items run sequentially (handlers read-modify-write
the same rows and D1 has no transaction across them); auth is checked per item against
the caller, so a public bulk reaches only public actions; a `bulk` item inside a bulk is
rejected; and a bulk sent over `GET` can only reach `GET` actions — batching is not a
way to perform writes over `GET`.

---

## Project structure

```
src/
├── index.ts                  # Worker entry, Hono app, REST aliases, cron scheduler
├── config.ts                 # Timezone (Asia/Bangkok), sanitizers, date helpers
├── constants.ts              # Tables, permissions, statuses, fees, TTLs
├── types.ts                  # Env / shared TypeScript interfaces
├── auth/                     # JWT sign/verify + auth resolution (Bearer / legacy)
├── cache/                    # Chunked KV cache, key builders, invalidation, rate limit
├── db/
│   ├── migrations/           # 0001_initial … 0004_add_create_booking
│   └── queries/              # SQL per entity (reservations, prisoners, users, …)
├── middleware/               # HTTP helpers (CORS, JSON), Turnstile verify
├── routes/                   # One handler module per domain + action dispatcher
└── services/                 # Pricing, archiving, discipline, logging, reservation logic
scripts/
└── migrate-sheets.ts         # Google Sheets CSV → D1 seed.sql generator
data/                         # CSV exports + generated seed.sql (git-ignored)
.github/workflows/deploy.yml  # CI/CD: typecheck → lint → format → deploy → migrate
```

---

## Local development

Prerequisites: Node.js 22+, npm, and `wrangler` (bundled as a dev dependency).

```bash
npm install
wrangler login

# Create local config with your own secrets (never commit this file):
Copy-Item .dev.vars.example .dev.vars   # then fill in JWT_SECRET, JWT_REFRESH_SECRET, TURNSTILE_SECRET

npm run dev                              # starts wrangler dev (local D1/KV)
```

The local D1 database and KV namespace are emulated by `wrangler dev`. Apply migrations
locally before testing:

```bash
npm run migrate:local
```

## Managing the backend

### Quality gates

```bash
npm run typecheck     # TypeScript type check (tsc --noEmit)
npm run lint          # ESLint
npm run lint:fix
npm run format        # Prettier (write)
npm run format:check  # Prettier (verify — run by CI)
npm run build         # typecheck + wrangler deploy --dry-run
```

### Deploying

```bash
npm run deploy        # production  → https://ccc-backend.<your-subdomain>.workers.dev
npm run deploy:dev    # development → https://ccc-backend-dev.<your-subdomain>.workers.dev
```

CI (`.github/workflows/deploy.yml`) deploys automatically and picks its target from the
branch that was pushed — see [Environments](#environments) below.

### Environments

Two isolated stacks. `[env.development]` in `wrangler.toml` redeclares every binding,
because wrangler does **not** inherit top-level `[vars]`, `[[d1_databases]]`,
`[[kv_namespaces]]` or `[triggers]` into an environment block.

|                 | Production (`main`)        | Development (`dev`)                |
| --------------- | -------------------------- | ---------------------------------- |
| Worker          | `ccc-backend`              | `ccc-backend-dev`                  |
| D1              | `ccc-reservations`         | `ccc-reservations-dev`             |
| KV              | `ccc-cache`                | `ccc-cache-dev`                    |
| `CACHE_VERSION` | `v4`                       | `dev-v1`                           |
| Cron            | daily + quarterly          | none (`crons = []`)                |
| Turnstile       | real widget                | Cloudflare test keys (always pass) |
| Notifications   | configurable               | forced off                         |
| Frontend        | `cida.dpdns.org`           | `dev.ccc-frontend.pages.dev`       |
| Dashboard       | `dashboard.cida.dpdns.org` | `dev.ccc-dashboard-6jh.pages.dev`  |

Dev commands all carry `--env development` (or target the `-dev` database by name):

```bash
npm run dev:dev            # wrangler dev against the development env
npm run deploy:dev
npm run migrate:dev
npm run db:sanitize:dev    # scrub PII after re-seeding
```

Secrets are stored per environment, so the dev worker needs its own — use
**different** JWT secrets so a dev-issued token is worthless against production:

```bash
npx wrangler secret put JWT_SECRET --env development
npx wrangler secret put JWT_REFRESH_SECRET --env development
npx wrangler secret put TURNSTILE_SECRET --env development
```

Dev uses Cloudflare's official Turnstile **test** keys, which always pass and never
render a challenge — secret `1x0000000000000000000000000000000AA`, site key
`1x00000000000000000000AA`. That removes the need for a separate dev widget; never use
them in production.

`ALLOWED_ORIGINS` is matched as an **exact full-origin string** (`makeCorsHeaders` in
`src/middleware/http.ts`) — no wildcards, no subdomain matching, so every dev origin is
listed literally. `TURNSTILE_ALLOWED_HOSTNAMES` _does_ match subdomains.

Cron is deliberately disabled on dev: the daily discipline cleanup and the quarterly
archive job would otherwise mutate dev data in the background. Exercise them on demand
with `npx wrangler dev --env development --test-scheduled`.

#### Refreshing the dev database from production

The dev D1 is seeded from a production export so it behaves realistically, then scrubbed.
Payment slips are stored as base64 in `reservations.slip_base64` and some rows exceed
D1's per-statement limit, so the raw dump cannot be imported directly —
`scripts/prepare-dev-dump.ts` blanks those oversized literals, which removes the slip
images and the size problem in one pass.

```bash
npx wrangler d1 export ccc-reservations --remote --output ./data/prod-dump.sql
npx tsx scripts/prepare-dev-dump.ts        # → ./data/dev-dump.sql
npx wrangler d1 execute ccc-reservations-dev --remote --file=./data/dev-dump.sql
npm run db:sanitize:dev                    # scrub names, IDs, phones, IPs, notes
```

`scripts/sanitize-dev-db.sql` is idempotent and re-runnable. It leaves `users`, `roles`,
`settings` and `prisoners` intact so logins, permissions and pricing behave like
production. **Never run it against `ccc-reservations`** — prefer the npm script, which
pins the dev database name.

### Database migrations

```bash
npm run migrate         # apply pending migrations to remote D1
npm run migrate:local   # apply to the local emulator
```

New schema changes go in `src/db/migrations/NNNN_description.sql` in the format
`0005_<description>.sql` (keep the sequential numbering).

### Seeding data from Google Sheets

The legacy data lives in Google Sheets. Export each sheet as CSV into `data/`, then:

```bash
npm run db:seed          # reads data/*.csv → generates data/seed.sql (hashes passwords)
npm run db:execute       # applies data/seed.sql to remote D1
```

If `data/seed.sql` gets too large for one `execute`, split it and apply the files in order.

### Creating resources (one-time setup)

Only needed if you are standing up a new environment from scratch. Paste the returned
IDs into `wrangler.toml`.

```bash
wrangler d1 create ccc-reservations        # → paste database_id under [[d1_databases]]
wrangler kv namespace create ccc-cache     # → paste id under [[kv_namespaces]]
```

### Secrets & credentials

Set secrets with `wrangler secret` so they never appear in the repo or bundle:

```bash
wrangler secret put JWT_SECRET
wrangler secret put JWT_REFRESH_SECRET
wrangler secret put TURNSTILE_SECRET

# Notifications — only needed once NOTIFY_PUSH_ENABLED / NOTIFY_LINE_ENABLED are "true"
wrangler secret put VAPID_PUBLIC_KEY        # Web Push keypair (see below)
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT           # e.g. mailto:admin@example.com
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_OA_ID
```

Generate the VAPID keypair once (base64url, uncompressed P-256):

```bash
npx web-push generate-vapid-keys
```

The public half is served to the frontend by `GET /api/notify/publicKey`, so the browser
never hardcodes it. The private half stays a secret and signs the VAPID JWT in
`src/services/push.ts`.

- Local-only copies live in `.dev.vars` (git-ignored). `.dev.vars.example` shows the keys.
- For CI, add the following GitHub Actions secrets (repo Settings → Secrets and variables → Actions):

| Secret                                     | Purpose                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| `CF_API_TOKEN` or `CLOUDFLARE_API_TOKEN`   | Cloudflare API token with Workers/D1 edit permission |
| `CF_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                                |

### Configuration variables (`wrangler.toml` → `[vars]`)

| Var               | Purpose                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `CACHE_VERSION`   | Bump (e.g. `v4`) to invalidate all KV caches after a deploy       |
| `ALLOWED_ORIGINS` | Comma-separated frontend origins allowed by CORS. `*` in dev only |
| `PASSWORD_SALT`   | Salt used for password hashing (keep consistent across deploys)   |

Notification and slip-verification vars:

| Var                         | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `NOTIFY_PUSH_ENABLED`       | `"true"` to deliver Web Push. Free and unlimited                             |
| `NOTIFY_LINE_ENABLED`       | `"true"` to deliver LINE messages (free tier: 200/month)                     |
| `NOTIFY_EVENT_ALLOWLIST`    | Comma-separated events allowed to send. Default `payment_due` only           |
| `NOTIFY_LINE_FALLBACK_ONLY` | `"true"` = LINE only when push did not reach the visitor, to protect the cap |
| `LINE_MONTHLY_CAP`          | Fallback monthly LINE cap (an admin setting wins)                            |
| `SLIP_OCR_ENABLED`          | `"true"` to read amount/Ref1/payee/time off slips with Workers AI            |
| `SLIP_OCR_MODEL`            | Vision model id, default `@cf/meta/llama-4-scout-17b-16e-instruct`           |
| `SLIP_OCR_DAILY_MAX`        | Inference budget per UTC day (Workers AI gives 10,000 free Neurons/day)      |
| `SLIP_AUTO_APPROVE_ENABLED` | `"true"` lets a fully matched slip set `ชำระแล้ว` by itself                  |
| `SLIP_MAX_AGE_HOURS`        | Slips older than this (by their printed time) never auto-approve             |

### Cron triggers

Cron schedules are declared in `wrangler.toml` under `[triggers]`. They deploy with the
worker. Logs from scheduled runs appear in Workers Observability.

### Verifying a deploy

```bash
curl https://ccc-backend.<your-subdomain>.workers.dev/api/ping
curl https://ccc-backend.<your-subdomain>.workers.dev/health       # HTML dashboard
curl https://ccc-backend.<your-subdomain>.workers.dev/api/health   # JSON
```

---

## Notes

- All timestamps are UTC internally; human-readable output uses `Asia/Bangkok` (`config.ts`).
- D1 cells cap at ~2 MB, so payment slips are limited accordingly (the legacy 20 MB
  limit does not apply here).
- The legacy `Google_Scripts.js` file is kept for reference/parity with the old backend
  but is not used at runtime.
