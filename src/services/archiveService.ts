import { ARCHIVE_MONTHS } from '../constants';
import { formatBangkok } from '../config';
import { archiveReservationsByRef, countArchivableReservations, getArchivableRefs } from '../db/queries/reservations';
import { Env } from '../types';
import { invalidateArchivedCache, invalidateReservationsCache } from '../cache/invalidation';

// D1 caps a statement at 100 bound parameters; the copy statement spends one on
// archivedAt, so 50 refs per batch leaves plenty of head-room.
const BATCH_SIZE = 50;
// Ceiling for one sweep, so a large backlog cannot run a cron invocation out of
// CPU time. Whatever is left over is reported as `remaining` and picked up by
// the next daily sweep (or a manual run with a bigger budget).
const DEFAULT_MAX_ROWS = 2000;

export interface ArchiveResult {
  status: string;
  /** Rows moved into reservations_archive by this sweep. */
  archived: number;
  /** Rows still older than the cutoff when the sweep stopped. */
  remaining: number;
  /** Visit dates strictly before this stay out of the live table. */
  cutoff: string;
}

/**
 * Bangkok calendar date, ARCHIVE_MONTHS back from today. visitDateISO is a
 * Bangkok-local date, so the cutoff has to be one too — a UTC `new Date()`
 * is up to seven hours behind and would keep a day of stale rows around.
 */
export function archiveCutoffISO(now: Date = new Date()): string {
  const [y, m, d] = formatBangkok(now).slice(0, 10).split('-');
  // Date.UTC normalises the month underflow (e.g. month -1 → December of the
  // previous year) for us.
  return new Date(Date.UTC(Number(y), Number(m) - 1 - ARCHIVE_MONTHS, Number(d))).toISOString().slice(0, 10);
}

/**
 * Moves every reservation whose visit date is older than ARCHIVE_MONTHS into
 * reservations_archive, keeping the live table — and therefore the dashboard's
 * month filter — to a rolling three-month window.
 *
 * Runs from the daily cron, so the window is enforced continuously rather than
 * drifting out to six months between quarterly runs. Idempotent: a sweep with
 * nothing to do costs one indexed COUNT.
 */
export async function archiveOldReservations(env: Env, maxRows = DEFAULT_MAX_ROWS): Promise<ArchiveResult> {
  const db = env.DB;
  const cutoff = archiveCutoffISO();

  const due = await countArchivableReservations(db, cutoff);
  if (due === 0) return { status: 'ok', archived: 0, remaining: 0, cutoff };

  const budget = Math.max(Math.min(maxRows, due), 0);
  const archivedAt = formatBangkok(new Date());
  let archived = 0;

  while (archived < budget) {
    const refs = await getArchivableRefs(db, cutoff, Math.min(BATCH_SIZE, budget - archived));
    if (refs.length === 0) break;
    archived += await archiveReservationsByRef(db, refs, archivedAt);
  }

  if (archived > 0) {
    await invalidateArchivedCache(env);
    await invalidateReservationsCache(env);
  }

  return { status: 'ok', archived, remaining: Math.max(due - archived, 0), cutoff };
}
