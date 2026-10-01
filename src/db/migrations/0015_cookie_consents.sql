-- Migration 0015: PDPA cookie-consent log.
-- One row per choice a visitor makes on the booking site's cookie banner, so the
-- institution can show when, and to which categories, an (anonymous) browser
-- consented. `consent_id` is a random id kept in that browser; the IP is stored
-- only as a salted hash. Rows older than the retention window are purged by the
-- daily cron.
CREATE TABLE IF NOT EXISTS cookie_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consent_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  choice TEXT NOT NULL,
  preferences INTEGER NOT NULL DEFAULT 0,
  analytics INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cookie_consents_created ON cookie_consents (created_at);
CREATE INDEX IF NOT EXISTS idx_cookie_consents_consent_id ON cookie_consents (consent_id);
