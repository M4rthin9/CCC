import { TABLES } from '../../constants';
import { Prisoner } from '../../types';
import { oneYearAgoISO } from '../../config';

export function getPrisoners(db: D1Database): Promise<Prisoner[]> {
  return db.prepare(
    `SELECT prisonerId, prisonerName, wing, status, vinaiDate, note
     FROM ${TABLES.prisoners} ORDER BY prisonerName COLLATE NOCASE`
  ).all<Prisoner>().then(res => (res.results ?? []).map(p => ({
    ...p,
    note: p.note ?? '',
  })));
}

// Minified rows — same shape the legacy backend returned for bandwidth savings:
// [prisonerName, prisonerId, wing, status, vinaiDate]
export async function getMinifiedPrisoners(db: D1Database): Promise<string[][]> {
  const prisoners = await getPrisoners(db);
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const p of prisoners) {
    if (!p.prisonerName || !p.prisonerId) continue;
    const key = p.prisonerId + '|' + p.prisonerName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([p.prisonerName, p.prisonerId, p.wing, p.status, p.vinaiDate]);
  }
  out.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? '', 'th'));
  return out;
}

export function getPrisonerById(db: D1Database, prisonerId: string): Promise<Prisoner | null> {
  return db.prepare(
    `SELECT prisonerId, prisonerName, wing, status, vinaiDate, note
     FROM ${TABLES.prisoners} WHERE prisonerId = ?`
  ).bind(prisonerId).first<Prisoner>();
}

export function getPrisonerIds(db: D1Database): Promise<string[]> {
  return db.prepare(`SELECT prisonerId FROM ${TABLES.prisoners}`).all<{ prisonerId: string }>()
    .then(res => (res.results ?? []).map(r => r.prisonerId));
}

export function upsertPrisoner(db: D1Database, p: {
  prisonerId: string;
  prisonerName: string;
  wing: string;
  status: string;
  vinaiDate: string;
  note: string;
}): Promise<void> {
  return db.prepare(
    `INSERT INTO ${TABLES.prisoners} (prisonerId, prisonerName, wing, status, vinaiDate, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(prisonerId) DO UPDATE SET
       prisonerName = excluded.prisonerName,
       wing = excluded.wing,
       status = excluded.status,
       vinaiDate = excluded.vinaiDate,
       note = excluded.note`
  ).bind(p.prisonerId, p.prisonerName, p.wing, p.status, p.vinaiDate, p.note).run().then(() => undefined);
}

export function clearExpiredDiscipline(db: D1Database): Promise<number> {
  // Clears prisoners whose status is 'ติดวินัย งดเยี่ยม' and vinaiDate is older
  // than one year ago (or empty dates are left untouched — matches legacy where
  // a missing date never auto-clears).
  return db.prepare(
    `UPDATE ${TABLES.prisoners}
     SET status = '', vinaiDate = ''
     WHERE status = 'ติดวินัย งดเยี่ยม'
       AND vinaiDate != ''
       AND vinaiDate <= ?`
  ).bind(oneYearAgoISO()).run().then(res => res.meta.changes ?? 0);
}

export function getPrisonerIdToWingMap(db: D1Database): Promise<Record<string, string>> {
  return db.prepare(`SELECT prisonerId, wing FROM ${TABLES.prisoners}`).all<{ prisonerId: string; wing: string }>()
    .then(res => {
      const map: Record<string, string> = {};
      for (const r of res.results ?? []) map[r.prisonerId] = r.wing ?? '';
      return map;
    });
}
