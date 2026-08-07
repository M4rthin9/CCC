import type { Env } from '../types';
import { ARCHIVE_MONTHS, BACKUP_RETENTION_DAYS } from '../lib/constants';
import { bangkokNow, bangkokNowISO, nowUtc, nowMinusMonthsISO } from '../lib/dates';
import { afterWrite, logEvent } from '../db/db';

export async function archiveOldReservations(env: Env): Promise<{ status: 'ok'; archived: number; cutoff: string }> {
  const months = parseInt(env.ARCHIVE_MONTHS || String(ARCHIVE_MONTHS), 10) || ARCHIVE_MONTHS;
  const cutoff = nowMinusMonthsISO(months);
  const now = nowUtc();
  const res = await env.DB.prepare('UPDATE bookings SET archived_at = ?, updated_at = ? WHERE archived_at IS NULL AND visit_date_iso < ?')
    .bind(bangkokNow(), now, cutoff)
    .run();
  const archived = res.meta.changes || 0;

  await afterWrite(env, {
    ref: null,
    prisonerId: null,
    event: { type: 'reservations_archived', at: now },
    log: {
      username: 'system',
      action: 'reservations_archived',
      targetRef: '',
      details: { archived, cutoff },
      result: 'success',
      ip: '',
      userAgent: '',
    },
  });
  return { status: 'ok', archived, cutoff };
}

export async function backupData(env: Env): Promise<{ status: 'ok'; backupKey: string; rows: Record<string, number> }> {
  const [bookings, prisoners, users, roles, settings] = await Promise.all([
    env.DB.prepare('SELECT * FROM bookings').all(),
    env.DB.prepare('SELECT * FROM prisoners').all(),
    env.DB.prepare('SELECT * FROM users').all(),
    env.DB.prepare('SELECT * FROM roles').all(),
    env.DB.prepare('SELECT * FROM settings').all(),
  ]);

  const snapshot = {
    exportedAt: new Date().toISOString(),
    bookings: bookings.results,
    prisoners: prisoners.results,
    users: users.results,
    roles: roles.results,
    settings: settings.results,
  };

  const backupKey = 'backups/' + bangkokNowISO() + '.json';
  await env.CC_SLIPS.put(backupKey, JSON.stringify(snapshot), {
    httpMetadata: { contentType: 'application/json' },
  });

  const retentionDays = parseInt(env.BACKUP_RETENTION_DAYS || String(BACKUP_RETENTION_DAYS), 10) || BACKUP_RETENTION_DAYS;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const list = await env.CC_SLIPS.list({ prefix: 'backups/' });
  const stale: string[] = [];
  for (const obj of list.objects) {
    const name = obj.key.substring('backups/'.length).replace('.json', '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) {
      const ts = new Date(name + 'T00:00:00Z').getTime();
      if (!isNaN(ts) && ts < cutoffMs) stale.push(obj.key);
    }
  }
  if (stale.length > 0) await Promise.all(stale.map((k) => env.CC_SLIPS.delete(k)));

  const rows = {
    bookings: (bookings.results || []).length,
    prisoners: (prisoners.results || []).length,
    users: (users.results || []).length,
    roles: (roles.results || []).length,
    settings: (settings.results || []).length,
  };

  await logEvent(env, {
    username: 'system',
    action: 'backup_created',
    targetRef: backupKey,
    details: { rows, removedBackups: stale.length },
    result: 'success',
    ip: '',
    userAgent: '',
  });
  return { status: 'ok', backupKey, rows };
}
