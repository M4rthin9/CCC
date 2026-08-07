// Chunked KV cache that mirrors the legacy Apps Script CacheService behavior:
// values larger than CACHE_CHUNK_SIZE are split into ~90KB chunks behind a
// master key (`key` -> `__chunks:<n>`), reassembled on read, and all chunk
// keys are purged on delete. KV put() is async (fire-and-forget semantics in
// the legacy code), so every helper returns a Promise.

const CACHE_CHUNK_SIZE = 90000;

export async function cachePutLarge(
  kv: KVNamespace,
  key: string,
  dataString: string,
  ttlSeconds: number
): Promise<void> {
  try {
    if (typeof dataString !== 'string' || dataString.length <= CACHE_CHUNK_SIZE) {
      await kv.put(key, String(dataString || ''), { expirationTtl: ttlSeconds });
      return;
    }
    const chunkCount = Math.ceil(dataString.length / CACHE_CHUNK_SIZE);
    await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        kv.put(
          key + '_chunk_' + i,
          dataString.slice(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE),
          { expirationTtl: ttlSeconds }
        )
      )
    );
    await kv.put(key, '__chunks:' + chunkCount, { expirationTtl: ttlSeconds });
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
      const parts = await Promise.all(
        Array.from({ length: chunkCount }, (_, i) => kv.get(key + '_chunk_' + i))
      );
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

export async function cachePut(
  kv: KVNamespace,
  key: string,
  value: string,
  ttlSeconds: number
): Promise<void> {
  try {
    await kv.put(key, value, { expirationTtl: ttlSeconds });
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
    await kv.put(key, String(attempts + 1), { expirationTtl: ttlSeconds });
    return true;
  } catch {
    return true;
  }
}

export async function resetRateLimit(kv: KVNamespace, key: string): Promise<void> {
  await cacheRemove(kv, key);
}
