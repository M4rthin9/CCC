import { PUBLIC_CACHE_TTL } from '../constants';
import { sanitizeStr } from '../config';
import { cacheKeyPrisoners } from '../cache/keys';
import { cacheGetLarge, cachePutLarge, cacheRemove } from '../cache/kv';
import {
  getMinifiedPrisoners, getPrisonerById, getPrisonerIdToWingMap, upsertPrisoner
} from '../db/queries/prisoners';
import { getActiveReservations } from '../db/queries/reservations';
import { hasPermission } from '../db/queries/roles';
import { invalidatePrisonersCache, invalidateReservationsCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import { isDisciplineActive } from '../services/disciplineService';
import { Env } from '../types';

export async function handleGetPrisoners(env: Env): Promise<Record<string, unknown>> {
  const key = cacheKeyPrisoners();
  const cached = await cacheGetLarge(env.CACHE_KV, key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return { status: 'ok', prisoners: parsed };
    } catch {
      await cacheRemove(env.CACHE_KV, key).catch(() => undefined);
    }
  }

  const prisoners = await getMinifiedPrisoners(env.DB);
  await cachePutLarge(env.CACHE_KV, key, JSON.stringify(prisoners), PUBLIC_CACHE_TTL);
  return { status: 'ok', prisoners };
}

export async function handleImportPrisoners(env: Env, body: Record<string, unknown>, user: { username: string }): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์นำเข้าข้อมูลผู้ต้องขัง' };
  }

  const prisoners = Array.isArray(body.prisoners) ? body.prisoners : null;
  if (!prisoners || prisoners.length === 0) {
    return { status: 'error', message: 'กรุณาส่งข้อมูลผู้ต้องขังอย่างน้อย 1 รายการ' };
  }
  if (prisoners.length > 5000) {
    return { status: 'error', message: 'ข้อมูลผู้ต้องขังมากเกินไป (สูงสุด 5000 รายการต่อครั้ง)' };
  }

  const errors: string[] = [];
  let added = 0;
  let updated = 0;

  for (let i = 0; i < prisoners.length; i++) {
    const p = prisoners[i] as Record<string, unknown>;
    const prisonerId = sanitizeStr(p.prisonerId, 64);
    const name = sanitizeStr(p.prisonerName, 200);
    if (!prisonerId || !name) {
      errors.push('แถวที่ ' + (i + 1) + ': ขาดเลขผู้ต้องขังหรือชื่อ');
      continue;
    }
    const existing = await getPrisonerById(env.DB, prisonerId);
    await upsertPrisoner(env.DB, {
      prisonerId,
      prisonerName: name,
      wing: sanitizeStr(p.wing, 64),
      status: sanitizeStr(p.status, 100),
      vinaiDate: sanitizeStr(p.vinaiDate, 40),
      note: sanitizeStr(p.note, 2000),
    });
    if (existing) updated++; else added++;
  }

  await invalidatePrisonersCache(env);
  await logEvent(env, user.username, 'import_prisoners', '', { added, updated, errors: errors.length }, 'success');
  return {
    status: 'ok',
    message: 'นำเข้าสำเร็จ: เพิ่ม ' + added + ' รายการ, อัปเดต ' + updated + ' รายการ',
    added,
    updated,
    errors,
  };
}

export async function handleSyncPrisonerWings(env: Env, body: Record<string, unknown>, user: { username: string }): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
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
      await env.DB.prepare('UPDATE reservations SET wing = ? WHERE ref = ?')
        .bind(wingMap[prisonerId], row.ref).run();
      updated++;
    }
  }

  if (updated > 0) {
    await invalidatePrisonersCache(env);
    await invalidateReservationsCache(env);
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
    prisoner: p ? {
      prisonerName: String(p.prisonerName || ''),
      status: String(p.status || ''),
      vinaiDate: String(p.vinaiDate || ''),
    } : null,
  };
}
