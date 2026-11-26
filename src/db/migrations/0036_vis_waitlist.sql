-- The current queue and payment window live on the original VIS reservation.
ALTER TABLE reservations ADD COLUMN visQueuedAt TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN visOfferedAt TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN visNoticeAt TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN visReminderAt TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN visContactRequired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN visPaymentRemainingMs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN visSlipSubmittedAt TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_vis_open_visitor ON reservations(UPPER(TRIM(visitorId)), visitDateISO)
WHERE bookingType != 'table' AND visitDateISO != ''
  AND status IN ('รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอคิวโต๊ะ', 'รอชำระเงิน');

ALTER TABLE notifications ADD COLUMN deliveryKey TEXT NOT NULL DEFAULT '';
DROP INDEX idx_notifications_dedupe;
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(ref, type, channel, recipient, deliveryKey);

-- Cover all writers, including the older dashboard force-status entry point.
CREATE TRIGGER guard_vis_waitlist_paid BEFORE UPDATE OF status ON reservations
WHEN OLD.visQueuedAt != '' AND OLD.status NOT IN ('ชำระแล้ว', 'เสร็จสิ้น')
  AND NEW.status IN ('ชำระแล้ว', 'เสร็จสิ้น')
  AND (OLD.status != 'รอชำระเงิน' OR OLD.visSlipSubmittedAt = '' OR OLD.visOfferedAt = '')
BEGIN
  SELECT RAISE(ABORT, 'VIS payment requires a slip submitted for an offered table');
END;
