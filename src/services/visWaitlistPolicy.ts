import { formatDateISO } from '../config';
import type { Env, Reservation } from '../types';

export const VIS_WAITLIST_START = '2026-11-30T17:00:00.000Z';
export const VIS_FIRST_QUEUE_DATE = '2026-12-01';
export const VIS_PAYMENT_MS = 12 * 60 * 60 * 1000;
// Same-day payment closes at 07:30 Bangkok (00:30 UTC).
export const VIS_PAYMENT_CUTOFF_UTC = 'T00:30:00.000Z';
export const VIS_STANDBY_LIMIT = 5;
export const VIS_WAITING = 'รอคิวโต๊ะ';
export const VIS_PENDING = "('รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอคิวโต๊ะ', 'รอชำระเงิน')";
export const VIS_PAID = "('ชำระแล้ว', 'เสร็จสิ้น')";
export const VIS_OPEN = `(${VIS_PENDING.slice(1, -1)}, ${VIS_PAID.slice(1, -1)})`;
export const VIS_BOOKING = "bookingType != 'table'";
export const VIS_REUSABLE_CONDITION = `${VIS_BOOKING} AND visitDateISO = '' AND status IN ${VIS_PENDING}
  AND visQueuedAt != '' AND UPPER(TRIM(visitorId)) = ? AND prisonerId = ?`;

export function visWaitlistEnabled(env: Pick<Env, 'VIS_WAITLIST_ENABLED'>, now = new Date()): boolean {
  return env.VIS_WAITLIST_ENABLED === 'true' && now.toISOString() >= VIS_WAITLIST_START;
}

export function usesVisWaitlist(env: Pick<Env, 'VIS_WAITLIST_ENABLED'>, date: unknown, now = new Date()): boolean {
  return visWaitlistEnabled(env, now) && String(date || '') >= VIS_FIRST_QUEUE_DATE;
}

export function visQueueApplies(
  env: Pick<Env, 'VIS_WAITLIST_ENABLED'>,
  row: Pick<Reservation, 'bookingType' | 'visitDateISO'>,
  queuedAt = '',
  now = new Date()
): boolean {
  return (
    row.bookingType !== 'table' &&
    visWaitlistEnabled(env, now) &&
    (queuedAt !== '' || String(row.visitDateISO || '') >= VIS_FIRST_QUEUE_DATE)
  );
}

export function visVisitorId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export const VIS_OTHER_DATE_CONDITION = `${VIS_BOOKING} AND visitDateISO != ''
  AND status IN ${VIS_PENDING} AND UPPER(TRIM(visitorId)) = ? AND visitDateISO >= ? AND visitDateISO != ?`;

export function visOtherDateBinds(visitorId: unknown, date: unknown, now: Date): string[] {
  return [visVisitorId(visitorId), formatDateISO(now), String(date || '')];
}

export const VIS_OTHER_DATE_PRISONER = `${VIS_BOOKING} AND visitDateISO != '' AND visitDateISO >= ?
  AND visitDateISO != ? AND status IN ${VIS_PENDING} AND EXISTS (
    SELECT 1 FROM json_each(?) AS requested WHERE prisonerId = requested.value
      OR instr('|' || replace(extraPrisoners, ';;', '|') || '|', '|' || requested.value || '|') > 0
  )`;
