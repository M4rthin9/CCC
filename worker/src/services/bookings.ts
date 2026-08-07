import type { Env, BookingRow, UserRow } from '../types';
import {
  ACTIVE_STATUSES,
  LOOKUP_CACHE_TTL,
  PUBLIC_CACHE_TTL,
  VALID_STATUSES,
  UPDATE_BOOKING_FIELDS,
  UPDATE_BOOKING_NUMERIC,
  UPDATE_BOOKING_CAPS,
} from '../lib/constants';
import {
  sanitizeStr,
  sanitizeInt,
  isValidISODate,
  normalizeVisitDateISO,
  validateSaveReservation,
  maskRowForPublic,
} from '../lib/validate';
import { nowUtc, bangkokNow } from '../lib/dates';
import { getVersioned, putVersioned, kvGetJSON, kvPutJSON, afterWrite, logEvent, checkRateLimit } from '../db/db';
import { hasPermission } from '../auth/guard';
import { resolveSlipImage, uploadSlipToR2 } from './slips';
import { verifyTurnstileToken } from '../router/turnstile';

export type ApiResult =
  | { status: 'ok'; [k: string]: unknown }
  | { status: 'error'; message: string };

export function bookingToRow(b: BookingRow): Record<string, unknown> {
  const row: Record<string, unknown> = {
    ref: b.ref,
    timestamp: b.timestamp,
    visitorName: b.visitor_name || '',
    visitorId: b.visitor_id || '',
    visitorPhone: b.visitor_phone || '',
    relation: b.relation || '',
    religion: b.religion || '',
    allergy: b.allergy || '',
    extraVisitorReligions: b.extra_visitor_religions || '',
    extraVisitorAllergies: b.extra_visitor_allergies || '',
    extraVisitorNames: b.extra_visitor_names || '',
    visitorApproved: b.visitor_approved || '',
    extraVisitorApproved: b.extra_visitor_approved || '',
    prisonerName: b.prisoner_name || '',
    prisonerId: b.prisoner_id,
    wing: b.wing || '',
    visitDate: b.visit_date || '',
    visitDateISO: b.visit_date_iso,
    visitorCount: b.visitor_count ?? 0,
    totalPersons: b.total_persons ?? 0,
    total: b.total ?? 0,
    adultCount: b.adult_count ?? 0,
    child5to8Count: b.child5to8_count ?? 0,
    childUnder5Count: b.child_under5_count ?? 0,
    status: b.status,
    slipImage: resolveSlipImage(b.slip_key),
    cancelReason: b.cancel_reason || '',
  };
  if (b.archived_at) row['archivedAt'] = b.archived_at;
  return row;
}

export async function getActiveRows(env: Env): Promise<Record<string, unknown>[]> {
  const res = await env.DB.prepare('SELECT * FROM bookings WHERE archived_at IS NULL ORDER BY id DESC').all<BookingRow>();
  return (res.results || []).map(bookingToRow);
}

export async function getArchivedRows(env: Env): Promise<Record<string, unknown>[]> {
  const res = await env.DB.prepare('SELECT * FROM bookings WHERE archived_at IS NOT NULL ORDER BY id DESC').all<BookingRow>();
  return (res.results || []).map(bookingToRow);
}

export async function getAllReservations(env: Env): Promise<ApiResult> {
  const rows = await getActiveRows(env);
  return { status: 'ok', rows };
}

export async function getAllReservationsWithArchive(env: Env, includeArchive: boolean): Promise<ApiResult> {
  const active = await getActiveRows(env);
  if (!includeArchive) return { status: 'ok', rows: active };
  const archived = await getArchivedRows(env);
  const activeRefs = new Set(active.map((r) => String(r.ref || '').trim().toUpperCase()));
  const merged = active.slice();
  archived.forEach((r) => {
    const ref = String(r.ref || '').trim();
    if (ref && !activeRefs.has(ref.toUpperCase())) {
      merged.push({ ...r, _archived: true });
    }
  });
  return { status: 'ok', rows: merged };
}

export async function getArchivedReservations(
  env: Env,
  from: string,
  to: string,
): Promise<ApiResult> {
  const fromVal = sanitizeStr(from, 10);
  const toVal = sanitizeStr(to, 10);
  let sql = 'SELECT * FROM bookings WHERE archived_at IS NOT NULL';
  const binds: unknown[] = [];
  if (fromVal || toVal) {
    sql += ' AND visit_date_iso >= ? AND visit_date_iso <= ?';
    binds.push(fromVal || '0000-00-00', toVal || '9999-12-31');
  }
  sql += ' ORDER BY id DESC';
  const res = await env.DB.prepare(sql).bind(...binds).all<BookingRow>();
  return { status: 'ok', rows: (res.results || []).map(bookingToRow) };
}

export async function getCountsByDate(env: Env): Promise<ApiResult> {
  const cached = await getVersioned<Record<string, number>>(env, 'counts', PUBLIC_CACHE_TTL);
  if (cached) return { status: 'ok', counts: cached };
  const res = await env.DB.prepare(
    `SELECT visit_date_iso, COUNT(*) AS c FROM bookings WHERE archived_at IS NULL AND status IN (?, ?, ?, ?, ?) GROUP BY visit_date_iso`,
  )
    .bind(...ACTIVE_STATUSES)
    .all<{ visit_date_iso: string; c: number }>();
  const counts: Record<string, number> = {};
  for (const r of res.results || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.visit_date_iso)) counts[r.visit_date_iso] = r.c;
  }
  await putVersioned(env, 'counts', counts, PUBLIC_CACHE_TTL);
  return { status: 'ok', counts };
}

export async function lookupByRef(
  env: Env,
  params: Record<string, unknown>,
): Promise<ApiResult> {
  const ref = sanitizeStr(params.ref, 64);
  const prisonerId = sanitizeStr(params.prisonerId, 64);
  if (!ref && !prisonerId) return { status: 'error', message: 'Missing ref or prisonerId' };

  const cacheKey = ref
    ? 'lookup:ref:' + ref.trim().toUpperCase()
    : 'lookup:pid:' + prisonerId.trim().toUpperCase();
  const cached = await kvGetJSON<{ rows: Record<string, unknown>[] }>(env, cacheKey);
  if (cached && Array.isArray(cached.rows)) return { status: 'ok', rows: cached.rows };

  let matches: BookingRow[];
  if (ref) {
    const res = await env.DB.prepare('SELECT * FROM bookings WHERE UPPER(ref) = ? AND archived_at IS NULL')
      .bind(ref.toUpperCase())
      .all<BookingRow>();
    matches = res.results || [];
  } else {
    const res = await env.DB.prepare('SELECT * FROM bookings WHERE prisoner_id = ? AND archived_at IS NULL')
      .bind(prisonerId)
      .all<BookingRow>();
    matches = res.results || [];
  }

  if (matches.length === 0) {
    if (ref) {
      const res = await env.DB.prepare('SELECT * FROM bookings WHERE UPPER(ref) = ? AND archived_at IS NOT NULL')
        .bind(ref.toUpperCase())
        .all<BookingRow>();
      matches = res.results || [];
    } else {
      const res = await env.DB.prepare('SELECT * FROM bookings WHERE prisoner_id = ? AND archived_at IS NOT NULL')
        .bind(prisonerId)
        .all<BookingRow>();
      matches = res.results || [];
    }
  }

  const masked = matches.map((b) => maskRowForPublic(bookingToRow(b)));
  await kvPutJSON(env, cacheKey, { rows: masked }, LOOKUP_CACHE_TTL);
  return { status: 'ok', rows: masked };
}

function generateRef(): string {
  return 'VIS-' + Math.floor(10000 + Math.random() * 90000);
}

function duplicateMessage(prisonerId: string, dupRef: string | null): ApiResult {
  return {
    status: 'error',
    message:
      '⚠️ ไม่สามารถจองได้ — มีการจองผู้ต้องขังหมายเลข "' + prisonerId + '" ในวันนี้อยู่แล้ว' +
      (dupRef ? ' (Ref: ' + dupRef + ')' : ''),
  };
}

async function findDupRef(env: Env, prisonerId: string, dateISO: string): Promise<string | null> {
  const res = await env.DB.prepare(
    'SELECT ref FROM bookings WHERE archived_at IS NULL AND prisoner_id = ? AND visit_date_iso = ? AND status IN (?, ?, ?, ?, ?) LIMIT 1',
  )
    .bind(prisonerId, dateISO, ...ACTIVE_STATUSES)
    .first<{ ref: string }>();
  return res ? res.ref : null;
}

export async function saveReservation(
  env: Env,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<ApiResult> {
  const validation = validateSaveReservation(body);
  if (!validation.ok || !validation.data) {
    return { status: 'error', message: validation.message || 'Invalid request body' };
  }
  const data = validation.data;

  if (!(await verifyTurnstileToken(env, String(body.turnstileToken || ''), ip))) {
    return { status: 'error', message: '⚠️ ไม่ผ่านการตรวจสอบความปลอดภัย (Turnstile) — กรุณาลองใหม่อีกครั้ง' };
  }

  const rateKey = 'booking_ip:' + ip;
  if (!(await checkRateLimit(env, rateKey, 10, 300))) {
    return { status: 'error', message: '⚠️ ระบบกำลังรับคำขอจำนวนมาก กรุณารอสักครู่แล้วลองใหม่อีกครั้ง' };
  }

  const prisonerId = String(data.prisonerId || '').trim();
  const targetDate = normalizeVisitDateISO(data.visitDateISO);

  let ref = String(data.ref || '').trim();
  if (!ref) ref = generateRef();

  const now = nowUtc();
  const timestamp = sanitizeStr(data.timestamp, 100) || bangkokNow();

  let slipKey = '';
  const slipImage = data.slipImage !== undefined ? String(data.slipImage) : '';
  if (slipImage) {
    if (slipImage.startsWith('data:image')) {
      try {
        slipKey = await uploadSlipToR2(env, ref, slipImage, '');
      } catch {
        slipKey = 'SLIP_UPLOADED:' + now;
      }
    } else {
      slipKey = sanitizeStr(slipImage, 2000);
    }
  }

  const insertSql = `
    INSERT INTO bookings (
      ref, timestamp, visitor_name, visitor_id, visitor_phone, relation, religion, allergy,
      extra_visitor_religions, extra_visitor_allergies, extra_visitor_names,
      visitor_approved, extra_visitor_approved,
      prisoner_id, prisoner_name, wing, visit_date, visit_date_iso,
      visitor_count, total_persons, total, adult_count, child5to8_count, child_under5_count,
      status, slip_key, cancel_reason, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings
      WHERE archived_at IS NULL AND prisoner_id = ? AND visit_date_iso = ?
        AND status IN (?, ?, ?, ?, ?)
    )
  `;

  const baseBinds: unknown[] = [
    ref,
    timestamp,
    data.visitorName !== undefined ? String(data.visitorName) : '',
    data.visitorId !== undefined ? String(data.visitorId) : '',
    data.visitorPhone !== undefined ? String(data.visitorPhone) : '',
    data.relation !== undefined ? String(data.relation) : '',
    data.religion !== undefined ? String(data.religion) : '',
    data.allergy !== undefined ? String(data.allergy) : '',
    data.extraVisitorReligions !== undefined ? String(data.extraVisitorReligions) : '',
    data.extraVisitorAllergies !== undefined ? String(data.extraVisitorAllergies) : '',
    data.extraVisitorNames !== undefined ? String(data.extraVisitorNames) : '',
    data.visitorApproved !== undefined ? String(data.visitorApproved) : '',
    data.extraVisitorApproved !== undefined ? String(data.extraVisitorApproved) : '',
    prisonerId,
    data.prisonerName !== undefined ? String(data.prisonerName) : '',
    data.wing !== undefined ? String(data.wing) : '',
    data.visitDate !== undefined ? String(data.visitDate) : '',
    targetDate,
    data.visitorCount !== undefined ? Number(data.visitorCount) : 0,
    data.totalPersons !== undefined ? Number(data.totalPersons) : 0,
    data.total !== undefined ? Number(data.total) : 0,
    data.adultCount !== undefined ? Number(data.adultCount) : 0,
    data.child5to8Count !== undefined ? Number(data.child5to8Count) : 0,
    data.childUnder5Count !== undefined ? Number(data.childUnder5Count) : 0,
    data.status !== undefined ? String(data.status) : 'รอตรวจสอบผู้เข้าร่วม',
    slipKey,
    '',
    now,
    now,
    prisonerId,
    targetDate,
    ...ACTIVE_STATUSES,
  ];

  let inserted = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await env.DB.prepare(insertSql).bind(...baseBinds).run();
      if (res.meta.changes === 0) {
        const dupRef = await findDupRef(env, prisonerId, targetDate);
        return duplicateMessage(prisonerId, dupRef);
      }
      inserted = true;
      break;
    } catch (e) {
      const dupRef = await findDupRef(env, prisonerId, targetDate);
      if (dupRef !== null) return duplicateMessage(prisonerId, dupRef);
      if (attempt >= 99) throw e;
      ref = generateRef();
      baseBinds[0] = ref;
    }
  }
  if (!inserted) return { status: 'error', message: 'เกิดข้อผิดพลาดในการบันทึกการจอง' };

  await afterWrite(env, {
    ref,
    prisonerId,
    event: { type: 'booking_created', ref, at: now },
    log: {
      username: 'public',
      action: 'booking_submitted',
      targetRef: ref,
      details: {
        visitorName: data.visitorName !== undefined ? String(data.visitorName) : '',
        prisonerName: data.prisonerName !== undefined ? String(data.prisonerName) : '',
        visitDate: data.visitDate !== undefined ? String(data.visitDate) : '',
      },
      result: 'success',
      ip,
      userAgent,
    },
  });

  return { status: 'ok', ref };
}

async function findActiveByRef(env: Env, ref: string): Promise<BookingRow[]> {
  const res = await env.DB.prepare('SELECT * FROM bookings WHERE ref = ? AND archived_at IS NULL').bind(ref).all<BookingRow>();
  return res.results || [];
}

export async function cancelBooking(
  env: Env,
  user: UserRow | null,
  ref: string,
  reason: string,
  isPublic: boolean,
  ip: string,
  userAgent: string,
): Promise<ApiResult> {
  const rows = await findActiveByRef(env, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };
  const prevStatus = rows[0].status;
  const cancelReason = isPublic ? '' : sanitizeStr(reason, 2000);
  await env.DB.prepare(
    'UPDATE bookings SET status = ?, cancel_reason = ?, updated_at = ? WHERE ref = ? AND archived_at IS NULL',
  )
    .bind('ยกเลิก', cancelReason, nowUtc(), ref)
    .run();
  const affectedRows = rows.length;
  await afterWrite(env, {
    ref,
    prisonerId: rows[0].prisoner_id,
    event: { type: 'booking_cancelled', ref, at: nowUtc() },
    log: {
      username: isPublic ? 'public' : user?.username || 'system',
      action: 'booking_cancelled',
      targetRef: ref,
      details: { previousStatus: prevStatus, affectedRows },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok' };
}

export async function updateStatus(
  env: Env,
  user: UserRow,
  ref: string,
  status: string,
  reason: string,
  ip: string,
  userAgent: string,
): Promise<ApiResult> {
  const refVal = sanitizeStr(ref, 64);
  const statusVal = sanitizeStr(status, 50);
  if (!refVal || !statusVal) return { status: 'error', message: 'Missing ref or status' };
  if (!VALID_STATUSES.includes(statusVal as (typeof VALID_STATUSES)[number])) {
    return { status: 'error', message: 'Invalid status: ' + statusVal };
  }

  const roleAllowedStatuses: Record<string, string[] | null> = {
    Superadmin: null,
    Admin: null,
    Tadtel: ['รอตรวจสอบวินัย', 'ไม่อนุมัติ'],
    Vinai: ['รอชำระเงิน', 'ไม่อนุมัติ', 'ยกเลิก'],
    Finance: ['ชำระแล้ว', 'เสร็จสิ้น', 'ไม่อนุมัติ'],
  };

  const callerRole = user.role;
  let effectiveAllowed = roleAllowedStatuses[callerRole];
  if (effectiveAllowed === undefined) {
    const dynamicAllowed: string[] = [];
    if (await hasPermission(env, user, 'approve_participant')) dynamicAllowed.push('รอตรวจสอบวินัย', 'ไม่อนุมัติ');
    if (await hasPermission(env, user, 'approve_discipline')) dynamicAllowed.push('รอชำระเงิน', 'ไม่อนุมัติ', 'ยกเลิก');
    if (await hasPermission(env, user, 'confirm_payment')) dynamicAllowed.push('ชำระแล้ว', 'เสร็จสิ้น', 'ไม่อนุมัติ');
    if (await hasPermission(env, user, 'cancel')) dynamicAllowed.push('ยกเลิก');
    effectiveAllowed = dynamicAllowed.length > 0 ? [...new Set(dynamicAllowed)] : [];
  }

  const canFreeRejectCancel =
    ['Superadmin', 'Admin', 'Vinai'].includes(callerRole) || (await hasPermission(env, user, 'cancel'));

  if (effectiveAllowed !== null && effectiveAllowed !== undefined && !effectiveAllowed.includes(statusVal)) {
    await logEvent(env, {
      username: user.username,
      action: 'status_change_rejected',
      targetRef: refVal,
      details: { newStatus: statusVal, reason: 'role_not_allowed', role: callerRole },
      result: 'denied',
      ip,
      userAgent,
    });
    return {
      status: 'error',
      message: 'Role "' + callerRole + '" is not allowed to set status "' + statusVal + '"',
    };
  }

  const rows = await findActiveByRef(env, refVal);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  const allowedTransitions: Record<string, string[]> = {
    'รอตรวจสอบผู้เข้าร่วม': ['รอตรวจสอบวินัย', 'ไม่อนุมัติ', 'ยกเลิก'],
    'รอตรวจสอบวินัย': ['รอชำระเงิน', 'ไม่อนุมัติ', 'ยกเลิก'],
    'รอชำระเงิน': ['ชำระแล้ว', 'ยกเลิก'],
    'ชำระแล้ว': ['เสร็จสิ้น', 'ยกเลิก'],
    'เสร็จสิ้น': [],
    'ไม่อนุมัติ': [],
    'ยกเลิก': [],
  };

  let rejected: { oldStatus: string; newStatus: string } | null = null;
  let allAlreadyAtTarget = true;
  for (const row of rows) {
    const oldStatus = String(row.status || '').trim();
    if (oldStatus === statusVal) continue;
    allAlreadyAtTarget = false;
    let allowed = allowedTransitions[oldStatus];
    if (canFreeRejectCancel && (statusVal === 'ไม่อนุมัติ' || statusVal === 'ยกเลิก')) {
      allowed = ['ไม่อนุมัติ', 'ยกเลิก'];
    }
    if (allowed && !allowed.includes(statusVal) && !rejected) {
      rejected = { oldStatus, newStatus: statusVal };
    }
  }

  if (allAlreadyAtTarget) {
    await logEvent(env, {
      username: user.username,
      action: 'status_change_noop',
      targetRef: refVal,
      details: { status: statusVal, reason: 'already_at_target' },
      result: 'success',
      ip,
      userAgent,
    });
    return { status: 'ok', noop: true };
  }
  if (rejected) {
    await logEvent(env, {
      username: user.username,
      action: 'status_change_rejected',
      targetRef: refVal,
      details: { oldStatus: rejected.oldStatus, newStatus: rejected.newStatus, reason: 'invalid_transition' },
      result: 'denied',
      ip,
      userAgent,
    });
    return {
      status: 'error',
      message: 'Cannot change from "' + rejected.oldStatus + '" to "' + rejected.newStatus + '"',
    };
  }

  const cancelReason = reason && (statusVal === 'ไม่อนุมัติ' || statusVal === 'ยกเลิก') ? sanitizeStr(reason, 2000) : '';
  await env.DB.prepare(
    'UPDATE bookings SET status = ?, cancel_reason = ?, updated_at = ? WHERE ref = ? AND archived_at IS NULL',
  )
    .bind(statusVal, cancelReason, nowUtc(), refVal)
    .run();

  await afterWrite(env, {
    ref: refVal,
    prisonerId: rows[0].prisoner_id,
    event: { type: 'status_changed', ref: refVal, at: nowUtc() },
    log: {
      username: user.username,
      action: 'status_changed',
      targetRef: refVal,
      details: { newStatus: statusVal, affectedRows: rows.length },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok' };
}

export async function updateVisitorApproval(
  env: Env,
  user: UserRow,
  ref: string,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<ApiResult> {
  const refVal = sanitizeStr(ref, 64);
  if (!refVal) return { status: 'error', message: 'Missing ref' };
  const rows = await findActiveByRef(env, refVal);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };
  const row = rows[0];

  const mainApproved = String(body.visitorApproved || '').trim().toLowerCase() === 'yes' ? 1 : 0;
  let correctTotal = 2000;
  let extraYesCount = 0;

  if (body.extraVisitorApproved) {
    const allApprovals = String(body.extraVisitorApproved).split(';;');
    extraYesCount = allApprovals.filter((v) => (v || '').trim().toLowerCase() === 'yes').length;
    const raw = row.extra_visitor_names || '';
    if (raw.includes(';;')) {
      const extras = raw
        .split(';;')
        .map((e) => {
          const p = e.split('|');
          return { name: (p[0] || '').trim(), id: (p[1] || '').trim(), relation: (p[2] || '').trim(), age: (p[3] || '').trim() };
        })
        .filter((e) => e.name);
      let extraFeeSum = 0;
      extras.forEach((v, idx) => {
        if ((allApprovals[idx] || '').trim().toLowerCase() === 'yes') {
          let fee = 1000;
          if (v.relation === 'บุตร / ธิดา') {
            const a = parseInt(v.age, 10);
            if (!isNaN(a) && a < 5) fee = 0;
            else if (!isNaN(a) && a <= 8) fee = 500;
          }
          extraFeeSum += fee;
        }
      });
      correctTotal += extraFeeSum;
    } else {
      correctTotal += extraYesCount * 1000;
    }
  }

  const correctVisitorCount = mainApproved + extraYesCount;
  const visitorApprovedVal = body.visitorApproved !== undefined ? sanitizeStr(body.visitorApproved, 8) : row.visitor_approved || '';
  const extraApprovedVal =
    body.extraVisitorApproved !== undefined ? sanitizeStr(body.extraVisitorApproved, 5000) : row.extra_visitor_approved || '';

  await env.DB.prepare(
    'UPDATE bookings SET visitor_approved = ?, extra_visitor_approved = ?, visitor_count = ?, total = ?, updated_at = ? WHERE ref = ? AND archived_at IS NULL',
  )
    .bind(visitorApprovedVal, extraApprovedVal, correctVisitorCount, correctTotal, nowUtc(), refVal)
    .run();

  await afterWrite(env, {
    ref: refVal,
    prisonerId: row.prisoner_id,
    event: { type: 'approval_updated', ref: refVal, at: nowUtc() },
    log: {
      username: user.username,
      action: 'visitor_approval_updated',
      targetRef: refVal,
      details: {
        visitorApproved: body.visitorApproved !== undefined ? body.visitorApproved : '',
        extraVisitorApproved: body.extraVisitorApproved !== undefined ? body.extraVisitorApproved : '',
        visitorCount: correctVisitorCount,
        total: correctTotal,
        affectedRows: rows.length,
      },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok', visitorCount: correctVisitorCount, total: correctTotal };
}

export async function updateSlipAndStatus(
  env: Env,
  user: UserRow | null,
  ref: string,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<ApiResult> {
  const refVal = sanitizeStr(ref, 64);
  const rows = await findActiveByRef(env, refVal);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };
  const row = rows[0];

  // Hardening (deliberate deviation from GAS): only 'ชำระแล้ว' is accepted.
  let status = 'ชำระแล้ว';
  if (body.status !== undefined && body.status !== '') {
    const s = sanitizeStr(body.status, 50);
    if (s !== 'ชำระแล้ว') return { status: 'error', message: 'Invalid status: ' + s };
    status = s;
  }

  let slipKey = row.slip_key || '';
  if (body.slipImage) {
    const slipVal = String(body.slipImage);
    if (slipVal.startsWith('data:image')) {
      try {
        slipKey = await uploadSlipToR2(env, refVal, slipVal, '');
      } catch {
        slipKey = 'SLIP_UPLOADED:' + new Date().toISOString();
      }
    } else {
      slipKey = sanitizeStr(slipVal, 2000);
    }
  }

  await env.DB.prepare(
    'UPDATE bookings SET status = ?, slip_key = ?, updated_at = ? WHERE ref = ? AND archived_at IS NULL',
  )
    .bind(status, slipKey, nowUtc(), refVal)
    .run();

  await afterWrite(env, {
    ref: refVal,
    prisonerId: row.prisoner_id,
    event: { type: 'slip_updated', ref: refVal, at: nowUtc() },
    log: {
      username: user?.username || 'public',
      action: 'slip_and_status_updated',
      targetRef: refVal,
      details: { status },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok' };
}

export async function updateBooking(
  env: Env,
  user: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<ApiResult> {
  if (user.role !== 'Superadmin') {
    return { status: 'error', message: 'เฉพาะ Superadmin เท่านั้นที่สามารถแก้ไขการจองได้' };
  }
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'กรุณาระบุเลขอ้างอิง' };

  const rows = await findActiveByRef(env, ref);
  if (rows.length === 0) return { status: 'error', message: 'ไม่พบการจองที่ระบุ' };
  const row = rows[0];

  const changes: Record<string, unknown> = {};
  const errors: string[] = [];
  UPDATE_BOOKING_FIELDS.forEach((field) => {
    if (body[field] === undefined) return;
    let value: unknown;
    if (UPDATE_BOOKING_NUMERIC.includes(field)) {
      value = sanitizeInt(body[field], 0);
    } else if (field === 'visitDateISO') {
      const s = sanitizeStr(body[field], 10);
      if (s && !isValidISODate(s)) {
        errors.push('รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)');
        return;
      }
      value = s;
    } else if (field === 'status') {
      const s = sanitizeStr(body[field], 50);
      if (!VALID_STATUSES.includes(s as (typeof VALID_STATUSES)[number])) {
        errors.push('สถานะไม่ถูกต้อง: ' + s);
        return;
      }
      value = s;
    } else {
      value = sanitizeStr(body[field], UPDATE_BOOKING_CAPS[field] || 1000);
    }
    changes[field] = value;
  });
  if (errors.length > 0) return { status: 'error', message: errors.join('; ') };

  const touchesKeyFields = changes.prisonerId !== undefined || changes.visitDateISO !== undefined;
  if (touchesKeyFields) {
    const currentPrisonerId = String(row.prisoner_id || '').trim();
    const currentDate = normalizeVisitDateISO(row.visit_date_iso);
    const effPrisonerId = changes.prisonerId !== undefined ? String(changes.prisonerId || '').trim() : currentPrisonerId;
    const effDate = changes.visitDateISO !== undefined ? normalizeVisitDateISO(changes.visitDateISO) : currentDate;
    if (effPrisonerId && effDate) {
      const dup = await env.DB.prepare(
        'SELECT ref FROM bookings WHERE archived_at IS NULL AND prisoner_id = ? AND visit_date_iso = ? AND id != ? AND status IN (?, ?, ?, ?, ?) LIMIT 1',
      )
        .bind(effPrisonerId, effDate, row.id, ...ACTIVE_STATUSES)
        .first<{ ref: string }>();
      if (dup) return duplicateMessage(effPrisonerId, dup.ref);
    }
  }

  const setCols: string[] = [];
  const binds: unknown[] = [];
  const colMap: Record<string, string> = {
    visitorName: 'visitor_name',
    visitorPhone: 'visitor_phone',
    visitorId: 'visitor_id',
    relation: 'relation',
    religion: 'religion',
    allergy: 'allergy',
    prisonerName: 'prisoner_name',
    prisonerId: 'prisoner_id',
    wing: 'wing',
    visitDate: 'visit_date',
    visitDateISO: 'visit_date_iso',
    visitorCount: 'visitor_count',
    total: 'total',
    status: 'status',
    extraVisitorNames: 'extra_visitor_names',
    extraVisitorReligions: 'extra_visitor_religions',
    extraVisitorAllergies: 'extra_visitor_allergies',
    extraVisitorApproved: 'extra_visitor_approved',
  };
  for (const field of Object.keys(changes)) {
    const col = colMap[field];
    if (!col) continue;
    setCols.push(col + ' = ?');
    binds.push(changes[field] as never);
  }

  if (setCols.length > 0) {
    const fullBinds: unknown[] = [...binds, nowUtc(), row.id];
    await env.DB.prepare('UPDATE bookings SET ' + setCols.join(', ') + ', updated_at = ? WHERE id = ?')
      .bind(...fullBinds)
      .run();
  }

  await afterWrite(env, {
    ref,
    prisonerId: row.prisoner_id,
    event: { type: 'booking_updated', ref, at: nowUtc() },
    log: {
      username: user.username,
      action: 'update_booking',
      targetRef: ref,
      details: changes,
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok', message: 'แก้ไขการจองสำเร็จ' };
}

export async function dedupeReservations(
  env: Env,
  user: UserRow,
  ip: string,
  userAgent: string,
): Promise<ApiResult> {
  if (!(await hasPermission(env, user, 'manage_users')) && !(await hasPermission(env, user, 'approve'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการนี้' };
  }
  const dupRefs = await env.DB.prepare(
    'SELECT ref FROM bookings WHERE archived_at IS NULL GROUP BY ref HAVING COUNT(*) > 1',
  ).all<{ ref: string }>();
  const refs = dupRefs.results || [];
  if (refs.length === 0) {
    return { status: 'ok', removed: 0, message: 'ไม่พบเลขอ้างอิงซ้ำในชีต' };
  }
  let removed = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const r of refs) {
    stmts.push(
      env.DB.prepare(
        'DELETE FROM bookings WHERE ref = ? AND archived_at IS NULL AND id NOT IN (SELECT MIN(id) FROM bookings WHERE ref = ?)',
      ).bind(r.ref, r.ref),
    );
  }
  const results = await env.DB.batch(stmts);
  for (const res of results) removed += res.meta.changes || 0;

  await afterWrite(env, {
    ref: null,
    prisonerId: null,
    event: { type: 'dedupe', at: nowUtc() },
    log: {
      username: user.username,
      action: 'dedupe_reservations',
      targetRef: '',
      details: { removed },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok', removed, message: 'ลบการจองซ้ำ ' + removed + ' แถว' };
}

export async function findDuplicateBookings(
  env: Env,
  user: UserRow,
): Promise<ApiResult> {
  if (!(await hasPermission(env, user, 'manage_users')) && !(await hasPermission(env, user, 'approve'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการนี้' };
  }
  const res = await env.DB.prepare(
    'SELECT id, ref, prisoner_id, visit_date_iso, visitor_name, status FROM bookings WHERE archived_at IS NULL',
  ).all<{ id: number; ref: string; prisoner_id: string; visit_date_iso: string; visitor_name: string | null; status: string }>();
  const groups = new Map<string, { prisonerId: string; visitDateISO: string; rows: { row: number; ref: string; visitorName: string }[] }>();
  for (const row of res.results || []) {
    if (!isActiveReservationStatusFor(row.status)) continue;
    const prisonerId = String(row.prisoner_id || '').trim();
    const visitDateISO = normalizeVisitDateISO(row.visit_date_iso);
    if (!prisonerId || !visitDateISO) continue;
    const key = prisonerId + '\u0001' + visitDateISO;
    let group = groups.get(key);
    if (!group) {
      group = { prisonerId, visitDateISO, rows: [] };
      groups.set(key, group);
    }
    group.rows.push({
      row: row.id,
      ref: String(row.ref || '').trim(),
      visitorName: String(row.visitor_name || '').trim(),
    });
  }
  const duplicates = Array.from(groups.values()).filter((g) => g.rows.length > 1);
  return { status: 'ok', count: duplicates.length, duplicates };
}

function isActiveReservationStatusFor(status: unknown): boolean {
  return ACTIVE_STATUSES.includes(String(status || '').trim());
}
