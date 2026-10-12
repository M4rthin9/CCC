import type { Env } from '../types';
import { readSystemStatus } from '../services/systemStatus';

export async function handleSystemStatus(env: Env, request: Request): Promise<Response> {
  // Canonical key excludes query strings and caller headers. CORS is applied after caching.
  const key = new Request(new URL('/api/system-status', request.url).toString());
  const cache = (caches as CacheStorage & { default?: Cache }).default;
  try {
    const hit = await cache?.match(key);
    if (hit) return hit;
  } catch {
    // Cache availability cannot cause a D1 fallback.
  }
  const data = await readSystemStatus(env);
  const response = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
  if (data.checkedAt) {
    try {
      await cache?.put(key, response.clone());
    } catch {
      // A valid KV snapshot still works when the edge cache is unavailable.
    }
  }
  return response;
}
