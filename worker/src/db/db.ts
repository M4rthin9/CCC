import type { Env, RealTimeEvent } from '../types';
import { bangkokNow, nowUtc } from '../lib/dates';
import { publishRealtime } from '../realtime/hub';

export async function getVersion(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'version'").first<{ value: string }>();
  return parseInt(row?.value || '0', 10) || 0;
}

export async function bumpVersion(env: Env): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO meta (key, value, updated_at) VALUES ('version', '1', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at",
  )
    .bind(nowUtc())
    .run();
  return getVersion(env);
}

export interface LogEntry {
  username?: string;
  action: string;
  targetRef?: string;
  details?: unknown;
  result?: string;
  ip?: string;
  userAgent?: string;
}

export function logEventStmt(env: Env, entry: LogEntry): D1PreparedStatement {
  const detailsStr = entry.details && typeof entry.details === 'object' ? JSON.stringify(entry.details) : entry.details || '';
  return env.DB.prepare(
    'INSERT INTO event_log (timestamp, username, action, target_ref, details_json, result, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      bangkokNow(),
      entry.username || 'system',
      entry.action,
      entry.targetRef || '',
      String(detailsStr),
      entry.result || 'success',
      String(entry.ip || ''),
      String(entry.userAgent || ''),
    );
}

export async function logEvent(env: Env, entry: LogEntry): Promise<void> {
  await logEventStmt(env, entry).run();
}

export async function kvGetJSON<T>(env: Env, key: string): Promise<T | null> {
  try {
    const val = await env.CC_CACHE.get(key);
    if (!val) return null;
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
}

export async function kvPutJSON(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await env.CC_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // ephemeral cache layer — a failed write is always safe
  }
}

export async function getVersioned<T>(env: Env, base: string, ttl: number): Promise<T | null> {
  const version = await getVersion(env);
  return kvGetJSON<T>(env, `${base}:${version}`);
}

export async function putVersioned(env: Env, base: string, value: unknown, ttl: number): Promise<void> {
  const version = await getVersion(env);
  await kvPutJSON(env, `${base}:${version}`, value, ttl);
}

export async function checkRateLimit(env: Env, key: string, maxAttempts: number, ttlSeconds: number): Promise<boolean> {
  try {
    const cur = parseInt((await env.CC_CACHE.get(key)) || '0', 10);
    if (cur >= maxAttempts) return false;
    await env.CC_CACHE.put(key, String(cur + 1), { expirationTtl: ttlSeconds });
    return true;
  } catch {
    return true;
  }
}

export async function resetRateLimit(env: Env, key: string): Promise<void> {
  try {
    await env.CC_CACHE.delete(key);
  } catch {
    // ignore
  }
}

export async function invalidateLookupCache(env: Env, ref?: string | null, prisonerId?: string | null): Promise<void> {
  const dels: Promise<unknown>[] = [];
  if (ref) dels.push(env.CC_CACHE.delete(`lookup:ref:${ref.trim().toUpperCase()}`));
  if (prisonerId) dels.push(env.CC_CACHE.delete(`lookup:pid:${String(prisonerId).trim().toUpperCase()}`));
  await Promise.all(dels);
}

export async function afterWrite(
  env: Env,
  opts: { ref?: string | null; prisonerId?: string | null; event: RealTimeEvent; log?: LogEntry },
): Promise<number> {
  const version = await bumpVersion(env);
  await invalidateLookupCache(env, opts.ref, opts.prisonerId);
  if (opts.log) await logEvent(env, opts.log);
  await publishRealtime(env, opts.event);
  return version;
}
