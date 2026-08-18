# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Serverless backend for a Thai prison visitor reservation system, migrated from a legacy
Google Apps Script + Sheets implementation to **Cloudflare Workers (Hono) + D1 + KV**. Serves
both the public booking flow and an admin dashboard (approvals, payments, prisoners, users,
event logs, settings). See `README.md` for the full feature list, API surface, and business rules
(pricing, discipline-status blocking, archiving).

## Commands

```bash
npm run dev              # wrangler dev (local D1/KV emulation)
npm run typecheck        # tsc --noEmit
npm run lint             # eslint src scripts
npm run lint:fix
npm run format            # prettier --write
npm run format:check      # prettier --check (CI)
npm run build             # typecheck + wrangler deploy --dry-run
npm run smoke              # tsx scripts/verify-smoke.ts

npm run migrate:local     # apply D1 migrations to local emulator
npm run migrate           # apply D1 migrations to remote
npm run deploy             # wrangler deploy
```

There is no unit test runner configured — `npm run smoke` (`scripts/verify-smoke.ts`) is the
closest thing to an integration check; `npm run build` (typecheck + dry-run deploy) is the
main correctness gate, matching CI (`.github/workflows/deploy.yml`: typecheck → lint →
format → deploy → migrate).

Local secrets: `Copy-Item .dev.vars.example .dev.vars` and fill in `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `TURNSTILE_SECRET` before `npm run dev`.

## Architecture

**Dual calling convention, one dispatcher.** All business logic is reached through a single
action-based dispatcher (`src/routes/dispatcher.ts`), 1:1 with the old Apps Script
`GET_ROUTES`/`POST_ROUTES`. `src/index.ts` wires two ways to reach it:

- Legacy: `GET /?action=<name>&...` or `POST /` / `POST /api` with `{ action, ...params }`.
- REST aliases (in `index.ts`): e.g. `GET /api/reservations` — these are thin wrappers that
  just call `runDispatch` with a hardcoded `action`, converting query/body into the same
  `RouteCtx` shape. When adding a new capability, add the action + handler to
  `dispatcher.ts`/`routes/*.ts` first; a REST alias is optional sugar on top.

Each route in `dispatcher.ts` declares `auth: boolean`. Auth resolution (JWT Bearer or legacy
`username`+`pass`) happens once per request in `resolveAuthUser` (`src/auth/middleware.ts`)
before dispatch, producing `AuthenticatedUser | null` on `RouteCtx`.

**Layering**: `routes/*.ts` (HTTP-shaped handlers, one module per domain) → `services/*.ts`
(business logic: pricing, discipline status, archiving, PromptPay/QR generation, push/LINE
notifications) → `db/queries/*.ts` (raw SQL against D1, one module per table/entity). Route
handlers should not embed SQL directly — add/extend a query function instead.

**Caching**: `src/cache/` implements a chunked KV cache (mirroring the old Apps Script
`CacheService`, which had a per-key size limit) — `kv.ts` for get/set/chunking, `keys.ts` for
key naming, `invalidation.ts` for cache-busting on writes. `CACHE_VERSION` in `wrangler.toml`
`[vars]` is a blunt global-invalidation knob (bump it to drop all caches on deploy).

**PromptPay/QR**: `services/promptpay.ts` + `promptpayCard.ts` + `promptpayConfig.ts` +
`qrImage.ts` build Thai PromptPay QR payloads and render them as branded PNG cards using the
`qrcode` package (not the now-removed vendored `@thai-qr-payment` encoder — a prior vendored
encoder diverged from spec and was rejected by bank apps; see git log). `slipQr.ts` (routes
and services) generates a verification QR for uploaded payment slips.

**Timezone**: all timestamps are stored/computed in UTC; human-readable output converts to
`Asia/Bangkok` via helpers in `src/config.ts`. Use those helpers rather than ad hoc `Date`
math when displaying or bucketing by visit date.

**D1 migrations**: sequential SQL files in `src/db/migrations/000N_description.sql`, run
by `wrangler d1 migrations apply` (see `migrate`/`migrate:local` scripts). Keep numbering
sequential when adding a new one.

**Env bindings** (`src/types.ts` `Env` interface): `DB` (D1), `CACHE_KV` (KV), plus vars from
`wrangler.toml` `[vars]` (`CACHE_VERSION`, `PASSWORD_SALT`, `ALLOWED_ORIGINS`,
`TURNSTILE_ALLOWED_HOSTNAMES`, `NOTIFY_PUSH_ENABLED`, `NOTIFY_LINE_ENABLED`,
`LINE_MONTHLY_CAP`) and secrets set via `wrangler secret put` (`JWT_SECRET`,
`JWT_REFRESH_SECRET`, `TURNSTILE_SECRET`).

**Cron** (`wrangler.toml` `[triggers]`, handled in `index.ts` `scheduled()`): daily
expired-discipline cleanup + expired-refresh-token deletion; quarterly archiving of
reservations older than 3 months into an archive table.
