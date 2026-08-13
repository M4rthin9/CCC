-- 0008: per-booking PromptPay invoice ref + main-visitor age for pricing recalc.
-- payment_ref1 — Reference 1 on the booking's PromptPay BillPayment QR. Minted
--                lazily on first QR/slip-verify access (services/paymentRef.ts);
--                '' means "not yet issued" and falls back to the static sample ref.
-- visitorAge   — main visitor's age as free text; '' = unknown (priced as adult).
--                TEXT, not INTEGER, so '' stays distinguishable from 0.
ALTER TABLE reservations ADD COLUMN payment_ref1 TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN visitorAge   TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations_archive ADD COLUMN payment_ref1 TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN visitorAge   TEXT NOT NULL DEFAULT '';

-- Enforces ref1 uniqueness so ensureBookingPaymentRef can retry on violation
-- instead of scanning the table. Partial, because '' is the un-issued sentinel
-- and repeats on every legacy row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_payment_ref1
  ON reservations (payment_ref1) WHERE payment_ref1 != '';
