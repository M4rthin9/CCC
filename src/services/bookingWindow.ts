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
