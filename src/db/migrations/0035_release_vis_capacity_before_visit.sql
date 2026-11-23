-- Match VIS capacity: a cancellation before the Bangkok visit date returns the slot.
-- A cancellation which returns its public slot must not create a strike.
DROP TRIGGER record_prisoner_booking_outcome;
CREATE TRIGGER record_prisoner_booking_outcome
AFTER UPDATE OF status ON reservations
WHEN NEW.bookingType != 'table' AND OLD.status != NEW.status
  AND ((NEW.status = 'ยกเลิก' AND NEW.cancellationRole IN ('Admin', 'Superadmin')
      AND NOT COALESCE(NEW.visitDateISO > date(NEW.cancelAt, '+7 hours'), 0))
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
