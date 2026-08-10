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

| Piece              | Choice                                            |
| ------------------ | ------------------------------------------------- |
| Runtime            | Cloudflare Workers (TypeScript, `nodejs_compat`)  |
| Web framework      | Hono (`hono`)                                     |
| Database           | Cloudflare D1 (SQLite) — `DB` binding             |
| Cache / rate limit | Cloudflare KV — `CACHE_KV` binding                |
| Auth               | JWT (`jose`) — access + rotating refresh tokens   |
| Bot protection     | Cloudflare Turnstile                              |
| Deploy tooling     | Wrangler v4, GitHub Actions CI/CD                 |

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

### Scheduled tasks (cron, UTC)
| Schedule        | Bangkok time        | Job                                                   |
| --------------- | ------------------- | ----------------------------------------------------- |
| `0 17 * * *`    | 00:00 daily         | Clear expired discipline status + delete expired refresh tokens |
| `15 17 1 */3 *` | 00:15, 1st of quarter | Archive reservations older than 3 months            |

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
npm run deploy        # wrangler deploy → https://ccc-backend.<your-subdomain>.workers.dev
```

Deploys are also triggered automatically by CI on every push to `main`.

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
```

- Local-only copies live in `.dev.vars` (git-ignored). `.dev.vars.example` shows the keys.
- For CI, add the following GitHub Actions secrets (repo Settings → Secrets and variables → Actions):

| Secret                    | Purpose                                  |
| ------------------------- | ---------------------------------------- |
| `CF_API_TOKEN` or `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers/D1 edit permission |
| `CF_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                   |

### Configuration variables (`wrangler.toml` → `[vars]`)

| Var                | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `CACHE_VERSION`    | Bump (e.g. `v4`) to invalidate all KV caches after a deploy   |
| `ALLOWED_ORIGINS`  | Comma-separated frontend origins allowed by CORS. `*` in dev only |
| `PASSWORD_SALT`    | Salt used for password hashing (keep consistent across deploys) |

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
