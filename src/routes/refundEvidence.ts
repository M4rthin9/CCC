import { formatBangkok, sanitizeStr } from '../config';
import { TABLES } from '../constants';
import {
  invalidateArchivedCache,
  invalidateLookupCache,
  invalidatePrisonerLookupCache,
  invalidateReservationsCache,
} from '../cache/invalidation';
import { getBookingEvidenceEvents } from '../db/queries/eventlog';
import { getArchivedReservationByRef, getReservationByRef, getSlipRecordByRef } from '../db/queries/reservations';
import { hasPermission } from '../db/queries/roles';
import { loadSlipDataUri } from '../services/slipStorage';
import { hasPaidEvidence, refundRecord, REFUNDED_STATUS, summarizeRefundEvidence } from '../services/refundEvidence';
import type { Env } from '../types';

export async function handleGetRefundEvidence(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (
    !(await hasPermission(env.DB, user.username, 'confirm_payment')) ||
    !(await hasPermission(env.DB, user.username, 'view_slip'))
  ) {
    return { status: 'error', message: 'ไม่มีสิทธิ์จัดทำเอกสารประกอบการคืนเงิน' };
  }
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'กรุณาระบุเลขอ้างอิงการจอง' };
  const live = await getReservationByRef(env.DB, ref);
  const booking = live ?? (await getArchivedReservationByRef(env.DB, ref));
  if (!booking) return { status: 'error', message: 'ไม่พบการจอง' };
  const events = await getBookingEvidenceEvents(env.DB, ref);
  // Embed stored bytes so saving/printing does not depend on an expiring image URL.
  const slipImage = (await loadSlipDataUri(env, ref)) || (await getSlipRecordByRef(env.DB, ref))?.url || '';
  const { slip_key: _key, ...record } = booking;
  return {
    status: 'ok',
    evidence: {
      booking: { ...record, _archived: !live, slipImage: undefined },
      stages: summarizeRefundEvidence(booking, events),
      slipImage,
      refund: refundRecord(events),
      canCompleteRefund:
        booking.status !== REFUNDED_STATUS && !refundRecord(events) && hasPaidEvidence(booking, events) && !!slipImage,
    },
  };
}

/** Record a refund already transferred by finance; this endpoint never transfers money. */
export async function handleCompleteRefund(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string },
  meta: { ip?: string; userAgent?: string } = {}
): Promise<Record<string, unknown>> {
  if (
    !(await hasPermission(env.DB, user.username, 'confirm_payment')) ||
    !(await hasPermission(env.DB, user.username, 'view_slip'))
  )
    return { status: 'error', message: 'ไม่มีสิทธิ์บันทึกการคืนเงิน' };
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'กรุณาระบุเลขอ้างอิง' };
  const live = await getReservationByRef(env.DB, ref);
  const row = live ?? (await getArchivedReservationByRef(env.DB, ref));
  if (!row) return { status: 'error', message: 'ไม่พบการจอง' };
  const events = await getBookingEvidenceEvents(env.DB, ref);
  if (row.status === REFUNDED_STATUS || events.some((event) => event.action === 'booking_refunded'))
    return { status: 'error', message: 'รายการนี้บันทึกคืนเงินแล้ว กรุณาโหลดข้อมูลใหม่' };
  const amount = Number(body.amount);
  const total = Number(row.total);
  const reason = String(body.reason ?? '').trim();
  const recipient = String(body.recipient ?? row.visitorName ?? '').trim();
  const account = String(body.account ?? '').trim();
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(total) ||
    amount > total ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001
  )
    return { status: 'error', message: 'ยอดคืนเงินต้องมากกว่า 0 และไม่เกินยอดชำระ โดยมีทศนิยมไม่เกิน 2 ตำแหน่ง' };
  if (!reason || reason.length > 250 || !recipient || recipient.length > 200 || account.length > 150)
    return { status: 'error', message: 'กรุณาระบุเหตุผลและชื่อผู้รับเงินคืนให้ครบถ้วนตามความยาวที่กำหนด' };
  if (!hasPaidEvidence(row, events))
    return { status: 'error', message: 'ไม่พบหลักฐานสถานะชำระเงิน ไม่สามารถบันทึกคืนเงินได้' };
  const slip = await getSlipRecordByRef(env.DB, ref);
  if (!slip || !(slip.url || slip.dataUri || slip.key)) return { status: 'error', message: 'ไม่พบสลิปชำระเงิน' };
  const table = live ? TABLES.reservations : TABLES.archive;
  const now = new Date();
  const timestamp = formatBangkok(now);
  const details = JSON.stringify({
    amount,
    reason,
    recipient,
    account,
    originalTotal: total,
    previousStatus: row.status,
    newStatus: REFUNDED_STATUS,
    archived: !live,
  });
  const version = Number(row.version || 1);
  const condition =
    "ref = ? AND status = ? AND CAST(total AS REAL) = ? AND CAST(COALESCE(NULLIF(version, ''), 1) AS INTEGER) = ?";
  // D1 batches are transactional. The conditional audit insert serializes retries;
  // the update can only use the audit inserted for the unchanged booking snapshot.
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ${TABLES.eventLog} (timestamp, username, action, targetRef, details, result, ip, userAgent)
      SELECT ?, ?, 'booking_refunded', ref, ?, 'success', ?, ? FROM ${table} WHERE ${condition}
      AND NOT EXISTS (SELECT 1 FROM ${TABLES.eventLog} WHERE targetRef = ? AND action = 'booking_refunded' AND result = 'success')`
    ).bind(
      timestamp,
      user.username,
      details,
      sanitizeStr(meta.ip, 64),
      sanitizeStr(meta.userAgent, 500),
      ref,
      row.status,
      total,
      version,
      ref
    ),
    env.DB.prepare(
      `UPDATE ${table} SET status = ?, updatedAt = ?, version = ? WHERE ${condition}
      AND EXISTS (SELECT 1 FROM ${TABLES.eventLog} WHERE targetRef = ? AND action = 'booking_refunded' AND result = 'success' AND timestamp = ? AND username = ? AND details = ?)`
    ).bind(
      REFUNDED_STATUS,
      now.toISOString(),
      version + 1,
      ref,
      row.status,
      total,
      version,
      ref,
      timestamp,
      user.username,
      details
    ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    return { status: 'error', message: 'ข้อมูลเปลี่ยนแปลงหรือบันทึกคืนเงินแล้ว กรุณาโหลดข้อมูลใหม่' };
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  if (row.prisonerId) await invalidatePrisonerLookupCache(env, row.prisonerId);
  if (!live) await invalidateArchivedCache(env);
  return {
    status: 'ok',
    bookingStatus: REFUNDED_STATUS,
    refund: { amount, reason, recipient, account, timestamp, actor: user.username },
  };
}
