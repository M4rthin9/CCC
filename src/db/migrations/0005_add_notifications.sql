-- Migration 0005: notification infrastructure (Web Push + LINE).
-- Added to support proactive status-change notifications to visitors at zero cost:
--   push_subscriptions — browser Web Push subscriptions keyed by endpoint, linked to a booking ref
--   line_friends      — LINE users who added the LINE Official Account, linked to a booking ref
--   notifications     — delivery outbox / audit trail, deduplicated per (ref, type, channel, recipient)

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  ref TEXT NOT NULL DEFAULT '',
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastActiveAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS line_friends (
  userId TEXT PRIMARY KEY,
  ref TEXT NOT NULL DEFAULT '',
  displayName TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  sentAt TEXT NOT NULL DEFAULT ''
);

-- Prevents duplicate delivery when the same event fires twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications (ref, type, channel, recipient);

CREATE INDEX IF NOT EXISTS idx_notifications_status
  ON notifications (status);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_ref
  ON push_subscriptions (ref);

CREATE INDEX IF NOT EXISTS idx_line_friends_ref
  ON line_friends (ref);
