import { reservationChanged } from '../services/reservationChanges';
import { PRISONERS_CACHE_TTL } from '../constants';
import { sanitizeStr } from '../config';
import { cacheKeyPrisoners } from '../cache/keys';
import { d1CacheGet, d1CachePut, d1CacheRemove } from '../cache/d1Cache';
import {
  getMinifiedPrisoners,
  getPrisoners,
  getPrisonerById,
  getPrisonerIdNameWing,
  getPrisonerIdToWingMap,
  importPrisonersBulk,
  updatePrisoner,
  syncPrisonerWing,
  type PrisonerImportRow,
} from '../db/queries/prisoners';
import { getActiveReservations } from '../db/queries/reservations';
import { hasPermission } from '../db/queries/roles';
import { invalidatePrisonersCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import { isDisciplineActive } from '../services/disciplineService';
import { Env, Prisoner } from '../types';
import { getUserByUsername } from '../db/queries/users';

const MAX_IMPORT_PRISONERS = 20000;
const RESERVATIONS_SYNC_BATCH = 100;

export async function handleGetPrisonersAdmin(env: Env, user: { username: string }): Promise<Record<string, unknown>> {
  const account = await getUserByUsername(env.DB, user.username);
  if (account?.role !== 'Admin' && !(await hasPermission(env.DB, user.username, 'manage_prisoners'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดูข้อมูลผู้ต้องขัง' };
  }
  return { status: 'ok', prisoners: await getPrisoners(env.DB) };
}

export async function handleUpdatePrisoner(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_prisoners'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์แก้ไขข้อมูลผู้ต้องขัง' };
  }
  const prisonerId = sanitizeStr(body.prisonerId, 64);
  if (!prisonerId) return { status: 'error', message: 'กรุณาระบุเลขผู้ต้องขัง' };
  const fields: Partial<Omit<Prisoner, 'prisonerId'>> = {};
  for (const [key, max] of [
    ['prisonerName', 200],
    ['wing', 64],
    ['status', 100],
    ['vinaiDate', 40],
    ['note', 2000],
  ] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string') return { status: 'error', message: 'ข้อมูลผู้ต้องขังไม่ถูกต้อง' };
    fields[key] = sanitizeStr(body[key], max);
  }
  if (!Object.keys(fields).length || fields.prisonerName === '') {
    return { status: 'error', message: 'กรุณาระบุข้อมูลที่ต้องการแก้ไขและชื่อผู้ต้องขัง' };
  }
  if (
    fields.vinaiDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(fields.vinaiDate) ||
      !Number.isFinite(Date.parse(fields.vinaiDate)) ||
      new Date(fields.vinaiDate).toISOString().slice(0, 10) !== fields.vinaiDate)
  ) {
    return { status: 'error', message: 'วันที่วินัยไม่ถูกต้อง (YYYY-MM-DD)' };
  }
  const prisoner = await updatePrisoner(env.DB, prisonerId, fields);
  if (!prisoner) return { status: 'error', message: 'ไม่พบผู้ต้องขังที่ต้องการแก้ไข' };
  const reservationsWingSynced =
    fields.wing === undefined ? 0 : await syncPrisonerWing(env.DB, prisonerId, fields.wing);
  await invalidatePrisonersCache(env);
  if (reservationsWingSynced) await reservationChanged(env);
  await logEvent(env, user.username, 'update_prisoner', prisonerId, { fields, reservationsWingSynced }, 'success');
  return { status: 'ok', message: 'บันทึกข้อมูลผู้ต้องขังแล้ว', prisoner, reservationsWingSynced };
}

export async function handleGetPrisoners(env: Env): Promise<Record<string, unknown>> {
  const key = cacheKeyPrisoners();
  const cached = await d1CacheGet<string>(env.DB, key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return { status: 'ok', prisoners: parsed };
    } catch {
      await d1CacheRemove(env.DB, key).catch(() => undefined);
    }
  }

  const prisoners = await getMinifiedPrisoners(env.DB);
  await d1CachePut(env.DB, key, JSON.stringify(prisoners), PRISONERS_CACHE_TTL);
  return { status: 'ok', prisoners };
}

export async function handleImportPrisoners(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_prisoners'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์นำเข้าข้อมูลผู้ต้องขัง' };
  }

  // Old single-record editors used this destructive action. Fail closed unless
  // the caller explicitly requested a complete roster replacement.
  if (body.replaceAll !== true) {
    return {
      status: 'error',
      message: 'การนำเข้าต้องยืนยันแทนที่รายชื่อทั้งหมด หากแก้ไขรายบุคคลให้ใช้ updatePrisoner',
    };
  }

  const prisoners = Array.isArray(body.prisoners) ? body.prisoners : null;
  if (!prisoners || prisoners.length === 0) {
    return { status: 'error', message: 'กรุณาส่งข้อมูลผู้ต้องขังอย่างน้อย 1 รายการ' };
  }
  if (prisoners.length > MAX_IMPORT_PRISONERS) {
    return {
      status: 'error',
      message: 'ข้อมูลผู้ต้องขังมากเกินไป (สูงสุด ' + MAX_IMPORT_PRISONERS + ' รายการต่อครั้ง)',
    };
  }

  const errors: string[] = [];
  const rows: PrisonerImportRow[] = [];
  for (let i = 0; i < prisoners.length; i++) {
    const p = (prisoners[i] && typeof prisoners[i] === 'object' ? prisoners[i] : {}) as Record<string, unknown>;
    const prisonerId = sanitizeStr(p.prisonerId, 64);
    const name = sanitizeStr(p.prisonerName, 200);
    if (!prisonerId || !name) {
      errors.push('แถวที่ ' + (i + 1) + ': ขาดเลขผู้ต้องขังหรือชื่อ');
      continue;
    }
    rows.push({
      prisonerId,
      prisonerName: name,
      wing: sanitizeStr(p.wing, 64),
      status: sanitizeStr(p.status, 100),
      vinaiDate: sanitizeStr(p.vinaiDate, 40),
      note: sanitizeStr(p.note, 2000),
    });
  }
  if (rows.length === 0 || errors.length > 0) {
    return {
      status: 'error',
      message: 'ข้อมูลนำเข้าไม่ถูกต้อง กรุณาแก้ไขทุกแถวก่อนแทนที่รายชื่อเดิม',
      errors,
    };
  }

  const existing = await getPrisonerIdNameWing(env.DB);
  const result = await importPrisonersBulk(env.DB, rows, existing);

  // Prisoners that changed wing: propagate the latest wing into their active
  // reservations so bookings follow the prisoner's current wing.
  let reservationsWingSynced = 0;
  if (result.wingChanges.length > 0) {
    const syncStmts = result.wingChanges.map((ch) =>
      env.DB.prepare('UPDATE reservations SET wing = ? WHERE prisonerId = ? AND wing != ?').bind(
        ch.wing,
        ch.prisonerId,
        ch.wing
      )
    );
    for (let i = 0; i < syncStmts.length; i += RESERVATIONS_SYNC_BATCH) {
      const res = await env.DB.batch(syncStmts.slice(i, i + RESERVATIONS_SYNC_BATCH));
      for (const r of res) reservationsWingSynced += Number(r?.meta?.changes ?? 0);
    }
  }

  await invalidatePrisonersCache(env);
  if (reservationsWingSynced > 0) await reservationChanged(env);
  await logEvent(
    env,
    user.username,
    'import_prisoners',
    '',
    {
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      wingChanged: result.wingChanged,
      reservationsWingSynced,
      errors: errors.length,
    },
    'success'
  );

  let message = 'นำเข้าสำเร็จ: เพิ่ม ' + result.added + ' รายการ, อัปเดต ' + result.updated + ' รายการ';
  if (result.removed > 0) message += ', ลบผู้ต้องขังที่ไม่อยู่ในไฟล์ ' + result.removed + ' รายการ';
  if (result.wingChanged > 0) message += ', เปลี่ยนแดน ' + result.wingChanged + ' รายการ';
  if (reservationsWingSynced > 0) message += ', ซิงค์แดนการจอง ' + reservationsWingSynced + ' รายการ';

  return {
    status: 'ok',
    message,
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    wingChanged: result.wingChanged,
    reservationsWingSynced,
    errors,
  };
}

export async function handleSyncPrisonerWings(
  env: Env,
  _body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_prisoners'))) {
    return { status: 'error', message: 'Unauthorized' };
  }

  const wingMap = await getPrisonerIdToWingMap(env.DB);
  const rows = await getActiveReservations(env.DB);

  let updated = 0;
  for (const row of rows) {
    const prisonerId = String(row.prisonerId || '').trim();
    if (!prisonerId || !wingMap[prisonerId]) continue;
    const currentWing = String(row.wing || '').trim();
    if (currentWing !== wingMap[prisonerId]) {
      await env.DB.prepare('UPDATE reservations SET wing = ? WHERE ref = ?').bind(wingMap[prisonerId], row.ref).run();
      updated++;
    }
  }

  if (updated > 0) {
    await invalidatePrisonersCache(env);
    await reservationChanged(env);
  }
  await logEvent(env, user.username, 'sync_prisoner_wings', '', { updated }, 'success');
  return { status: 'ok', message: 'อัปเดตแดนผู้ต้องขังเสร็จสิ้น: ' + updated + ' รายการ', updated };
}

export async function handleRecheckPrisoner(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pid = sanitizeStr(body.prisonerId, 64);
  if (!pid) return { status: 'error', message: 'Missing prisonerId' };
  const p = await getPrisonerById(env.DB, pid);
  const restricted = isDisciplineActive(p ? p.status : '', p ? p.vinaiDate : null);
  return {
    status: 'ok',
    prisonerId: pid,
    restricted,
    prisoner: p
      ? {
          prisonerName: String(p.prisonerName || ''),
          status: String(p.status || ''),
          vinaiDate: String(p.vinaiDate || ''),
        }
      : null,
  };
}

/** Public selection check; exposes only the current booking ban, never staff notes. */
export async function handleGetPrisonerBookingBan(
  env: Env,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const prisonerId = sanitizeStr(body.prisonerId, 64);
  if (!prisonerId) return { status: 'error', message: 'Missing prisonerId' };
  const now = new Date();
  const ban = await env.DB.prepare(
    'SELECT bannedUntil FROM prisoner_booking_blacklist WHERE prisonerId = ? AND bannedUntil > ?'
  )
    .bind(prisonerId, now.toISOString())
    .first<{ bannedUntil: string }>();
  return { status: 'ok', bannedUntil: ban?.bannedUntil ?? '', serverTime: now.toISOString() };
}
