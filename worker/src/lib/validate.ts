import {
  PUBLIC_LOOKUP_FIELDS,
  SAVE_NUMERIC_FIELDS,
  SAVE_RESERVATION_FIELDS,
  SAVE_STRING_CAPS,
} from './constants';

export function formatDateISO(date: Date): string {
  return (
    date.getFullYear() +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0')
  );
}

export function sanitizeStr(value: unknown, maxLen?: number): string {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  const max = maxLen === undefined || maxLen === null ? 1000 : maxLen;
  return s.length > max ? s.substring(0, max) : s;
}

export function sanitizeInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(String(value), 10);
  if (isNaN(n)) return fallback;
  return n < 0 ? 0 : n;
}

export function isValidISODate(str: unknown): boolean {
  const s = String(str);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d.getTime()) && String(d.getFullYear()) === s.slice(0, 4);
}

export function normalizeVisitDateISO(value: unknown): string {
  if (value instanceof Date && !isNaN(value.getTime())) return formatDateISO(value);
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  return !isNaN(parsed.getTime()) ? formatDateISO(parsed) : s;
}

export interface SaveValidationResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export function validateSaveReservation(body: Record<string, unknown>): SaveValidationResult {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Invalid request body' };
  const ref = sanitizeStr(body.ref, 64);
  const vdi = body.visitDateISO !== undefined && body.visitDateISO !== '' ? String(body.visitDateISO).trim() : '';
  if (vdi && !isValidISODate(vdi)) return { ok: false, message: 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)' };

  const data: Record<string, unknown> = {};
  SAVE_RESERVATION_FIELDS.forEach((field) => {
    if (body[field] === undefined) return;
    if (SAVE_NUMERIC_FIELDS.includes(field)) {
      data[field] = sanitizeInt(body[field], 0);
    } else if (field === 'status') {
      const s = sanitizeStr(body[field], 50);
      data[field] = s === 'รอตรวจสอบผู้เข้าร่วม' || s === '' ? s : 'รอตรวจสอบผู้เข้าร่วม';
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

export function maskRowForPublic(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  PUBLIC_LOOKUP_FIELDS.forEach((k) => {
    if (row[k] === undefined || row[k] === null || String(row[k]) === '') return;
    if (k === 'extraVisitorNames') {
      out[k] = String(row[k])
        .split(';;')
        .map((part) => {
          const p = part.split('|');
          return (p[0] || '').trim();
        })
        .filter((n) => n)
        .join(';;');
    } else {
      out[k] = row[k];
    }
  });
  return out;
}
