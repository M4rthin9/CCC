import {
  cacheKeyArchived,
  cacheKeyCounts,
  cacheKeyPrisoners,
  cacheKeyReservations,
  cacheKeyRoles,
  cacheKeyTableCounts,
  cacheKeyUser,
  cacheKeyUsers,
  lookupCacheKey,
} from './keys';
import { d1CacheRemove } from './d1Cache';
import { Env } from '../types';
import { bumpDataVersion } from '../db/queries/settings';

// Every cached payload lives in D1 (`d1_cache`) — KV is no longer written on
// these paths, so deleting the old KV twins only burned the free-tier
// 1,000 deletes/day budget for keys nothing reads.

export async function invalidateReservationsCache(env: Env): Promise<void> {
  await Promise.all([
    d1CacheRemove(env.DB, cacheKeyReservations(env)),
    d1CacheRemove(env.DB, cacheKeyCounts(env)),
    d1CacheRemove(env.DB, cacheKeyTableCounts(env)),
  ]);
  await bumpDataVersion(env.DB, 'reservations');
}

export async function invalidateLookupCache(env: Env, ref: string): Promise<void> {
  if (!ref) return;
  await d1CacheRemove(env.DB, lookupCacheKey(env, ref, null));
}

export async function invalidatePrisonerLookupCache(env: Env, prisonerId: string): Promise<void> {
  if (!prisonerId) return;
  await d1CacheRemove(env.DB, lookupCacheKey(env, null, prisonerId));
}

export async function invalidateUserCache(env: Env, username: string): Promise<void> {
  await d1CacheRemove(env.DB, cacheKeyUser(username));
}

export async function invalidateAllUsersCache(env: Env): Promise<void> {
  await d1CacheRemove(env.DB, cacheKeyUsers(env));
  await bumpDataVersion(env.DB, 'users');
}

export async function invalidatePrisonersCache(env: Env): Promise<void> {
  await d1CacheRemove(env.DB, cacheKeyPrisoners());
  await bumpDataVersion(env.DB, 'prisoners');
}

export async function invalidateRolesCache(env: Env): Promise<void> {
  await d1CacheRemove(env.DB, cacheKeyRoles(env));
  await bumpDataVersion(env.DB, 'roles');
}

export async function invalidateArchivedCache(env: Env): Promise<void> {
  await d1CacheRemove(env.DB, cacheKeyArchived(env));
}
