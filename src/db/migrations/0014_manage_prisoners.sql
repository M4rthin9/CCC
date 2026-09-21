-- Migration 0014: add manage_prisoners permission column to roles.
-- Grants prisoner import/edit (including the vinai discipline date) to the
-- discipline (Vinai) role and keeps it for the superadmin, who previously
-- reached the same actions via manage_users.

ALTER TABLE roles ADD COLUMN manage_prisoners INTEGER NOT NULL DEFAULT 0;

UPDATE roles SET manage_prisoners = 1 WHERE lower(roleName) = 'superadmin';
UPDATE roles SET manage_prisoners = 1 WHERE lower(roleName) = 'vinai';