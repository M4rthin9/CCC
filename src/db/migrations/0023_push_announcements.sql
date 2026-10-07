-- Additive: existing subscriptions, notification rows and booking settings stay intact.
-- Deploy before the new Worker; old clients keep using the same push-message API.
-- Rollback: retain this table and disable the dashboard composer; no data removal needed.
CREATE TABLE IF NOT EXISTS push_announcements (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queueing'
);
