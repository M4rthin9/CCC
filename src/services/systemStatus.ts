import type { Env } from '../types';
import { getSettings } from '../db/queries/settings';
import { parseBookingWindow } from './bookingWindow';
import { parseTableBookingConfig } from './tableCapacity';
import { parsePromo } from './promo';

export const STATUS_KEY = 'public:system-status:v1';
export const STATUS_INTERVAL = 300_000;
export const STATUS_STALE_AFTER = 900_000;
const RETENTION = 7 * 24 * 60 * 60 * 1000;
const MAX_SAMPLES = RETENTION / STATUS_INTERVAL;
export const STATUS_IDS = ['api', 'database', 'visit', 'table', 'payment', 'files'] as const;
export type ServiceState = 'operational' | 'maintenance' | 'outage' | 'unknown';
export interface StatusSample {
  at: number;
  states: ServiceState[];
}
export interface StatusSnapshot {
  version: 1;
  checkedAt: string | null;
  stale: boolean;
  services: { id: (typeof STATUS_IDS)[number]; state: ServiceState }[];
  history: StatusSample[];
  notice: { title: string; body: string } | null;
}
const STATES: ServiceState[] = ['operational', 'maintenance', 'outage', 'unknown'];

function empty(): StatusSnapshot {
  return {
    version: 1,
    checkedAt: null,
    stale: true,
    services: STATUS_IDS.map((id) => ({ id, state: 'unknown' })),
    history: [],
    notice: null,
  };
}

/** Only fixed, public fields survive KV parsing; no raw settings or errors are published. */
export function parseStatus(raw: string | null, now: number): StatusSnapshot {
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw) as StatusSnapshot;
    const at = Date.parse(data.checkedAt ?? '');
    if (data.version !== 1 || !Number.isFinite(at)) return empty();
    const services = STATUS_IDS.map((id) => {
      const state = data.services?.find((s) => s.id === id)?.state;
      return { id, state: STATES.includes(state as ServiceState) ? (state as ServiceState) : ('unknown' as const) };
    });
    const history = Array.isArray(data.history)
      ? data.history
          .filter(
            (s) =>
              Number.isFinite(s.at) &&
              s.at > now - RETENTION &&
              s.at <= now + STATUS_INTERVAL &&
              Array.isArray(s.states) &&
              s.states.length === STATUS_IDS.length &&
              s.states.every((state) => STATES.includes(state))
          )
          .slice(-MAX_SAMPLES)
      : [];
    const notice =
      data.notice && typeof data.notice.title === 'string' && typeof data.notice.body === 'string'
        ? { title: data.notice.title.slice(0, 120), body: data.notice.body.slice(0, 3000) }
        : null;
    const stale = now - at > STATUS_STALE_AFTER || at > now + STATUS_INTERVAL;
    return {
      version: 1,
      checkedAt: data.checkedAt,
      stale,
      services: stale ? services.map((s) => ({ ...s, state: 'unknown' })) : services,
      history,
      notice,
    };
  } catch {
    return empty();
  }
}

/** Cron only: one indexed settings read, no D1 writes, one KV read/put per five minutes. */
export async function recordSystemStatus(env: Env, scheduledTime: number): Promise<void> {
  const now = Math.floor(scheduledTime / STATUS_INTERVAL) * STATUS_INTERVAL;
  const previous = parseStatus(await env.CACHE_KV.get(STATUS_KEY), now);
  if (previous.checkedAt && Date.parse(previous.checkedAt) >= now) return;

  let settings: Record<string, unknown> | null = null;
  try {
    settings = await getSettings(env.DB);
  } catch {
    // Store the failed observation without exposing SQL, configuration, or credentials.
  }
  let files: ServiceState = 'unknown';
  if (env.SLIPS) {
    try {
      await env.SLIPS.head('__system-status-read-probe__');
      files = 'operational';
    } catch {
      files = 'outage';
    }
  }
  const booking = settings ? parseBookingWindow(settings.bookingWindow, settings.scheduledOpenings) : null;
  const table = settings ? parseTableBookingConfig(settings.tableBooking) : null;
  const payment = settings?.payment;
  const paymentEnabled =
    !payment || typeof payment !== 'object' || (payment as { enabled?: boolean }).enabled !== false;
  const states: ServiceState[] = [
    'operational',
    settings ? 'operational' : 'outage',
    !settings ? 'outage' : !booking?.open || !env.TURNSTILE_SECRET ? 'maintenance' : 'operational',
    !settings
      ? 'outage'
      : !booking?.open ||
          !table?.enabled ||
          table.maintenance ||
          !env.TURNSTILE_SECRET ||
          (!!table.opensAt && Date.parse(table.opensAt) > now)
        ? 'maintenance'
        : 'operational',
    !settings ? 'outage' : !paymentEnabled ? 'maintenance' : 'operational',
    files,
  ];
  const promo = settings ? parsePromo(settings.promo) : null;
  const notice = promo?.notice.enabled ? { title: promo.notice.title, body: promo.notice.body } : null;
  const snapshot: StatusSnapshot = {
    version: 1,
    checkedAt: new Date(now).toISOString(),
    stale: false,
    services: STATUS_IDS.map((id, i) => ({ id, state: states[i]! })),
    history: [...previous.history.filter((s) => s.at < now), { at: now, states }].slice(-MAX_SAMPLES),
    notice,
  };
  await env.CACHE_KV.put(STATUS_KEY, JSON.stringify(snapshot));
}

/** Public traffic never falls through to the old table-counting health endpoint or D1. */
export async function readSystemStatus(env: Env, now = Date.now()): Promise<StatusSnapshot> {
  try {
    return parseStatus(await env.CACHE_KV.get(STATUS_KEY, { cacheTtl: 60 }), now);
  } catch {
    return empty();
  }
}
