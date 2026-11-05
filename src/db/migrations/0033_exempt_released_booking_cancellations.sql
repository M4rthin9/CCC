-- Match VIS capacity's CANCEL_RELEASE_DAYS = 4 (Bangkok calendar dates).
-- A cancellation which returns its public slot must not create a strike.
DROP TRIGGER record_prisoner_booking_outcome;
CREATE TRIGGER record_prisoner_booking_outcome
AFTER UPDATE OF status ON reservations
WHEN NEW.bookingType != 'table' AND OLD.status != NEW.status
  AND ((NEW.status = 'ยกเลิก' AND NEW.cancellationRole IN ('Admin', 'Superadmin')
      AND NOT (NEW.cancelAt != ''
        AND NEW.visitDateISO >= date(NEW.cancelAt, '+7 hours', '+4 days')))
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

-- Correct known early-cancellation strikes already recorded by migration 0032's
-- policy. Use the immutable outcome time, not an editable booking cancelAt.
-- Deleted bookings have no recoverable visit date, so their history is retained.
CREATE TABLE _released_booking_strikes AS
SELECT o.id, o.prisonerId FROM prisoner_booking_outcomes o
WHERE o.kind = 'cancelled' AND EXISTS (
  SELECT 1 FROM (
    SELECT ref, visitDateISO FROM reservations
    UNION ALL SELECT ref, visitDateISO FROM reservations_archive
  ) r WHERE r.ref = o.ref AND r.visitDateISO >= date(o.occurredAt, '+7 hours', '+4 days')
);

-- Replay only affected prisoners' remaining outcomes, in their original order.
-- Existing strike/paid triggers reproduce the streak and calendar-month expiry;
-- valid bans and unrelated prisoners' states are preserved.
CREATE TABLE _booking_blacklist_replay AS
SELECT o.* FROM prisoner_booking_outcomes o
WHERE o.prisonerId IN (SELECT prisonerId FROM _released_booking_strikes)
  AND o.id NOT IN (SELECT id FROM _released_booking_strikes);

DELETE FROM prisoner_booking_blacklist
WHERE prisonerId IN (SELECT prisonerId FROM _released_booking_strikes);
DELETE FROM prisoner_booking_outcomes
WHERE prisonerId IN (SELECT prisonerId FROM _released_booking_strikes);
INSERT INTO prisoner_booking_outcomes (id, ref, prisonerId, kind, occurredAt)
SELECT id, ref, prisonerId, kind, occurredAt FROM _booking_blacklist_replay ORDER BY id;

DROP TABLE _booking_blacklist_replay;
DROP TABLE _released_booking_strikes;
