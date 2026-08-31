// KV is intentionally near-idle: the free tier allows only ~1,000 writes and
// ~1,000 deletes per day, and metering every public request through it blew
// that budget daily. All caches, rate limits and daily counters now live in
// D1 (`src/cache/d1Cache.ts`), which has no comparable write cap.
//
// What is left here is a single read helper used by the health probe. Do not
// reintroduce KV writes on a per-request path.

export async function cacheGet(kv: KVNamespace, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}
