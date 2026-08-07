import type { Env, EventLogRow, UserRow } from '../types';
import { logEvent } from '../db/db';
import { hasPermission } from '../auth/guard';
import { sanitizeStr } from '../lib/validate';

export interface EventLogParams {
  fromDate?: string;
  toDate?: string;
  username?: string;
  action?: string;
  search?: string;
}

export async function getEventLogs(
  env: Env,
  user: UserRow,
  params: Record<string, string>,
): Promise<{ status: 'ok'; logs: Record<string, unknown>[] } | { status: 'error'; message: string }> {
  if (!(await hasPermission(env, user, 'view_eventlog'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดูบันทึกการทำงาน' };
  }
  const sql: string[] = ['SELECT * FROM event_log'];
  const where: string[] = [];
  const binds: unknown[] = [];

  const fromDate = sanitizeStr(params.fromDate, 100);
  const toDate = sanitizeStr(params.toDate, 100);
  const username = sanitizeStr(params.username, 100);
  const action = sanitizeStr(params.action, 100);
  const search = sanitizeStr(params.search, 200);

  if (fromDate) {
    where.push('timestamp >= ?');
    binds.push(fromDate);
  }
  if (toDate) {
    where.push('timestamp <= ?');
    binds.push(toDate + ' 23:59:59');
  }
  if (username) {
    where.push('username LIKE ?');
    binds.push('%' + username + '%');
  }
  if (action) {
    where.push('action LIKE ?');
    binds.push('%' + action + '%');
  }
  if (search) {
    where.push('(details_json LIKE ? OR target_ref LIKE ? OR username LIKE ?)');
    binds.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
  }
  if (where.length > 0) sql.push('WHERE ' + where.join(' AND '));
  sql.push('ORDER BY id DESC LIMIT 500');

  const res = await env.DB.prepare(sql.join(' ')).bind(...binds).all<EventLogRow>();
  const logs = (res.results || []).map((r) => ({
    timestamp: r.timestamp,
    username: r.username || '',
    action: r.action || '',
    targetRef: r.target_ref || '',
    details: r.details_json || '',
    result: r.result || 'success',
    ip: r.ip || '',
    userAgent: r.user_agent || '',
  }));
  return { status: 'ok', logs };
}

export async function logClientEvent(
  env: Env,
  user: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<Record<string, unknown>> {
  await logEvent(env, {
    username: user.username || 'client',
    action: sanitizeStr(body.clientAction, 200) || 'client_action',
    targetRef: sanitizeStr(body.targetRef, 64),
    details: body.details && typeof body.details === 'object' ? body.details : {},
    result: 'success',
    ip,
    userAgent,
  });
  return { status: 'ok' };
}
