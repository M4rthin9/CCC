-- 0013: track when a booking was cancelled so the daily cron can permanently
-- delete cancelled rows once they are well past their use (48h after cancel or
-- 2 days after the visit date), keeping the reservation page clean.
--
-- cancelAt — ISO UTC instant the booking was marked ยกเลิก. '' = not cancelled.
ALTER TABLE reservations         ADD COLUMN cancelAt TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN cancelAt TEXT NOT NULL DEFAULT '';
