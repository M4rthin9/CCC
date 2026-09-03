import {
  DEFAULT_TABLES_PER_DAY,
  DEFAULT_TABLE_HOLD_MINUTES,
  DEFAULT_TABLE_SEATS,
  TABLE_BOOKING_SETTING_KEY,
} from '../constants';
import { parseExtraVisitorNames } from './pricing';
import { getSettings } from '../db/queries/settings';
import { countActiveTableBookings, releaseExpiredTableHolds } from '../db/queries/reservations';
import { Env } from '../types';

export interface TableBookingConfig {
  /** False closes the no-prisoner booking flow without a deploy. */
  enabled: boolean;
  /** True keeps the table-booking page behind a maintenance/coming-soon popup. */
  maintenance: boolean;
  /** Tables sellable per visit date. */
  perDay: number;
  /** Minutes an unpaid booking keeps its slot. */
  holdMinutes: number;
  /** People one table seats, counting the visitor who made the booking. */
  seatsPerTable: number;
}

const DEFAULT_CONFIG: TableBookingConfig = {
  enabled: true,
  maintenance: true,
  perDay: DEFAULT_TABLES_PER_DAY,
  holdMinutes: DEFAULT_TABLE_HOLD_MINUTES,
  seatsPerTable: DEFAULT_TABLE_SEATS,
};

/** Clamp a settings value to a sane positive integer, falling back on garbage. */
function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0 || n > max) return fallback;
  return n;
}

/**
 * Resolve the table-booking knobs from `admin_settings.tableBooking`, defaulting
 * to 10 tables/day on a 60-minute hold. A missing or malformed key must never
 * take the flow down, so every field falls back individually.
 */
export async function getTableBookingConfig(env: Env): Promise<TableBookingConfig> {
  let raw: unknown;
  try {
    const settings = await getSettings(env.DB);
    raw = (settings as Record<string, unknown>)[TABLE_BOOKING_SETTING_KEY];
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  const cfg = raw as Record<string, unknown>;
  return {
    enabled: cfg.enabled !== false,
    maintenance: cfg.maintenance !== false,
    perDay: positiveInt(cfg.perDay, DEFAULT_CONFIG.perDay, 500),
    holdMinutes: positiveInt(cfg.holdMinutes, DEFAULT_CONFIG.holdMinutes, 60 * 24 * 7),
    seatsPerTable: positiveInt(cfg.seatsPerTable, DEFAULT_CONFIG.seatsPerTable, 50),
  };
}

/** ISO instant at which a hold taken now lapses. */
export function holdExpiryFrom(nowIso: string, holdMinutes: number): string {
  return new Date(new Date(nowIso).getTime() + holdMinutes * 60_000).toISOString();
}

export interface CapacityCheck {
  ok: boolean;
  used: number;
  perDay: number;
}

/**
 * Sweep lapsed holds for the date, then report whether a slot is free.
 *
 * The sweep is only housekeeping — `countActiveTableBookings` already ignores
 * expired holds — but doing it here keeps the dashboard free of zombie pending
 * rows without needing a fast cron.
 */
export async function checkTableCapacity(
  env: Env,
  visitDateISO: string,
  perDay: number,
  nowIso: string
): Promise<CapacityCheck> {
  await releaseExpiredTableHolds(env.DB, nowIso, visitDateISO).catch(() => 0);
  const used = await countActiveTableBookings(env.DB, visitDateISO, nowIso);
  return { ok: used < perDay, used, perDay };
}

/**
 * Head count a table booking occupies: the visitor who books, plus every extra
 * visitor named on it. The prisoner ladder does not apply — a table booking has
 * no prisoner — and children still take a seat even when they are charged less.
 */
export function tableSeatsUsed(data: { extraVisitorNames?: unknown }): number {
  return 1 + parseExtraVisitorNames(data.extraVisitorNames).length;
}

/** Returns an error message when the booking wants more seats than one table has. */
export function checkTableSeats(data: { extraVisitorNames?: unknown }, seatsPerTable: number): string | null {
  const used = tableSeatsUsed(data);
  if (used <= seatsPerTable) return null;
  return seatsFullMessage(seatsPerTable, used);
}

export function seatsFullMessage(seatsPerTable: number, requested: number): string {
  return `⚠️ 1 โต๊ะรับได้สูงสุด ${seatsPerTable} คน (รวมผู้จอง) แต่ระบุมา ${requested} คน กรุณาลดจำนวนผู้เข้าร่วม`;
}

export function dayFullMessage(perDay: number): string {
  return `⚠️ วันที่เลือกเต็มแล้ว (${perDay} โต๊ะ/วัน) กรุณาเลือกวันอื่น`;
}
