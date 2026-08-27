import { PUBLIC_CACHE_TTL, VALID_STATUSES, ACTIVE_STATUSES } from '../constants';
import { sanitizeStr, normalizeVisitDateISO, formatDateISO } from '../config';
import { cacheKeyArchived, cacheKeyCounts, cacheKeyReservations } from '../cache/keys';
import { d1CacheGet, d1CachePut, d1CacheRemove, d1CacheGetVersioned, d1CachePutVersioned } from '../cache/d1Cache';
import { getScopeVersion } from '../db/queries/settings';
import {
  getActiveReservations,
  getArchivedReservations,
  getArchivedReservationByRef,
  getReservationsByRefs,
  updateReservationColumns,
  updateArchivedReservationColumns,
  insertReservation,
  countReservationsByDate,
  getAllRefs,
  deleteReservation,
  deleteArchivedReservation,
} from '../db/queries/reservations';
import { deleteNotesByRef } from '../db/queries/notes';
import { deleteNotificationDataByRef } from '../db/queries/notifications';
import { hasPermission } from '../db/queries/roles';
import {
  invalidateArchivedCache,
  invalidateLookupCache,
  invalidatePrisonerLookupCache,
  invalidateReservationsCache,
} from '../cache/invalidation';
import { computeApprovalTotals, applyServerPricing } from '../services/pricing';
import { logEvent } from '../services/logger';
import { notify } from '../services/notifications';
import { getPrisonerDiscipline } from '../services/disciplineService';
import {
  generateUniqueRefServer,
  parseUpdateBookingFields,
  findDuplicateActive,
  validateSaveReservation,
} from '../services/reservationService';
import { Env, Reservation } from '../types';
import { AuthenticatedUser } from '../auth/middleware';

const ACTIVE = ACTIVE_STATUSES;

export async function getAllReservations(env: Env): Promise<Record<string, unknown>> {
  const key = cacheKeyReservations(env);
  let version: number;
  try {
    version = await getScopeVersion(env.DB, 'reservations');
  } catch {
    version = -1;
  }
  if (version !== -1) {
    const { hit } = await d1CacheGetVersioned<Reservation[]>(env.DB, key, version);
    if (Array.isArray(hit)) return { status: 'ok', rows: hit };
  }

  const rows = await getActiveReservations(env.DB);
  if (version !== -1) {
    await d1CachePutVersioned(env.DB, key, version, rows, PUBLIC_CACHE_TTL);
  }
  return { status: 'ok', rows };
}

export async function getAllReservationsWithArchive(
  env: Env,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const active = await getActiveReservations(env.DB);
  if (!(body && body.includeArchive)) {
    return { status: 'ok', rows: active };
  }
  const archived = await getArchivedReservations(env.DB);
  const activeRefs = new Set(
    active.map((r) =>
      String(r.ref || '')
        .trim()
        .toUpperCase()
    )
  );
  const merged = active.slice();
  archived.forEach((r) => {
    const ref = String(r.ref || '').trim();
    if (ref && !activeRefs.has(ref.toUpperCase())) {
      merged.push(Object.assign({}, r, { _archived: true }));
    }
  });
  return { status: 'ok', rows: merged };
}

export async function getArchivedReservationsHandler(
  env: Env,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const key = cacheKeyArchived(env);
  const cached = await d1CacheGet<string>(env.DB, key);
  let rows: Reservation[] | null = null;
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      await d1CacheRemove(env.DB, key).catch(() => undefined);
    }
  }
  if (rows === null) {
    rows = await getArchivedReservations(env.DB);
    await d1CachePut(env.DB, key, JSON.stringify(rows), 21600);
  }

  const from = sanitizeStr(params.from, 10);
  const to = sanitizeStr(params.to, 10);
  if (from || to) {
    rows = rows.filter((r) => {
      const vdi = String(r.visitDateISO || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vdi)) return false;
      if (from && vdi < from) return false;
      if (to && vdi > to) return false;
      return true;
    });
  }
  return { status: 'ok', rows };
}

export async function getCountsByDate(env: Env): Promise<Record<string, unknown>> {
  const countsKey = cacheKeyCounts(env);
  let version: number;
  try {
    version = await getScopeVersion(env.DB, 'reservations');
  } catch {
    version = -1;
  }
  if (version !== -1) {
    const { hit } = await d1CacheGetVersioned<Record<string, number>>(env.DB, countsKey, version);
    if (hit) return { status: 'ok', counts: hit };
  }

  const counts = await countReservationsByDate(env.DB);
  if (version !== -1) {
    await d1CachePutVersioned(env.DB, countsKey, version, counts, PUBLIC_CACHE_TTL);
  }
  return { status: 'ok', counts };
}

export async function handleDedupeReservations(
  env: Env,
  _body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  const canManage = await hasPermission(env.DB, user.username, 'manage_users');
  const canApprove = await hasPermission(env.DB, user.username, 'approve');
  if (!canManage && !canApprove) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการนี้' };
  }
  // reservations.ref is a PRIMARY KEY in D1, so duplicate refs cannot exist.
  // The migration script keeps the first occurrence of any duplicate ref.
  await logEvent(env, user.username, 'dedupe_reservations', '', { removed: 0 }, 'success');
  return { status: 'ok', removed: 0, message: 'ไม่พบเลขอ้างอิงซ้ำในชีต' };
}

export async function handleFindDuplicateBookings(
  env: Env,
  _body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  const canManage = await hasPermission(env.DB, user.username, 'manage_users');
  const canApprove = await hasPermission(env.DB, user.username, 'approve');
  if (!canManage && !canApprove) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการนี้' };
  }

  const rows = await getActiveReservations(env.DB);
  const groups: Record<
    string,
    { prisonerId: string; visitDateISO: string; rows: Array<{ row: number; ref: string; visitorName: string }> }
  > = {};
  let i = 0;
  for (const row of rows) {
    i++;
    if (!isActive(row.status)) continue;
    const prisonerId = String(row.prisonerId || '').trim();
    const visitDateISO = normalizeVisitDateISO(row.visitDateISO);
    if (!prisonerId || !visitDateISO) continue;
    const key = prisonerId + '\u0001' + visitDateISO;
    if (!groups[key]) groups[key] = { prisonerId, visitDateISO, rows: [] };
    groups[key].rows.push({
      row: i + 1,
      ref: String(row.ref || '').trim(),
      visitorName: String(row.visitorName || '').trim(),
    });
  }

  const duplicates = Object.keys(groups)
    .filter((key) => (groups[key]?.rows.length ?? 0) > 1)
    .map((key) => groups[key]!);

  return { status: 'ok', count: duplicates.length, duplicates };
}

function isActive(status: unknown): boolean {
  return ACTIVE.includes(String(status || '').trim());
}

/**
 * Resolve a ref against the active table first, falling back to the archive.
 * Used by the Superadmin force-paths so an archived booking stays editable,
 * deletable and re-statusable like any other booking. Returns the row plus
 * which table it lives in, since writes must target the right one.
 */
async function resolveRefAnyTable(env: Env, ref: string): Promise<{ row: Reservation | null; archived: boolean }> {
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length > 0) return { row: rows[0]!, archived: false };
  const archivedRow = await getArchivedReservationByRef(env.DB, ref);
  return { row: archivedRow, archived: true };
}

export async function handleCancelBooking(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  const today = formatDateISO(new Date());
  const allExpired = rows.every((row) => {
    const d = String(row.visitDateISO || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today;
  });
  if (allExpired) {
    return { status: 'error', message: 'เกินวันเข้างานแล้ว ไม่สามารถปฏิเสธ/ยกเลิกได้' };
  }

  const prevStatus = String(rows[0]!.status || '');
  await updateReservationColumns(env.DB, ref, [['status', 'ยกเลิก']]);
  if (body.reason) {
    await updateReservationColumns(env.DB, ref, [['cancelReason', sanitizeStr(body.reason, 2000)]]);
  }

  await logEvent(
    env,
    user.username,
    'booking_cancelled',
    ref,
    { previousStatus: prevStatus, affectedRows: rows.length },
    'success'
  );
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  await notify(env, {
    ref,
    type: 'booking_cancelled',
    prisonerName: rows[0]?.prisonerName,
    reason: body.reason ? ' ด้วยเหตุผล: ' + sanitizeStr(body.reason, 2000) : '',
  }).catch(() => undefined);
  return { status: 'ok' };
}

/**
 * Hard-delete a booking. Superadmin only, and irreversible: the row is removed
 * (from `reservations`, or from `reservations_archive` for archived bookings)
 * along with every side row that points at its ref (nothing in the schema
 * cascades). The only trace left is the event_log entry below, which carries a
 * snapshot of what was deleted.
 */
export async function handleDeleteBooking(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string; role: string }
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);

  if (user.role !== 'Superadmin') {
    await logEvent(
      env,
      user.username,
      'booking_delete_rejected',
      ref,
      { reason: 'role_not_allowed', role: user.role },
      'denied'
    );
    return { status: 'error', message: 'เฉพาะ Superadmin เท่านั้นที่สามารถลบการจองได้' };
  }

  if (!ref) return { status: 'error', message: 'กรุณาระบุเลขอ้างอิง' };

  const { row, archived: wasArchived } = await resolveRefAnyTable(env, ref);
  if (!row) return { status: 'error', message: 'ไม่พบการจองที่ระบุ' };

  // Snapshot for the audit trail. Never include slip_base64 — logEvent caps
  // details at 5000 chars and the slip is multi-MB.
  const snapshot = {
    status: String(row.status ?? ''),
    visitorName: String(row.visitorName ?? ''),
    visitorId: String(row.visitorId ?? ''),
    prisonerId: String(row.prisonerId ?? ''),
    prisonerName: String(row.prisonerName ?? ''),
    wing: String(row.wing ?? ''),
    visitDateISO: String(row.visitDateISO ?? ''),
    totalPersons: Number(row.totalPersons ?? 0),
    total: Number(row.total ?? 0),
    createdBy: String(row.createdBy ?? ''),
    createdAt: String(row.createdAt ?? ''),
    archived: wasArchived,
  };

  await deleteNotesByRef(env.DB, ref);
  await deleteNotificationDataByRef(env.DB, ref);
  if (wasArchived) {
    await deleteArchivedReservation(env.DB, ref);
  } else {
    await deleteReservation(env.DB, ref);
  }

  await logEvent(
    env,
    user.username,
    wasArchived ? 'archived_booking_deleted' : 'booking_deleted',
    ref,
    snapshot,
    'success'
  );
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  if (wasArchived) await invalidateArchivedCache(env);
  if (snapshot.prisonerId) await invalidatePrisonerLookupCache(env, snapshot.prisonerId);

  return { status: 'ok', message: 'ลบการจองเรียบร้อย', archived: wasArchived };
}

/** Slip columns wiped when a mistaken upload is reverted: the stored image
 *  itself plus every verification artifact, so getSlipByRef stops serving the
 *  wrong slip and its recorded fingerprints cannot collide with the
 *  duplicate-slip guard when the replacement upload is verified. */
const SLIP_CLEAR_COLUMNS: Array<[string, string]> = [
  ['slip_base64', ''],
  ['slipImage', ''],
  ['slip_verify_status', ''],
  ['slip_verify_json', ''],
  ['slip_verify_at', ''],
  ['slip_fingerprint', ''],
  ['slip_image_hash', ''],
  ['slip_ocr_json', ''],
  ['slip_decision', ''],
  ['slip_decision_json', ''],
];

/**
 * Rewind a booking to รอชำระเงิน because the visitor uploaded the wrong slip.
 * Superadmin only. The forward-only transition rules in handleUpdateStatus
 * cannot express this move — that restriction protects ordinary staff flows,
 * while an explicit, audited escape hatch covers genuine mistakes.
 *
 * Clearing the slip alongside the status is what makes the retry work: the
 * public payment path refuses any booking that is not already รอชำระเงิน, and
 * a lingering wrong slip would still be served by getSlipByRef.
 */
export async function handleRevertBookingPayment(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string; role: string }
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);

  if (user.role !== 'Superadmin') {
    await logEvent(
      env,
      user.username,
      'booking_payment_revert_rejected',
      ref,
      { reason: 'role_not_allowed', role: user.role },
      'denied'
    );
    return { status: 'error', message: 'เฉพาะ Superadmin เท่านั้นที่สามารถย้อนสถานะการชำระเงินได้' };
  }

  if (!ref) return { status: 'error', message: 'กรุณาระบุเลขอ้างอิง' };

  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'ไม่พบการจองที่ระบุ' };
  const row = rows[0]!;

  const prevStatus = String(row.status || '').trim();
  if (prevStatus !== 'รอชำระเงิน' && prevStatus !== 'ชำระแล้ว') {
    return { status: 'error', message: 'สถานะ "' + prevStatus + '" ไม่สามารถย้อนกลับไปรอชำระเงินได้' };
  }

  // Same guard as cancel/reject: never ask a visitor to pay for a visit that
  // has already happened.
  const d = String(row.visitDateISO || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < formatDateISO(new Date())) {
    return { status: 'error', message: 'เกินวันเข้างานแล้ว ไม่สามารถย้อนสถานะการชำระเงินได้' };
  }

  await updateReservationColumns(env.DB, ref, [
    ['status', 'รอชำระเงิน'],
    ...SLIP_CLEAR_COLUMNS,
    ['updatedAt', new Date().toISOString()],
    ['version', Number(row.version || 1) + 1],
  ]);

  // Snapshot without slip_base64 — logEvent caps details at 5000 chars.
  await logEvent(
    env,
    user.username,
    'booking_payment_reverted',
    ref,
    {
      previousStatus: prevStatus,
      hadSlip: Boolean(row.slip_base64 || row.slipImage),
      slipVerifyStatus: String(row.slip_verify_status || ''),
      slipDecision: String(row.slip_decision || ''),
    },
    'success'
  );
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);

  if (body.notify !== false && body.notify !== 'false') {
    await notify(env, {
      ref,
      type: 'payment_due',
      prisonerName: row.prisonerName,
      visitDate: row.visitDate,
      total: row.total,
    }).catch(() => undefined);
  }
  return { status: 'ok', message: 'ย้อนสถานะกลับเป็นรอชำระเงินแล้ว', previousStatus: prevStatus };
}

export async function handlePublicCancelBooking(
  env: Env,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  // Same guard the staff path applies: a visit that has already happened cannot
  // be cancelled retroactively. Its absence here was an asymmetry, not a rule.
  const today = formatDateISO(new Date());
  const allExpired = rows.every((row) => {
    const d = String(row.visitDateISO || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today;
  });
  if (allExpired) {
    return { status: 'error', message: 'เกินวันเข้างานแล้ว ไม่สามารถยกเลิกได้' };
  }

  const prevStatus = String(rows[0]!.status || '');
  if (prevStatus === 'ยกเลิก') return { status: 'ok', noop: true };

  await updateReservationColumns(env.DB, ref, [['status', 'ยกเลิก']]);

  await logEvent(
    env,
    'public',
    'booking_cancelled',
    ref,
    { previousStatus: prevStatus, affectedRows: rows.length },
    'success'
  );
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  await notify(env, {
    ref,
    type: 'booking_cancelled',
    prisonerName: rows[0]?.prisonerName,
    reason: body.reason ? ' ด้วยเหตุผล: ' + sanitizeStr(body.reason, 2000) : '',
  }).catch(() => undefined);
  return { status: 'ok' };
}

const allowedTransitions: Record<string, string[]> = {
  รอตรวจสอบผู้เข้าร่วม: ['รอตรวจสอบวินัย', 'ไม่อนุมัติ', 'ยกเลิก'],
  รอตรวจสอบวินัย: ['รอชำระเงิน', 'ไม่อนุมัติ', 'ยกเลิก'],
  รอชำระเงิน: ['ชำระแล้ว', 'ยกเลิก'],
  ชำระแล้ว: ['เสร็จสิ้น', 'ยกเลิก'],
  เสร็จสิ้น: [],
  ไม่อนุมัติ: [],
  ยกเลิก: [],
};

const roleAllowedStatuses: Record<string, string[] | null> = {
  Superadmin: null,
  Admin: null,
  Tadtel: ['รอตรวจสอบวินัย'],
  Vinai: ['รอชำระเงิน', 'ไม่อนุมัติ', 'ยกเลิก'],
  Finance: ['ชำระแล้ว', 'เสร็จสิ้น', 'ไม่อนุมัติ'],
};

export async function handleUpdateStatus(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string; role: string }
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  const status = sanitizeStr(body.status, 50);
  if (!ref || !status) return { status: 'error', message: 'Missing ref or status' };
  if (!VALID_STATUSES.includes(status as never)) return { status: 'error', message: 'Invalid status: ' + status };

  const callerRole = user.role;

  // Dynamic roles: allow advancement based on permissions, mirroring legacy.
  let effectiveAllowed = roleAllowedStatuses[callerRole];
  if (effectiveAllowed === undefined) {
    const dynamicAllowed: string[] = [];
    if (await hasPermission(env.DB, user.username, 'approve_participant'))
      dynamicAllowed.push('รอตรวจสอบวินัย', 'ไม่อนุมัติ');
    if (await hasPermission(env.DB, user.username, 'approve_discipline'))
      dynamicAllowed.push('รอชำระเงิน', 'ไม่อนุมัติ', 'ยกเลิก');
    if (await hasPermission(env.DB, user.username, 'confirm_payment'))
      dynamicAllowed.push('ชำระแล้ว', 'เสร็จสิ้น', 'ไม่อนุมัติ');
    if (await hasPermission(env.DB, user.username, 'cancel')) dynamicAllowed.push('ยกเลิก');
    effectiveAllowed = dynamicAllowed.length > 0 ? [...new Set(dynamicAllowed)] : [];
  }

  const canFreeRejectCancel =
    ['Superadmin', 'Admin', 'Vinai'].includes(callerRole) || (await hasPermission(env.DB, user.username, 'cancel'));

  if (effectiveAllowed !== null && !effectiveAllowed.includes(status)) {
    await logEvent(
      env,
      user.username,
      'status_change_rejected',
      ref,
      { newStatus: status, reason: 'role_not_allowed', role: callerRole },
      'denied'
    );
    return { status: 'error', message: 'Role "' + callerRole + '" is not allowed to set status "' + status + '"' };
  }

  // Superadmin force path: any status → any status on any booking regardless
  // of its current status, including archived rows. Ordinary staff keep the
  // forward-only workflow and the expired-visit guard untouched.
  const isSuperForce = callerRole === 'Superadmin';
  let rows: Reservation[];
  let fromArchive = false;
  if (isSuperForce) {
    const target = await resolveRefAnyTable(env, ref);
    if (!target.row) return { status: 'error', message: 'Ref not found' };
    rows = [target.row];
    fromArchive = target.archived;
  } else {
    rows = await getReservationsByRefs(env.DB, ref);
    if (rows.length === 0) return { status: 'error', message: 'Ref not found' };
  }

  if (!isSuperForce && (status === 'ไม่อนุมัติ' || status === 'ยกเลิก')) {
    const today = formatDateISO(new Date());
    const allExpired = rows.every((row) => {
      const d = String(row.visitDateISO || '').trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today;
    });
    if (allExpired) {
      return { status: 'error', message: 'เกินวันเข้างานแล้ว ไม่สามารถปฏิเสธ/ยกเลิกได้' };
    }
  }

  let rejected: { oldStatus: string; newStatus: string } | null = null;
  let allAlreadyAtTarget = true;
  for (const row of rows) {
    const oldStatus = String(row.status || '').trim();
    if (oldStatus === status) continue;
    allAlreadyAtTarget = false;
    if (isSuperForce) continue;
    let allowed = allowedTransitions[oldStatus];
    if (canFreeRejectCancel && (status === 'ไม่อนุมัติ' || status === 'ยกเลิก')) {
      allowed = ['ไม่อนุมัติ', 'ยกเลิก'];
    }
    if (allowed && !allowed.includes(status) && !rejected) {
      rejected = { oldStatus, newStatus: status };
    }
  }

  if (allAlreadyAtTarget) {
    // The usual reason a staff member re-applies a status they already set is
    // that the dashboard showed them a stale row. Drop the caches on the way out
    // so the retry actually repairs the view instead of returning a silent no-op.
    await invalidateReservationsCache(env);
    await invalidateLookupCache(env, ref);
    await logEvent(env, user.username, 'status_change_noop', ref, { status, reason: 'already_at_target' }, 'success');
    return { status: 'ok', noop: true };
  }
  if (rejected) {
    await logEvent(
      env,
      user.username,
      'status_change_rejected',
      ref,
      { oldStatus: rejected.oldStatus, newStatus: rejected.newStatus, reason: 'invalid_transition' },
      'denied'
    );
    return { status: 'error', message: 'Cannot change from "' + rejected.oldStatus + '" to "' + status + '"' };
  }

  const cols: Array<[string, unknown]> = [['status', status]];
  if (body.reason && (status === 'ไม่อนุมัติ' || status === 'ยกเลิก')) {
    cols.push(['cancelReason', sanitizeStr(body.reason, 2000)]);
  }
  if (fromArchive) {
    await updateArchivedReservationColumns(env.DB, ref, cols);
  } else {
    await updateReservationColumns(env.DB, ref, cols);
  }

  await logEvent(
    env,
    user.username,
    fromArchive ? 'archived_status_changed' : 'status_changed',
    ref,
    { newStatus: status, affectedRows: rows.length, ...(fromArchive ? { archived: true } : {}) },
    'success'
  );
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  if (fromArchive) await invalidateArchivedCache(env);

  // Archived bookings are historical records — never ping visitors about them.
  if (fromArchive) return { status: 'ok', archived: true };

  const reasonText = body.reason ? ' ด้วยเหตุผล: ' + sanitizeStr(body.reason, 2000) : '';
  if (status === 'ชำระแล้ว') {
    await notify(env, {
      ref,
      type: 'payment_confirmed',
      total: rows[0]?.total,
      visitDate: rows[0]?.visitDate,
    }).catch(() => undefined);
  } else if (status === 'ไม่อนุมัติ') {
    await notify(env, {
      ref,
      type: 'visitor_rejected',
      prisonerName: rows[0]?.prisonerName,
      reason: reasonText,
    }).catch(() => undefined);
  } else if (status === 'ยกเลิก') {
    await notify(env, {
      ref,
      type: 'booking_cancelled',
      prisonerName: rows[0]?.prisonerName,
      reason: reasonText,
    }).catch(() => undefined);
  } else if (status === 'รอชำระเงิน') {
    // The one moment the visitor has to act — this is the event the
    // NOTIFY_EVENT_ALLOWLIST is set to by default.
    await notify(env, {
      ref,
      type: 'payment_due',
      prisonerName: rows[0]?.prisonerName,
      visitDate: rows[0]?.visitDate,
      total: rows[0]?.total,
    }).catch(() => undefined);
  } else {
    await notify(env, {
      ref,
      type: 'status_changed',
      status,
      prisonerName: rows[0]?.prisonerName,
      visitDate: rows[0]?.visitDate,
    }).catch(() => undefined);
  }
  return { status: 'ok' };
}

export async function handleUpdateVisitorApproval(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!body.ref) return { status: 'error', message: 'Missing ref' };
  const ref = sanitizeStr(body.ref, 64);
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  // Same fallback as extraVisitorApproved below: a caller deciding only the
  // extra visitors omits visitorApproved, and reading that absence as "not
  // approved" dropped the already-approved main visitor out of visitorCount
  // and total.
  const mainApprovedRaw =
    body.visitorApproved !== undefined ? String(body.visitorApproved) : String(rows[0]!.visitorApproved || '');
  const mainApproved = mainApprovedRaw.trim().toLowerCase() === 'yes';
  // Fall back to the persisted approvals when only the main visitor is being
  // approved, so previously-approved extra visitors keep their fees (and their
  // child discounts) instead of being wiped out of the total.
  const extraVisitorApproved =
    body.extraVisitorApproved !== undefined
      ? String(body.extraVisitorApproved)
      : String(rows[0]!.extraVisitorApproved || '') || undefined;
  const extraVisitorNames = String(rows[0]!.extraVisitorNames || '');
  const mainRelation = String(rows[0]!.relation || '');
  const mainAge = String(rows[0]!.visitorAge || '');

  const { visitorCount, total, adultCount, child5to8Count, childUnder5Count } = computeApprovalTotals(
    mainApproved,
    extraVisitorApproved,
    extraVisitorNames,
    mainRelation,
    mainAge
  );

  const cols: Array<[string, unknown]> = [];
  if (body.visitorApproved !== undefined) cols.push(['visitorApproved', sanitizeStr(body.visitorApproved, 8)]);
  if (body.extraVisitorApproved !== undefined)
    cols.push(['extraVisitorApproved', sanitizeStr(body.extraVisitorApproved, 5000)]);
  cols.push(['visitorCount', visitorCount]);
  cols.push(['total', total]);
  cols.push(['adultCount', adultCount]);
  cols.push(['child5to8Count', child5to8Count]);
  cols.push(['childUnder5Count', childUnder5Count]);

  const mainRejected = body.visitorApproved !== undefined && !mainApproved;
  if (mainRejected) {
    cols.push(['status', 'ไม่อนุมัติ']);
    cols.push(['cancelReason', 'ผู้เยี่ยมหลักถูกปฏิเสธการเข้าร่วม']);
  }

  await updateReservationColumns(env.DB, ref, cols);

  await logEvent(
    env,
    user.username,
    'visitor_approval_updated',
    ref,
    {
      visitorApproved: body.visitorApproved,
      extraVisitorApproved: body.extraVisitorApproved,
      visitorCount,
      total,
      adultCount,
      child5to8Count,
      childUnder5Count,
      affectedRows: rows.length,
    },
    'success'
  );
  if (mainRejected) {
    await logEvent(
      env,
      user.username,
      'visitor_rejected_booking',
      ref,
      { reason: 'ผู้เยี่ยมหลักถูกปฏิเสธการเข้าร่วม', affectedRows: rows.length },
      'success'
    );
  }
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);

  if (mainRejected) {
    await notify(env, {
      ref,
      type: 'visitor_rejected',
      prisonerName: rows[0]?.prisonerName,
      reason: ' ด้วยเหตุผล: ผู้เยี่ยมหลักถูกปฏิเสธการเข้าร่วม',
    }).catch(() => undefined);
  } else if (body.visitorApproved !== undefined) {
    await notify(env, {
      ref,
      type: 'visitor_approved',
      visitorCount,
      total,
    }).catch(() => undefined);
  }
  return { status: 'ok', visitorCount, total, adultCount, child5to8Count, childUnder5Count };
}

export async function handleUpdateBooking(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string; role: string }
): Promise<Record<string, unknown>> {
  if (user.role !== 'Superadmin') {
    return { status: 'error', message: 'เฉพาะ Superadmin เท่านั้นที่สามารถแก้ไขการจองได้' };
  }
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'กรุณาระบุเลขอ้างอิง' };

  const lookup = await resolveRefAnyTable(env, ref);
  const current = lookup.row;
  if (!current) return { status: 'error', message: 'ไม่พบการจองที่ระบุ' };
  const fromArchive = lookup.archived;

  const { cols, changes, errors } = parseUpdateBookingFields(body);
  if (errors.length > 0) return { status: 'error', message: errors.join('; ') };

  // Discipline and duplicate-booking checks guard future visits. An archived
  // row is a historical record, so moving its prisoner/date cannot create a
  // new double-booking and the prisoner's current standing is irrelevant.
  const touchesKeyFields = !fromArchive && (changes.prisonerId !== undefined || changes.visitDateISO !== undefined);
  if (touchesKeyFields) {
    const effPrisonerId =
      changes.prisonerId !== undefined
        ? String(changes.prisonerId || '').trim()
        : String(current.prisonerId || '').trim();
    const effDate =
      changes.visitDateISO !== undefined
        ? normalizeVisitDateISO(changes.visitDateISO)
        : normalizeVisitDateISO(current.visitDateISO);
    const discipline = await getPrisonerDiscipline(env, effPrisonerId);
    if (discipline.restricted) {
      return { status: 'error', message: discipline.message };
    }
    const dupRef = await findDuplicateActive(env, effPrisonerId, effDate, ref);
    if (dupRef !== null) {
      return {
        status: 'error',
        message:
          '⚠️ ไม่สามารถจองได้ — มีการจองผู้ต้องขังหมายเลข "' +
          effPrisonerId +
          '" ในวันนี้อยู่แล้ว' +
          (dupRef ? ' (Ref: ' + dupRef + ')' : ''),
      };
    }
  }

  // Server-authoritative pricing: recompute whenever a pricing input changed
  // or any pricing numeric was supplied, and drop the client-supplied
  // numerics from cols in favor of the authoritative ones.
  const pricingInputs = ['relation', 'visitorAge', 'extraVisitorNames'];
  const pricingNumerics = ['total', 'visitorCount', 'adultCount', 'child5to8Count', 'childUnder5Count', 'totalPersons'];
  const touchedPricingInput = pricingInputs.some((f) => changes[f] !== undefined);
  const suppliedNumeric = pricingNumerics.some((f) => changes[f] !== undefined);
  if (touchedPricingInput || suppliedNumeric) {
    const merged: Record<string, unknown> = { ...current, ...changes };
    const clientTotal =
      merged.total !== undefined && merged.total !== null && merged.total !== '' ? Number(merged.total) : undefined;
    const pricing = applyServerPricing(merged);
    pricingNumerics.forEach((f) => {
      const i = cols.findIndex(([c]) => c === f);
      if (i >= 0) cols.splice(i, 1);
    });
    pricingNumerics.forEach((f) => cols.push([f, merged[f]]));
    if (clientTotal !== undefined && clientTotal !== pricing.serverTotal) {
      await logEvent(
        env,
        user.username,
        'pricing_override',
        ref,
        { clientTotal, serverTotal: pricing.serverTotal },
        'success'
      );
    }
  }

  if (cols.length > 0) {
    cols.push(['updatedAt', new Date().toISOString()]);
    cols.push(['version', Number(current.version || 1) + 1]);
    if (fromArchive) {
      await updateArchivedReservationColumns(env.DB, ref, cols);
    } else {
      await updateReservationColumns(env.DB, ref, cols);
    }
  }

  await logEvent(
    env,
    user.username,
    'update_booking',
    ref,
    { ...changes, ...(fromArchive ? { archived: true } : {}) },
    'success'
  );
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  if (fromArchive) await invalidateArchivedCache(env);
  return { status: 'ok', message: 'แก้ไขการจองสำเร็จ', archived: fromArchive };
}

export async function handleCreateBooking(
  env: Env,
  body: Record<string, unknown>,
  user: AuthenticatedUser
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'create_booking'))) {
    await logEvent(
      env,
      user.username,
      'create_booking_rejected',
      '',
      { reason: 'role_not_allowed', role: user.role },
      'denied'
    );
    return { status: 'error', message: 'Role "' + user.role + '" is not allowed to create bookings' };
  }

  // Mirror handleSaveReservation minus Turnstile: allow the server to assign the ref.
  const payload = { ...body };
  if (!String(payload.ref || '').trim()) payload.ref = '__AUTO__';
  const validation = validateSaveReservation(payload);
  if (!validation.ok) return { status: 'error', message: validation.message };

  const data = validation.data;

  // Server-authoritative pricing (mirrors handleSaveReservation).
  const { clientTotal, serverTotal } = applyServerPricing(data);
  if (clientTotal !== undefined && clientTotal !== serverTotal) {
    await logEvent(
      env,
      user.username,
      'pricing_override',
      String(data.ref || ''),
      { clientTotal, serverTotal },
      'success'
    );
  }

  const newPrisonerId = String(data.prisonerId || '').trim();

  const discipline = await getPrisonerDiscipline(env, newPrisonerId);
  if (discipline.restricted) {
    return { status: 'error', message: discipline.message };
  }

  const dupRef = await findDuplicateActive(env, newPrisonerId, String(data.visitDateISO || ''), null);
  if (dupRef !== null) {
    return {
      status: 'error',
      message:
        '⚠️ ไม่สามารถจองได้ — มีการจองผู้ต้องขังหมายเลข "' +
        newPrisonerId +
        '" ในวันนี้อยู่แล้ว' +
        (dupRef ? ' (Ref: ' + dupRef + ')' : ''),
    };
  }

  const existingRefs = await getAllRefs(env.DB);
  let ref = String(data.ref || '').trim();
  if (!ref || ref === '__AUTO__' || existingRefs.includes(ref)) {
    ref = generateUniqueRefServer(existingRefs);
  }
  data.ref = ref;

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    ...data,
    createdAt: now,
    updatedAt: now,
    version: 1,
    createdBy: user.username,
    source: 'admin',
  };

  await insertReservation(env.DB, row);
  await invalidateReservationsCache(env);
  await invalidatePrisonerLookupCache(env, newPrisonerId);
  await logEvent(
    env,
    user.username,
    'booking_created_admin',
    ref,
    {
      visitorName: data.visitorName,
      prisonerName: data.prisonerName,
      visitDate: data.visitDate,
    },
    'success'
  );
  return { status: 'ok', ref };
}

// ── Bulk booking actions ───────────────────────────────────────────
// The generic `bulk` fan-out in dispatcher.ts can already batch any action,
// but the dashboard's multi-select needs one call per *operation* rather than
// per row — and "approve" is not a fixed status: each row advances from
// wherever it currently sits. This handler resolves that per ref and then
// delegates to the single-row handlers so role checks, transition rules,
// notifications and event logging stay identical to the one-at-a-time path.

/** Same cap as MAX_BULK_ITEMS in dispatcher.ts: bounds the D1 write burst. */
const MAX_BULK_REFS = 50;

/** The single forward step out of each status (mirrors allowedTransitions). */
const NEXT_STATUS: Record<string, string> = {
  รอตรวจสอบผู้เข้าร่วม: 'รอตรวจสอบวินัย',
  รอตรวจสอบวินัย: 'รอชำระเงิน',
  รอชำระเงิน: 'ชำระแล้ว',
  ชำระแล้ว: 'เสร็จสิ้น',
};

const BULK_OPERATIONS = ['approve', 'decline', 'cancel', 'delete'] as const;
type BulkOperation = (typeof BULK_OPERATIONS)[number];

/** Refs may arrive as an array, a JSON-encoded array, or a comma-separated list. */
function parseRefs(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof list === 'string') {
    const text = list.trim();
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch {
        return [];
      }
    } else {
      list = text.split(',');
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const item of list) {
    const ref = sanitizeStr(item, 64);
    if (ref) seen.add(ref);
  }
  return [...seen];
}

/**
 * Apply one operation to many bookings.
 *
 *   POST / { action: 'bulkBookingAction', operation: 'approve',
 *            refs: ['VIS-0001', 'VIS-0002'], reason: '...' }
 *
 * `approve` advances each ref one step along the workflow (a fixed target can
 * be forced with `status`); `decline` sets ไม่อนุมัติ, `cancel` sets ยกเลิก,
 * `delete` hard-deletes (Superadmin only, enforced by handleDeleteBooking).
 *
 * Refs run sequentially — the underlying handlers read-modify-write the same
 * rows and D1 has no cross-statement transaction here. A failing ref never
 * aborts the rest unless `stopOnError` is set; the caller gets a per-ref report
 * plus an overall success / partial / error status.
 */
export async function handleBulkBookingAction(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string; role: string }
): Promise<Record<string, unknown>> {
  const operation = sanitizeStr(body.operation, 20).toLowerCase() as BulkOperation;
  if (!BULK_OPERATIONS.includes(operation)) {
    return { status: 'error', message: 'operation ต้องเป็น ' + BULK_OPERATIONS.join(' / ') };
  }

  const refs = parseRefs(body.refs ?? body.ref);
  if (refs.length === 0) return { status: 'error', message: 'กรุณาระบุเลขอ้างอิงอย่างน้อย 1 รายการ' };
  if (refs.length > MAX_BULK_REFS) {
    return { status: 'error', message: `รับได้สูงสุด ${MAX_BULK_REFS} รายการต่อครั้ง (ส่งมา ${refs.length})` };
  }

  // An explicit target only makes sense for approve; decline/cancel/delete
  // have exactly one meaning.
  const forcedStatus = operation === 'approve' ? sanitizeStr(body.status, 50) : '';
  if (forcedStatus && !VALID_STATUSES.includes(forcedStatus as never)) {
    return { status: 'error', message: 'Invalid status: ' + forcedStatus };
  }

  const stopOnError = body.stopOnError === true || body.stopOnError === 'true';
  const results: Array<{ ref: string; status: 'success' | 'error'; message?: string; newStatus?: string }> = [];
  let succeeded = 0;

  for (const ref of refs) {
    try {
      let result: Record<string, unknown>;
      let newStatus = '';

      if (operation === 'delete') {
        result = await handleDeleteBooking(env, { ref }, user);
      } else {
        if (operation === 'approve') {
          if (forcedStatus) {
            newStatus = forcedStatus;
          } else {
            const rows = await getReservationsByRefs(env.DB, ref);
            if (rows.length === 0) {
              results.push({ ref, status: 'error', message: 'ไม่พบการจองที่ระบุ' });
              if (stopOnError) break;
              continue;
            }
            const current = String(rows[0]!.status || '').trim();
            const next = NEXT_STATUS[current];
            if (!next) {
              results.push({ ref, status: 'error', message: 'สถานะ "' + current + '" ไม่สามารถอนุมัติต่อได้' });
              if (stopOnError) break;
              continue;
            }
            newStatus = next;
          }
        } else {
          newStatus = operation === 'decline' ? 'ไม่อนุมัติ' : 'ยกเลิก';
        }
        result = await handleUpdateStatus(env, { ref, status: newStatus, reason: body.reason }, user);
      }

      if (result.status === 'error') {
        results.push({ ref, status: 'error', message: String(result.message || 'Failed') });
      } else {
        succeeded++;
        results.push({ ref, status: 'success', ...(newStatus ? { newStatus } : {}) });
      }
    } catch (e) {
      console.error('[BulkBookingAction:' + operation + ':' + ref + ']', String(e));
      results.push({ ref, status: 'error', message: 'Server error' });
    }

    if (stopOnError && results[results.length - 1]?.status === 'error') break;
  }

  const failed = results.length - succeeded;
  const status = failed === 0 ? 'success' : succeeded > 0 ? 'partial' : 'error';
  await logEvent(
    env,
    user.username,
    'bulk_booking_' + operation,
    '',
    { requested: refs.length, processed: results.length, succeeded, failed, refs },
    status
  );

  return { status, operation, requested: refs.length, processed: results.length, succeeded, failed, results };
}
