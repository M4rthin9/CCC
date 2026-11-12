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

export function visitorApprovalsComplete(data: Record<string, unknown>): boolean {
  const flags = String(data.extraVisitorApproved || '').split(';;');
  return (
    decision(data.visitorApproved) === 'yes' &&
    parseExtraVisitorNames(data.extraVisitorNames).every((_, i) => ['yes', 'no'].includes(decision(flags[i])))
  );
}

export interface VisitorClearance {
  visitorId: string;
  decision: string;
  sourceRef: string;
  decidedBy: string;
}

/** Legacy stage grants must still have supporting approval in their source booking. */
export function reusableVisitorClearance(
  clearance: VisitorClearance,
  source: Record<string, unknown> | undefined,
  ref: string
): boolean {
  if (decision(clearance.decision) !== 'yes') return false;
  if (clearance.decidedBy !== 'legacy') return true;
  if (!source || clearance.sourceRef === ref) return false;
  if (source.participantApproved === 'yes') return true;
  if (identity(source.visitorId) === identity(clearance.visitorId)) return decision(source.visitorApproved) === 'yes';
  const flags = String(source.extraVisitorApproved || '').split(';;');
  return parseExtraVisitorNames(source.extraVisitorNames).some(
    (guest, i) => identity(guest.id) === identity(clearance.visitorId) && decision(flags[i]) === 'yes'
  );
}

/** Preserve individual decisions; history can approve only guests still undecided. */
export async function refreshReturningVisitorApprovals(db: D1Database, data: Record<string, unknown>): Promise<number> {
  const prisonerId = identity(data.prisonerId);
  const extras = parseExtraVisitorNames(data.extraVisitorNames);
  const known = prisonerId
    ? await db
        .prepare(
          `SELECT c.visitorId, c.decision, c.sourceRef, c.decidedBy,
          COALESCE(r.ref,a.ref) AS sourceExists,
          COALESCE(r.visitorId,a.visitorId) AS sourceVisitorId,
          COALESCE(r.visitorApproved,a.visitorApproved) AS sourceVisitorApproved,
          COALESCE(r.extraVisitorNames,a.extraVisitorNames) AS sourceExtraVisitorNames,
          COALESCE(r.extraVisitorApproved,a.extraVisitorApproved) AS sourceExtraVisitorApproved,
          COALESCE(r.participantApproved,a.participantApproved) AS sourceParticipantApproved
          FROM visitor_clearances c LEFT JOIN reservations r ON r.ref=c.sourceRef
          LEFT JOIN reservations_archive a ON a.ref=c.sourceRef
          WHERE c.prisonerId = ? AND c.decision = 'yes'`
        )
        .bind(prisonerId)
        .all<
          VisitorClearance & {
            sourceExists: string;
            sourceVisitorId: string;
            sourceVisitorApproved: string;
            sourceExtraVisitorNames: string;
            sourceExtraVisitorApproved: string;
            sourceParticipantApproved: string;
          }
        >()
    : { results: [] };
  const approved = new Set(
    (known.results || [])
      .filter((row) =>
        reusableVisitorClearance(
          row,
          row.sourceExists
            ? {
                visitorId: row.sourceVisitorId,
                visitorApproved: row.sourceVisitorApproved,
                extraVisitorNames: row.sourceExtraVisitorNames,
                extraVisitorApproved: row.sourceExtraVisitorApproved,
                participantApproved: row.sourceParticipantApproved,
              }
            : undefined,
          String(data.ref || '')
        )
      )
      .map((row) => identity(row.visitorId))
  );
  const beforeMain = decision(data.visitorApproved);
  const beforeExtra = String(data.extraVisitorApproved || '')
    .split(';;')
    .map(decision);
  const resolve = (id: unknown, current: string) =>
    ['yes', 'no'].includes(current) ? current : identity(id) && approved.has(identity(id)) ? 'yes' : '';
  const main = resolve(data.visitorId, beforeMain);
  const extra = extras.map((guest, i) => resolve(guest.id, beforeExtra[i] || ''));
  data.visitorApproved = main;
  data.extraVisitorApproved = extra.join(';;');
  data.participantApproved = visitorApprovalsComplete(data) ? 'yes' : '';
  data.status =
    data.participantApproved === 'yes'
      ? data.disciplineApproved === 'yes'
        ? 'รอชำระเงิน'
        : 'รอตรวจสอบวินัย'
      : 'รอตรวจสอบผู้เข้าร่วม';
  return (
    (main === 'yes' && beforeMain !== 'yes' ? 1 : 0) +
    extra.filter((flag, i) => flag === 'yes' && beforeExtra[i] !== 'yes').length
  );
}

/** A new booking never inherits client-supplied decisions or a discipline approval. */
export async function applyReturningVisitorApprovals(db: D1Database, data: Record<string, unknown>): Promise<number> {
  data.visitorApproved = '';
  data.extraVisitorApproved = '';
  data.disciplineApproved = '';
  return refreshReturningVisitorApprovals(db, data);
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
