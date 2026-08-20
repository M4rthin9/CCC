import { PUBLIC_CACHE_TTL, VALID_STATUSES, ACTIVE_STATUSES } from '../constants';
import { sanitizeStr, normalizeVisitDateISO, formatDateISO } from '../config';
import { cacheKeyArchived, cacheKeyCounts, cacheKeyReservations } from '../cache/keys';
import { cacheGetLarge, cachePutLarge, cacheRemove } from '../cache/kv';
import { cacheGetVersioned, cachePutVersioned } from '../cache/versioned';
import {
  getActiveReservations,
  getArchivedReservations,
  getReservationsByRefs,
  updateReservationColumns,
  insertReservation,
  countReservationsByDate,
  getAllRefs,
  deleteReservation,
} from '../db/queries/reservations';
import { deleteNotesByRef } from '../db/queries/notes';
import { deleteNotificationDataByRef } from '../db/queries/notifications';
import { hasPermission } from '../db/queries/roles';
import {
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
  const { hit, version } = await cacheGetVersioned<Reservation[]>(env, key, 'reservations');
  if (Array.isArray(hit)) return { status: 'ok', rows: hit };

  const rows = await getActiveReservations(env.DB);
  await cachePutVersioned(env, key, version, rows, PUBLIC_CACHE_TTL);
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
  const cached = await cacheGetLarge(env.CACHE_KV, key);
  let rows: Reservation[] | null = null;
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      await cacheRemove(env.CACHE_KV, key).catch(() => undefined);
    }
  }
  if (rows === null) {
    rows = await getArchivedReservations(env.DB);
    await cachePutLarge(env.CACHE_KV, key, JSON.stringify(rows), 21600);
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
  const { hit, version } = await cacheGetVersioned<Record<string, number>>(env, countsKey, 'reservations');
  if (hit) return { status: 'ok', counts: hit };

  const counts = await countReservationsByDate(env.DB);
  await cachePutVersioned(env, countsKey, version, counts, PUBLIC_CACHE_TTL);
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
 * from `reservations` along with every side row that points at its ref (nothing
 * in the schema cascades). The only trace left is the event_log entry below,
 * which carries a snapshot of what was deleted.
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

  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'ไม่พบการจองที่ระบุ' };

  const row = rows[0]!;
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
    affectedRows: rows.length,
  };

  await deleteNotesByRef(env.DB, ref);
  await deleteNotificationDataByRef(env.DB, ref);
  await deleteReservation(env.DB, ref);

  await logEvent(env, user.username, 'booking_deleted', ref, snapshot, 'success');
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  if (snapshot.prisonerId) await invalidatePrisonerLookupCache(env, snapshot.prisonerId);

  return { status: 'ok', message: 'ลบการจองเรียบร้อย' };
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

  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  if (status === 'ไม่อนุมัติ' || status === 'ยกเลิก') {
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
  await updateReservationColumns(env.DB, ref, cols);

  await logEvent(
    env,
    user.username,
    'status_changed',
    ref,
    { newStatus: status, affectedRows: rows.length },
    'success'
  );
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);

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

  const mainApproved =
    String(body.visitorApproved || '')
      .toString()
      .trim()
      .toLowerCase() === 'yes';
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

  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'ไม่พบการจองที่ระบุ' };

  const { cols, changes, errors } = parseUpdateBookingFields(body);
  if (errors.length > 0) return { status: 'error', message: errors.join('; ') };

  const touchesKeyFields = changes.prisonerId !== undefined || changes.visitDateISO !== undefined;
  if (touchesKeyFields) {
    const current = rows[0]!;
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
    const merged: Record<string, unknown> = { ...rows[0]!, ...changes };
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
    cols.push(['version', Number(rows[0]!.version || 1) + 1]);
    await updateReservationColumns(env.DB, ref, cols);
  }

  await logEvent(env, user.username, 'update_booking', ref, changes, 'success');
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  return { status: 'ok', message: 'แก้ไขการจองสำเร็จ' };
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
