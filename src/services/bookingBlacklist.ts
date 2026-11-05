import type { Env } from '../types';
import { formatBangkok } from '../config';

/** Always read live state: a cancellation must block the very next booking. */
export async function prisonerBookingBanError(env: Env, prisonerId: string): Promise<string> {
  const ban = await env.DB.prepare(
    `SELECT bannedUntil FROM prisoner_booking_blacklist
     WHERE prisonerId = ? AND bannedUntil > ?`
  )
    .bind(prisonerId.trim(), new Date().toISOString())
    .first<{ bannedUntil: string }>();
  if (!ban) return '';
  return `⚠️ ผู้ต้องขังหมายเลข ${prisonerId} ถูกระงับการจอง 3 เดือน เนื่องจากแอดมินยกเลิกการจอง 2 ครั้งติดต่อกัน จองได้อีกครั้งตั้งแต่ ${formatBangkok(new Date(ban.bannedUntil))} (เวลาไทย)`;
}
