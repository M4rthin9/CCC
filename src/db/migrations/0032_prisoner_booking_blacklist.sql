-- New events only: historical cancellations cannot reliably identify their actor.
-- Keep outcomes independently of reservations so archive/deletion cannot erase a ban.
ALTER TABLE reservations ADD COLUMN cancellationRole TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN cancellationRole TEXT NOT NULL DEFAULT '';

CREATE TABLE prisoner_booking_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  prisonerId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cancelled', 'paid')),
  occurredAt TEXT NOT NULL,
  UNIQUE (ref, prisonerId, kind)
);

CREATE TABLE prisoner_booking_blacklist (
  prisonerId TEXT PRIMARY KEY,
  consecutiveCancellations INTEGER NOT NULL DEFAULT 0,
  bannedUntil TEXT NOT NULL DEFAULT ''
);

CREATE TRIGGER prisoner_booking_cancel_strike
AFTER INSERT ON prisoner_booking_outcomes WHEN NEW.kind = 'cancelled'
BEGIN
  INSERT INTO prisoner_booking_blacklist (prisonerId) VALUES (NEW.prisonerId)
    ON CONFLICT (prisonerId) DO NOTHING;
  UPDATE prisoner_booking_blacklist
  SET bannedUntil = CASE WHEN consecutiveCancellations = 1 THEN
      -- Clamp to the last day of the target month, preserving Bangkok time.
      -- (31 August + three calendar months = 30 November.)
      strftime('%Y-%m-%dT%H:%M:%fZ',
        datetime(NEW.occurredAt, '+7 hours', 'start of month', '+3 months',
          '+' || (min(CAST(strftime('%d', NEW.occurredAt, '+7 hours') AS INTEGER),
            CAST(strftime('%d', NEW.occurredAt, '+7 hours', 'start of month', '+4 months', '-1 day') AS INTEGER)) - 1) || ' days'),
        '+' || strftime('%H', NEW.occurredAt, '+7 hours') || ' hours',
        '+' || strftime('%M', NEW.occurredAt, '+7 hours') || ' minutes',
        '+' || strftime('%f', NEW.occurredAt, '+7 hours') || ' seconds', '-7 hours')
      ELSE bannedUntil END,
      consecutiveCancellations = (consecutiveCancellations + 1) % 2
  WHERE prisonerId = NEW.prisonerId;
END;

CREATE TRIGGER prisoner_booking_paid_reset
AFTER INSERT ON prisoner_booking_outcomes WHEN NEW.kind = 'paid'
BEGIN
  UPDATE prisoner_booking_blacklist SET consecutiveCancellations = 0
    WHERE prisonerId = NEW.prisonerId;
END;

CREATE TRIGGER record_prisoner_booking_outcome
AFTER UPDATE OF status ON reservations
WHEN NEW.bookingType != 'table' AND OLD.status != NEW.status
  AND ((NEW.status = 'ยกเลิก' AND NEW.cancellationRole IN ('Admin', 'Superadmin'))
    OR NEW.status IN ('ชำระแล้ว', 'เสร็จสิ้น'))
BEGIN
  INSERT OR IGNORE INTO prisoner_booking_outcomes (ref, prisonerId, kind, occurredAt)
  SELECT NEW.ref, prisonerId,
    CASE WHEN NEW.status = 'ยกเลิก' THEN 'cancelled' ELSE 'paid' END,
    CASE WHEN NEW.status = 'ยกเลิก' THEN NEW.cancelAt ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
  FROM (
    WITH RECURSIVE extras(token, rest) AS (
      SELECT '', NEW.extraPrisoners || ';;'
      UNION ALL
      SELECT substr(rest, 1, instr(rest, ';;') - 1), substr(rest, instr(rest, ';;') + 2)
      FROM extras WHERE rest != ''
    ), ids(value) AS (
      SELECT substr(token, instr(token, '|') + 1) FROM extras WHERE instr(token, '|') > 0
    )
    SELECT trim(NEW.prisonerId) AS prisonerId
    UNION SELECT trim(substr(value, 1, instr(value, '|') - 1)) FROM ids
  ) WHERE prisonerId != '';
END;

-- Defense in depth: these guards also cover staff creation, concurrent public
-- inserts, changing the prisoner, adding a shared-table prisoner and reopening a booking.
CREATE TRIGGER block_blacklisted_prisoner_insert
BEFORE INSERT ON reservations
WHEN NEW.bookingType != 'table' AND EXISTS (
  SELECT 1 FROM prisoner_booking_blacklist b
  WHERE b.bannedUntil > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND (b.prisonerId = trim(NEW.prisonerId) OR instr(NEW.extraPrisoners, '|' || b.prisonerId || '|') > 0)
)
BEGIN
  SELECT RAISE(ABORT, 'PRISONER_BOOKING_BANNED');
END;

CREATE TRIGGER block_blacklisted_prisoner_update
BEFORE UPDATE OF prisonerId, extraPrisoners, status ON reservations
WHEN NEW.bookingType != 'table'
  AND (NEW.prisonerId != OLD.prisonerId OR NEW.extraPrisoners != OLD.extraPrisoners
    OR (OLD.status IN ('ยกเลิก', 'ไม่อนุมัติ') AND NEW.status NOT IN ('ยกเลิก', 'ไม่อนุมัติ')))
  AND EXISTS (
    SELECT 1 FROM prisoner_booking_blacklist b
    WHERE b.bannedUntil > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (b.prisonerId = trim(NEW.prisonerId) OR instr(NEW.extraPrisoners, '|' || b.prisonerId || '|') > 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'PRISONER_BOOKING_BANNED');
END;
