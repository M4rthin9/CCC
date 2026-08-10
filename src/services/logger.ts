import { formatBangkok } from '../config';
import { insertEventLog } from '../db/queries/eventlog';
import { Env } from '../types';
import { sanitizeStr } from '../config';

export interface LogMeta {
  ip?: string;
  userAgent?: string;
}

// Mirrors logEvent() in the legacy backend. Never throws.
export async function logEvent(
  env: Env,
  username: string | null,
  action: string,
  targetRef: string | null,
  details: unknown,
  result: string,
  meta?: LogMeta
): Promise<void> {
  try {
    const detailsStr = details && typeof details === 'object' ? JSON.stringify(details) : String(details || '');
    await insertEventLog(env.DB, {
      timestamp: formatBangkok(new Date()),
      username: sanitizeStr(username || 'system', 100),
      action: sanitizeStr(action, 200),
      targetRef: sanitizeStr(targetRef || '', 64),
      details: sanitizeStr(detailsStr, 5000),
      result: sanitizeStr(result || 'success', 50),
      ip: sanitizeStr(meta?.ip || '', 64),
      userAgent: sanitizeStr(meta?.userAgent || '', 500),
    });
  } catch {
    // Event logging must never break a request.
  }
}
