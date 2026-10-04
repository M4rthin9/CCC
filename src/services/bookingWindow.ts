import { BOOKING_MAX_DAYS_AHEAD, BOOKING_WINDOW_SETTING_KEY } from '../constants';
import { isValidISODate, sanitizeStr } from '../config';
import { getSettings } from '../db/queries/settings';
import { Env } from '../types';

export interface BookingWindowConfig {
  /** False closes every public booking path (visit + table) without a deploy. */
  open: boolean;
  /** Shown to the visitor while `open` is false; '' = the standard wording. */
  closedMessage: string;
  /** Dates nobody may book publicly, mapped to a short reason for the calendar. */
  closedDates: Record<string, string>;
  /** Dates the calendar blocks by default (weekend, holiday) that are opened anyway. */
  openDates: string[];
}

/** A year of overrides is far more than anyone keeps; bounds the public payload. */
const MAX_DATES = 366;

const DEFAULT_CLOSED_MESSAGE = '⚠️ ขณะนี้ปิดรับจองชั่วคราว กรุณาลองใหม่อีกครั้งภายหลัง';

/**
 * Sanitise `admin_settings.bookingWindow`. A missing or malformed key means
 * OPEN with no overrides — a bad settings save must never shut the site.
 */
export function parseBookingWindow(raw: unknown): BookingWindowConfig {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const closedDates: Record<string, string> = {};
  const rawClosed = cfg.closedDates;
  if (rawClosed && typeof rawClosed === 'object' && !Array.isArray(rawClosed)) {
    for (const [date, note] of Object.entries(rawClosed as Record<string, unknown>)) {
      if (Object.keys(closedDates).length >= MAX_DATES) break;
      if (isValidISODate(date)) closedDates[date] = sanitizeStr(note, 60);
    }
  }

  const openDates = Array.isArray(cfg.openDates)
    ? [...new Set(cfg.openDates.map(String).filter((d) => isValidISODate(d) && !(d in closedDates)))].slice(
        0,
        MAX_DATES
      )
    : [];

  return {
    open: cfg.open !== false,
    closedMessage: sanitizeStr(cfg.closedMessage, 500),
    closedDates,
    openDates,
  };
}

export async function getBookingWindow(env: Env): Promise<BookingWindowConfig> {
  try {
    const settings = await getSettings(env.DB);
    return parseBookingWindow((settings as Record<string, unknown>)[BOOKING_WINDOW_SETTING_KEY]);
  } catch {
    return parseBookingWindow(undefined);
  }
}

/**
 * Last visit date the public may book: BOOKING_MAX_DAYS_AHEAD weekdays ahead,
 * weekends not counted. The window rolls at 07:00 Bangkok (UTC+7, no DST),
 * which is UTC midnight — so it counts from the UTC date.
 */
export function lastOpenDateISO(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let n = 0; n < BOOKING_MAX_DAYS_AHEAD;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Public holidays the booking calendar blocks — a copy of HOLIDAYS in the
 * frontend's calendar.ts (from 2026-10 on; earlier dates can never open again).
 * ponytail: duplicated list; serve it from admin_settings if it starts changing often.
 */
const HOLIDAYS = new Set([
  '2026-10-13',
  '2026-10-16',
  '2026-10-23',
  '2026-12-05',
  '2026-12-07',
  '2026-12-10',
  '2026-12-31',
  '2027-01-01',
  '2027-02-21',
  '2027-02-22',
  '2027-04-06',
  '2027-04-13',
  '2027-04-14',
  '2027-04-15',
  '2027-05-01',
  '2027-05-03',
  '2027-05-04',
  '2027-05-20',
  '2027-06-03',
  '2027-07-18',
  '2027-07-19',
  '2027-07-28',
  '2027-08-12',
  '2027-10-13',
  '2027-10-23',
  '2027-10-25',
  '2027-12-05',
  '2027-12-06',
  '2027-12-10',
  '2027-12-31',
]);

/** Bookable dates that open between two instants: the window's new tail, minus
 *  weekends, holidays and admin-closed dates (admin-opened dates count). */
export function datesOpenedBetween(from: Date, to: Date, cfg: BookingWindowConfig): string[] {
  const out: string[] = [];
  const last = lastOpenDateISO(to);
  const d = new Date(lastOpenDateISO(from) + 'T00:00:00Z');
  for (d.setUTCDate(d.getUTCDate() + 1); d.toISOString().slice(0, 10) <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const weekendOrHoliday = d.getUTCDay() === 0 || d.getUTCDay() === 6 || HOLIDAYS.has(iso);
    if (iso in cfg.closedDates) continue;
    if (weekendOrHoliday && !cfg.openDates.includes(iso)) continue;
    out.push(iso);
  }
  return out;
}

/** Why a public booking for `visitDateISO` is refused, or null when it may go ahead. */
export function bookingWindowError(cfg: BookingWindowConfig, visitDateISO: string): string | null {
  if (!cfg.open) return cfg.closedMessage || DEFAULT_CLOSED_MESSAGE;
  if (visitDateISO > lastOpenDateISO()) return '⚠️ วันที่เลือกยังไม่เปิดรับจอง (เปิดจองวันใหม่ทุกวันเวลา 07:00 น.)';
  const note = cfg.closedDates[visitDateISO];
  if (note !== undefined) {
    return `⚠️ วันที่เลือกปิดรับจอง${note ? ` (${note})` : ''} กรุณาเลือกวันอื่น`;
  }
  return null;
}
