// KV is intentionally near-idle: the free tier allows only ~1,000 writes and
// ~1,000 deletes per day, and metering every public request through it blew
// that budget daily. All caches, rate limits and daily counters now live in
// D1 (`src/cache/d1Cache.ts`), which also has a shared daily write limit.
//
// The public status monitor also stores one bounded snapshot every five minutes
// (288 puts/day), never on a public-request path. Do not add per-visitor writes.

export async function cacheGet(kv: KVNamespace, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}
