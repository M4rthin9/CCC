-- Migration 0007: slip reuse / duplicate-payment detection.
-- slip_fingerprint  — dedupes on the actual bank transaction: `slipVerify` bank
--                      Mini-QR -> `sendingBank:transRef`, TrueMoney Mini-QR ->
--                      `truemoney:transactionId`. Empty when the slip only
--                      carried our own paymentQr (no transaction id exists to
--                      dedupe on) or nothing was parsed.
-- slip_image_hash    — SHA-256 (hex) of the raw slip image bytes, a fallback
--                      that catches the exact same file being re-uploaded even
--                      when the QR itself didn't yield a fingerprint.
ALTER TABLE reservations ADD COLUMN slip_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN slip_image_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations_archive ADD COLUMN slip_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN slip_image_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_reservations_slip_fingerprint ON reservations (slip_fingerprint) WHERE slip_fingerprint != '';
CREATE INDEX IF NOT EXISTS idx_reservations_slip_image_hash ON reservations (slip_image_hash) WHERE slip_image_hash != '';
