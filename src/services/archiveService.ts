import { ARCHIVE_MONTHS } from '../constants';
import { formatBangkok, formatDateISO } from '../config';
import {
  getActiveReservations, insertArchivedReservation, clearAllReservations,
  insertReservation
} from '../db/queries/reservations';
import { Env, Reservation } from '../types';
import { invalidateArchivedCache, invalidateReservationsCache } from '../cache/invalidation';

// Archives reservations whose visitDateISO is older than ARCHIVE_MONTHS.
// Mirrors the legacy archiveOldReservations() (runs on the 1st of every 3rd
// month at 00:15 Bangkok).
export async function archiveOldReservations(env: Env): Promise<{ status: string; archived: number }> {
  const db = env.DB;
  const rows = await getActiveReservations(db);
  if (rows.length === 0) return { status: 'ok', archived: 0 };

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_MONTHS);
  const cutoffStr = formatDateISO(cutoff);
  const nowStr = formatBangkok(new Date());

  const toArchive: Reservation[] = [];
  const remaining: Reservation[] = [];
  let archivedCount = 0;

  for (const row of rows) {
    const vdi = normalize(row.visitDateISO);
    if (vdi && /^\d{4}-\d{2}-\d{2}$/.test(vdi) && vdi < cutoffStr) {
      toArchive.push({ ...row, archivedAt: nowStr });
      archivedCount++;
    } else {
      remaining.push(row);
    }
  }

  if (archivedCount === 0) return { status: 'ok', archived: 0 };

  for (const row of toArchive) {
    await insertArchivedReservation(db, row);
  }

  await clearAllReservations(db);
  for (const row of remaining) {
    await insertReservation(db, row);
  }

  await invalidateArchivedCache(env);
  await invalidateReservationsCache(env);
  return { status: 'ok', archived: archivedCount };
}

function normalize(v: unknown): string {
  if (v instanceof Date) return formatDateISO(v);
  return String(v || '').trim();
}
