import { cacheGetLarge, cachePutLarge } from './kv';
import { DataScope, getScopeVersion } from '../db/queries/settings';
import { Env } from '../types';

// Deleting a KV key is not enough to keep the reservation caches honest.
//
// A reader that started its D1 query *before* a write lands will finish *after*
// the writer deleted the cache key, and then repopulate it with its pre-write
// snapshot — which sticks for the full TTL. That is why an approved booking can
// appear to revert to its old status. KV deletes are also only eventually
// consistent across PoPs, so a neighbouring colo can serve the old blob anyway.
//
// Stamping every payload with the data_version it was built from makes both
// cases self-correcting: invalidateReservationsCache() bumps data_version in D1
// (strongly consistent), so any blob written from an older snapshot no longer
// matches and is treated as a miss. The worst case is a redundant D1 read, never
// a stale answer.

const NO_VERSION = -1;

interface Envelope {
  v: number;
  d: unknown;
}

export interface VersionedRead<T> {
  hit: T | null;
  version: number;
}

/**
 * Read the current data_version, then the cached envelope, and return the
 * payload only when the two agree.
 *
 * The returned `version` is read *before* the caller queries D1, which is what
 * makes the guard sound: if a write commits between that read and the caller's
 * put, the stamp is already stale and the next reader refetches.
 */
export async function cacheGetVersioned<T>(env: Env, key: string, scope: DataScope): Promise<VersionedRead<T>> {
  let version: number;
  try {
    version = await getScopeVersion(env.DB, scope);
  } catch {
    // Version unavailable — fall back to an uncached read rather than risking a
    // stale hit, and tell the caller not to write the result back.
    return { hit: null, version: NO_VERSION };
  }

  const raw = await cacheGetLarge(env.CACHE_KV, key);
  if (!raw) return { hit: null, version };

  try {
    const parsed = JSON.parse(raw) as Envelope;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== version) return { hit: null, version };
    return { hit: parsed.d as T, version };
  } catch {
    return { hit: null, version };
  }
}

/** Write a payload stamped with the version it was built from. */
export async function cachePutVersioned(
  env: Env,
  key: string,
  version: number,
  data: unknown,
  ttlSeconds: number
): Promise<void> {
  if (version === NO_VERSION) return;
  const envelope: Envelope = { v: version, d: data };
  await cachePutLarge(env.CACHE_KV, key, JSON.stringify(envelope), ttlSeconds);
}
