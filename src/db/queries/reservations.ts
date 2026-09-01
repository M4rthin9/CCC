import { ACTIVE_STATUSES, AWAITING_PAYMENT, CANCELLED, HOLD_EXPIRED_REASON, TABLES } from '../../constants';
import { Env, Reservation } from '../../types';

const RESERVATION_COLUMNS = [
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
  'payment_ref1',
  'status',
  'slipImage',
  'slip_key',
  'slip_verify_status',
  'slip_verify_json',
  'slip_verify_at',
  'slip_fingerprint',
  'slip_image_hash',
  'slip_ocr_json',
  'slip_decision',
  'slip_decision_json',
  'cancelReason',
  'createdAt',
  'updatedAt',
  'version',
  'createdBy',
  'source',
  'bookingType',
  'holdExpiresAt',
  'cancelAt',
];

// slip_base64 holds multi-MB base64 slip uploads and is intentionally NOT part
// of RESERVATION_COLUMNS so list endpoints never ship it. It must still be
// writable (uploadSlip / updateSlipAndStatus) and retained when archiving.
const RESERVATION_WRITABLE_COLUMNS = [...RESERVATION_COLUMNS, 'slip_base64'];

export function reservationRowToObject(row: unknown): Reservation {
  const r = (row ?? {}) as Record<string, unknown>;
  const out: Reservation = {} as Reservation;
  for (const col of RESERVATION_COLUMNS) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    if (
      ['visitorCount', 'totalPersons', 'total', 'adultCount', 'child5to8Count', 'childUnder5Count', 'version'].includes(
        col
      )
    ) {
      out[col] = Number(v);
    } else {
      out[col] = String(v);
    }
  }
  return out;
}

export function getActiveReservations(db: D1Database): Promise<Reservation[]> {
  return db
    .prepare(`SELECT ${RESERVATION_COLUMNS.join(', ')} FROM ${TABLES.reservations} ORDER BY rowid DESC`)
    .all<Record<string, unknown>>()
    .then((res) => (res.results ?? []).map(reservationRowToObject));
}

export function getArchivedReservations(db: D1Database): Promise<Reservation[]> {
  return db
    .prepare(`SELECT ${RESERVATION_COLUMNS.join(', ')}, archivedAt FROM ${TABLES.archive} ORDER BY rowid DESC`)
    .all<Record<string, unknown>>()
    .then((res) => {
      return (res.results ?? []).map((r) => {
        const obj = reservationRowToObject(r);
        if (r['archivedAt'] !== null && r['archivedAt'] !== undefined) obj.archivedAt = String(r['archivedAt']);
        return obj;
      });
    });
}

export function getArchivedReservationByRef(db: D1Database, ref: string): Promise<Reservation | null> {
  return db
    .prepare(`SELECT ${RESERVATION_COLUMNS.join(', ')}, archivedAt FROM ${TABLES.archive} WHERE ref = ?`)
    .bind(ref)
    .first<Record<string, unknown>>()
    .then((r) => {
      if (!r) return null;
      const obj = reservationRowToObject(r);
      if (r['archivedAt'] !== null && r['archivedAt'] !== undefined) obj.archivedAt = String(r['archivedAt']);
      return obj;
    });
}

export function getReservationByRef(db: D1Database, ref: string): Promise<Reservation | null> {
  return db
    .prepare(`SELECT ${RESERVATION_COLUMNS.join(', ')} FROM ${TABLES.reservations} WHERE ref = ?`)
    .bind(ref)
    .first<Record<string, unknown>>()
    .then((r) => (r ? reservationRowToObject(r) : null));
}

export interface StoredSlip {
  /** R2 object key ('' when the row predates the R2 migration). */
  key: string;
  /** Legacy base64 data URI kept in D1 ('' for R2-backed rows). */
  dataUri: string;
  /** Legacy Drive thumbnail URL from the Apps Script era. */
  url: string;
  /** True when the ref was found in the archive rather than the live table. */
  archived: boolean;
}

const SLIP_SELECT = 'slipImage, slip_key, slip_base64';

function rowToStoredSlip(r: Record<string, unknown> | null, archived: boolean): StoredSlip | null {
  if (!r) return null;
  const dataUri = r.slip_base64 ? String(r.slip_base64) : '';
  const legacy = r.slipImage ? String(r.slipImage) : '';
  return {
    key: r.slip_key ? String(r.slip_key) : '',
    dataUri,
    // slipImage doubles as a Drive URL on legacy rows; a data URI there is
    // still just the image.
    url: legacy.indexOf('data:image') === 0 ? '' : legacy,
    archived,
  };
}

/** Locate a booking's slip in the live table, falling back to the archive. */
export function getSlipRecordByRef(db: D1Database, ref: string): Promise<StoredSlip | null> {
  return db
    .prepare(`SELECT ${SLIP_SELECT} FROM ${TABLES.reservations} WHERE ref = ? LIMIT 1`)
    .bind(ref)
    .first<Record<string, unknown>>()
    .then((r) => {
      const live = rowToStoredSlip(r, false);
      if (live && (live.key || live.dataUri || live.url)) return live;
      return db
        .prepare(`SELECT ${SLIP_SELECT} FROM ${TABLES.archive} WHERE ref = ? LIMIT 1`)
        .bind(ref)
        .first<Record<string, unknown>>()
        .then((a) => rowToStoredSlip(a, true) ?? live);
    });
}

/** Bookings whose slip still sits in D1 as base64, oldest first. Used by the
 *  one-shot backfill that moves them into R2 — batched, because a page of these
 *  rows is megabytes each. */
export function listBase64Slips(
  db: D1Database,
  limit: number,
  table: string = TABLES.reservations
): Promise<Array<{ ref: string; slip_base64: string }>> {
  return db
    .prepare(`SELECT ref, slip_base64 FROM ${table} WHERE slip_base64 != '' AND slip_key = '' LIMIT ?`)
    .bind(limit)
    .all<{ ref: string; slip_base64: string }>()
    .then((res) => res.results ?? []);
}

export function countBase64Slips(db: D1Database, table: string = TABLES.reservations): Promise<number> {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE slip_base64 != '' AND slip_key = ''`)
    .first<{ n: number }>()
    .then((r) => Number(r?.n ?? 0));
}

export function getReservationsByRefs(db: D1Database, ref: string): Promise<Reservation[]> {
  return db
    .prepare(`SELECT ${RESERVATION_COLUMNS.join(', ')} FROM ${TABLES.reservations} WHERE ref = ? ORDER BY rowid`)
    .bind(ref)
    .all<Record<string, unknown>>()
    .then((res) => (res.results ?? []).map(reservationRowToObject));
}

export function getReservationsByPrisonerId(db: D1Database, prisonerId: string): Promise<Reservation[]> {
  return db
    .prepare(
      `SELECT ${RESERVATION_COLUMNS.join(', ')} FROM ${TABLES.reservations} WHERE prisonerId = ? ORDER BY rowid DESC`
    )
    .bind(prisonerId)
    .all<Record<string, unknown>>()
    .then((res) => (res.results ?? []).map(reservationRowToObject));
}

export function findDuplicateActiveBooking(
  db: D1Database,
  prisonerId: string,
  visitDateISO: string,
  excludeRef: string | null
): Promise<string | null> {
  const active = ['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น'];
  const placeholders = active.map(() => '?').join(', ');
  let sql = `SELECT ref FROM ${TABLES.reservations} WHERE prisonerId = ? AND visitDateISO = ? AND status IN (${placeholders})`;
  const params: unknown[] = [prisonerId, visitDateISO, ...active];
  if (excludeRef) {
    sql += ' AND ref != ?';
    params.push(excludeRef);
  }
  sql += ' LIMIT 1';
  return db
    .prepare(sql)
    .bind(...params)
    .first<{ ref: string }>()
    .then((r) => (r ? r.ref : null));
}

const PAID_STATUSES = ['ชำระแล้ว', 'เสร็จสิ้น'];

/** Find another (already-paid) reservation reusing the same slip — either the
 *  same bank/TrueMoney transaction id, or the exact same image bytes. Checks
 *  both the active and archived tables so an archived paid booking's slip
 *  can't be silently replayed against a new one. */
export function findReservationBySlipFingerprint(
  db: D1Database,
  fingerprint: string,
  imageHash: string,
  excludeRef: string
): Promise<{ ref: string; matchedBy: 'fingerprint' | 'image' } | null> {
  if (!fingerprint && !imageHash) return Promise.resolve(null);
  const matchClauses: string[] = [];
  const matchParams: unknown[] = [];
  if (fingerprint) {
    matchClauses.push('slip_fingerprint = ?');
    matchParams.push(fingerprint);
  }
  if (imageHash) {
    matchClauses.push('slip_image_hash = ?');
    matchParams.push(imageHash);
  }
  const paidPlaceholders = PAID_STATUSES.map(() => '?').join(', ');
  const half = (table: string) =>
    `SELECT ref, slip_fingerprint, slip_image_hash FROM ${table} WHERE (${matchClauses.join(' OR ')}) AND ref != ? AND status IN (${paidPlaceholders})`;
  const sql = `${half(TABLES.reservations)} UNION ALL ${half(TABLES.archive)} LIMIT 1`;
  const halfParams = [...matchParams, excludeRef, ...PAID_STATUSES];
  return db
    .prepare(sql)
    .bind(...halfParams, ...halfParams)
    .first<{ ref: string; slip_fingerprint: string; slip_image_hash: string }>()
    .then((r) =>
      r ? { ref: r.ref, matchedBy: fingerprint && r.slip_fingerprint === fingerprint ? 'fingerprint' : 'image' } : null
    );
}

/** Prisoner-visit bookings only: the no-prisoner table pool is counted separately
 *  by countActiveTableBookingsByDate, so the two calendars stay independent. */
export function countReservationsByDate(db: D1Database): Promise<Record<string, number>> {
  return db
    .prepare(
      `SELECT visitDateISO, COUNT(*) as c FROM ${TABLES.reservations}
     WHERE status IN (?, ?, ?, ?, ?) AND visitDateISO LIKE '____-__-__'
       AND bookingType != 'table'
     GROUP BY visitDateISO`
    )
    .bind('รอตรวจสอบวินัย', 'รอตรวจสอบผู้เข้าร่วม', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น')
    .all<{ visitDateISO: string; c: number }>()
    .then((res) => {
      const counts: Record<string, number> = {};
      for (const r of res.results ?? []) {
        counts[r.visitDateISO] = Number(r.c);
      }
      return counts;
    });
}

// ── Table bookings (bookingType = 'table') ─────────────────────────
// A day's capacity is consumed by every active table booking EXCEPT one that is
// still awaiting payment past its hold. Excluding expired holds inside the count
// itself is what makes capacity correct the instant a hold lapses, without
// depending on the housekeeping sweep below having run first.
const TABLE_ACTIVE_STATUSES = ACTIVE_STATUSES;

export function countActiveTableBookings(db: D1Database, visitDateISO: string, nowIso: string): Promise<number> {
  const placeholders = TABLE_ACTIVE_STATUSES.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${TABLES.reservations}
        WHERE bookingType = 'table'
          AND visitDateISO = ?
          AND status IN (${placeholders})
          AND NOT (status = ? AND holdExpiresAt != '' AND holdExpiresAt < ?)`
    )
    .bind(visitDateISO, ...TABLE_ACTIVE_STATUSES, AWAITING_PAYMENT, nowIso)
    .first<{ n: number }>()
    .then((r) => Number(r?.n ?? 0));
}

/** Per-date used counts for the public availability calendar. */
export function countActiveTableBookingsByDate(db: D1Database, nowIso: string): Promise<Record<string, number>> {
  const placeholders = TABLE_ACTIVE_STATUSES.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT visitDateISO, COUNT(*) AS c FROM ${TABLES.reservations}
        WHERE bookingType = 'table'
          AND visitDateISO LIKE '____-__-__'
          AND status IN (${placeholders})
          AND NOT (status = ? AND holdExpiresAt != '' AND holdExpiresAt < ?)
        GROUP BY visitDateISO`
    )
    .bind(...TABLE_ACTIVE_STATUSES, AWAITING_PAYMENT, nowIso)
    .all<{ visitDateISO: string; c: number }>()
    .then((res) => {
      const counts: Record<string, number> = {};
      for (const r of res.results ?? []) counts[r.visitDateISO] = Number(r.c);
      return counts;
    });
}

/**
 * Cancel table bookings whose payment hold has lapsed. Housekeeping only — the
 * count above already ignores them — so this exists to keep zombie rows out of
 * the dashboard. Returns the number of rows cancelled.
 */
export function releaseExpiredTableHolds(db: D1Database, nowIso: string, visitDateISO?: string): Promise<number> {
  const scoped = visitDateISO ? ' AND visitDateISO = ?' : '';
  // SET status, cancelReason, updatedAt | WHERE status, holdExpiresAt < now [, visitDateISO]
  const binds: unknown[] = [CANCELLED, HOLD_EXPIRED_REASON, nowIso, nowIso, AWAITING_PAYMENT, nowIso];
  if (visitDateISO) binds.push(visitDateISO);
  return db
    .prepare(
      `UPDATE ${TABLES.reservations}
          SET status = ?, cancelReason = ?, holdExpiresAt = '', cancelAt = ?, updatedAt = ?
        WHERE bookingType = 'table'
          AND status = ?
          AND holdExpiresAt != ''
          AND holdExpiresAt < ?${scoped}`
    )
    .bind(...binds)
    .run()
    .then((res) => Number(res.meta?.changes ?? 0));
}

export function getAllRefs(db: D1Database): Promise<string[]> {
  return db
    .prepare(`SELECT ref FROM ${TABLES.reservations}`)
    .all<{ ref: string }>()
    .then((res) => (res.results ?? []).map((r) => r.ref));
}

/**
 * Live allocations that have been cancelled (status 'ยกเลิก') and are now well
 * past their use are permanently dropped so the reservation page stays clean.
 * A row qualifies once EITHER threshold is met (whichever happens first):
 *   - 48 hours after it was marked cancelled (cancelAt), or
 *   - 2 days after the visit date (visitDateISO).
 * Returns the refs removed, for downstream note/notification cleanup.
 */
export async function listExpiredCancelledRefs(
  db: D1Database,
  nowIso: string,
  cancelAfterHours = 48,
  cancelAfterDays = 2
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT ref FROM ${TABLES.reservations}
        WHERE status = ?
          AND (
            (cancelAt != '' AND cancelAt <= ?)
            OR
            (visitDateISO GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND visitDateISO < date(?, ?))
          )`
    )
    .bind(CANCELLED, subtractHours(nowIso, cancelAfterHours), nowIso, '-' + cancelAfterDays + ' days')
    .all<{ ref: string }>();
  return (res.results ?? []).map((r) => r.ref);
}

function subtractHours(iso: string, hours: number): string {
  const ms = new Date(iso).getTime() - hours * 3600000;
  return new Date(ms).toISOString();
}

export function insertReservation(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const cols = RESERVATION_COLUMNS;
  const values = cols.map((c) => (data[c] !== undefined ? data[c] : ''));
  const stmt = db.prepare(
    `INSERT INTO ${TABLES.reservations} (${cols.join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`
  );
  return stmt
    .bind(...values)
    .run()
    .then(() => undefined);
}

function updateColumnsIn(db: D1Database, table: string, ref: string, cols: Array<[string, unknown]>): Promise<void> {
  if (cols.length === 0) return Promise.resolve();
  const allowed = new Set(RESERVATION_WRITABLE_COLUMNS);
  const filtered = cols.filter(([c]) => allowed.has(c));
  if (filtered.length === 0) return Promise.resolve();
  const setSql = filtered.map(([c]) => `${c} = ?`).join(', ');
  const params = filtered.map(([, v]) => v);
  return db
    .prepare(`UPDATE ${table} SET ${setSql} WHERE ref = ?`)
    .bind(...params, ref)
    .run()
    .then(() => undefined);
}

export function updateReservationColumns(db: D1Database, ref: string, cols: Array<[string, unknown]>): Promise<void> {
  return updateColumnsIn(db, TABLES.reservations, ref, cols);
}

export function updateArchivedReservationColumns(
  db: D1Database,
  ref: string,
  cols: Array<[string, unknown]>
): Promise<void> {
  return updateColumnsIn(db, TABLES.archive, ref, cols);
}

export function insertArchivedReservation(db: D1Database, data: Record<string, unknown>): Promise<void> {
  const cols = [...RESERVATION_COLUMNS, 'slip_base64', 'archivedAt'];
  const values = cols.map((c) => (data[c] !== undefined ? data[c] : ''));
  return db
    .prepare(
      `INSERT OR REPLACE INTO ${TABLES.archive} (${cols.join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`
    )
    .bind(...values)
    .run()
    .then(() => undefined);
}

export function deleteReservation(db: D1Database, ref: string): Promise<void> {
  return db
    .prepare(`DELETE FROM ${TABLES.reservations} WHERE ref = ?`)
    .bind(ref)
    .run()
    .then(() => undefined);
}

export function deleteArchivedReservation(db: D1Database, ref: string): Promise<void> {
  return db
    .prepare(`DELETE FROM ${TABLES.archive} WHERE ref = ?`)
    .bind(ref)
    .run()
    .then(() => undefined);
}

export function clearAllReservations(db: D1Database): Promise<void> {
  return db
    .prepare(`DELETE FROM ${TABLES.reservations}`)
    .run()
    .then(() => undefined);
}

export function getEnvDb(env: Env): D1Database {
  return env.DB;
}
