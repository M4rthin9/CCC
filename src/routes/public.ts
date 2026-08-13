import { PUBLIC_LOOKUP_FIELDS, LOOKUP_CACHE_TTL } from '../constants';
import { sanitizeStr } from '../config';
import { lookupCacheKey } from '../cache/keys';
import { cacheGet, cachePut, cacheRemove } from '../cache/kv';
import {
  getActiveReservations,
  getArchivedReservations,
  getReservationsByPrisonerId,
  insertReservation,
  getAllRefs,
} from '../db/queries/reservations';
import { verifyTurnstileToken } from '../middleware/turnstile';
import { invalidatePrisonerLookupCache, invalidateReservationsCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import { validateSaveReservation, generateUniqueRefServer, findDuplicateActive } from '../services/reservationService';
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
  const cached = await cacheGet(env.CACHE_KV, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.rows)) return { status: 'ok', rows: parsed.rows };
    } catch {
      await cacheRemove(env.CACHE_KV, cacheKey).catch(() => undefined);
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
  await cachePut(env.CACHE_KV, cacheKey, JSON.stringify({ rows: masked }), LOOKUP_CACHE_TTL);
  return { status: 'ok', rows: masked };
}
