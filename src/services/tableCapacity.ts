import { DEFAULT_TABLES_PER_DAY, DEFAULT_TABLE_HOLD_MINUTES, TABLE_BOOKING_SETTING_KEY } from '../constants';
import { getSettings } from '../db/queries/settings';
import { countActiveTableBookings, releaseExpiredTableHolds } from '../db/queries/reservations';
import { Env } from '../types';

export interface TableBookingConfig {
  /** False closes the no-prisoner booking flow without a deploy. */
  enabled: boolean;
  /** Tables sellable per visit date. */
  perDay: number;
  /** Minutes an unpaid booking keeps its slot. */
  holdMinutes: number;
}

const DEFAULT_CONFIG: TableBookingConfig = {
  enabled: true,
  perDay: DEFAULT_TABLES_PER_DAY,
  holdMinutes: DEFAULT_TABLE_HOLD_MINUTES,
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
    perDay: positiveInt(cfg.perDay, DEFAULT_CONFIG.perDay, 500),
    holdMinutes: positiveInt(cfg.holdMinutes, DEFAULT_CONFIG.holdMinutes, 60 * 24 * 7),
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

export function dayFullMessage(perDay: number): string {
  return `⚠️ วันที่เลือกเต็มแล้ว (${perDay} โต๊ะ/วัน) กรุณาเลือกวันอื่น`;
}
