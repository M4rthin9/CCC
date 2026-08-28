-- 0012: parallel "table booking" flow — reservations with no prisoner attached.
--
-- These share the reservations table with the existing prisoner-visit flow so the
-- whole payment half (PromptPay QR, slip upload/verify, admin approval) keeps
-- working unchanged: all of it keys off `ref` and `total` only.
--
-- bookingType   — 'prisoner' = the existing 4-stage visit flow (participant check →
--                 discipline check → payment). 'table' = no-prisoner seating, which
--                 starts straight at 'รอชำระเงิน'. Defaults to 'prisoner' so every
--                 pre-existing row keeps today's behaviour.
-- holdExpiresAt — ISO UTC instant after which an UNPAID table booking stops consuming
--                 one of the day's table slots. '' = no hold, which covers every
--                 prisoner booking and any table booking that has been paid.
ALTER TABLE reservations         ADD COLUMN bookingType   TEXT NOT NULL DEFAULT 'prisoner';
ALTER TABLE reservations         ADD COLUMN holdExpiresAt TEXT NOT NULL DEFAULT '';

-- The archive table must stay column-identical: insertArchivedReservation inserts the
-- shared RESERVATION_COLUMNS list plus archivedAt.
ALTER TABLE reservations_archive ADD COLUMN bookingType   TEXT NOT NULL DEFAULT 'prisoner';
ALTER TABLE reservations_archive ADD COLUMN holdExpiresAt TEXT NOT NULL DEFAULT '';

-- Serves the per-day capacity count on the public booking hot path.
CREATE INDEX IF NOT EXISTS idx_reservations_tableday
  ON reservations (bookingType, visitDateISO, status);
