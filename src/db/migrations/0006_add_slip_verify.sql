-- Migration 0006: slip QR verification results.
-- The slip-verify Mini-QR (and/or the payment QR) printed on a bank slip is
-- scanned from the uploaded slip image and parsed with @thai-qr-payment/payload.
-- The outcome is persisted here so admins can review it without re-scanning:
--   slip_verify_status — 'ok' | 'mismatch' | 'slip_verify' | 'unreadable' | '' (not yet verified)
--   slip_verify_json   — parsed JSON: kind, sendingBank/transRef or billPayment fields,
--                        and per-field match booleans vs the booking's expected values
--   slip_verify_at     — ISO timestamp of the last verification attempt

ALTER TABLE reservations ADD COLUMN slip_verify_status TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN slip_verify_json TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN slip_verify_at TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations_archive ADD COLUMN slip_verify_status TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN slip_verify_json TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN slip_verify_at TEXT NOT NULL DEFAULT '';
