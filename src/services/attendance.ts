import { SignJWT, jwtVerify } from 'jose';
import { formatBangkok } from '../config';
import { ACTIVE_STATUSES, COMPLETED } from '../constants';
import type { AttendanceRecord } from '../db/queries/attendance';
import { parseExtraVisitorNames } from './pricing';
import type { Reservation } from '../types';

const PREFIX = 'CCC-ENTRY:';
const audience = 'ccc-visitor-entry';
export const attendanceToday = () => formatBangkok(new Date()).slice(0, 10);

export function validAttendanceDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** COMPLETED is the final payment authority; individual approval flags remain metadata.
 * A submitted/auto-verified slip (PAID_STATUS) is still awaiting finance review. */
export function entryBlockedReason(booking: Reservation): string {
  if (booking.status !== COMPLETED) return 'ยังไม่ยืนยันการชำระเงิน หรือรายการถูกยกเลิก/คืนเงิน';
  if (!validAttendanceDate(String(booking.visitDateISO || ''))) return 'วันที่เข้าร่วมไม่ถูกต้อง';
  return '';
}

export async function attendanceGuests(booking: Reservation) {
  const approvals = String(booking.extraVisitorApproved || '').split(';;');
  const religions = String(booking.extraVisitorReligions || '').split(';;');
  const allergies = String(booking.extraVisitorAllergies || '').split(';;');
  const guests = [
    {
      name: String(booking.visitorName || ''),
      id: String(booking.visitorId || ''),
      relation: String(booking.relation || ''),
      age: String(booking.visitorAge || ''),
      religion: String(booking.religion || ''),
      allergy: String(booking.allergy || ''),
      approved: booking.visitorApproved,
    },
    ...parseExtraVisitorNames(booking.extraVisitorNames).map((guest, index) => ({
      ...guest,
      religion: religions[index] || '',
      allergy: allergies[index] || '',
      approved: approvals[index],
    })),
  ];
  const identified = await Promise.all(
    guests.map(async (guest, index) => {
      // Identity remains stable when extra guests are reordered; QR/attendance never stores ID numbers.
      const identity = `${index === 0 ? 'main' : 'extra'}:${guest.id.trim().toUpperCase() || guest.name.trim()}`;
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      return {
        guestKey: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        name: guest.name,
        id: guest.id,
        relation: guest.relation,
        age: guest.age,
        religion: guest.religion,
        allergy: guest.allergy,
        main: index === 0,
        approval: String(guest.approved || '')
          .trim()
          .toLowerCase(),
        approved:
          String(guest.approved || '')
            .trim()
            .toLowerCase() === 'yes',
      };
    })
  );
  // Malformed legacy rosters may repeat the same guest; never admit that identity twice.
  return identified.filter(
    (guest, index) => identified.findIndex((other) => other.guestKey === guest.guestKey) === index
  );
}

export async function tableAttendance(booking: Reservation, records: AttendanceRecord[]) {
  const guests = await attendanceGuests(booking);
  const approved = guests.filter((guest) => guest.approved);
  const arrived = new Set(records.map((record) => record.guestKey));
  const guestArrivals = guests.filter((guest) => arrived.has(guest.guestKey)).length;
  const expectedCount = Math.max(Number(booking.visitorCount) || 0, guests.length);
  const fullyRegistered = expectedCount > 0 && guestArrivals >= expectedCount;
  const registrationStatus = fullyRegistered
    ? ('registered' as const)
    : records.length
      ? ('partial' as const)
      : ('not_registered' as const);
  const refunded = Number(booking.attendanceRefunded) === 1;
  const blockedReason = refunded ? 'รายการนี้คืนเงินแล้ว' : entryBlockedReason(booking);
  const explicitType = String(booking.bookingType || '').trim();
  return {
    ref: booking.ref,
    visitDateISO: String(booking.visitDateISO || ''),
    bookingType:
      explicitType === 'table' || explicitType === 'prisoner'
        ? explicitType
        : booking.ref.toUpperCase().startsWith('TBL-')
          ? 'table'
          : 'prisoner',
    visitorName: String(booking.visitorName || ''),
    visitorPhone: String(booking.visitorPhone || ''),
    prisonerName: String(booking.prisonerName || ''),
    prisonerId: String(booking.prisonerId || ''),
    wing: String(booking.wing || ''),
    extraPrisoners: String(booking.extraPrisoners || ''),
    visitorCount: Number(booking.visitorCount) || 0,
    total: Number(booking.total) || 0,
    paymentStatus: String(booking.status || ''),
    paymentConfirmed: booking.status === COMPLETED && !refunded,
    active: ACTIVE_STATUSES.includes(String(booking.status || '')) && !refunded,
    eligible: !blockedReason && booking.visitDateISO === attendanceToday(),
    blockedReason,
    expectedCount,
    approvedCount: approved.length,
    checkedInCount: records.length,
    remainingCount: Math.max(0, expectedCount - guestArrivals),
    registrationStatus,
    guests: guests.map((guest) => {
      const record = records.find((record) => record.guestKey === guest.guestKey);
      return {
        guestKey: guest.guestKey,
        name: guest.name,
        id: guest.id,
        relation: guest.relation,
        approved: guest.approved,
        checkedInAt: record?.checkedInAt || '',
        checkedInBy: record?.checkedInBy || '',
      };
    }),
  };
}

/** Staff-only business details; never return slip storage keys or verification internals. */
export function entryReservation(booking: Reservation) {
  const fields = [
    'ref',
    'timestamp',
    'visitorName',
    'visitorId',
    'visitorPhone',
    'relation',
    'religion',
    'allergy',
    'extraVisitorReligions',
    'extraVisitorAllergies',
    'extraVisitorNames',
    'visitorApproved',
    'extraVisitorApproved',
    'prisonerName',
    'prisonerId',
    'extraPrisoners',
    'wing',
    'visitDate',
    'visitDateISO',
    'visitorCount',
    'totalPersons',
    'total',
    'adultCount',
    'child5to8Count',
    'childUnder5Count',
    'visitorAge',
    'status',
    'cancelReason',
    'createdAt',
    'updatedAt',
    'createdBy',
    'source',
    'bookingType',
  ] as const;
  return Object.fromEntries(fields.map((field) => [field, booking[field]])) as Pick<
    Reservation,
    (typeof fields)[number]
  >;
}

export async function createEntryToken(secret: string, booking: Reservation): Promise<string> {
  const expiresAt = Math.floor(Date.parse(`${booking.visitDateISO}T23:59:59+07:00`) / 1000) + 1;
  return (
    PREFIX +
    (await new SignJWT({ ref: booking.ref, visitDateISO: booking.visitDateISO })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(audience)
      .setAudience(audience)
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(secret)))
  );
}

export async function readEntryToken(
  secret: string,
  raw: unknown
): Promise<{ ref: string; visitDateISO: string } | null> {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX) || raw.length > 1500) return null;
  try {
    const { payload } = await jwtVerify(raw.slice(PREFIX.length), new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: audience,
      audience,
    });
    return typeof payload.ref === 'string' && typeof payload.visitDateISO === 'string'
      ? { ref: payload.ref, visitDateISO: payload.visitDateISO }
      : null;
  } catch {
    return null;
  }
}
