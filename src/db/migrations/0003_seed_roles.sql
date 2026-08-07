-- Migration 0003: seed built-in roles so hasPermission() works immediately
-- after a fresh deploy, before any CSV data is imported.
-- Column order matches the roles table definition in 0001_initial.sql.
-- 1 = permission granted, 0 = denied.

INSERT OR IGNORE INTO roles (roleName, approve, reject, confirm_payment, reject_payment, cancel, visitor_approval, view_slip, view_detail, export, print, manage_users, view_eventlog, approve_discipline, reject_discipline, approve_participant, manage_settings) VALUES
  ('Superadmin', 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1),
  ('Admin',      1,1,1,1,1,1,1,1,1,1,0,1,1,1,1,0),
  ('Finance',    0,0,1,1,1,0,1,1,0,0,0,0,0,0,0,0),
  ('Vinai',      0,0,0,0,0,0,1,1,0,0,0,0,1,1,0,0),
  ('Tadtel',     0,0,0,0,0,1,1,1,0,0,0,0,0,0,1,0),
  ('User',       0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0);
