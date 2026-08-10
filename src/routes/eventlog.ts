import { sanitizeStr } from '../config';
import { getEventLogs } from '../db/queries/eventlog';
import { hasPermission } from '../db/queries/roles';
import { logEvent } from '../services/logger';
import { Env } from '../types';

export async function handleGetEventLogs(
  env: Env,
  params: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'view_eventlog'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดูบันทึกการทำงาน' };
  }
  const logs = await getEventLogs(env.DB, {
    fromDate: params.fromDate ? sanitizeStr(params.fromDate, 20) : undefined,
    toDate: params.toDate ? sanitizeStr(params.toDate, 20) : undefined,
    username: params.username ? sanitizeStr(params.username, 100) : undefined,
    action: params.actionFilter ? sanitizeStr(params.actionFilter, 200) : undefined,
    search: params.search ? sanitizeStr(params.search, 500) : undefined,
  });
  return { status: 'ok', logs };
}

export async function handleLogClientEvent(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  await logEvent(
    env,
    user.username || 'client',
    body.clientAction ? sanitizeStr(body.clientAction, 200) : 'client_action',
    body.targetRef ? sanitizeStr(body.targetRef, 64) : '',
    body.details ?? {},
    'success'
  );
  return { status: 'ok' };
}
