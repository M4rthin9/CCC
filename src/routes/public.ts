import { PUBLIC_LOOKUP_FIELDS, LOOKUP_CACHE_TTL } from '../constants';
import { sanitizeStr } from '../config';
import { lookupCacheKey } from '../cache/keys';
import { d1CacheGet, d1CachePut, d1CacheRemove } from '../cache/d1Cache';
import {
  getActiveReservations,
  getArchivedReservations,
  getReservationsByPrisonerId,
  insertReservation,
  deleteReservation,
  countActiveTableBookings,
  getAllRefs,
} from '../db/queries/reservations';
import { verifyTurnstileToken } from '../middleware/turnstile';
import { invalidatePrisonerLookupCache, invalidateReservationsCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import {
  validateSaveReservation,
  validateSaveTableReservation,
  generateUniqueRefServer,
  findDuplicateActive,
} from '../services/reservationService';
import { checkTableCapacity, dayFullMessage, getTableBookingConfig, holdExpiryFrom } from '../services/tableCapacity';
import { BOOKING_TYPE_PRISONER, BOOKING_TYPE_TABLE, TABLE_REF_PREFIX } from '../constants';
import { normalizeVisitDateISO } from '../config';
import { applyServerPricing } from '../services/pricing';
import { getPrisonerDiscipline } from '../services/disciplineService';
import { notify } from '../services/notifications';
import { Env, Reservation } from '../types';

export async function handlePing(): Promise<Record<string, unknown>> {
  return { status: 'ok', pong: true, timestamp: new Date().toISOString() };
}

export function handleGetBackendUrl(request: Request): Record<string, unknown> {
  const url = new URL(request.url);
  return { url: url.origin };
}

export function handleResolveUrl(request: Request): Record<string, unknown> {
  const url = new URL(request.url);
  return {
    status: 'ok',
    url: url.origin,
    resolvedUrl: url.origin,
    message: 'resolveUrl endpoint reached successfully',
  };
}

export async function handleTestConnection(env: Env): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { status: 'ok', message: 'Connected', timestamp: new Date().toISOString() };
  try {
    const info = await env.DB.prepare('SELECT COUNT(*) as c FROM reservations').first<{ c: number }>();
    result.database = 'D1 (SQLite)';
    result.reservationCount = info?.c ?? 0;
  } catch (e) {
    result.databaseError = String(e);
    result.message = 'Connected to worker, but database unavailable';
  }
  return result;
}

export async function handleGetSheetInfo(env: Env): Promise<Record<string, unknown>> {
  try {
    const tables = [
      'reservations',
      'reservations_archive',
      'prisoners',
      'users',
      'roles',
      'event_log',
      'notes',
      'settings',
    ];
    const allTables: Array<{ name: string; rows: number }> = [];
    for (const t of tables) {
      const r = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${t}`).first<{ c: number }>();
      allTables.push({ name: t, rows: r ? Number(r.c) : 0 });
    }
    const sample = await getActiveReservations(env.DB);
    return {
      status: 'ok',
      databaseName: 'ccc-reservations',
      allTables,
      mainSheet: {
        name: 'reservations',
        totalRows: allTables.find((t) => t.name === 'reservations')?.rows ?? 0,
        headers: Object.keys(sample[0] ?? {}),
        sampleRow: sample[0] ?? {},
      },
    };
  } catch (e) {
    return { status: 'error', message: 'Failed to get sheet info: ' + String(e) };
  }
}

export async function handleSaveReservation(
  env: Env,
  body: Record<string, unknown>,
  meta: { ip: string; userAgent: string }
): Promise<Record<string, unknown>> {
  const validation = validateSaveReservation(body);
  if (!validation.ok) return { status: 'error', message: validation.message };

  // Turnstile gate (public booking path only). Fail closed on bad/missing token.
  const remoteIp = sanitizeStr(body.ip, 64) || meta.ip || undefined;
  if (!(await verifyTurnstileToken(env, body.turnstileToken, remoteIp))) {
    return { status: 'error', message: '⚠️ ไม่ผ่านการตรวจสอบความปลอดภัย (Turnstile) — กรุณาลองใหม่อีกครั้ง' };
  }

  const data = validation.data;

  // Server-authoritative pricing: never trust client-submitted totals/counts.
  const { clientTotal, serverTotal } = applyServerPricing(data);
  if (clientTotal !== undefined && clientTotal !== serverTotal) {
    await logEvent(
      env,
      'public',
      'pricing_override',
      String(data.ref || ''),
      { clientTotal, serverTotal },
      'success',
      meta
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
  if (!ref || existingRefs.includes(ref)) {
    ref = generateUniqueRefServer(existingRefs);
  }
  data.ref = ref;

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    ...data,
    // insertReservation writes '' for any column it is not given, so the D1
    // DEFAULT never applies — state the type explicitly.
    bookingType: BOOKING_TYPE_PRISONER,
    createdAt: now,
    updatedAt: now,
    version: 1,
    createdBy: 'public',
  };

  await insertReservation(env.DB, row);
  await invalidateReservationsCache(env);
  await invalidatePrisonerLookupCache(env, newPrisonerId);
  await logEvent(
    env,
    'public',
    'booking_submitted',
    ref,
    {
      visitorName: data.visitorName,
      prisonerName: data.prisonerName,
      visitDate: data.visitDate,
    },
    'success',
    meta
  );
  await notify(env, {
    ref,
    type: 'booking_submitted',
    prisonerName: data.prisonerName,
    visitDate: data.visitDate,
    total: data.total,
    status: data.status,
  }).catch(() => undefined);
  return { status: 'ok', ref };
}

/**
 * Public no-prisoner "table" booking.
 *
 * Deliberately mirrors handleSaveReservation so the two read side by side, with
 * the prisoner-specific stages removed: there is no prisoner, so the discipline
 * check and the one-booking-per-prisoner-per-day guard have nothing to act on.
 * The flow is therefore book → pay → staff confirm the payment, and the booking
 * is created directly in 'รอชำระเงิน'.
 *
 * In exchange it gains the one rule the visit flow does not have: a hard cap of
 * N tables per visit date, held for a limited time while the visitor pays.
 */
export async function handleSaveTableReservation(
  env: Env,
  body: Record<string, unknown>,
  meta: { ip: string; userAgent: string }
): Promise<Record<string, unknown>> {
  const config = await getTableBookingConfig(env);
  if (!config.enabled) {
    return { status: 'error', message: '⚠️ ขณะนี้ปิดรับจองโต๊ะชั่วคราว กรุณาลองใหม่อีกครั้งภายหลัง' };
  }

  // Unlike the legacy visit flow (whose frontend mints its own ref), a table
  // booking lets the server assign it — same '__AUTO__' sentinel handleCreateBooking uses.
  const payload = { ...body };
  if (!String(payload.ref || '').trim()) payload.ref = '__AUTO__';
  const validation = validateSaveTableReservation(payload);
  if (!validation.ok) return { status: 'error', message: validation.message };

  // Turnstile gate (public booking path only). Fail closed on bad/missing token.
  const remoteIp = sanitizeStr(body.ip, 64) || meta.ip || undefined;
  if (!(await verifyTurnstileToken(env, body.turnstileToken, remoteIp))) {
    return { status: 'error', message: '⚠️ ไม่ผ่านการตรวจสอบความปลอดภัย (Turnstile) — กรุณาลองใหม่อีกครั้ง' };
  }

  const data = validation.data;

  const visitDateISO = normalizeVisitDateISO(data.visitDateISO);
  if (!visitDateISO) return { status: 'error', message: 'กรุณาเลือกวันที่เข้าใช้บริการ' };
  data.visitDateISO = visitDateISO;

  // Server-authoritative pricing: same age ladder as a visit booking, minus the
  // prisoner fee — there is no prisoner on this booking.
  const { clientTotal, serverTotal } = applyServerPricing(data, { includePrisonerFee: false });
  if (clientTotal !== undefined && clientTotal !== serverTotal) {
    await logEvent(
      env,
      'public',
      'pricing_override',
      String(data.ref || ''),
      { clientTotal, serverTotal },
      'success',
      meta
    );
  }

  const now = new Date().toISOString();
  const capacity = await checkTableCapacity(env, visitDateISO, config.perDay, now);
  if (!capacity.ok) {
    return { status: 'error', message: dayFullMessage(config.perDay), full: true, used: capacity.used };
  }

  const existingRefs = await getAllRefs(env.DB);
  let ref = String(data.ref || '').trim();
  if (!ref || ref === '__AUTO__' || existingRefs.includes(ref)) {
    ref = generateUniqueRefServer(existingRefs, TABLE_REF_PREFIX);
  }
  data.ref = ref;

  const row: Record<string, unknown> = {
    ...data,
    bookingType: BOOKING_TYPE_TABLE,
    holdExpiresAt: holdExpiryFrom(now, config.holdMinutes),
    createdAt: now,
    updatedAt: now,
    version: 1,
    createdBy: 'public',
    source: 'public-table',
  };

  await insertReservation(env.DB, row);

  // D1 gives us no transaction across the count and the insert, so two requests
  // can both see the last free slot. Re-count afterwards and roll our own row
  // back if we went over — cheap, and it closes the double-submit window.
  const after = await countActiveTableBookings(env.DB, visitDateISO, now);
  if (after > config.perDay) {
    await deleteReservation(env.DB, ref).catch(() => undefined);
    await logEvent(env, 'public', 'table_booking_overbooked', ref, { visitDateISO, used: after }, 'denied', meta);
    return { status: 'error', message: dayFullMessage(config.perDay), full: true, used: config.perDay };
  }

  await invalidateReservationsCache(env);
  await logEvent(
    env,
    'public',
    'table_booking_submitted',
    ref,
    { visitorName: data.visitorName, visitDate: data.visitDate, total: data.total },
    'success',
    meta
  );
  // Payment is the immediate next step, so tell the visitor to pay rather than
  // just acknowledging the submission.
  await notify(env, {
    ref,
    type: 'payment_due',
    visitDate: data.visitDate,
    total: data.total,
    status: data.status,
  }).catch(() => undefined);

  return { status: 'ok', ref, holdExpiresAt: row.holdExpiresAt, holdMinutes: config.holdMinutes };
}

function maskRowForPublic(row: Reservation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  PUBLIC_LOOKUP_FIELDS.forEach((k) => {
    const v = (row as Record<string, unknown>)[k];
    if (v === undefined || v === null || String(v) === '') return;
    if (k === 'extraVisitorNames') {
      out[k] = String(v)
        .split(';;')
        .map((part) => {
          const p = part.split('|');
          return (p[0] || '').trim();
        })
        .filter((n) => n)
        .join(';;');
    } else {
      out[k] = v;
    }
  });
  return out;
}

export async function handleLookupByRef(env: Env, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(params.ref, 64);
  const prisonerId = sanitizeStr(params.prisonerId, 64);
  if (!ref && !prisonerId) return { status: 'error', message: 'Missing ref or prisonerId' };

  const cacheKey = lookupCacheKey(env, ref, prisonerId);
  const cached = await d1CacheGet<string>(env.DB, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.rows)) return { status: 'ok', rows: parsed.rows };
    } catch {
      await d1CacheRemove(env.DB, cacheKey).catch(() => undefined);
    }
  }

  let matches: Reservation[];
  if (ref) {
    const active = await getActiveReservations(env.DB);
    matches = active.filter((r) => String(r.ref).toUpperCase() === ref.toUpperCase());
  } else {
    matches = await getReservationsByPrisonerId(env.DB, prisonerId);
  }

  if (matches.length === 0) {
    const archived = await getArchivedReservations(env.DB);
    if (ref) matches = archived.filter((r) => String(r.ref).toUpperCase() === ref.toUpperCase());
    else matches = archived.filter((r) => String(r.prisonerId).trim() === prisonerId);
  }

  const masked = matches.map(maskRowForPublic);
  await d1CachePut(env.DB, cacheKey, JSON.stringify({ rows: masked }), LOOKUP_CACHE_TTL);
  return { status: 'ok', rows: masked };
}
