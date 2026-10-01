-- Migration 0017: reschedule seven visits from Mon 28 Sep 2026 to Mon 5 Oct 2026.
--
-- The bookings below were archived with the rest of September. 5 Oct is inside
-- the live window, so they move back into `reservations` with the new date —
-- left in the archive they would stay read-only and out of the day's lists.
-- Every other column (status, payment, slip, visitors) is carried over as is.
-- A row leaves the archive only once it is in the live table, and each move
-- is written to the event log.

INSERT OR IGNORE INTO reservations (
  ref, timestamp, visitorName, visitorId, visitorPhone, relation, religion,
  allergy, extraVisitorReligions, extraVisitorAllergies, extraVisitorNames,
  visitorApproved, extraVisitorApproved, prisonerName, prisonerId, wing,
  visitDate, visitDateISO, visitorCount, totalPersons, total, adultCount,
  child5to8Count, childUnder5Count, status, slipImage, slip_base64,
  cancelReason, createdAt, updatedAt, version, createdBy, source,
  slip_verify_status, slip_verify_json, slip_verify_at, slip_fingerprint,
  slip_image_hash, payment_ref1, visitorAge, slip_ocr_json, slip_decision,
  slip_decision_json, slip_key, bookingType, holdExpiresAt, cancelAt
)
SELECT
  ref, timestamp, visitorName, visitorId, visitorPhone, relation, religion,
  allergy, extraVisitorReligions, extraVisitorAllergies, extraVisitorNames,
  visitorApproved, extraVisitorApproved, prisonerName, prisonerId, wing,
  'วันจันทร์ที่ 5 ตุลาคม 2569', '2026-10-05', visitorCount, totalPersons, total, adultCount,
  child5to8Count, childUnder5Count, status, slipImage, slip_base64,
  cancelReason, createdAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version + 1, createdBy, source,
  slip_verify_status, slip_verify_json, slip_verify_at, slip_fingerprint,
  slip_image_hash, payment_ref1, visitorAge, slip_ocr_json, slip_decision,
  slip_decision_json, slip_key, bookingType, holdExpiresAt, cancelAt
FROM reservations_archive
WHERE ref IN ('VIS-15326', 'VIS-21775', 'VIS-31252', 'VIS-43330', 'VIS-43861', 'VIS-73239', 'VIS-90290');

DELETE FROM reservations_archive
WHERE ref IN ('VIS-15326', 'VIS-21775', 'VIS-31252', 'VIS-43330', 'VIS-43861', 'VIS-73239', 'VIS-90290')
  AND ref IN (SELECT ref FROM reservations WHERE visitDateISO = '2026-10-05');

INSERT INTO event_log (timestamp, username, action, targetRef, details, result)
SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', '+7 hours'), 'system', 'reschedule_booking', ref,
       '{"from":"2026-09-28","to":"2026-10-05","via":"migration 0017"}', 'success'
FROM reservations
WHERE ref IN ('VIS-15326', 'VIS-21775', 'VIS-31252', 'VIS-43330', 'VIS-43861', 'VIS-73239', 'VIS-90290')
  AND visitDateISO = '2026-10-05';

-- Fresh counts for the public calendar and fresh lists for open dashboards.
DELETE FROM d1_cache WHERE key NOT LIKE 'rl:%';
UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
WHERE key IN ('data_version', 'data_version:reservations');
