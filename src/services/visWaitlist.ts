import { formatDateISO } from '../config';
import { AWAITING_PAYMENT } from '../constants';
import type { Env, Reservation } from '../types';
import { notify } from './notifications';
import { getPublicBookingConfig } from './publicCapacity';
import { reservationChanged } from './reservationChanges';
import {
  VIS_BOOKING,
  VIS_FIRST_QUEUE_DATE,
  VIS_OPEN,
  VIS_PAID,
  VIS_PAYMENT_CUTOFF_UTC,
  VIS_PAYMENT_MS,
  VIS_PENDING,
  VIS_STANDBY_LIMIT,
  VIS_WAITING,
  visQueueApplies,
  visWaitlistEnabled,
} from './visWaitlistPolicy';

const READY = `status = '${VIS_WAITING}' AND participantApproved = 'yes' AND disciplineApproved = 'yes'`;
const OCCUPIED = `(status IN ${VIS_PAID} OR (status IN ${VIS_PENDING} AND visOfferedAt != '')
  OR (status IN ('ยกเลิก', 'คืนเงินแล้ว') AND (visOfferedAt != '' OR visQueuedAt = '')
    AND NOT COALESCE(visitDateISO > date(cancelAt, '+7 hours'), 0)))`;
const HOUR = 60 * 60 * 1000;

interface VisPaymentState {
  visQueuedAt: string;
  visOfferedAt: string;
  holdExpiresAt: string;
  visSlipSubmittedAt: string;
  visPaymentRemainingMs: number;
}

export function readVisPaymentState(db: D1Database, ref: string): Promise<VisPaymentState | null> {
  return db
    .prepare(
      `SELECT visQueuedAt, visOfferedAt, holdExpiresAt, visSlipSubmittedAt, visPaymentRemainingMs
    FROM reservations WHERE ref = ?`
    )
    .bind(ref)
    .first<VisPaymentState>();
}

export async function getManagedVisPayment(
  env: Env,
  row: Pick<Reservation, 'ref' | 'bookingType' | 'visitDateISO'>,
  now = new Date()
): Promise<VisPaymentState | null> {
  if (row.bookingType === 'table' || !visWaitlistEnabled(env, now)) return null;
  const payment = await readVisPaymentState(env.DB, row.ref);
  return payment && visQueueApplies(env, row, payment.visQueuedAt, now) ? payment : null;
}

export function visPaymentOpen(row: Pick<Reservation, 'status'>, payment: VisPaymentState, now = new Date()): boolean {
  return row.status === AWAITING_PAYMENT && payment.visOfferedAt !== '' && payment.holdExpiresAt > now.toISOString();
}

/** Claim the verification slot before writing payment evidence to object storage. */
export async function claimVisSlip(db: D1Database, row: Reservation, now = new Date()): Promise<boolean> {
  const stamp = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE reservations SET visSlipSubmittedAt = ?
    WHERE ref = ? AND version = ? AND status = ? AND visOfferedAt != '' AND holdExpiresAt > ? AND visSlipSubmittedAt = ''`
    )
    .bind(stamp, row.ref, row.version || 1, AWAITING_PAYMENT, stamp)
    .run();
  return Number(result.meta.changes) === 1;
}

export async function clearVisSlipClaim(db: D1Database, ref: string, submittedAt: string): Promise<void> {
  await db
    .prepare(`UPDATE reservations SET visSlipSubmittedAt = '' WHERE ref = ? AND visSlipSubmittedAt = ?`)
    .bind(ref, submittedAt)
    .run();
}

export interface VisCalendar {
  counts: Record<string, number>;
  queueFullDates: string[];
}

export async function getVisCalendar(
  db: D1Database,
  from: string,
  through: string,
  capacity: number
): Promise<VisCalendar> {
  const rows = await db
    .prepare(
      `SELECT visitDateISO AS date,
    SUM(CASE WHEN status IN ${VIS_PAID} THEN 1 ELSE 0 END) AS paid, COUNT(*) AS requests FROM reservations
    WHERE ${VIS_BOOKING} AND visitDateISO BETWEEN ? AND ? AND status IN ${VIS_OPEN} GROUP BY visitDateISO`
    )
    .bind(from, through)
    .all<{ date: string; paid: number; requests: number }>();
  return {
    counts: Object.fromEntries((rows.results || []).map((row) => [row.date, Number(row.paid)])),
    queueFullDates: (rows.results || [])
      .filter((row) => row.requests >= capacity + VIS_STANDBY_LIMIT)
      .map((row) => row.date),
  };
}

/** One statement takes the next approved entries and reserves capacity for them. */
export async function offerVisTables(db: D1Database, date: string, capacity: number, now: Date): Promise<number> {
  const stamp = now.toISOString();
  const cutoff = date + VIS_PAYMENT_CUTOFF_UTC;
  if (cutoff <= stamp) return 0;
  const fullWindow = new Date(now.getTime() + VIS_PAYMENT_MS).toISOString();
  const expires = cutoff < fullWindow ? cutoff : fullWindow;
  const result = await db
    .prepare(
      `WITH next AS MATERIALIZED (
      SELECT ref FROM reservations WHERE ${VIS_BOOKING} AND visitDateISO = ? AND ${READY} AND visOfferedAt = ''
      ORDER BY COALESCE(NULLIF(visQueuedAt, ''), NULLIF(createdAt, ''), timestamp), rowid
      LIMIT (SELECT MAX(0, ? - COUNT(*)) FROM reservations WHERE ${VIS_BOOKING} AND visitDateISO = ? AND ${OCCUPIED})
    )
    UPDATE reservations SET status = ?, visQueuedAt = COALESCE(NULLIF(visQueuedAt, ''), NULLIF(createdAt, ''), ?),
      visOfferedAt = ?, holdExpiresAt = ?, visNoticeAt = '', visReminderAt = '', visContactRequired = 0,
      updatedAt = ?, version = COALESCE(NULLIF(version, ''), 1) + 1 WHERE ref IN (SELECT ref FROM next)`
    )
    .bind(date, capacity, date, AWAITING_PAYMENT, stamp, stamp, expires, stamp)
    .run();
  return Number(result.meta.changes);
}

interface VisNotice {
  ref: string;
  holdExpiresAt: string;
  visOfferedAt: string;
  type: 'payment_due' | 'vis_payment_reminder' | 'vis_payment_expired';
}

async function sendVisNotice(env: Env, notice: VisNotice): Promise<boolean> {
  const deadline = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(notice.holdExpiresAt));
  const body =
    notice.type === 'vis_payment_expired'
      ? `หมดเวลาชำระเงินสำหรับ ${notice.ref} กรุณาเลือกวันใหม่ด้วยเลขเดิมที่หน้าตรวจสอบสถานะ`
      : `${notice.ref} กรุณาชำระเงินภายใน ${deadline} น. (เวลาไทย) ที่หน้าตรวจสอบสถานะ`;
  const result = await notify(env, { ref: notice.ref, type: notice.type, body }, notice.holdExpiresAt);
  if (result.sent.push + result.sent.line > 0) return true;
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 AS found FROM notifications
     WHERE ref = ? AND type = ? AND deliveryKey = ? AND status = 'sent' LIMIT 1`
    )
      .bind(notice.ref, notice.type, notice.holdExpiresAt)
      .first()
  );
}

export async function processVisWaitlist(env: Env, now = new Date()): Promise<void> {
  if (!visWaitlistEnabled(env, now)) return;
  const db = env.DB;
  const stamp = now.toISOString();
  const today = formatDateISO(now);
  const launchDeadline = new Date(now.getTime() + VIS_PAYMENT_MS).toISOString();
  const from = today > VIS_FIRST_QUEUE_DATE ? today : VIS_FIRST_QUEUE_DATE;
  const [legacy, expired, resumed, closed] = await db.batch([
    db
      .prepare(
        `UPDATE reservations SET visQueuedAt = COALESCE(NULLIF(createdAt, ''), ?),
      visOfferedAt = ?, holdExpiresAt = MIN(?, visitDateISO || '${VIS_PAYMENT_CUTOFF_UTC}'), updatedAt = ?, version = COALESCE(NULLIF(version, ''), 1) + 1,
      visSlipSubmittedAt = CASE WHEN slip_key != '' OR slipImage != '' OR slip_base64 != '' THEN ? ELSE '' END
      WHERE ${VIS_BOOKING} AND visitDateISO >= ? AND status = ? AND visQueuedAt = ''
        AND visitDateISO || '${VIS_PAYMENT_CUTOFF_UTC}' > ?`
      )
      .bind(stamp, stamp, launchDeadline, stamp, stamp, from, AWAITING_PAYMENT, stamp),
    db
      .prepare(
        `WITH expired AS MATERIALIZED (
        SELECT ref, visOfferedAt, holdExpiresAt FROM reservations WHERE ${VIS_BOOKING} AND status = ?
        AND visOfferedAt != '' AND holdExpiresAt != '' AND holdExpiresAt <= ? AND visSlipSubmittedAt = '' LIMIT 3
      ) UPDATE reservations SET status = ?, visitDate = '', visitDateISO = '', holdExpiresAt = '', visOfferedAt = '',
        visNoticeAt = '', visReminderAt = '', visContactRequired = 0, payment_ref1 = '', updatedAt = ?,
        version = COALESCE(NULLIF(version, ''), 1) + 1 WHERE ref IN (SELECT ref FROM expired)
      RETURNING ref, (SELECT holdExpiresAt FROM expired WHERE expired.ref = reservations.ref) AS holdExpiresAt,
      (SELECT visOfferedAt FROM expired WHERE expired.ref = reservations.ref) AS visOfferedAt`
      )
      .bind(AWAITING_PAYMENT, stamp, VIS_WAITING, stamp),
    db
      .prepare(
        `UPDATE reservations SET status = ?,
        holdExpiresAt = MIN(visitDateISO || '${VIS_PAYMENT_CUTOFF_UTC}',
          strftime('%Y-%m-%dT%H:%M:%fZ', ?, (visPaymentRemainingMs / 1000.0) || ' seconds')),
        updatedAt = ?, visPaymentRemainingMs = 0, visNoticeAt = '', visReminderAt = '', version = version + 1
      WHERE ${VIS_BOOKING} AND visitDateISO >= ? AND ${READY} AND visOfferedAt != '' AND visPaymentRemainingMs > 0
        AND visitDateISO || '${VIS_PAYMENT_CUTOFF_UTC}' > ?`
      )
      .bind(AWAITING_PAYMENT, stamp, stamp, from, stamp),
    db
      .prepare(
        `UPDATE reservations SET
        status = CASE WHEN status = ? THEN ? ELSE status END,
        visQueuedAt = COALESCE(NULLIF(visQueuedAt, ''), NULLIF(createdAt, ''), ?),
        visitDate = '', visitDateISO = '', visOfferedAt = '', visNoticeAt = '', visReminderAt = '',
        visPaymentRemainingMs = 0, visContactRequired = 0, payment_ref1 = '', updatedAt = ?, version = version + 1
      WHERE ${VIS_BOOKING} AND visitDateISO >= ? AND visitDateISO || '${VIS_PAYMENT_CUTOFF_UTC}' <= ?
        AND status IN ${VIS_PENDING} AND holdExpiresAt = '' AND visSlipSubmittedAt = ''
        AND slip_key = '' AND slipImage = '' AND slip_base64 = ''`
      )
      .bind(AWAITING_PAYMENT, VIS_WAITING, stamp, stamp, VIS_FIRST_QUEUE_DATE, stamp),
  ]);
  let changed = [legacy, expired, resumed, closed].reduce((sum, result) => sum + Number(result?.meta.changes || 0), 0);
  const capacity = (await getPublicBookingConfig(env)).perDay;
  const dates = await db
    .prepare(
      `SELECT visitDateISO AS date FROM reservations
    WHERE ${VIS_BOOKING} AND visitDateISO >= ? AND visitDateISO || '${VIS_PAYMENT_CUTOFF_UTC}' > ? AND ${READY} AND visOfferedAt = ''
      AND (SELECT COUNT(*) FROM reservations occupied WHERE occupied.visitDateISO = reservations.visitDateISO
        AND ${VIS_BOOKING} AND ${OCCUPIED}) < ?
    GROUP BY visitDateISO ORDER BY visitDateISO LIMIT 5`
    )
    .bind(from, stamp, capacity)
    .all<{ date: string }>();
  for (const { date } of dates.results || []) changed += await offerVisTables(db, date, capacity, now);
  if (changed > 0) await reservationChanged(env);

  for (const row of expired?.results || []) {
    const notice = row as unknown as Omit<VisNotice, 'type'>;
    if (notice.visOfferedAt && notice.holdExpiresAt)
      await sendVisNotice(env, { ...notice, type: 'vis_payment_expired' });
  }
  if (env.PUSH_QUEUE) await env.PUSH_QUEUE.send({ visNotices: true });
  else await sendPendingVisNotices(env, now);
}

export async function sendPendingVisNotices(env: Env, now = new Date()): Promise<void> {
  if (!visWaitlistEnabled(env, now)) return;
  const db = env.DB;
  const stamp = now.toISOString();
  const due = await db
    .prepare(
      `SELECT ref, holdExpiresAt, visOfferedAt,
      CASE WHEN visNoticeAt = '' THEN 'payment_due' ELSE 'vis_payment_reminder' END AS type
    FROM reservations WHERE ${VIS_BOOKING} AND status = ? AND visOfferedAt != ''
      AND holdExpiresAt > ? AND visSlipSubmittedAt = ''
      AND (visNoticeAt = '' OR (visReminderAt = '' AND holdExpiresAt <= ?))
    ORDER BY holdExpiresAt LIMIT 4`
    )
    .bind(AWAITING_PAYMENT, stamp, new Date(now.getTime() + 2 * HOUR).toISOString())
    .all<VisNotice>();
  for (const notice of due.results || []) {
    const sent = await sendVisNotice(env, notice);
    const marker = notice.type === 'payment_due' ? 'visNoticeAt' : 'visReminderAt';
    await db
      .prepare(
        `UPDATE reservations SET ${marker} = ?, visContactRequired = CASE WHEN ? THEN 0 ELSE 1 END
      WHERE ref = ? AND visOfferedAt = ? AND ${marker} = ''`
      )
      .bind(stamp, sent ? 1 : 0, notice.ref, notice.visOfferedAt)
      .run();
  }
  if (due.results?.length === 4) await env.PUSH_QUEUE?.send({ visNotices: true });
}
