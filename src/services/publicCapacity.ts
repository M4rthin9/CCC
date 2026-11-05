import { DEFAULT_PUBLIC_VISITS_PER_DAY, PUBLIC_BOOKING_SETTING_KEY } from '../constants';
import { getSettings } from '../db/queries/settings';
import { Env } from '../types';
import { positiveInt } from './tableCapacity';

export interface PublicBookingConfig {
  /** Public prisoner-visit bookings sellable per visit date. */
  perDay: number;
  previousPerDay: number;
  effectiveFrom: string;
}

const DEFAULT_CONFIG: PublicBookingConfig = {
  perDay: 25,
  previousPerDay: DEFAULT_PUBLIC_VISITS_PER_DAY,
  effectiveFrom: '2026-11-09',
};

/**
 * Resolve the normal-flow daily booking cap from `admin_settings.publicBooking`,
 * The legacy 20-table limit becomes 25 from 9 November; custom staff caps remain valid.
 * A missing or malformed key must never take the flow
 * down, so it falls back individually.
 */
export async function getPublicBookingConfig(env: Env): Promise<PublicBookingConfig> {
  let raw: unknown;
  try {
    const settings = await getSettings(env.DB);
    raw = (settings as Record<string, unknown>)[PUBLIC_BOOKING_SETTING_KEY];
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return parsePublicBookingConfig(raw);
}

export function parsePublicBookingConfig(raw: unknown): PublicBookingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  const cfg = raw as Record<string, unknown>;
  const previousPerDay = positiveInt(cfg.perDay, DEFAULT_CONFIG.previousPerDay, 500);
  return {
    ...DEFAULT_CONFIG,
    previousPerDay,
    perDay: previousPerDay === DEFAULT_PUBLIC_VISITS_PER_DAY ? 25 : previousPerDay,
  };
}

export function publicCapacityForDate(config: PublicBookingConfig, visitDateISO: string): number {
  return visitDateISO >= config.effectiveFrom ? config.perDay : config.previousPerDay;
}

export function visitsFullMessage(perDay: number): string {
  return `⚠️ วันที่เลือกเต็มแล้ว (รับจอง ${perDay} ราย/วัน) กรุณาเลือกวันอื่น`;
}
