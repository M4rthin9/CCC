import { parseExtraVisitorNames } from './pricing';
import type { Reservation } from '../types';

const identity = (value: unknown) =>
  String(value || '')
    .trim()
    .toUpperCase();
const decision = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase();

/** Only creation calls this: an approval never carries discipline into a new booking. */
export async function applyReturningVisitorApprovals(db: D1Database, data: Record<string, unknown>): Promise<number> {
  const prisonerId = identity(data.prisonerId);
  const extras = parseExtraVisitorNames(data.extraVisitorNames);
  const known = prisonerId
    ? await db
        .prepare("SELECT visitorId FROM visitor_clearances WHERE prisonerId = ? AND decision = 'yes'")
        .bind(prisonerId)
        .all<{ visitorId: string }>()
    : { results: [] };
  const approved = new Set((known.results || []).map((row) => row.visitorId));
  const main = identity(data.visitorId) && approved.has(identity(data.visitorId)) ? 'yes' : '';
  const extra = extras.map((guest) => (identity(guest.id) && approved.has(identity(guest.id)) ? 'yes' : ''));
  data.visitorApproved = main;
  data.extraVisitorApproved = extra.join(';;');
  data.participantApproved = main === 'yes' && extra.every((flag) => flag === 'yes') ? 'yes' : '';
  data.disciplineApproved = '';
  data.status = data.participantApproved === 'yes' ? 'รอตรวจสอบวินัย' : 'รอตรวจสอบผู้เข้าร่วม';
  return (main === 'yes' ? 1 : 0) + extra.filter((flag) => flag === 'yes').length;
}

/** A staff approval of the whole stage endorses every guest except explicit
 * rejections. Its original decision time prevents retries overriding later denials. */
export async function rememberParticipantStage(db: D1Database, row: Reservation, username: string): Promise<void> {
  if (!identity(row.prisonerId) || row.bookingType === 'table' || row.ref.toUpperCase().startsWith('TBL-')) return;
  const flags = String(row.extraVisitorApproved || '').split(';;');
  const guests = [
    { id: identity(row.visitorId), decision: decision(row.visitorApproved) === 'no' ? 'no' : 'yes' },
    ...parseExtraVisitorNames(row.extraVisitorNames).map((guest, i) => ({
      id: identity(guest.id),
      decision: decision(flags[i]) === 'no' ? 'no' : 'yes',
    })),
  ].filter((guest) => guest.id);
  const unique = new Map<string, string>();
  for (const guest of guests) if (unique.get(guest.id) !== 'no') unique.set(guest.id, guest.decision);
  if (!unique.size) return;
  await db
    .prepare(
      `INSERT INTO visitor_clearances (prisonerId, visitorId, decision, sourceRef, decidedBy, decidedAt)
    SELECT ?, json_extract(guest.value, '$[0]'), json_extract(guest.value, '$[1]'), ref, ?, updatedAt
    FROM reservations, json_each(?) AS guest WHERE ref = ? AND version = ? AND status = ?
    ON CONFLICT (prisonerId, visitorId) DO UPDATE SET decision = excluded.decision,
      sourceRef = excluded.sourceRef, decidedBy = excluded.decidedBy, decidedAt = excluded.decidedAt
    WHERE excluded.decidedAt > visitor_clearances.decidedAt
      OR (excluded.decidedAt = visitor_clearances.decidedAt AND excluded.decision = 'no')`
    )
    .bind(
      identity(row.prisonerId),
      username,
      JSON.stringify([...unique]),
      row.ref,
      Number(row.version || 1),
      String(row.status || '')
    )
    .run();
}

/** Run before the booking update in the SAME D1 batch. A stale snapshot records
 * no decisions; failure of any statement rolls back the booking and history. */
export function visitorClearanceStatements(
  db: D1Database,
  current: Reservation,
  changes: { visitorApproved?: string; extraVisitorApproved?: string },
  username: string,
  now: string
): D1PreparedStatement[] {
  const prisonerId = identity(current.prisonerId);
  if (!prisonerId || current.bookingType === 'table' || current.ref.toUpperCase().startsWith('TBL-')) return [];
  const changed = new Map<string, string>();
  const add = (id: unknown, value: unknown, previous: unknown) => {
    const key = identity(id),
      next = decision(value);
    if (!key || !['yes', 'no'].includes(next) || next === decision(previous)) return;
    // A malformed duplicate roster cannot turn an explicit rejection into a grant.
    if (changed.get(key) !== 'no') changed.set(key, next);
  };
  if (changes.visitorApproved !== undefined) add(current.visitorId, changes.visitorApproved, current.visitorApproved);
  if (changes.extraVisitorApproved !== undefined) {
    const before = String(current.extraVisitorApproved || '').split(';;');
    const after = changes.extraVisitorApproved.split(';;');
    parseExtraVisitorNames(current.extraVisitorNames).forEach((guest, index) =>
      add(guest.id, after[index], before[index])
    );
  }
  return [...changed].map(([visitorId, value]) =>
    db
      .prepare(
        `INSERT INTO visitor_clearances (prisonerId, visitorId, decision, sourceRef, decidedBy, decidedAt)
     SELECT ?, ?, ?, ref, ?, ? FROM reservations WHERE ref = ? AND version = ? AND status = ? AND total = ?
     ON CONFLICT (prisonerId, visitorId) DO UPDATE SET
       decision = excluded.decision, sourceRef = excluded.sourceRef,
       decidedBy = excluded.decidedBy, decidedAt = excluded.decidedAt`
      )
      .bind(
        prisonerId,
        visitorId,
        value,
        username,
        now,
        current.ref,
        Number(current.version || 1),
        String(current.status || ''),
        Number(current.total || 0)
      )
  );
}
