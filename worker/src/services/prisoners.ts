import type { Env, PrisonerRow, UserRow } from '../types';
import { PUBLIC_CACHE_TTL } from '../lib/constants';
import { getVersioned, putVersioned, afterWrite, logEvent } from '../db/db';
import { hasPermission } from '../auth/guard';
import { sanitizeStr } from '../lib/validate';
import { formatDateISO, nowUtc } from '../lib/dates';

const DISCIPLINE_STATUS = 'ติดวินัย งดเยี่ยม';

export function isDisciplineActive(p: { status?: string | null; vinai_date?: string | null }): boolean {
  if (!p) return false;
  if (String(p.status || '').trim() !== DISCIPLINE_STATUS) return false;
  const vd = p.vinai_date;
  if (vd === undefined || vd === null || String(vd).trim() === '') return true;
  const parsed = new Date(String(vd).trim());
  if (isNaN(parsed.getTime())) return true;
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  return parsed > oneYearAgo;
}

async function clearExpiredDiscipline(env: Env): Promise<number> {
  const res = await env.DB.prepare('SELECT id, prisoner_id, status, vinai_date FROM prisoners WHERE status = ?')
    .bind(DISCIPLINE_STATUS)
    .all<PrisonerRow>();
  const clears: D1PreparedStatement[] = [];
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  for (const row of res.results || []) {
    const vd = row.vinai_date;
    if (!vd) continue;
    const parsed = new Date(String(vd).trim());
    if (isNaN(parsed.getTime())) continue;
    if (parsed <= oneYearAgo) {
      clears.push(env.DB.prepare("UPDATE prisoners SET status = '', vinai_date = '', updated_at = ? WHERE id = ?").bind(nowUtc(), row.id));
    }
  }
  if (clears.length === 0) return 0;
  await env.DB.batch(clears);
  return clears.length;
}

export async function getPrisoners(env: Env): Promise<{ status: 'ok'; prisoners: [string, string, string, string, string][] }> {
  const cleared = await clearExpiredDiscipline(env);
  if (cleared > 0) {
    const version = await getVersion(env);
    await env.CC_CACHE.delete('prisoners:' + version).catch(() => undefined);
  }

  const cached = await getVersioned<[string, string, string, string, string][]>(env, 'prisoners', PUBLIC_CACHE_TTL);
  if (cached) return { status: 'ok', prisoners: cached };

  const res = await env.DB.prepare('SELECT prisoner_name, prisoner_id, wing, status, vinai_date FROM prisoners').all<PrisonerRow>();
  const prisoners: [string, string, string, string, string][] = [];
  const seen = new Set<string>();
  for (const row of res.results || []) {
    const name = String(row.prisoner_name || '').trim();
    const id = String(row.prisoner_id || '').trim();
    const wing = String(row.wing || '').trim();
    if (!name || !id) continue;
    const key = id + '|' + name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const statusVal = String(row.status || '').trim();
    let vinaiDateVal = '';
    if (row.vinai_date) {
      const d = new Date(String(row.vinai_date).trim());
      vinaiDateVal = !isNaN(d.getTime()) ? formatDateISO(d) : String(row.vinai_date).trim();
    }
    prisoners.push([name, id, wing, statusVal, vinaiDateVal]);
  }
  prisoners.sort((a, b) => a[0].localeCompare(b[0], 'th'));
  await putVersioned(env, 'prisoners', prisoners, PUBLIC_CACHE_TTL);
  return { status: 'ok', prisoners };
}

export async function getPrisonerById(env: Env, prisonerId: string): Promise<PrisonerRow | null> {
  const target = String(prisonerId || '').trim();
  if (!target) return null;
  return env.DB.prepare('SELECT * FROM prisoners WHERE prisoner_id = ?').bind(target).first<PrisonerRow>();
}

export async function recheckPrisoner(
  env: Env,
  prisonerId: string,
): Promise<{ status: 'ok'; prisonerId: string; restricted: boolean; prisoner: { prisonerName: string; status: string; vinaiDate: string } | null }> {
  const p = await getPrisonerById(env, prisonerId);
  const restricted = isDisciplineActive(p);
  return {
    status: 'ok',
    prisonerId: prisonerId,
    restricted,
    prisoner: p
      ? {
          prisonerName: p.prisoner_name || '',
          status: p.status || '',
          vinaiDate: p.vinai_date || '',
        }
      : null,
  };
}

export async function importPrisoners(
  env: Env,
  user: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message?: string; added?: number; updated?: number; errors?: string[] }> {
  if (!(await hasPermission(env, user, 'manage_users'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์นำเข้าข้อมูลผู้ต้องขัง' };
  }
  if (!Array.isArray(body.prisoners)) {
    return { status: 'error', message: 'กรุณาส่งข้อมูลผู้ต้องขังอย่างน้อย 1 รายการ' };
  }
  const prisoners = body.prisoners as Record<string, unknown>[];
  if (prisoners.length === 0) {
    return { status: 'error', message: 'กรุณาส่งข้อมูลผู้ต้องขังอย่างน้อย 1 รายการ' };
  }
  if (prisoners.length > 5000) {
    return { status: 'error', message: 'ข้อมูลผู้ต้องขังมากเกินไป (สูงสุด 5000 รายการต่อครั้ง)' };
  }

  const now = nowUtc();
  const errors: string[] = [];
  const normalized: { prisonerId: string; name: string; wing: string; status: string; vinaiDate: string; note: string }[] = [];
  prisoners.forEach((p, i) => {
    const prisonerId = sanitizeStr(p.prisonerId, 64);
    const name = sanitizeStr(p.prisonerName, 200);
    if (!prisonerId || !name) {
      errors.push('แถวที่ ' + (i + 1) + ': ขาดเลขผู้ต้องขังหรือชื่อ');
      return;
    }
    normalized.push({
      prisonerId,
      name,
      wing: sanitizeStr(p.wing, 64),
      status: sanitizeStr(p.status, 100),
      vinaiDate: sanitizeStr(p.vinaiDate, 40),
      note: sanitizeStr(p.note, 2000),
    });
  });

  const existingRes = await env.DB.prepare('SELECT prisoner_id FROM prisoners').all<{ prisoner_id: string }>();
  const idIndex = new Map<string, boolean>();
  for (const r of existingRes.results || []) idIndex.set(r.prisoner_id, true);

  let added = 0;
  let updated = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const p of normalized) {
    if (idIndex.has(p.prisonerId)) {
      stmts.push(
        env.DB.prepare(
          'UPDATE prisoners SET prisoner_name = ?, wing = ?, status = ?, vinai_date = ?, note = ?, updated_at = ? WHERE prisoner_id = ?',
        ).bind(p.name, p.wing, p.status, p.vinaiDate, p.note, now, p.prisonerId),
      );
      updated++;
    } else {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO prisoners (prisoner_id, prisoner_name, wing, status, vinai_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(p.prisonerId, p.name, p.wing, p.status, p.vinaiDate, p.note, now, now),
      );
      added++;
    }
  }
  if (stmts.length > 0) await env.DB.batch(stmts);

  await afterWrite(env, {
    ref: null,
    prisonerId: null,
    event: { type: 'prisoners_imported', at: now },
    log: {
      username: user.username,
      action: 'import_prisoners',
      targetRef: '',
      details: { added, updated, errors: errors.length },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return {
    status: 'ok',
    message: 'นำเข้าสำเร็จ: เพิ่ม ' + added + ' รายการ, อัปเดต ' + updated + ' รายการ',
    added,
    updated,
    errors,
  };
}

export async function syncPrisonerWings(
  env: Env,
  user: UserRow,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message: string; updated?: number }> {
  const prisoners = await env.DB.prepare('SELECT prisoner_id, wing FROM prisoners').all<{ prisoner_id: string; wing: string | null }>();
  if (!prisoners.results || prisoners.results.length === 0) {
    return { status: 'error', message: 'ไม่มีข้อมูลผู้ต้องขังในระบบ' };
  }
  const wingMap = new Map<string, string>();
  for (const p of prisoners.results) {
    const id = String(p.prisoner_id || '').trim();
    const wing = String(p.wing || '').trim();
    if (id) wingMap.set(id, wing);
  }

  const bookings = await env.DB.prepare('SELECT id, prisoner_id, wing FROM bookings WHERE archived_at IS NULL').all<{
    id: number;
    prisoner_id: string;
    wing: string | null;
  }>();
  if (!bookings.results || bookings.results.length === 0) {
    return { status: 'error', message: 'ไม่มีข้อมูลการจองในระบบ' };
  }

  const now = nowUtc();
  const updates: D1PreparedStatement[] = [];
  for (const b of bookings.results) {
    const prisonerId = String(b.prisoner_id || '').trim();
    const targetWing = wingMap.get(prisonerId);
    if (!prisonerId || targetWing === undefined) continue;
    const currentWing = String(b.wing || '').trim();
    if (currentWing !== targetWing) {
      updates.push(env.DB.prepare('UPDATE bookings SET wing = ?, updated_at = ? WHERE id = ?').bind(targetWing, now, b.id));
    }
  }

  if (updates.length > 0) await env.DB.batch(updates);

  await afterWrite(env, {
    ref: null,
    prisonerId: null,
    event: { type: 'prisoners_synced', at: now },
    log: {
      username: user.username,
      action: 'sync_prisoner_wings',
      targetRef: '',
      details: { updated: updates.length },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok', message: 'อัปเดตแดนผู้ต้องขังเสร็จสิ้น: ' + updates.length + ' รายการ', updated: updates.length };
}

export async function cleanupExpiredDiscipline(env: Env): Promise<{ status: 'ok'; cleared: number }> {
  const cleared = await clearExpiredDiscipline(env);
  if (cleared > 0) {
    await afterWrite(env, {
      ref: null,
      prisonerId: null,
      event: { type: 'discipline_cleanup', at: nowUtc() },
      log: {
        username: 'system',
        action: 'cleanup_expired_discipline',
        targetRef: '',
        details: { cleared },
        result: 'success',
        ip: '',
        userAgent: '',
      },
    });
  } else {
    await logEvent(env, {
      username: 'system',
      action: 'cleanup_expired_discipline',
      targetRef: '',
      details: { cleared: 0 },
      result: 'success',
      ip: '',
      userAgent: '',
    });
  }
  return { status: 'ok', cleared };
}
