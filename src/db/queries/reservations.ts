import { TABLES } from '../../constants';
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
  'status',
  'slipImage',
  'cancelReason',
  'createdAt',
  'updatedAt',
  'version',
  'createdBy',
  'source',
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

export function getReservationByRef(db: D1Database, ref: string): Promise<Reservation | null> {
  return db
    .prepare(`SELECT ${RESERVATION_COLUMNS.join(', ')} FROM ${TABLES.reservations} WHERE ref = ?`)
    .bind(ref)
    .first<Record<string, unknown>>()
    .then((r) => (r ? reservationRowToObject(r) : null));
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

export function countReservationsByDate(db: D1Database): Promise<Record<string, number>> {
  return db
    .prepare(
      `SELECT visitDateISO, COUNT(*) as c FROM ${TABLES.reservations}
     WHERE status IN (?, ?, ?, ?, ?) AND visitDateISO LIKE '____-__-__'
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

export function getAllRefs(db: D1Database): Promise<string[]> {
  return db
    .prepare(`SELECT ref FROM ${TABLES.reservations}`)
    .all<{ ref: string }>()
    .then((res) => (res.results ?? []).map((r) => r.ref));
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

export function updateReservationColumns(db: D1Database, ref: string, cols: Array<[string, unknown]>): Promise<void> {
  if (cols.length === 0) return Promise.resolve();
  const allowed = new Set(RESERVATION_WRITABLE_COLUMNS);
  const filtered = cols.filter(([c]) => allowed.has(c));
  if (filtered.length === 0) return Promise.resolve();
  const setSql = filtered.map(([c]) => `${c} = ?`).join(', ');
  const params = filtered.map(([, v]) => v);
  return db
    .prepare(`UPDATE ${TABLES.reservations} SET ${setSql} WHERE ref = ?`)
    .bind(...params, ref)
    .run()
    .then(() => undefined);
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

export function clearAllReservations(db: D1Database): Promise<void> {
  return db
    .prepare(`DELETE FROM ${TABLES.reservations}`)
    .run()
    .then(() => undefined);
}

export function getEnvDb(env: Env): D1Database {
  return env.DB;
}
