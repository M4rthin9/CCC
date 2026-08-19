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
--
-- `extraVisitorNames` is a `;;`-separated list of `name|id|relation|age` tuples
-- (see parseExtraVisitorNames in src/services/pricing.ts). The replacement below
-- rebuilds the SAME NUMBER of well-formed tuples, so the stored visitorCount /
-- adultCount / total stay consistent with what the parser sees — otherwise the
-- next admin edit would silently recompute a smaller, cheaper booking.
-- `replace(hex(zeroblob(n)), '00', tpl)` is the SQLite idiom for repeat(tpl, n);
-- the trailing `;;` is trimmed by the outer substr.

-- ── Live reservations ──────────────────────────────────────────────
UPDATE reservations SET
  visitorName          = 'ผู้เยี่ยมทดสอบ ' || substr(ref, -4),
  visitorId            = '0000000000000',
  visitorPhone         = '08' || substr('00000000' || abs(random() % 100000000), -8),
  extraVisitorNames    = CASE WHEN extraVisitorNames = '' THEN ''
                              ELSE substr(
                                replace(
                                  hex(zeroblob(
                                    (length(extraVisitorNames) - length(replace(extraVisitorNames, ';;', ''))) / 2 + 1
                                  )),
                                  '00',
                                  'ผู้ติดตามทดสอบ ' || substr(ref, -4) || '|0000000000000|เพื่อน|30;;'
                                ),
                                1,
                                length(replace(
                                  hex(zeroblob(
                                    (length(extraVisitorNames) - length(replace(extraVisitorNames, ';;', ''))) / 2 + 1
                                  )),
                                  '00',
                                  'ผู้ติดตามทดสอบ ' || substr(ref, -4) || '|0000000000000|เพื่อน|30;;'
                                )) - 2
                              ) END,
  -- Payment slips are photographs of real bank transfers, and the verification
  -- columns carry the bank's own transaction identifiers (sendingBank:transRef)
  -- plus the parsed receipt payload — every bit as identifying as the image.
  slipImage            = '',
  slip_base64          = '',
  slip_verify_status   = '',
  slip_verify_json     = '',
  slip_verify_at       = '',
  slip_fingerprint     = '',
  slip_image_hash      = '';

-- ── Archived reservations (same shape, plus archivedAt) ────────────
UPDATE reservations_archive SET
  visitorName          = 'ผู้เยี่ยมทดสอบ ' || substr(ref, -4),
  visitorId            = '0000000000000',
  visitorPhone         = '08' || substr('00000000' || abs(random() % 100000000), -8),
  extraVisitorNames    = CASE WHEN extraVisitorNames = '' THEN ''
                              ELSE substr(
                                replace(
                                  hex(zeroblob(
                                    (length(extraVisitorNames) - length(replace(extraVisitorNames, ';;', ''))) / 2 + 1
                                  )),
                                  '00',
                                  'ผู้ติดตามทดสอบ ' || substr(ref, -4) || '|0000000000000|เพื่อน|30;;'
                                ),
                                1,
                                length(replace(
                                  hex(zeroblob(
                                    (length(extraVisitorNames) - length(replace(extraVisitorNames, ';;', ''))) / 2 + 1
                                  )),
                                  '00',
                                  'ผู้ติดตามทดสอบ ' || substr(ref, -4) || '|0000000000000|เพื่อน|30;;'
                                )) - 2
                              ) END,
  slipImage            = '',
  slip_base64          = '',
  slip_verify_status   = '',
  slip_verify_json     = '',
  slip_verify_at       = '',
  slip_fingerprint     = '',
  slip_image_hash      = '';

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

-- Force every cached payload to be rebuilt from the scrubbed rows. The counter
-- the dashboard polls via /api/version lives in `settings`, not in the unused
-- `data_version` table — mirror bumpDataVersion() in src/db/queries/settings.ts.
INSERT INTO settings (key, value, savedBy, savedAt)
  VALUES ('data_version', CAST(strftime('%s', 'now') AS TEXT), 'sanitize', datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);
