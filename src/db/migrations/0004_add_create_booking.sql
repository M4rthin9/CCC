-- Migration 0004: add the create_booking permission (dashboard new-booking)
-- so the auth'd createBooking action can be gated via hasPermission().
-- 1 = permission granted, 0 = denied.

ALTER TABLE roles ADD COLUMN create_booking INTEGER NOT NULL DEFAULT 0;
UPDATE roles SET create_booking = 1 WHERE roleName IN ('Superadmin', 'Admin');

-- Booking origin tag: 'admin' for dashboard-created bookings, '' for public/legacy.
ALTER TABLE reservations ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN source TEXT NOT NULL DEFAULT '';
