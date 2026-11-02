import { getReservationByRef } from '../db/queries/reservations';
import {
  getAttendance,
  getAttendanceBookings,
  recordAttendance,
  type AttendanceRecord,
} from '../db/queries/attendance';
import { getBookingEvidenceEvents } from '../db/queries/eventlog';
import { hasPermission } from '../db/queries/roles';
import { d1IncrementCounter } from '../cache/d1Cache';
import {
  attendanceGuests,
  attendanceToday,
  createEntryToken,
  entryBlockedReason,
  entryReservation,
  readEntryToken,
  validAttendanceDate,
  tableAttendance,
} from '../services/attendance';
import { renderQr } from '../services/qrImage';
import type { Env } from '../types';

const error = (message: string) => ({ status: 'error' as const, message });
type EntryResult =
  | ReturnType<typeof error>
  | {
      status: 'ok';
      recorded: boolean;
      alreadyCheckedIn: boolean;
      entry: {
        reservation: ReturnType<typeof entryReservation>;
        ref: string;
        visitDateISO: string | undefined;
        bookingType: string | undefined;
        paymentStatus: string | undefined;
        paymentConfirmed: boolean;
        allowed: boolean;
        blockedReason: string;
        guests: Array<Awaited<ReturnType<typeof attendanceGuests>>[number] & { attendance: AttendanceRecord | null }>;
      };
    };
async function canCheckAttendance(env: Env, username: string): Promise<boolean> {
  return (
    (await hasPermission(env.DB, username, 'visitor_approval')) ||
    (await hasPermission(env.DB, username, 'confirm_payment'))
  );
}

export async function handleGetVisitorEntryQr(env: Env, body: Record<string, unknown>, ip: string) {
  // Kept in the handler so public bulk requests cannot bypass the identity-attempt budget.
  const attempts = await d1IncrementCounter(env.DB, `entryqr:${ip}`, 300);
  if (attempts === null || attempts > 20) return error('กรุณารอสักครู่ก่อนลองใหม่');
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  const id = typeof body.visitorId === 'string' ? body.visitorId.trim().toUpperCase() : '';
  if (!ref || ref.length > 64 || !id || id.length > 64)
    return error('กรุณากรอกเลขอ้างอิงและเลขบัตรประชาชน/หนังสือเดินทางของผู้จองหลัก');
  const booking = await getReservationByRef(env.DB, ref);
  if (!booking || !booking.visitorId || booking.visitorId.trim().toUpperCase() !== id)
    return error('ข้อมูลยืนยันผู้จองไม่ถูกต้อง');
  const blocked = entryBlockedReason(booking);
  if (blocked) return error(blocked);
  if (String(booking.visitDateISO) < attendanceToday()) return error('เลยวันที่เข้าร่วมแล้ว');
  if ((await getBookingEvidenceEvents(env.DB, ref)).some((event) => event.action === 'booking_refunded'))
    return error('รายการนี้คืนเงินแล้ว');
  const payload = await createEntryToken(env.JWT_SECRET, booking);
  const { qrDataUrl } = await renderQr(payload);
  return { status: 'ok', payload, qrDataUrl, ref, visitDateISO: booking.visitDateISO };
}

export async function handleCheckVisitorEntry(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string },
  checkIn = false
): Promise<EntryResult> {
  if (!(await canCheckAttendance(env, user.username))) return error('ไม่มีสิทธิ์ตรวจสอบการเข้างาน');
  const token = await readEntryToken(env.JWT_SECRET, body.qr);
  if (!token) return error('QR เข้างานไม่ถูกต้องหรือหมดอายุ กรุณาใช้ QR เข้างานจากหน้าสถานะการจอง');
  const booking = await getReservationByRef(env.DB, token.ref);
  if (!booking || booking.visitDateISO !== token.visitDateISO)
    return error('ไม่พบการจองหรือมีการเปลี่ยนวันที่ กรุณาขอ QR ใหม่');
  let blockedReason = entryBlockedReason(booking);
  if (!blockedReason && booking.visitDateISO !== attendanceToday()) blockedReason = 'ยังไม่ถึงวันที่เข้าร่วมตามการจอง';
  if (
    !blockedReason &&
    (await getBookingEvidenceEvents(env.DB, booking.ref)).some((event) => event.action === 'booking_refunded')
  )
    blockedReason = 'รายการนี้คืนเงินแล้ว';
  const guests = await attendanceGuests(booking);
  let recorded = false;
  if (checkIn) {
    if (blockedReason) return error(blockedReason);
    const guest = guests.find((guest) => guest.guestKey === body.guestKey);
    if (!guest) return error('ไม่พบผู้เข้าร่วมนี้ในการจอง');
    recorded = await recordAttendance(env.DB, booking, guest, user.username);
    if (!recorded) {
      const existing = await getAttendance(env.DB, token.visitDateISO, token.ref);
      if (!existing.some((record) => record.guestKey === guest.guestKey))
        return error('ข้อมูลการจองเปลี่ยน กรุณาสแกนเพื่อตรวจสอบใหม่');
      const refreshed = await handleCheckVisitorEntry(env, body, user);
      if (refreshed.status === 'error') return refreshed;
      return { ...refreshed, recorded: false, alreadyCheckedIn: true };
    }
  }
  const attendance = await getAttendance(env.DB, token.visitDateISO, token.ref);
  return {
    status: 'ok',
    recorded,
    alreadyCheckedIn: checkIn && !recorded,
    entry: {
      reservation: entryReservation(booking),
      ref: booking.ref,
      visitDateISO: booking.visitDateISO,
      bookingType: booking.bookingType,
      paymentStatus: booking.status,
      paymentConfirmed: booking.status === 'เสร็จสิ้น',
      allowed: !blockedReason,
      blockedReason,
      guests: guests.map((guest) => ({
        ...guest,
        attendance: attendance.find((record) => record.guestKey === guest.guestKey) ?? null,
      })),
    },
  };
}

export async function handleGetAttendance(env: Env, body: Record<string, unknown>, user: { username: string }) {
  if (!(await canCheckAttendance(env, user.username))) return error('ไม่มีสิทธิ์ดูรายการเข้างาน');
  const date = String(body.date || attendanceToday());
  if (!validAttendanceDate(date)) return error('วันที่ไม่ถูกต้อง');
  const [rows, bookings] = await Promise.all([getAttendance(env.DB, date), getAttendanceBookings(env.DB, date)]);
  const byRef = new Map<string, AttendanceRecord[]>();
  for (const row of rows) {
    const group = byRef.get(row.ref) ?? [];
    group.push(row);
    byRef.set(row.ref, group);
  }
  const tables = await Promise.all(bookings.map((booking) => tableAttendance(booking, byRef.get(booking.ref) ?? [])));
  return { status: 'ok', date, rows, tables, asOf: new Date().toISOString() };
}
