# CC Cafe Reservation — Cloudflare Backend

ระบบจองคิวเพื่อร่วมกิจกรรม — ทัณฑสถานบำบัดพิเศษกลาง

Cloudflare Workers backend that **replaces the Google Apps Script backend**
(`Google_Scripts.js` is kept in this repo only as the previous-migration reference
for behavior parity).

## Stack (new technology, no Apps Script)

- **Cloudflare Workers** + **TypeScript** + **Hono** router + **Zod** validation
- **D1** (SQLite) — the single database (all data: bookings, prisoners, users, roles, notes, event log, settings, sessions)
- **R2** — slip images (replaces Google Drive)
- **KV** (`CC_CACHE`) — throwaway speed layer (parity TTLs)
- **Durable Object** (`RealtimeHub`) — WebSocket realtime for admin
- **Cron triggers** — daily discipline cleanup, quarterly archive, nightly backups to R2

## Endpoints

All REST under `/api/*` (see `worker/src/router.ts` for the full parity table).
Auth via httpOnly `cc_session` cookie; sessions in D1.

## First-time setup

```bash
npm install

# Cloudflare resources (replace placeholder IDs in wrangler.jsonc)
npm run db:create       # wrangler d1 create cc-cafe-reservation-db
npm run bucket:create   # wrangler r2 bucket create cc-cafe-reservation-slips
npm run kv:create       # wrangler kv namespace create CC_CACHE

# secrets
wrangler secret put TURNSTILE_SECRET
wrangler secret put SEED_USERS_JSON     # [["admin","pass123","Superadmin","Admin"]]
wrangler secret put ADMIN_EXPORT_TOKEN

# local DB
npm run db:migrate:local

# run / test / deploy
npm run dev
npm run test
npm run build
npm run deploy
```

## Migration from Google Sheets

1. Add `exportAllData_` to the GAS project (protected by `ADMIN_EXPORT_TOKEN`) returning
   bookings (active + archive), prisoners, users, roles, notes, event log, admin settings.
2. Run `npm run db:seed -- --export-url <GAS_URL> --token <ADMIN_EXPORT_TOKEN>`
   → pre-checks duplicate prisoner+date active bookings (fails loudly),
   emits `migrations/seed.sql` + a parity report.
3. Apply: `wrangler d1 migrations apply cc-cafe-reservation-db --remote` then
   `wrangler d1 execute cc-cafe-reservation-db --remote --file=migrations/seed.sql`.

## Caching model

All data lives only in D1. KV + edge cache are ephemeral speed layers; every cache
read falls back to D1 on miss. Cache keys embed the D1 `meta(version)` counter so
a write orphans stale entries by TTL.

## Frontend integration (later phase)

Point `config.js`/page wrappers at same-origin `/api` with cookie auth. Not part of
this backend phase.
