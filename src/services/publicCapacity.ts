import { DEFAULT_PUBLIC_VISITS_PER_DAY, PUBLIC_BOOKING_SETTING_KEY } from '../constants';
import { getSettings } from '../db/queries/settings';
import { Env } from '../types';
import { positiveInt } from './tableCapacity';

export interface PublicBookingConfig {
  /** Public prisoner-visit bookings sellable per visit date. */
  perDay: number;
}

const DEFAULT_CONFIG: PublicBookingConfig = { perDay: DEFAULT_PUBLIC_VISITS_PER_DAY };

/**
 * Resolve the normal-flow daily booking cap from `admin_settings.publicBooking`,
 * defaulting to 20 per day. A missing or malformed key must never take the flow
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  const cfg = raw as Record<string, unknown>;
  return { perDay: positiveInt(cfg.perDay, DEFAULT_CONFIG.perDay, 500) };
}

export function visitsFullMessage(perDay: number): string {
  return `⚠️ วันที่เลือกเต็มแล้ว (รับจอง ${perDay} ราย/วัน) กรุณาเลือกวันอื่น`;
}
