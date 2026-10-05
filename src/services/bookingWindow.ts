import { BOOKING_MAX_DAYS_AHEAD, BOOKING_WINDOW_SETTING_KEY, SCHEDULED_OPENINGS_SETTING_KEY } from '../constants';
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
  /**
   * Dates that open only from a set instant (ISO, UTC), e.g. a Sunday opened at
   * 12:00 Bangkok. Read from admin_settings.scheduledOpenings — a sibling key, so
   * the dashboard booking-window card (which rebuilds bookingWindow) keeps it.
   */
  openAt: Record<string, string>;
}

/** A year of overrides is far more than anyone keeps; bounds the public payload. */
const MAX_DATES = 366;

const DEFAULT_CLOSED_MESSAGE = '⚠️ ขณะนี้ปิดรับจองชั่วคราว กรุณาลองใหม่อีกครั้งภายหลัง';

/**
 * Sanitise `admin_settings.bookingWindow`. A missing or malformed key means
 * OPEN with no overrides — a bad settings save must never shut the site.
 */
export function parseBookingWindow(raw: unknown, scheduled?: unknown): BookingWindowConfig {
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

  const openAt: Record<string, string> = {};
  if (scheduled && typeof scheduled === 'object' && !Array.isArray(scheduled)) {
    for (const [date, at] of Object.entries(scheduled as Record<string, unknown>)) {
      if (Object.keys(openAt).length >= MAX_DATES) break;
      const t = Date.parse(String(at));
      if (isValidISODate(date) && !isNaN(t)) openAt[date] = new Date(t).toISOString();
    }
  }

  return {
    open: cfg.open !== false,
    closedMessage: sanitizeStr(cfg.closedMessage, 500),
    closedDates,
    openDates,
    openAt,
  };
}

export async function getBookingWindow(env: Env): Promise<BookingWindowConfig> {
  try {
    const settings = await getSettings(env.DB);
    const all = settings as Record<string, unknown>;
    return parseBookingWindow(all[BOOKING_WINDOW_SETTING_KEY], all[SCHEDULED_OPENINGS_SETTING_KEY]);
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

/** Weekend, holiday or admin-closed, unless an admin opened it. */
function isShut(iso: string, cfg: BookingWindowConfig): boolean {
  if (iso in cfg.closedDates) return true;
  if (cfg.openDates.includes(iso)) return false;
  const day = new Date(iso + 'T00:00:00Z').getUTCDay();
  return day === 0 || day === 6 || HOLIDAYS.has(iso);
}

/**
 * Bookable dates that open in (from, to]: the window's new tail at the 07:00
 * roll, plus scheduled openings whose time falls in the range. A date with a
 * scheduled time opens then, not at the roll.
 */
export function datesOpenedBetween(from: Date, to: Date, cfg: BookingWindowConfig): string[] {
  const out = new Set<string>();
  const last = lastOpenDateISO(to);
  const d = new Date(lastOpenDateISO(from) + 'T00:00:00Z');
  for (d.setUTCDate(d.getUTCDate() + 1); d.toISOString().slice(0, 10) <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!isShut(iso, cfg) && !cfg.openAt[iso]) out.add(iso);
  }
  for (const [iso, at] of Object.entries(cfg.openAt)) {
    const t = Date.parse(at);
    if (t > from.getTime() && t <= to.getTime() && iso <= last && !isShut(iso, cfg)) out.add(iso);
  }
  return [...out].sort();
}

/** HH:MM in Bangkok time, e.g. "12:00". */
export function bangkokTime(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }).format(at);
}

/** Why a public booking for `visitDateISO` is refused, or null when it may go ahead. */
export function bookingWindowError(cfg: BookingWindowConfig, visitDateISO: string): string | null {
  if (!cfg.open) return cfg.closedMessage || DEFAULT_CLOSED_MESSAGE;
  if (visitDateISO > lastOpenDateISO()) return '⚠️ วันที่เลือกยังไม่เปิดรับจอง (เปิดจองวันใหม่ทุกวันเวลา 07:00 น.)';
  const note = cfg.closedDates[visitDateISO];
  if (note !== undefined) {
    return `⚠️ วันที่เลือกปิดรับจอง${note ? ` (${note})` : ''} กรุณาเลือกวันอื่น`;
  }
  const at = cfg.openAt[visitDateISO];
  if (at && Date.now() < Date.parse(at)) {
    return `⚠️ วันที่เลือกจะเปิดรับจองเวลา ${bangkokTime(new Date(at))} น. กรุณารอสักครู่`;
  }
  return null;
}
