-- Migration 0021: opt-in "booking opens" alerts on a browser push subscription.
--
-- A browser that opts in from the home page gets two broadcasts on mornings a
-- new bookable date opens: 06:50 ("10 minutes to go") and 07:00 ("open now").
-- Independent of `ref`: the same browser can also follow one booking.
ALTER TABLE push_subscriptions ADD COLUMN openingAlerts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_opening_alerts
  ON push_subscriptions(openingAlerts) WHERE openingAlerts = 1;

-- Pushes carry no payload: the service worker asks for the newest message
-- addressed to its endpoint (GET /api/notify/message).
CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient, id);
