-- Additive: reserve most of the Free-tier write allocation for booking/payment.
-- At most 1,000 availability-recipient rows are queued per UTC day. A broadcast
-- that does not fit stays armed for a later scan/day; nobody is silently dropped.
CREATE TABLE IF NOT EXISTS table_notification_budget (
  day TEXT PRIMARY KEY,
  recipients INTEGER NOT NULL DEFAULT 0,
  readsReserved INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Index only pending pushes. Avoid reading unrelated LINE/old sent rows each scan.
CREATE INDEX IF NOT EXISTS idx_notifications_pending_push
  ON notifications(id) WHERE status = 'pending' AND channel = 'push';

CREATE TABLE IF NOT EXISTS table_notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  dates TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  lastBatch INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_table_notification_events_pending
  ON table_notification_events(id) WHERE complete = 0;
