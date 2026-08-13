import { TABLES } from '../../constants';
import { Prisoner } from '../../types';
import { oneYearAgoISO } from '../../config';

export function getPrisoners(db: D1Database): Promise<Prisoner[]> {
  return db
    .prepare(
      `SELECT prisonerId, prisonerName, wing, status, vinaiDate, note
     FROM ${TABLES.prisoners} ORDER BY prisonerName COLLATE NOCASE`
    )
    .all<Prisoner>()
    .then((res) =>
      (res.results ?? []).map((p) => ({
        ...p,
        note: p.note ?? '',
      }))
    );
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
  return db
    .prepare(
      `SELECT prisonerId, prisonerName, wing, status, vinaiDate, note
     FROM ${TABLES.prisoners} WHERE prisonerId = ?`
    )
    .bind(prisonerId)
    .first<Prisoner>();
}

export function getPrisonerIds(db: D1Database): Promise<string[]> {
  return db
    .prepare(`SELECT prisonerId FROM ${TABLES.prisoners}`)
    .all<{ prisonerId: string }>()
    .then((res) => (res.results ?? []).map((r) => r.prisonerId));
}

export function upsertPrisoner(
  db: D1Database,
  p: {
    prisonerId: string;
    prisonerName: string;
    wing: string;
    status: string;
    vinaiDate: string;
    note: string;
  }
): Promise<void> {
  return db
    .prepare(
      `INSERT INTO ${TABLES.prisoners} (prisonerId, prisonerName, wing, status, vinaiDate, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(prisonerId) DO UPDATE SET
       prisonerName = excluded.prisonerName,
       wing = excluded.wing,
       status = excluded.status,
       vinaiDate = excluded.vinaiDate,
       note = excluded.note`
    )
    .bind(p.prisonerId, p.prisonerName, p.wing, p.status, p.vinaiDate, p.note)
    .run()
    .then(() => undefined);
}

export function clearExpiredDiscipline(db: D1Database): Promise<number> {
  // Clears prisoners whose status is 'ติดวินัย งดเยี่ยม' and vinaiDate is older
  // than one year ago (or empty dates are left untouched — matches legacy where
  // a missing date never auto-clears).
  return db
    .prepare(
      `UPDATE ${TABLES.prisoners}
     SET status = '', vinaiDate = ''
     WHERE status = 'ติดวินัย งดเยี่ยม'
       AND vinaiDate != ''
       AND vinaiDate <= ?`
    )
    .bind(oneYearAgoISO())
    .run()
    .then((res) => res.meta.changes ?? 0);
}

export interface PrisonerImportRow {
  prisonerId: string;
  prisonerName: string;
  wing: string;
  status: string;
  vinaiDate: string;
  note: string;
}

export interface PrisonerImportResult {
  total: number;
  added: number;
  updated: number;
  /** Prisoners present before the import that are not in the new upload. */
  removed: number;
  wingChanged: number;
  /** Prisoners whose wing changed on this import, with their new wing. */
  wingChanges: Array<{ prisonerId: string; wing: string }>;
}

const IMPORT_COLS = ['prisonerId', 'prisonerName', 'wing', 'status', 'vinaiDate', 'note'] as const;
// D1 caps bound params at 100 per statement: 6 cols x 16 rows = 96.
const ROWS_PER_STATEMENT = 16;
const STATEMENTS_PER_BATCH = 100;

/** Only the identity columns are needed to compare against the current list. */
export function getPrisonerIdNameWing(
  db: D1Database
): Promise<Array<{ prisonerId: string; prisonerName: string; wing: string }>> {
  return db
    .prepare(`SELECT prisonerId, prisonerName, wing FROM ${TABLES.prisoners}`)
    .all<{ prisonerId: string; prisonerName: string; wing: string }>()
    .then((res) =>
      (res.results ?? []).map((r) => ({
        prisonerId: String(r.prisonerId || ''),
        prisonerName: String(r.prisonerName || ''),
        wing: String(r.wing || ''),
      }))
    );
}

/**
 * Full-replace import for CSV uploads (up to 20k rows): the uploaded list is the
 * source of truth. All existing prisoners are deleted and replaced by the new
 * upload, so prisoners released from prison (absent from the file) are removed
 * automatically and every kept prisoner gets the latest name / wing / status
 * (vinai) / vinaiDate / note. Rows are de-duplicated by prisonerId within the
 * upload (last row wins) and written in chunked multi-row INSERT statements.
 * Counts: added = ids not in the DB before, updated = ids kept from before,
 * removed = ids dropped, wingChanged = kept ids whose wing changed.
 */
export async function importPrisonersBulk(
  db: D1Database,
  rows: PrisonerImportRow[],
  existing: Array<{ prisonerId: string; prisonerName: string; wing: string }>
): Promise<PrisonerImportResult> {
  const oldById = new Map<string, string>();
  for (const e of existing) oldById.set(e.prisonerId, e.wing || '');

  const lastById = new Map<string, PrisonerImportRow>();
  for (const r of rows) lastById.set(r.prisonerId, r);
  const unique = Array.from(lastById.values());

  let added = 0;
  let updated = 0;
  const wingChanges = new Map<string, string>();
  const uploadIds = new Set<string>();
  for (const r of unique) {
    uploadIds.add(r.prisonerId);
    const oldWing = oldById.get(r.prisonerId);
    if (oldWing !== undefined) {
      updated += 1;
      if (oldWing !== (r.wing || '')) wingChanges.set(r.prisonerId, r.wing || '');
    } else {
      added += 1;
    }
  }
  let removed = 0;
  for (const id of oldById.keys()) if (!uploadIds.has(id)) removed += 1;

  const insertStmts: D1PreparedStatement[] = [];
  for (let i = 0; i < unique.length; i += ROWS_PER_STATEMENT) {
    const chunk = unique.slice(i, i + ROWS_PER_STATEMENT);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const sql = `INSERT INTO ${TABLES.prisoners} (${IMPORT_COLS.join(', ')})
     VALUES ${values}`;
    const params: string[] = [];
    for (const r of chunk) params.push(r.prisonerId, r.prisonerName, r.wing, r.status, r.vinaiDate, r.note);
    insertStmts.push(db.prepare(sql).bind(...params));
  }

  if (insertStmts.length === 0) {
    return { total: 0, added, updated, removed, wingChanged: 0, wingChanges: [] };
  }

  // Delete-then-insert. The DELETE leads the first batch so the table is never
  // wiped without being refilled, and each batch is atomic.
  const deleteStmt = db.prepare(`DELETE FROM ${TABLES.prisoners}`);
  const firstBatch = [deleteStmt, ...insertStmts.slice(0, STATEMENTS_PER_BATCH - 1)];
  await db.batch(firstBatch);
  for (let i = STATEMENTS_PER_BATCH - 1; i < insertStmts.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(insertStmts.slice(i, i + STATEMENTS_PER_BATCH));
  }

  return {
    total: unique.length,
    added,
    updated,
    removed,
    wingChanged: wingChanges.size,
    wingChanges: Array.from(wingChanges, ([prisonerId, wing]) => ({ prisonerId, wing })),
  };
}

export function getPrisonerIdToWingMap(db: D1Database): Promise<Record<string, string>> {
  return db
    .prepare(`SELECT prisonerId, wing FROM ${TABLES.prisoners}`)
    .all<{ prisonerId: string; wing: string }>()
    .then((res) => {
      const map: Record<string, string> = {};
      for (const r of res.results ?? []) map[r.prisonerId] = r.wing ?? '';
      return map;
    });
}
