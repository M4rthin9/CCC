import { CACHE_VERSION, PASSWORD_SALT } from './constants';

// Cloudflare Workers always run in UTC. All human-readable timestamps in the
// system use Asia/Bangkok (UTC+7, no DST).
export const TIMEZONE = 'Asia/Bangkok';

export function formatDateISO(date: Date): string {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

export function formatBangkok(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatBangkokThai(date: Date): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function getCacheVersion(env: { CACHE_VERSION?: string }): string {
  return env.CACHE_VERSION || CACHE_VERSION;
}

export function getPasswordSalt(env: { PASSWORD_SALT?: string }): string {
  return env.PASSWORD_SALT || PASSWORD_SALT;
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
  const s = String(str || '');
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

export function isActiveReservationStatus(status: unknown): boolean {
  return ['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น'].includes(String(status || '').trim());
}

export function todayISO(): string {
  return formatDateISO(new Date());
}

export function oneYearAgoISO(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return formatDateISO(d);
}
