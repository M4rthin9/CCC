import type { EventLog, Reservation } from '../types';

export const REFUNDED_STATUS = 'คืนเงินแล้ว';
export interface RefundRecord {
  amount: number;
  reason: string;
  recipient: string;
  account: string;
  timestamp: string;
  actor: string;
}

export function refundRecord(events: EventLog[]): RefundRecord | null {
  const event = events.find((entry) => entry.action === 'booking_refunded' && entry.result === 'success');
  if (!event) return null;
  try {
    const data = JSON.parse(event.details);
    return {
      amount: Number(data.amount),
      reason: String(data.reason || ''),
      recipient: String(data.recipient || ''),
      account: String(data.account || ''),
      timestamp: event.timestamp,
      actor: event.username,
    };
  } catch {
    return null;
  }
}

export function hasPaidEvidence(row: Reservation, events: EventLog[]): boolean {
  const paid = ['ชำระแล้ว', 'เสร็จสิ้น'];
  if (paid.includes(String(row.status).trim())) return true;
  if (String(row.status).trim() !== 'ยกเลิก') return false;
  let wasPaid = false;
  for (const event of events) {
    if (event.targetRef !== row.ref || event.result !== 'success') continue;
    if (event.action === 'booking_payment_reverted') {
      wasPaid = false;
      continue;
    }
    if (event.action === 'slip_auto_approved') {
      wasPaid = true;
      continue;
    }
    try {
      const details = JSON.parse(event.details);
      const status = String(details.newStatus ?? details.status ?? details.previousStatus ?? '').trim();
      if (paid.includes(status)) wasPaid = true;
      else if (['รอชำระเงิน', 'รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย'].includes(status)) wasPaid = false;
    } catch {
      /* Legacy events without details do not prove payment. */
    }
  }
  return wasPaid;
}

export interface EvidenceStage {
  label: string;
  state: string;
  timestamp: string;
  actor: string;
  source: string;
}

/** Summarize actual records; an upload never proves that finance confirmed payment. */
export function summarizeRefundEvidence(row: Reservation, events: EventLog[]): EvidenceStage[] {
  const table = row.bookingType === 'table' || row.ref.toUpperCase().startsWith('TBL-');
  const relevant = events.filter((event) => event.targetRef === row.ref && event.result === 'success');
  const parsed = relevant.map((event) => {
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(event.details) ?? {};
    } catch {
      /* Legacy text logs remain usable by action. */
    }
    return { event, details };
  });
  const statusOf = (details: Record<string, unknown>) => String(details.newStatus ?? details.status ?? '').trim();
  const statusEvent = (action: string) =>
    ['status_changed', 'archived_status_changed', 'update_booking'].includes(action);
  const booked = relevant.find((event) =>
    ['booking_submitted', 'table_booking_submitted', 'booking_created_admin', 'table_booking_created_admin'].includes(
      event.action
    )
  );
  const approved = parsed.find(({ event, details }) => statusEvent(event.action) && statusOf(details) === 'รอชำระเงิน');
  const uploaded = parsed
    .filter(({ event }) => ['slip_uploaded', 'slip_and_status_updated'].includes(event.action))
    .at(-1);
  const confirmed = parsed
    .filter(({ event, details }) => statusEvent(event.action) && statusOf(details) === 'เสร็จสิ้น')
    .at(-1);
  const automatic = parsed.filter(({ event }) => event.action === 'slip_auto_approved').at(-1);
  const recordConfirmed =
    String(row.status ?? '').trim() === 'เสร็จสิ้น' ||
    parsed.some(({ event, details }) => event.action === 'booking_refunded' && details.previousStatus === 'เสร็จสิ้น');
  const inferredApproval =
    relevant.some((event) => event.action === 'slip_auto_approved') ||
    parsed.some(
      ({ event, details }) =>
        (statusEvent(event.action) && ['รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น'].includes(statusOf(details))) ||
        ['ชำระแล้ว', 'เสร็จสิ้น'].includes(String(details.previousStatus ?? '').trim())
    ) ||
    ['รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น'].includes(String(row.status ?? '').trim());
  const stage = (label: string, state: string, event?: EventLog): EvidenceStage => ({
    label,
    state,
    timestamp: event?.timestamp ?? '',
    actor: event?.username ?? '',
    source: event ? `บันทึกระบบ: ${event.action}` : 'ข้อมูลการจอง; ไม่พบบันทึกวันและผู้ดำเนินการ',
  });
  return [
    {
      ...stage('การจอง', 'มีรายการจอง', booked),
      timestamp: booked?.timestamp || String(row.timestamp || row.createdAt || ''),
      actor: booked?.username || String(row.createdBy || ''),
    },
    stage(
      'การอนุมัติให้ชำระเงิน',
      table
        ? 'TBL ไม่ต้องรออนุมัติ'
        : approved
          ? 'พบบันทึกอนุมัติ'
          : inferredApproval
            ? 'ผ่านขั้นอนุมัติตามสถานะ; ไม่พบวันอนุมัติ'
            : 'ไม่พบหลักฐานอนุมัติ',
      approved?.event
    ),
    stage('การอัปโหลดสลิป', uploaded ? 'พบบันทึกอัปโหลด' : 'ตรวจสอบจากสลิปแนบ; ไม่พบวันอัปโหลด', uploaded?.event),
    stage(
      'การยืนยันชำระเงิน',
      confirmed
        ? 'พบบันทึกยืนยันชำระเงิน'
        : recordConfirmed
          ? 'สถานะยืนยันชำระเงิน; ไม่พบบันทึกผู้ยืนยัน'
          : automatic
            ? 'ระบบตรวจสลิปผ่านอัตโนมัติ; ไม่พบการยืนยันจากฝ่ายการเงิน'
            : 'ไม่พบการยืนยันชำระเงินจากเจ้าหน้าที่',
      confirmed?.event ?? automatic?.event
    ),
  ];
}
