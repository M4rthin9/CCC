-- Preserve the accepted TBL terms version and server timestamp with the booking.
-- Existing bookings have no recorded acceptance and remain blank.
ALTER TABLE reservations ADD COLUMN tableAgreementVersion TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN tableAgreementAcceptedAt TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN tableAgreementVersion TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN tableAgreementAcceptedAt TEXT NOT NULL DEFAULT '';
