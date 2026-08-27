// Chunked KV cache that mirrors the legacy Apps Script CacheService behavior:
// values larger than CACHE_CHUNK_SIZE are split into ~90KB chunks behind a
// master key (`key` -> `__chunks:<n>`), reassembled on read, and all chunk
// keys are purged on delete. KV put() is async (fire-and-forget semantics in
// the legacy code), so every helper returns a Promise.

const CACHE_CHUNK_SIZE = 90000;

// ── In-memory write dedup ──────────────────────────────────────────
// Cloudflare KV free tier allows only 1,000 puts/day. An in-memory map
// tracks the last value written per key so we can skip redundant puts
// (e.g. repeated health checks, identical cache refreshes within TTL).
// The map is scoped to a single Worker isolate lifecycle; entries older
// than DEDUP_TTL_MS are evicted on access.
const DEDUP_TTL_MS = 30_000; // 30 s — shorter than any cache TTL
const _lastWrite = new Map<string, { v: string; ts: number }>();

function _wasRecentlyWritten(key: string, value: string): boolean {
  const entry = _lastWrite.get(key);
  if (entry && entry.v === value && Date.now() - entry.ts < DEDUP_TTL_MS) {
    return true;
  }
  return false;
}

function _recordWrite(key: string, value: string): void {
  // Cap map size to avoid unbounded memory growth (Worker isolate memory
  // limit ~128 MB). Evict oldest 20% when the map exceeds 10 000 entries.
  if (_lastWrite.size > 10_000) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, e] of _lastWrite) {
      if (e.ts < cutoff) _lastWrite.delete(k);
    }
    // If still too large after eviction, clear entirely.
    if (_lastWrite.size > 10_000) _lastWrite.clear();
  }
  _lastWrite.set(key, { v: value, ts: Date.now() });
}

export async function cachePutLarge(
  kv: KVNamespace,
  key: string,
  dataString: string,
  ttlSeconds: number
): Promise<void> {
  try {
    if (typeof dataString !== 'string' || dataString.length <= CACHE_CHUNK_SIZE) {
      const value = String(dataString || '');
      if (_wasRecentlyWritten(key, value)) return;
      await kv.put(key, value, { expirationTtl: ttlSeconds });
      _recordWrite(key, value);
      return;
    }
    // For chunked data, use the full payload + chunk count as the dedup fingerprint
    const chunkCount = Math.ceil(dataString.length / CACHE_CHUNK_SIZE);
    const fingerprint = dataString.length + ':' + chunkCount;
    if (_wasRecentlyWritten(key, fingerprint)) return;
    await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        kv.put(key + '_chunk_' + i, dataString.slice(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE), {
          expirationTtl: ttlSeconds,
        })
      )
    );
    await kv.put(key, '__chunks:' + chunkCount, { expirationTtl: ttlSeconds });
    _recordWrite(key, fingerprint);
  } catch {
    // KV unavailable — callers fall back to direct DB reads.
  }
}

export async function cacheGetLarge(kv: KVNamespace, key: string): Promise<string | null> {
  try {
    const meta = await kv.get(key);
    if (meta === null) return null;
    if (meta.indexOf('__chunks:') === 0) {
      const chunkCount = parseInt(meta.substring('__chunks:'.length), 10) || 0;
      if (chunkCount <= 0) return null;
      const parts = await Promise.all(Array.from({ length: chunkCount }, (_, i) => kv.get(key + '_chunk_' + i)));
      let out = '';
      for (let i = 0; i < chunkCount; i++) {
        const p = parts[i];
        if (p === null || p === '') {
          await kv.delete(key).catch(() => undefined);
          return null;
        }
        out += p;
      }
      return out;
    }
    return meta;
  } catch {
    return null;
  }
}

export async function cacheRemoveLarge(kv: KVNamespace, key: string): Promise<void> {
  try {
    const meta = await kv.get(key).catch(() => null);
    if (meta && meta.indexOf('__chunks:') === 0) {
      const chunkCount = parseInt(meta.substring('__chunks:'.length), 10) || 0;
      await Promise.all(
        Array.from({ length: chunkCount }, (_, i) => kv.delete(key + '_chunk_' + i).catch(() => undefined))
      );
    }
    await kv.delete(key).catch(() => undefined);
  } catch {
    // ignore
  }
}

export async function cachePut(kv: KVNamespace, key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    if (_wasRecentlyWritten(key, value)) return;
    await kv.put(key, value, { expirationTtl: ttlSeconds });
    _recordWrite(key, value);
  } catch {
    // ignore
  }
}

export async function cacheGet(kv: KVNamespace, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

export async function cacheRemove(kv: KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch {
    // ignore
  }
}

// KV-backed rate limiter (attempts counter with TTL). Returns true when the
// request is allowed.
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  maxAttempts: number,
  ttlSeconds: number
): Promise<boolean> {
  try {
    const attempts = parseInt((await kv.get(key)) || '0', 10) || 0;
    if (attempts >= maxAttempts) return false;
    const next = String(attempts + 1);
    if (_wasRecentlyWritten(key, next)) return true;
    await kv.put(key, next, { expirationTtl: ttlSeconds });
    _recordWrite(key, next);
    return true;
  } catch {
    return true;
  }
}

export async function resetRateLimit(kv: KVNamespace, key: string): Promise<void> {
  await cacheRemove(kv, key);
}
