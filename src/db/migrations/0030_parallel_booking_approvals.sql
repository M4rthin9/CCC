-- Independent staff checks. Existing bookings retain their completed stages.
ALTER TABLE reservations ADD COLUMN participantApproved TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN disciplineApproved TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN participantApproved TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN disciplineApproved TEXT NOT NULL DEFAULT '';

UPDATE reservations SET participantApproved = 'yes'
WHERE status IN ('รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น');
UPDATE reservations SET disciplineApproved = 'yes'
WHERE status IN ('รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น');
UPDATE reservations_archive SET participantApproved = 'yes'
WHERE status IN ('รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น');
UPDATE reservations_archive SET disciplineApproved = 'yes'
WHERE status IN ('รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น');
