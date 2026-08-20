-- Migration 0009: automated slip decision (OCR + matching, no bank Open API).
-- The Mini-QR in 0006/0007 only proves a slip is *real* and unused; it carries
-- no amount or payee. These columns hold what was read off the slip image and
-- the decision that came out of matching it against the booking:
--   slip_ocr_json      — verbatim fields transcribed by the vision model
--                        (amount, dateTimeText, ref1, receiverName,
--                        receiverAccountTail, senderName). '' = OCR not run.
--   slip_decision      — 'auto_approved' | 'review' | '' (not yet decided)
--   slip_decision_json — per-check booleans + score, so the dashboard can show
--                        *why* a slip did not auto-approve.
ALTER TABLE reservations ADD COLUMN slip_ocr_json TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN slip_decision TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN slip_decision_json TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations_archive ADD COLUMN slip_ocr_json TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN slip_decision TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN slip_decision_json TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_reservations_slip_decision
  ON reservations (slip_decision) WHERE slip_decision != '';
