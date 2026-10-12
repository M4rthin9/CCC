import { formatBangkok, isValidISODate } from '../config';
import { getSettings } from '../db/queries/settings';
import { getPendingPushNotifications } from '../db/queries/notifications';
import {
  claimTableScan,
  queueTableAvailability,
  TABLE_NOTIFICATION_DAILY_LIMIT,
} from '../db/queries/tableAvailability';
import { Env } from '../types';
import { isBookableDate, lastOpenDateISO, parseBookingWindow } from './bookingWindow';
import { parseTableBookingConfig, tableBookingOpeningError } from './tableCapacity';
import { startDrain } from './notifications';
import { logEvent } from './logger';

/** Detect full → available after writes and on the five-minute expiry scan. */
export async function broadcastTableAvailability(
  env: Env,
  now: Date = new Date(),
  scheduledTime?: number
): Promise<Record<string, unknown>> {
  if (env.NOTIFY_PUSH_ENABLED !== 'true') return { status: 'ok', queued: 0, skipped: 'push_disabled' };
  const subscriber = await env.DB.prepare(
    'SELECT endpoint FROM push_subscriptions WHERE openingAlerts = 1 LIMIT 1'
  ).first();
  if (!subscriber) return { status: 'ok', queued: 0, skipped: 'no_subscribers' };
  const settings = await getSettings(env.DB); // A failed read must never invent an open window.
  const window = parseBookingWindow(settings.bookingWindow, settings.scheduledOpenings);
  const table = parseTableBookingConfig(settings.tableBooking);
  // Larger configured capacities need fewer scheduled scans to preserve read
  // headroom. Mutation-triggered scans still happen immediately while budgeted.
  const scanSteps = Math.max(1, Math.ceil(table.perDay / 50));
  if (scheduledTime !== undefined && Math.floor(scheduledTime / 300_000) % scanSteps !== 0) {
    return { status: 'ok', queued: 0, skipped: 'read_cadence' };
  }
  const today = formatBangkok(now).slice(0, 10);
  const last = lastOpenDateISO(now);
  const dates: { date: string; label: string }[] = [];
  if (window.open && !tableBookingOpeningError(table, now)) {
    const date = new Date(today + 'T00:00:00Z');
    for (
      date.setUTCDate(date.getUTCDate() + 1);
      date.toISOString().slice(0, 10) <= last;
      date.setUTCDate(date.getUTCDate() + 1)
    ) {
      const iso = date.toISOString().slice(0, 10);
      if (isValidISODate(iso) && isBookableDate(iso, window, now)) {
        dates.push({
          date: iso,
          label: new Intl.DateTimeFormat('th-TH', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(date),
        });
      }
    }
  }
  if (dates.length === 0) return { status: 'ok', queued: 0, skipped: 'no_bookable_dates' };
  const enabled = env.NOTIFY_PUSH_ENABLED === 'true';
  const readReservation = 1000 + dates.length * table.perDay * 8 + TABLE_NOTIFICATION_DAILY_LIMIT * 2;
  if (!(await claimTableScan(env.DB, now.toISOString().slice(0, 10), readReservation))) {
    return { status: 'ok', queued: 0, skipped: 'read_budget' };
  }
  const ref = 'TABLE-AVAILABLE-' + crypto.randomUUID();
  const queued = await queueTableAvailability(env.DB, {
    ref,
    now: now.toISOString(),
    today,
    perDay: table.perDay,
    dates,
    enabled,
  });
  let deliveryStarted = false;
  if (enabled && (queued > 0 || (await getPendingPushNotifications(env.DB, 1)).length > 0)) {
    try {
      await startDrain(env);
      deliveryStarted = true;
    } catch {
      await logEvent(env, 'system', 'table_availability_drain_pending', ref, { queued }, 'error');
    }
  }
  if (queued > 0) await logEvent(env, 'system', 'table_availability_broadcast', ref, { queued }, 'success');
  return { status: 'ok', queued, deliveryStarted };
}
