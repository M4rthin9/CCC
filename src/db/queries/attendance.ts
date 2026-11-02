import { COMPLETED, TABLES } from '../../constants';
import type { Reservation } from '../../types';

export interface AttendanceRecord {
  ref: string;
  visitDateISO: string;
  guestKey: string;
  guestName: string;
  checkedInAt: string;
  checkedInBy: string;
}

/** Read the day's current bookings directly; the sent daily report is not a data source. */
export async function getAttendanceBookings(db: D1Database, date: string): Promise<Reservation[]> {
  const columns = [
    'ref',
    'visitDateISO',
    'bookingType',
    'visitorName',
    'visitorId',
    'visitorPhone',
    'visitorApproved',
    'extraVisitorNames',
    'extraVisitorApproved',
    'visitorCount',
    'status',
    'total',
    'prisonerName',
  ];
  const select = columns.map((column) => `r.${column}`).join(', ');
  const refunded = `EXISTS (SELECT 1 FROM ${TABLES.eventLog} e WHERE e.targetRef = r.ref
    AND e.action = 'booking_refunded' AND e.result = 'success') AS attendanceRefunded`;
  const result = await db
    .prepare(
      `SELECT ${select}, ${refunded} FROM ${TABLES.reservations} r WHERE r.visitDateISO = ?
    UNION ALL SELECT ${select}, ${refunded} FROM ${TABLES.archive} r WHERE r.visitDateISO = ?
    AND NOT EXISTS (SELECT 1 FROM ${TABLES.reservations} live WHERE live.ref = r.ref) ORDER BY ref`
    )
    .bind(date, date)
    .all<Reservation>();
  return result.results ?? [];
}

export async function getAttendance(db: D1Database, visitDateISO: string, ref?: string): Promise<AttendanceRecord[]> {
  const result = await db
    .prepare(
      `SELECT ref, visitDateISO, guestKey, guestName, checkedInAt, checkedInBy
    FROM visitor_attendance WHERE visitDateISO = ? ${ref ? 'AND ref = ?' : ''} ORDER BY checkedInAt DESC`
    )
    .bind(...(ref ? [visitDateISO, ref] : [visitDateISO]))
    .all<AttendanceRecord>();
  return result.results ?? [];
}

/** Conditional insert rechecks the exact live booking snapshot inside SQLite. */
export async function recordAttendance(
  db: D1Database,
  booking: Reservation,
  guest: { guestKey: string; name: string },
  username: string
): Promise<boolean> {
  const snapshotColumns = ['visitDateISO', 'visitorId', 'visitorName', 'extraVisitorNames'] as const;
  const result = await db
    .prepare(
      `INSERT INTO visitor_attendance
    (ref, visitDateISO, guestKey, guestName, checkedInAt, checkedInBy)
    SELECT ref, visitDateISO, ?, ?, ?, ? FROM reservations
    WHERE ref = ? AND status = ? AND visitDateISO = strftime('%Y-%m-%d', 'now', '+7 hours')
    AND ${snapshotColumns.map((column) => `${column} = ?`).join(' AND ')}
    AND NOT EXISTS (SELECT 1 FROM event_log WHERE targetRef = ? AND action = 'booking_refunded' AND result = 'success')
    ON CONFLICT (ref, visitDateISO, guestKey) DO NOTHING`
    )
    .bind(
      guest.guestKey,
      guest.name,
      new Date().toISOString(),
      username,
      booking.ref,
      COMPLETED,
      ...snapshotColumns.map((column) => String(booking[column] || '')),
      booking.ref
    )
    .run();
  return result.meta.changes === 1;
}
