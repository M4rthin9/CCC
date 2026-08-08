import { clearExpiredDiscipline, getPrisonerById, getPrisoners } from '../db/queries/prisoners';
import { DISCIPLINE_STATUS } from '../constants';
import { Env, Prisoner } from '../types';
import { invalidatePrisonersCache } from '../cache/invalidation';

// Daily cleanup: clears the 'ติดวินัย งดเยี่ยม' status for prisoners whose
// vinaiDate is more than one year old. Runs daily at 00:00 Bangkok.
export async function cleanupExpiredDiscipline(env: Env): Promise<{ status: string; cleared: number }> {
  const cleared = await clearExpiredDiscipline(env.DB);
  if (cleared > 0) await invalidatePrisonersCache(env);
  return { status: 'ok', cleared };
}

// Read-time auto-cleanup mirroring handleGetPrisoners: any expired-discipline
// row is cleared on the fly before the list is returned.
export async function autoCleanupPrisoners(env: Env): Promise<void> {
  const db = env.DB;
  const prisoners = await getPrisoners(db);
  if (prisoners.length === 0) return;

  const oneYearAgoISO = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  let cleared = 0;
  for (const p of prisoners) {
    if (p.status !== 'ติดวินัย งดเยี่ยม' || !p.vinaiDate) continue;
    const vd = normalizeVinaiDate(p.vinaiDate);
    if (vd && vd <= oneYearAgoISO) {
      await db.prepare('UPDATE prisoners SET status = ?, vinaiDate = ? WHERE prisonerId = ?')
        .bind('', '', p.prisonerId).run();
      cleared++;
    }
  }
  if (cleared > 0) await invalidatePrisonersCache(env);
}

function normalizeVinaiDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v || '').trim();
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}

// True when a prisoner is currently restricted from visits.
export function isDisciplineActive(status: string, vinaiDate: unknown): boolean {
  if (String(status || '').trim() !== DISCIPLINE_STATUS) return false;
  if (vinaiDate === undefined || vinaiDate === null || String(vinaiDate).trim() === '') return true;
  const vd = normalizeVinaiDate(vinaiDate);
  if (!vd) return true;
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  return new Date(vd + 'T00:00:00').getTime() > oneYearAgo.getTime();
}

// Look up a prisoner and report whether their discipline status blocks new bookings.
export async function getPrisonerDiscipline(
  env: Env,
  prisonerId: string
): Promise<{ restricted: boolean; message: string }> {
  const pid = String(prisonerId || '').trim();
  if (!pid) return { restricted: false, message: '' };
  const p: Prisoner | null = await getPrisonerById(env.DB, pid);
  if (!p || !isDisciplineActive(p.status, p.vinaiDate)) return { restricted: false, message: '' };
  const name = p.prisonerName ? String(p.prisonerName) : '';
  const label = name ? name + ' (' + pid + ')' : 'หมายเลข ' + pid;
  return {
    restricted: true,
    message: '⚠️ ไม่สามารถจองได้ — ผู้ต้องขัง "' + label + '" มีสถานะติดวินัย งดเยี่ยม ไม่สามารถจองเยี่ยมได้',
  };
}
