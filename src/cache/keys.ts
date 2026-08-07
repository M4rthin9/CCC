import { getCacheVersion } from '../config';

export function cacheKeyReservations(env: { CACHE_VERSION?: string }): string {
  return getCacheVersion(env) + ':allReservations';
}

export function cacheKeyCounts(env: { CACHE_VERSION?: string }): string {
  return getCacheVersion(env) + ':counts';
}

export function cacheKeyArchived(env: { CACHE_VERSION?: string }): string {
  return getCacheVersion(env) + ':allArchived';
}

export function cacheKeyUsers(env: { CACHE_VERSION?: string }): string {
  return getCacheVersion(env) + ':users';
}

export function cacheKeyRoles(env: { CACHE_VERSION?: string }): string {
  return getCacheVersion(env) + ':roles';
}

export function cacheKeyUser(env: { CACHE_VERSION?: string }, username: string): string {
  return 'user_' + String(username || '').toLowerCase();
}

export function cacheKeyPrisoners(): string {
  return 'prisoners';
}

export function cacheKeySpreadsheetId(env: { CACHE_VERSION?: string }): string {
  return getCacheVersion(env) + ':spreadsheetId';
}

export function lookupCacheKey(env: { CACHE_VERSION?: string }, ref: string | null, prisonerId: string | null): string {
  const v = getCacheVersion(env);
  if (ref) return v + ':lookup:ref:' + String(ref).trim().toUpperCase();
  return v + ':lookup:pid:' + String(prisonerId || '').trim().toUpperCase();
}

export function rateLimitKey(namespace: string, key: string): string {
  return 'rl:' + namespace + ':' + key;
}
