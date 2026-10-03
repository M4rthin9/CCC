-- Migration 0020: correct four archived legacy bookings that charged a child
-- as an adult.
--
-- These rows came from the Apps Script sheet (createdBy = 'legacy') with a
-- total that ignores the child ladder (<5 free, 5-8 half). Their age-bucket
-- counts are right; only `total` is off, which inflated the daily report —
-- 24 Jul 2026 showed 48,000 against the 47,000 actually collected. Each update
-- is guarded on the old total so a re-run changes nothing, and each change is
-- written to the event log first.

INSERT INTO event_log (timestamp, username, action, targetRef, details, result)
SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', '+7 hours'), 'system', 'legacy_total_corrected', ref,
       json_object('visitDateISO', visitDateISO, 'from', total,
                   'to', CASE ref WHEN 'VIS-37212' THEN 2500 ELSE 2000 END,
                   'reason', 'child charged as adult in legacy import', 'via', 'migration 0020'),
       'success'
FROM reservations_archive
WHERE total = 3000 AND ref IN ('VIS-37212', 'VIS-81233', 'VIS-59051', 'VIS-62668');

UPDATE reservations_archive SET total = 2500 WHERE ref = 'VIS-37212' AND total = 3000;
UPDATE reservations_archive SET total = 2000 WHERE ref IN ('VIS-81233', 'VIS-59051', 'VIS-62668') AND total = 3000;
