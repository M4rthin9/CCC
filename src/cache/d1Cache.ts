// D1-backed cache layer — replaces KV for hot-path reads (reservations,
// counts, prisoners, users, roles) so the KV free-tier 1,000 puts/day
// budget is reserved for rate-limiting and infrequent counters only.
//
// D1 (SQLite) has no write limit.  Values are stored as-is (no chunking)
// because D1 cells can hold up to 1 MB of text — comfortably above any
// cache payload in this project.

export async function d1CacheGet<T = string>(db: D1Database, key: string): Promise<T | null> {
  try {
    const row = await db
      .prepare('SELECT value FROM d1_cache WHERE key = ? AND expires_at > ?')
      .bind(key, nowSec())
      .first<{ value: string }>();
    if (!row) return null;
    return row.value as T;
  } catch {
    return null;
  }
}

export async function d1CachePut(db: D1Database, key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    const expiresAt = nowSec() + ttlSeconds;
    await db
      .prepare(
        'INSERT INTO d1_cache (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
      )
      .bind(key, value, expiresAt)
      .run();
  } catch {
    // D1 unavailable — callers fall back to direct DB reads.
  }
}

export async function d1CacheRemove(db: D1Database, key: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM d1_cache WHERE key = ?').bind(key).run();
  } catch {
    // ignore
  }
}

/** Remove all expired rows.  Call periodically (e.g. cron) to reclaim space. */
export async function d1CacheCleanup(db: D1Database): Promise<number> {
  try {
    const result = await db.prepare('DELETE FROM d1_cache WHERE expires_at <= ?').bind(nowSec()).run();
    return result.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Versioned helpers (mirror src/cache/versioned.ts) ────────────────

interface Envelope {
  v: number;
  d: unknown;
}

const NO_VERSION = -1;

export interface VersionedRead<T> {
  hit: T | null;
  version: number;
}

export async function d1CacheGetVersioned<T>(db: D1Database, key: string, version: number): Promise<VersionedRead<T>> {
  if (version === NO_VERSION) return { hit: null, version: NO_VERSION };
  const raw = await d1CacheGet<string>(db, key);
  if (!raw) return { hit: null, version };
  try {
    const parsed = JSON.parse(raw) as Envelope;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== version) return { hit: null, version };
    return { hit: parsed.d as T, version };
  } catch {
    return { hit: null, version };
  }
}

export async function d1CachePutVersioned(
  db: D1Database,
  key: string,
  version: number,
  data: unknown,
  ttlSeconds: number
): Promise<void> {
  if (version === NO_VERSION) return;
  const envelope: Envelope = { v: version, d: data };
  await d1CachePut(db, key, JSON.stringify(envelope), ttlSeconds);
}
