-- Scrub personally-identifiable data from the DEVELOPMENT database.
--
-- The dev DB is seeded from a production export so that dev behaves realistically,
-- but that export carries real visitor names, phone numbers and national ID numbers.
-- Run this IMMEDIATELY after every import:
--
--   npx wrangler d1 execute ccc-reservations-dev --remote --file=./scripts/sanitize-dev-db.sql
--
-- Deliberately NOT touched, because dev needs them to behave like production:
--   users / roles / settings — real logins, permissions and pricing config
--   prisoners                — inmate records drive wing/discipline logic
--   reservations.status, dates, counts, totals — the actual business state under test
--
-- Safe to re-run: every statement is idempotent.
--
-- SAFETY: this file must never be executed against `ccc-reservations` (production).
-- The npm script `db:sanitize:dev` pins the dev database name for you — prefer it
-- over typing the wrangler command by hand.

-- ── Live reservations ──────────────────────────────────────────────
UPDATE reservations SET
  visitorName          = 'ผู้เยี่ยมทดสอบ ' || substr(ref, -4),
  visitorId            = '0000000000000',
  visitorPhone         = '08' || substr('00000000' || abs(random() % 100000000), -8),
  extraVisitorNames    = CASE WHEN extraVisitorNames = '' THEN ''
                              ELSE 'ผู้ติดตามทดสอบ ' || substr(ref, -4) END,
  -- Payment slips are photographs of real bank transfers.
  slipImage            = '',
  slip_base64          = '';

-- ── Archived reservations (same shape, plus archivedAt) ────────────
UPDATE reservations_archive SET
  visitorName          = 'ผู้เยี่ยมทดสอบ ' || substr(ref, -4),
  visitorId            = '0000000000000',
  visitorPhone         = '08' || substr('00000000' || abs(random() % 100000000), -8),
  extraVisitorNames    = CASE WHEN extraVisitorNames = '' THEN ''
                              ELSE 'ผู้ติดตามทดสอบ ' || substr(ref, -4) END,
  slipImage            = '',
  slip_base64          = '';

-- ── Free-text notes may quote visitor details ─────────────────────
UPDATE notes SET text = '[note redacted for dev]';

-- ── Event log holds IPs, user agents and detail payloads ──────────
UPDATE event_log SET
  ip        = '0.0.0.0',
  userAgent = 'dev-sanitised',
  details   = '[redacted for dev]';

-- ── Notification channels: drop entirely so dev can never reach a
--    real person even if NOTIFY_* are switched on by mistake. ──────
DELETE FROM push_subscriptions;
DELETE FROM line_friends;
DELETE FROM notifications;

-- ── Sessions: prod refresh tokens must not be redeemable on dev ───
DELETE FROM refresh_tokens;

-- Force every cached payload to be rebuilt from the scrubbed rows.
UPDATE data_version SET version = version + 1 WHERE id = 1;
