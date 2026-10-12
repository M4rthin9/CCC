import { invalidateReservationsCache } from '../cache/invalidation';
import { Env } from '../types';
import { broadcastTableAvailability } from './tableAvailability';

/** Reservation writes own both cache freshness and vacancy detection. */
export async function reservationChanged(env: Env): Promise<void> {
  await invalidateReservationsCache(env);
  try {
    await broadcastTableAvailability(env);
  } catch (error) {
    // The booking/cancellation already succeeded. The cron retries detection;
    // an outbox transaction failure leaves the full-state intact for that retry.
    console.error('[Availability] reservation change:', String(error));
  }
}
