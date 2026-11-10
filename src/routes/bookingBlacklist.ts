import type { Env } from '../types';
import { sanitizeStr } from '../config';
import { getUserByUsername } from '../db/queries/users';
import { getPrisonerById } from '../db/queries/prisoners';
import { getBookingBan, getBookingBlacklist, saveBookingBan } from '../db/queries/bookingBlacklist';
import { logEvent } from '../services/logger';
import { threeMonthBanExpiry } from '../services/bookingBlacklist';
import { bumpDataVersion } from '../db/queries/settings';

async function canManage(env: Env, username: string): Promise<boolean> {
  const account = await getUserByUsername(env.DB, username);
  return account?.role === 'Superadmin' || account?.role === 'Admin' || account?.role === 'Vinai';
}

export async function handleGetBookingBlacklist(
  env: Env,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await canManage(env, user.username))) return { status: 'error', message: 'ไม่มีสิทธิ์จัดการบัญชีระงับการจอง' };
  const now = new Date();
  const rows = (await getBookingBlacklist(env.DB)).map((row) => ({
    ...row,
    daysRemaining: Math.max(0, Math.ceil((Date.parse(row.bannedUntil) - now.getTime()) / 86400000)) || 0,
    banned: row.bannedUntil > now.toISOString(),
  }));
  return { status: 'ok', rows, serverTime: now.toISOString() };
}

export async function handleUpdateBookingBan(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await canManage(env, user.username))) return { status: 'error', message: 'ไม่มีสิทธิ์จัดการบัญชีระงับการจอง' };
  const prisonerId = sanitizeStr(body.prisonerId, 64);
  if (!prisonerId) return { status: 'error', message: 'กรุณาระบุเลขผู้ต้องขัง' };
  const previous = await getBookingBan(env.DB, prisonerId);
  if (!previous && !(await getPrisonerById(env.DB, prisonerId))) {
    return { status: 'error', message: 'ไม่พบผู้ต้องขัง' };
  }
  let warnings = previous?.consecutiveCancellations ?? 0;
  let bannedUntil: string;
  if (body.operation === 'ban') {
    warnings = 0;
    bannedUntil = threeMonthBanExpiry(new Date());
  } else if (body.operation === 'unban') {
    bannedUntil = '';
  } else if (body.operation === 'update') {
    if (body.warnings !== 0 && body.warnings !== 1) {
      return { status: 'error', message: 'คำเตือนต้องเป็น 0 หรือ 1 ครั้ง (ครบ 2 ครั้งจะระงับการจอง)' };
    }
    warnings = body.warnings;
    if (
      typeof body.bannedUntil !== 'string' ||
      (body.bannedUntil !== '' &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(body.bannedUntil) ||
          !Number.isFinite(Date.parse(body.bannedUntil)) ||
          Date.parse(body.bannedUntil) <= Date.now()))
    ) {
      return { status: 'error', message: 'วันสิ้นสุดการระงับต้องเป็นวันเวลาในอนาคต หรือเว้นว่างเพื่อยกเลิก' };
    }
    bannedUntil = body.bannedUntil ? new Date(body.bannedUntil).toISOString() : '';
  } else {
    return { status: 'error', message: 'คำสั่งไม่ถูกต้อง' };
  }
  await saveBookingBan(env.DB, prisonerId, warnings, bannedUntil);
  await bumpDataVersion(env.DB, 'prisoners');
  await logEvent(
    env,
    user.username,
    'update_booking_ban',
    prisonerId,
    {
      operation: body.operation,
      previous,
      warnings,
      bannedUntil,
      reason: sanitizeStr(body.reason, 2000),
    },
    'success'
  );
  return { status: 'ok', message: 'บันทึกการระงับการจองแล้ว', warnings, bannedUntil };
}
