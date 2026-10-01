-- Migration 0016: reset October 2026 bookings.
--
-- Every booking with a visit date in October 2026 (any status, both booking
-- types) leaves the live `reservations` table so the month can be booked again
-- from scratch. Nothing is destroyed: each row is copied into
-- `reservations_backup` first, and a row is deleted only once its copy exists.
--
-- `reservations_backup` is deliberately NOT `reservations_archive`: the archive
-- feeds the dashboard's "include archive" view and the finance report, and
-- these reset bookings must not count as business. No code reads this table;
-- it exists so a reset booking can still be found by ref (e.g. to refund a
-- slip) with a direct D1 query.

CREATE TABLE IF NOT EXISTS reservations_backup (
  ref TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT '',
  visitorName TEXT NOT NULL DEFAULT '',
  visitorId TEXT NOT NULL DEFAULT '',
  visitorPhone TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL DEFAULT '',
  religion TEXT NOT NULL DEFAULT '',
  allergy TEXT NOT NULL DEFAULT '',
  extraVisitorReligions TEXT NOT NULL DEFAULT '',
  extraVisitorAllergies TEXT NOT NULL DEFAULT '',
  extraVisitorNames TEXT NOT NULL DEFAULT '',
  visitorApproved TEXT NOT NULL DEFAULT '',
  extraVisitorApproved TEXT NOT NULL DEFAULT '',
  prisonerName TEXT NOT NULL DEFAULT '',
  prisonerId TEXT NOT NULL DEFAULT '',
  wing TEXT NOT NULL DEFAULT '',
  visitDate TEXT NOT NULL DEFAULT '',
  visitDateISO TEXT NOT NULL DEFAULT '',
  visitorCount INTEGER NOT NULL DEFAULT 0,
  totalPersons INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  adultCount INTEGER NOT NULL DEFAULT 0,
  child5to8Count INTEGER NOT NULL DEFAULT 0,
  childUnder5Count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'รอตรวจสอบผู้เข้าร่วม',
  slipImage TEXT NOT NULL DEFAULT '',
  slip_base64 TEXT NOT NULL DEFAULT '',
  cancelReason TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT NOT NULL DEFAULT 'legacy',
  archivedAt TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  slip_verify_status TEXT NOT NULL DEFAULT '',
  slip_verify_json TEXT NOT NULL DEFAULT '',
  slip_verify_at TEXT NOT NULL DEFAULT '',
  slip_fingerprint TEXT NOT NULL DEFAULT '',
  slip_image_hash TEXT NOT NULL DEFAULT '',
  payment_ref1 TEXT NOT NULL DEFAULT '',
  visitorAge TEXT NOT NULL DEFAULT '',
  slip_ocr_json TEXT NOT NULL DEFAULT '',
  slip_decision TEXT NOT NULL DEFAULT '',
  slip_decision_json TEXT NOT NULL DEFAULT '',
  slip_key TEXT NOT NULL DEFAULT '',
  bookingType TEXT NOT NULL DEFAULT 'prisoner',
  holdExpiresAt TEXT NOT NULL DEFAULT '',
  cancelAt TEXT NOT NULL DEFAULT ''
);

-- Same column list as the archive sweep (RESERVATION_WRITABLE_COLUMNS in
-- src/db/queries/reservations.ts), so nothing is dropped in transit.
INSERT OR IGNORE INTO reservations_backup (
  ref, timestamp, visitorName, visitorId, visitorPhone, relation, religion,
  allergy, extraVisitorReligions, extraVisitorAllergies, extraVisitorNames,
  visitorApproved, extraVisitorApproved, prisonerName, prisonerId, wing,
  visitDate, visitDateISO, visitorCount, totalPersons, total, adultCount,
  child5to8Count, childUnder5Count, status, slipImage, slip_base64,
  cancelReason, createdAt, updatedAt, version, createdBy, source,
  slip_verify_status, slip_verify_json, slip_verify_at, slip_fingerprint,
  slip_image_hash, payment_ref1, visitorAge, slip_ocr_json, slip_decision,
  slip_decision_json, slip_key, bookingType, holdExpiresAt, cancelAt, archivedAt
)
SELECT
  ref, timestamp, visitorName, visitorId, visitorPhone, relation, religion,
  allergy, extraVisitorReligions, extraVisitorAllergies, extraVisitorNames,
  visitorApproved, extraVisitorApproved, prisonerName, prisonerId, wing,
  visitDate, visitDateISO, visitorCount, totalPersons, total, adultCount,
  child5to8Count, childUnder5Count, status, slipImage, slip_base64,
  cancelReason, createdAt, updatedAt, version, createdBy, source,
  slip_verify_status, slip_verify_json, slip_verify_at, slip_fingerprint,
  slip_image_hash, payment_ref1, visitorAge, slip_ocr_json, slip_decision,
  slip_decision_json, slip_key, bookingType, holdExpiresAt, cancelAt,
  '2026-10 reset'
FROM reservations
WHERE visitDateISO >= '2026-10-01' AND visitDateISO < '2026-11-01';

-- Only rows whose copy is in the backup table are removed, so a failed or
-- partial copy can never cost a booking.
DELETE FROM reservations
WHERE visitDateISO >= '2026-10-01' AND visitDateISO < '2026-11-01'
  AND ref IN (SELECT ref FROM reservations_backup);

-- The public calendar and the dashboard read cached counts/lists from
-- d1_cache; drop every cached payload (rate-limit counters `rl:*` stay) so the
-- freed October slots show at once, and bump the change counters so open
-- dashboards refetch instead of showing the removed bookings.
DELETE FROM d1_cache WHERE key NOT LIKE 'rl:%';
UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
WHERE key IN ('data_version', 'data_version:reservations');
