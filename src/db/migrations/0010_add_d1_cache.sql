CREATE TABLE IF NOT EXISTS d1_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_d1_cache_expires ON d1_cache (expires_at);
