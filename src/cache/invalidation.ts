import {
  cacheKeyArchived,
  cacheKeyCounts,
  cacheKeyPrisoners,
  cacheKeyReservations,
  cacheKeyRoles,
  cacheKeyUser,
  cacheKeyUsers,
  lookupCacheKey,
} from './keys';
import { cacheRemove, cacheRemoveLarge } from './kv';
import { Env } from '../types';
import { bumpDataVersion } from '../db/queries/settings';

export async function invalidateReservationsCache(env: Env): Promise<void> {
  await Promise.all([
    cacheRemoveLarge(env.CACHE_KV, cacheKeyReservations(env)),
    cacheRemoveLarge(env.CACHE_KV, cacheKeyCounts(env)),
  ]);
  await bumpDataVersion(env.DB, 'reservations');
}

export async function invalidateLookupCache(env: Env, ref: string): Promise<void> {
  if (!ref) return;
  await cacheRemove(env.CACHE_KV, lookupCacheKey(env, ref, null));
}

export async function invalidatePrisonerLookupCache(env: Env, prisonerId: string): Promise<void> {
  if (!prisonerId) return;
  await cacheRemove(env.CACHE_KV, lookupCacheKey(env, null, prisonerId));
}

export async function invalidateUserCache(env: Env, username: string): Promise<void> {
  await cacheRemove(env.CACHE_KV, cacheKeyUser(username));
}

export async function invalidateAllUsersCache(env: Env): Promise<void> {
  await cacheRemoveLarge(env.CACHE_KV, cacheKeyUsers(env));
  await bumpDataVersion(env.DB, 'users');
}

export async function invalidatePrisonersCache(env: Env): Promise<void> {
  await cacheRemoveLarge(env.CACHE_KV, cacheKeyPrisoners());
  await bumpDataVersion(env.DB, 'prisoners');
}

export async function invalidateRolesCache(env: Env): Promise<void> {
  await cacheRemove(env.CACHE_KV, cacheKeyRoles(env));
  await bumpDataVersion(env.DB, 'roles');
}

export async function invalidateArchivedCache(env: Env): Promise<void> {
  await cacheRemoveLarge(env.CACHE_KV, cacheKeyArchived(env));
}
