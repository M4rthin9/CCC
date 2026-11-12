import { createHash } from 'node:crypto';
import { parseExtraVisitorNames } from '../src/services/pricing';
import {
  reusableVisitorClearance,
  visitorApprovalsComplete,
  type VisitorClearance,
} from '../src/services/visitorClearance';

type Row = Record<string, unknown>;
const id = (value: unknown) =>
  String(value || '')
    .trim()
    .toUpperCase();
const flag = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase();
export const recheckFields = [
  'visitorApproved',
  'extraVisitorApproved',
  'participantApproved',
  'disciplineApproved',
  'status',
] as const;
export const reviewStatuses = ['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน'];
export interface ApprovalRecheck {
  ref: string;
  version: number;
  total: number;
  updatedAt: string;
  rosterHash: string;
  before: Row;
  after: Row;
}

export function approvalRecheckPlan(
  live: Row[],
  archive: Row[],
  clearances: Array<VisitorClearance & { prisonerId: string }>,
  events: Row[],
  locked: Set<string>
): ApprovalRecheck[] {
  const sources = new Map([...archive, ...live].map((row) => [String(row.ref), row]));
  const history = new Map(clearances.map((c) => [`${id(c.prisonerId)}:${id(c.visitorId)}`, c]));
  const stageApprovals = new Map<string, number>();
  const rosterEdits = new Map<string, number>();
  for (const event of events) {
    let details: Row;
    try {
      details = JSON.parse(String(event.details || '{}'));
    } catch {
      continue;
    }
    const ref = String(event.targetRef),
      time = Date.parse(
        String(event.timestamp).replace(' ', 'T') + (String(event.timestamp).includes('Z') ? '' : '+07:00')
      );
    if (event.action === 'booking_stage_approved' && details.stage === 'participant')
      stageApprovals.set(ref, Math.max(stageApprovals.get(ref) || 0, time));
    if (
      event.action === 'update_booking' &&
      ['extraVisitorNames', 'visitorId', 'prisonerId'].some((key) => details[key] !== undefined)
    )
      rosterEdits.set(ref, Math.max(rosterEdits.get(ref) || 0, time));
  }
  return live.flatMap((row) => {
    const ref = String(row.ref);
    if (
      row.bookingType === 'table' ||
      ref.toUpperCase().startsWith('TBL-') ||
      !reviewStatuses.includes(String(row.status)) ||
      locked.has(ref)
    )
      return [];
    const extras = parseExtraVisitorNames(row.extraVisitorNames),
      previous = String(row.extraVisitorApproved || '').split(';;');
    const explicitStage =
      (stageApprovals.get(ref) || 0) > 0 && (stageApprovals.get(ref) || 0) >= (rosterEdits.get(ref) || 0);
    const returning = (visitorId: unknown) => {
      if (!id(visitorId)) return false;
      const c = history.get(`${id(row.prisonerId)}:${id(visitorId)}`);
      if (c?.decision === 'no') return false;
      if (c && reusableVisitorClearance(c, sources.get(c.sourceRef), ref)) return true;
      // A legacy grant may have been overwritten by this booking's stage flag.
      // Recover proof from another booking, never from this booking itself.
      return [...sources.values()].some((source) => {
        if (
          source.ref === ref ||
          source.bookingType === 'table' ||
          String(source.ref).startsWith('TBL-') ||
          id(source.prisonerId) !== id(row.prisonerId)
        )
          return false;
        if (
          id(source.visitorId) === id(visitorId) &&
          (flag(source.visitorApproved) === 'yes' || source.participantApproved === 'yes')
        )
          return true;
        const flags = String(source.extraVisitorApproved || '').split(';;');
        return parseExtraVisitorNames(source.extraVisitorNames).some(
          (guest, i) =>
            id(guest.id) === id(visitorId) && (flag(flags[i]) === 'yes' || source.participantApproved === 'yes')
        );
      });
    };
    const resolve = (visitorId: unknown, decision: unknown) =>
      ['yes', 'no'].includes(flag(decision)) ? flag(decision) : explicitStage || returning(visitorId) ? 'yes' : '';
    const after: Row = {
      visitorApproved: resolve(row.visitorId, row.visitorApproved),
      extraVisitorApproved: extras.map((g, i) => resolve(g.id, previous[i])).join(';;'),
      disciplineApproved: row.disciplineApproved,
    };
    const ready = visitorApprovalsComplete({ ...row, ...after });
    after.participantApproved = ready ? 'yes' : '';
    after.status = ready
      ? row.disciplineApproved === 'yes'
        ? 'รอชำระเงิน'
        : 'รอตรวจสอบวินัย'
      : 'รอตรวจสอบผู้เข้าร่วม';
    if (!recheckFields.some((field) => String(row[field] || '') !== String(after[field] || ''))) return [];
    return [
      {
        ref,
        version: Number(row.version || 1),
        total: Number(row.total || 0),
        updatedAt: String(row.updatedAt || ''),
        rosterHash: createHash('sha256')
          .update(JSON.stringify([row.visitorId, row.prisonerId, row.extraVisitorNames]))
          .digest('hex'),
        before: Object.fromEntries(recheckFields.map((field) => [field, row[field] || ''])),
        after,
      },
    ];
  });
}

export const recheckGuard = `r.ref=json_extract(p.value,'$.ref') AND r.version=json_extract(p.value,'$.version')
 AND r.updatedAt=json_extract(p.value,'$.updatedAt') AND r.total=json_extract(p.value,'$.total')
 AND r.status=json_extract(p.value,'$.before.status')
 AND r.visitorApproved=json_extract(p.value,'$.before.visitorApproved')
 AND r.extraVisitorApproved=json_extract(p.value,'$.before.extraVisitorApproved')
 AND r.participantApproved=json_extract(p.value,'$.before.participantApproved')
 AND r.disciplineApproved=json_extract(p.value,'$.before.disciplineApproved')
 AND NOT EXISTS(SELECT 1 FROM reservation_payment_locks l WHERE l.ref=r.ref)`;
export const recheckUpdateSql = `UPDATE reservations AS r SET
 visitorApproved=json_extract(p.value,'$.after.visitorApproved'),
 extraVisitorApproved=json_extract(p.value,'$.after.extraVisitorApproved'),
 participantApproved=json_extract(p.value,'$.after.participantApproved'),
 status=json_extract(p.value,'$.after.status'),updatedAt=?,version=r.version+1
 FROM json_each(?) AS p WHERE ${recheckGuard}
 AND r.status IN ('รอตรวจสอบผู้เข้าร่วม','รอตรวจสอบวินัย','รอชำระเงิน')
 AND r.bookingType!='table' AND upper(r.ref) NOT LIKE 'TBL-%'
 RETURNING ref,version`;
