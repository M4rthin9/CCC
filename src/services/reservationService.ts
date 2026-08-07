import { sanitizeInt, sanitizeStr, isValidISODate, normalizeVisitDateISO } from '../config';
import {
  SAVE_NUMERIC_FIELDS, SAVE_RESERVATION_FIELDS, SAVE_STRING_CAPS,
  UPDATE_BOOKING_CAPS, UPDATE_BOOKING_FIELDS, UPDATE_BOOKING_NUMERIC, VALID_STATUSES
} from '../constants';
import { getActiveReservations } from '../db/queries/reservations';
import { Env } from '../types';

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; message: string };

export function validateSaveReservation(body: Record<string, unknown>): ValidationResult<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Invalid request body' };
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { ok: false, message: 'กรุณากรอกเลขอ้างอิง' };
  const vdi = body.visitDateISO !== undefined && body.visitDateISO !== '' ? String(body.visitDateISO).trim() : '';
  if (vdi && !isValidISODate(vdi)) return { ok: false, message: 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)' };

  const data: Record<string, unknown> = {};
  SAVE_RESERVATION_FIELDS.forEach(field => {
    if (body[field] === undefined) return;
    if (SAVE_NUMERIC_FIELDS.includes(field)) {
      data[field] = sanitizeInt(body[field], 0);
    } else if (field === 'status') {
      const s = sanitizeStr(body[field], 50);
      data[field] = (s === 'รอตรวจสอบผู้เข้าร่วม' || s === '') ? s : 'รอตรวจสอบผู้เข้าร่วม';
    } else {
      const cap = SAVE_STRING_CAPS[field] || 1000;
      data[field] = sanitizeStr(body[field], cap);
    }
  });
  data.ref = ref;
  if (data.status === undefined || data.status === '') {
    data.status = 'รอตรวจสอบผู้เข้าร่วม';
  }
  return { ok: true, data };
}

export function generateUniqueRefServer(existingRefs: string[]): string {
  const existing = new Set(existingRefs.map(r => String(r).trim()));
  let ref = '';
  let attempts = 0;
  do {
    ref = 'VIS-' + Math.floor(10000 + Math.random() * 90000);
    attempts++;
  } while (existing.has(ref) && attempts < 100);
  return ref;
}

export async function collectActiveRefs(env: Env): Promise<string[]> {
  const rows = await getActiveReservations(env.DB);
  return rows.map(r => String(r.ref || '').trim()).filter(Boolean);
}

export async function findDuplicateActive(
  env: Env,
  prisonerId: string,
  visitDateISO: string,
  excludeRef: string | null
): Promise<string | null> {
  const pid = String(prisonerId || '').trim();
  const date = normalizeVisitDateISO(visitDateISO);
  if (!pid || !date) return null;
  const { findDuplicateActiveBooking } = await import('../db/queries/reservations');
  return findDuplicateActiveBooking(env.DB, pid, date, excludeRef);
}

export interface UpdateBookingParsed {
  cols: Array<[string, unknown]>;
  changes: Record<string, unknown>;
  errors: string[];
}

export function parseUpdateBookingFields(body: Record<string, unknown>): UpdateBookingParsed {
  const cols: Array<[string, unknown]> = [];
  const changes: Record<string, unknown> = {};
  const errors: string[] = [];

  UPDATE_BOOKING_FIELDS.forEach(field => {
    if (body[field] === undefined) return;
    let value: unknown;
    if (UPDATE_BOOKING_NUMERIC.includes(field)) {
      value = sanitizeInt(body[field], 0);
    } else if (field === 'visitDateISO') {
      const s = sanitizeStr(body[field], 10);
      if (s && !isValidISODate(s)) { errors.push('รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)'); return; }
      value = s;
    } else if (field === 'status') {
      const s = sanitizeStr(body[field], 50);
      if (!VALID_STATUSES.includes(s as never)) { errors.push('สถานะไม่ถูกต้อง: ' + s); return; }
      value = s;
    } else {
      value = sanitizeStr(body[field], UPDATE_BOOKING_CAPS[field] || 1000);
    }
    cols.push([field, value]);
    changes[field] = value;
  });

  return { cols, changes, errors };
}
