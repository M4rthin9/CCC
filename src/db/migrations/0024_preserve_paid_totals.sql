-- 0024: restore seven totals supported by the original payment slips.
-- Proof is checked before deployment by verify-payment-repair-evidence.ts.
-- Preserve approval/attendance counts: money received is independent of the tariff.
-- Rollback values and evidence hashes remain in payment_total_corrections.
CREATE TABLE payment_total_corrections (
  ref TEXT PRIMARY KEY, visitDateISO TEXT NOT NULL, fromTotal INTEGER NOT NULL,
  paidAmount INTEGER NOT NULL, expectedVersion INTEGER NOT NULL, slipSha256 TEXT NOT NULL,
  appliedAt TEXT NOT NULL DEFAULT ''
);
INSERT INTO payment_total_corrections
  (ref, visitDateISO, fromTotal, paidAmount, expectedVersion, slipSha256) VALUES
('VIS-55903', '2026-07-16', 2500, 3000, 1, '753ef4e981af0ff5e8da6ae5352d7574030bd0d08f07578fe99633bb7f7a587e'),
('VIS-97273', '2026-06-18', 3500, 4000, 1, '32e009f80c8af269eeee9f6df9d8501dd3f8e2a7519fbf5f2c6967b373730215'),
('VIS-37212', '2026-07-23', 2500, 3000, 1, 'd791c99d77a77d93818660728b6e1cac517ce63640660a19e78026b192387823'),
('VIS-32602', '2026-06-17', 2500, 3000, 1, '1e2fbdcb9bd8855e286b3fcbfeb9606a499a163c9f10e7a54ca8a959466cc6e5'),
('VIS-19649', '2026-07-01', 2500, 3000, 1, 'f393a4293677d071e760ffae5a29ad7f7b3686084bc4dbceefabdaaa7f8ac888'),
('VIS-81233', '2026-07-24', 2000, 3000, 1, '93e375dbcded3a512b18e102ed0de4916fcf60e14701538e8b93abe65a04f02b'),
('VIS-62668', '2026-08-19', 2000, 3000, 2, 'b8aff978355463e1503767fa0772257b11a2cd86f157aae14b208978b12f366f');

-- Abort the whole migration if a production row changed after the audited snapshot.
-- Missing rows on development/cold databases require no financial correction.
CREATE TABLE payment_repair_guard (valid INTEGER CHECK (valid = 1));
INSERT INTO payment_repair_guard
SELECT 0 FROM reservations_archive a JOIN payment_total_corrections c ON c.ref = a.ref
WHERE a.visitDateISO != c.visitDateISO OR a.status != 'เสร็จสิ้น'
   OR a.total != c.fromTotal OR a.version != c.expectedVersion;
DROP TABLE payment_repair_guard;

INSERT INTO event_log (timestamp, username, action, targetRef, details, result)
SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', '+7 hours'), 'system', 'payment_total_corrected_from_slip', a.ref,
       json_object('from', a.total, 'to', c.paidAmount, 'visitDateISO', a.visitDateISO,
                   'evidence', 'original stored bank slip manually reviewed',
                   'slipSha256', c.slipSha256, 'via', 'migration 0024'), 'success'
FROM reservations_archive a JOIN payment_total_corrections c ON c.ref = a.ref;
UPDATE payment_total_corrections SET appliedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE ref IN (SELECT ref FROM reservations_archive);
UPDATE reservations_archive
SET total = (SELECT paidAmount FROM payment_total_corrections c WHERE c.ref = reservations_archive.ref),
    version = version + 1, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE ref IN (SELECT ref FROM payment_total_corrections WHERE appliedAt != '');

-- This is a recorded-payment snapshot, not a claim that every legacy slip was verified.
-- Keep it separately so reverting a booking status cannot unlock its amount.
CREATE TABLE reservation_payment_locks (
  ref TEXT PRIMARY KEY, total INTEGER NOT NULL,
  lockedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO reservation_payment_locks (ref, total)
SELECT ref, total FROM reservations WHERE status IN ('ชำระแล้ว', 'เสร็จสิ้น', 'คืนเงินแล้ว')
UNION ALL SELECT ref, total FROM reservations_archive WHERE status IN ('ชำระแล้ว', 'เสร็จสิ้น', 'คืนเงินแล้ว');

CREATE TRIGGER reservations_payment_lock_insert AFTER INSERT ON reservations
WHEN NEW.status IN ('ชำระแล้ว', 'เสร็จสิ้น', 'คืนเงินแล้ว')
BEGIN
  INSERT OR IGNORE INTO reservation_payment_locks (ref, total) VALUES (NEW.ref, NEW.total);
END;
CREATE TRIGGER reservations_payment_lock_status AFTER UPDATE OF status ON reservations
WHEN NEW.status IN ('ชำระแล้ว', 'เสร็จสิ้น', 'คืนเงินแล้ว')
BEGIN
  INSERT OR IGNORE INTO reservation_payment_locks (ref, total) VALUES (NEW.ref, NEW.total);
END;
CREATE TRIGGER reservations_payment_total_update BEFORE UPDATE OF total ON reservations
WHEN EXISTS (SELECT 1 FROM reservation_payment_locks l WHERE l.ref = OLD.ref AND l.total != NEW.total)
BEGIN
  SELECT RAISE(ABORT, 'Settled payment total is locked; reconcile against payment evidence');
END;
CREATE TRIGGER reservations_payment_total_insert BEFORE INSERT ON reservations
WHEN EXISTS (SELECT 1 FROM reservation_payment_locks l WHERE l.ref = NEW.ref AND l.total != NEW.total)
BEGIN
  SELECT RAISE(ABORT, 'Settled payment total is locked; reconcile against payment evidence');
END;

CREATE TRIGGER reservations_archive_payment_lock_insert AFTER INSERT ON reservations_archive
WHEN NEW.status IN ('ชำระแล้ว', 'เสร็จสิ้น', 'คืนเงินแล้ว')
BEGIN
  INSERT OR IGNORE INTO reservation_payment_locks (ref, total) VALUES (NEW.ref, NEW.total);
END;
CREATE TRIGGER reservations_archive_payment_lock_status AFTER UPDATE OF status ON reservations_archive
WHEN NEW.status IN ('ชำระแล้ว', 'เสร็จสิ้น', 'คืนเงินแล้ว')
BEGIN
  INSERT OR IGNORE INTO reservation_payment_locks (ref, total) VALUES (NEW.ref, NEW.total);
END;
CREATE TRIGGER reservations_archive_payment_total_update BEFORE UPDATE OF total ON reservations_archive
WHEN EXISTS (SELECT 1 FROM reservation_payment_locks l WHERE l.ref = OLD.ref AND l.total != NEW.total)
BEGIN
  SELECT RAISE(ABORT, 'Settled payment total is locked; reconcile against payment evidence');
END;
CREATE TRIGGER reservations_archive_payment_total_insert BEFORE INSERT ON reservations_archive
WHEN EXISTS (SELECT 1 FROM reservation_payment_locks l WHERE l.ref = NEW.ref AND l.total != NEW.total)
BEGIN
  SELECT RAISE(ABORT, 'Settled payment total is locked; reconcile against payment evidence');
END;

DELETE FROM d1_cache WHERE key NOT LIKE 'rl:%';
UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
WHERE key IN ('data_version', 'data_version:reservations');
