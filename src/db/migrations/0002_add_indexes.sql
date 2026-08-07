-- Migration 0002: indexes for the hot query paths.
-- The duplicate-booking guard (prisonerId + visitDateISO + active status) is
-- the most frequently executed query; the lookup endpoints are second.

CREATE INDEX IF NOT EXISTS idx_reservations_prisoner_date
  ON reservations (prisonerId, visitDateISO);

CREATE INDEX IF NOT EXISTS idx_reservations_visitdate
  ON reservations (visitDateISO);

CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations (status);

CREATE INDEX IF NOT EXISTS idx_archive_visitdate
  ON reservations_archive (visitDateISO);

CREATE INDEX IF NOT EXISTS idx_archive_ref
  ON reservations_archive (ref);

CREATE INDEX IF NOT EXISTS idx_prisoners_name
  ON prisoners (prisonerName);

CREATE INDEX IF NOT EXISTS idx_eventlog_ts
  ON event_log (timestamp);

CREATE INDEX IF NOT EXISTS idx_eventlog_username
  ON event_log (username);

CREATE INDEX IF NOT EXISTS idx_notes_ref
  ON notes (ref);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_username
  ON refresh_tokens (username);
