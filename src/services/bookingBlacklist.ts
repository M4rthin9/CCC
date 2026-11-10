import type { Env } from '../types';
import { formatBangkok } from '../config';

/** Three calendar months at the same Bangkok time, clamped to month end. */
export function threeMonthBanExpiry(now: Date): string {
  const local = new Date(now.getTime() + 7 * 3600000);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() + 3);
  const lastDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  local.setUTCDate(Math.min(day, lastDay));
  return new Date(local.getTime() - 7 * 3600000).toISOString();
}

/** Always read live state: a cancellation must block the very next booking. */
export async function prisonerBookingBanError(env: Env, prisonerId: string): Promise<string> {
  const ban = await env.DB.prepare(
    `SELECT bannedUntil FROM prisoner_booking_blacklist
     WHERE prisonerId = ? AND bannedUntil > ?`
  )
    .bind(prisonerId.trim(), new Date().toISOString())
    .first<{ bannedUntil: string }>();
  if (!ban) return '';
  return `⚠️ ผู้ต้องขังหมายเลข ${prisonerId} ถูกระงับการจอง จองได้อีกครั้งตั้งแต่ ${formatBangkok(new Date(ban.bannedUntil))} (เวลาไทย)`;
}
