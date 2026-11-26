import { invalidatePrisonersCache } from '../cache/invalidation';
import { formatBangkok } from '../config';
import { DISCIPLINE_STATUS } from '../constants';
import { getPrisoners } from '../db/queries/prisoners';
import { hasPermission } from '../db/queries/roles';
import { logEvent } from '../services/logger';
import { reservationChanged } from '../services/reservationChanges';
import type { Env, Prisoner } from '../types';

type Kind = 'roster' | 'discipline';
type WorkbookRow = { row: number; prisonerId: string; prisonerName: string; value: string };
type Before = Pick<Prisoner, 'prisonerName' | 'wing' | 'vinaiDate'>;
type PlannedRow = WorkbookRow & { change: 'add' | 'update' | 'clear'; before: Before | null };

const ISSUE = {
  duplicate: 'เลขผู้ต้องขังซ้ำในไฟล์',
  older: 'มีรายการวันเริ่มวินัยใหม่กว่า',
  missing: 'ไม่พบเลขผู้ต้องขังในระบบ',
  mismatch: 'ชื่อไม่ตรงกับเลขผู้ต้องขังในระบบ',
  inactive: 'ไม่มีสถานะงดเยี่ยมให้แก้ไข',
  invalid: 'วันที่เริ่มวินัยไม่ถูกต้องหรืออยู่ในอนาคต',
};

function text(value: unknown, max: number): value is string {
  return storedText(value, max) && value.trim() === value;
}

function storedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function sourceRow(value: unknown, kind: Kind): value is WorkbookRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as WorkbookRow;
  return (
    Number.isInteger(row.row) &&
    row.row > 0 &&
    text(row.prisonerId, 64) &&
    !!row.prisonerId &&
    text(row.prisonerName, 200) &&
    !!row.prisonerName &&
    text(row.value, 30) &&
    (kind === 'roster' ? /^แดน [1-9]\d?$/.test(row.value) : row.value >= '2000-01-01' && validDate(row.value))
  );
}

function nameKey(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/^(?:นักโทษชาย|นักโทษหญิง|น\.\s*[ชญ]\.|นางสาว|นาย|นาง)\s*/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function disciplineChange(row: WorkbookRow, before: Before, today: string): PlannedRow['change'] | string {
  if (nameKey(row.prisonerName) !== nameKey(before.prisonerName)) return ISSUE.mismatch;
  if (row.value > today) return ISSUE.invalid;
  const [year, month, day] = row.value.split('-').map(Number) as [number, number, number];
  const daysInMonth = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  const expires = new Date(Date.UTC(year + 1, month - 1, Math.min(day, daysInMonth))).toISOString().slice(0, 10);
  if (expires > today) return 'update';
  if (validDate(before.vinaiDate) && before.vinaiDate > row.value) return ISSUE.older;
  return 'clear';
}

function previewWorkbook(rows: WorkbookRow[], current: Prisoner[], kind: Kind, today: string) {
  const pending: PlannedRow[] = [];
  const issues: Array<{ row: number; reason: string }> = [];
  const byId = new Map(current.map((prisoner) => [prisoner.prisonerId, prisoner]));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  if (kind === 'roster') {
    for (const row of rows) {
      if (seen.has(row.prisonerId)) duplicates.add(row.prisonerId);
      seen.add(row.prisonerId);
    }
    seen.clear();
  }

  let unchanged = 0;
  for (const row of kind === 'discipline' ? [...rows].sort((a, b) => b.value.localeCompare(a.value)) : rows) {
    const existing = byId.get(row.prisonerId);
    const before = existing
      ? {
          prisonerName: existing.prisonerName,
          wing: existing.wing,
          vinaiDate: existing.vinaiDate,
        }
      : null;
    if (kind === 'roster') {
      if (duplicates.has(row.prisonerId)) {
        issues.push({ row: row.row, reason: ISSUE.duplicate });
      } else if (
        before?.prisonerName === row.prisonerName &&
        (before.wing === row.value || `แดน ${before.wing}` === row.value)
      ) {
        unchanged++;
      } else {
        pending.push({ ...row, before, change: before ? 'update' : 'add' });
      }
      continue;
    }

    let change: string;
    if (!before) change = ISSUE.missing;
    else if (existing?.status.trim() !== DISCIPLINE_STATUS) change = ISSUE.inactive;
    else if (seen.has(row.prisonerId)) change = ISSUE.older;
    else change = disciplineChange(row, before, today);
    if (before && (change === 'clear' || change === 'update')) {
      seen.add(row.prisonerId);
      if (change === 'update' && row.value === before.vinaiDate) unchanged++;
      else pending.push({ ...row, before, change });
    } else {
      if (change === ISSUE.older) seen.add(row.prisonerId);
      issues.push({ row: row.row, reason: change });
    }
  }
  return { status: 'ok', rows: pending, issues, unchanged };
}

export async function handlePrisonerWorkbook(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string },
  now = new Date()
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_prisoners'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์นำเข้าข้อมูลผู้ต้องขัง' };
  }
  const { kind, operation, rows } = body;
  const maxRows = operation === 'apply' ? 500 : 20_000;
  if (
    (kind !== 'roster' && kind !== 'discipline') ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > maxRows ||
    !rows.every((row) => sourceRow(row, kind))
  ) {
    return { status: 'error', message: 'ข้อมูลในไฟล์ไม่ถูกต้องหรือมีจำนวนรายการเกินกำหนด' };
  }
  const today = formatBangkok(now).slice(0, 10);
  if (operation === 'preview') return previewWorkbook(rows, await getPrisoners(env.DB), kind, today);
  if (operation !== 'apply' || new Set(rows.map((row) => row.prisonerId)).size !== rows.length) {
    return { status: 'error', message: 'กรุณาตรวจสอบตัวอย่างก่อนบันทึก' };
  }

  const changes = rows as PlannedRow[];
  for (const row of changes) {
    const before = row.before;
    if (
      before &&
      (!storedText(before.prisonerName, 200) || !storedText(before.wing, 64) || !storedText(before.vinaiDate, 40))
    ) {
      return { status: 'error', message: 'ข้อมูลเดิมเปลี่ยนไป กรุณาตรวจสอบตัวอย่างใหม่' };
    }
    if (kind === 'roster' && row.change === (before ? 'update' : 'add')) continue;
    if (
      kind === 'discipline' &&
      before &&
      (row.change === 'update' || row.change === 'clear') &&
      disciplineChange(row, before, today) === row.change
    )
      continue;
    return { status: 'error', message: 'รายการเปลี่ยนแปลงไม่ตรงกับกฎนำเข้า กรุณาตรวจสอบตัวอย่างใหม่' };
  }

  const input = JSON.stringify(changes);
  const fields = `SELECT value->>'$.prisonerId' AS id, value->>'$.prisonerName' AS name,
    value->>'$.value' AS next, value->>'$.before.prisonerName' AS oldName,
    value->>'$.before.wing' AS oldWing, value->>'$.before.vinaiDate' AS oldDate,
    value->>'$.change' AS requested FROM json_each(?)`;
  let applied: number;
  let reservationsWingSynced = 0;
  if (kind === 'roster') {
    const [added, updated, synced] = await env.DB.batch([
      env.DB.prepare(
        `WITH incoming AS (${fields})
        INSERT INTO prisoners (prisonerId, prisonerName, wing)
        SELECT id, name, next FROM incoming WHERE requested = 'add'
        ON CONFLICT(prisonerId) DO NOTHING`
      ).bind(input),
      env.DB.prepare(
        `WITH incoming AS (${fields})
        UPDATE prisoners AS p SET prisonerName = i.name,
          wing = CASE WHEN 'แดน ' || i.oldWing = i.next THEN p.wing ELSE i.next END FROM incoming i
        WHERE i.requested = 'update' AND p.prisonerId = i.id AND p.prisonerName = i.oldName AND p.wing = i.oldWing`
      ).bind(input),
      env.DB.prepare(
        `WITH incoming AS (${fields})
        UPDATE reservations AS r SET wing = p.wing FROM incoming i JOIN prisoners p ON p.prisonerId = i.id
        WHERE r.prisonerId = p.prisonerId AND p.prisonerName = i.name AND p.wing = i.next AND r.wing != p.wing
          AND (i.requested = 'add' OR i.oldWing != i.next)`
      ).bind(input),
    ]);
    applied = Number(added?.meta.changes ?? 0) + Number(updated?.meta.changes ?? 0);
    reservationsWingSynced = Number(synced?.meta.changes ?? 0);
  } else {
    const result = await env.DB.prepare(
      `WITH incoming AS (${fields})
      UPDATE prisoners AS p SET status = CASE WHEN i.requested = 'clear' THEN '' ELSE p.status END,
        vinaiDate = CASE WHEN i.requested = 'clear' THEN '' ELSE i.next END
      FROM incoming i WHERE p.prisonerId = i.id AND p.prisonerName = i.oldName
        AND TRIM(p.status) = ? AND p.vinaiDate = i.oldDate`
    )
      .bind(input, DISCIPLINE_STATUS)
      .run();
    applied = Number(result.meta.changes ?? 0);
  }

  if (applied) await invalidatePrisonersCache(env);
  if (reservationsWingSynced) await reservationChanged(env);
  const conflicted = changes.length - applied;
  await logEvent(
    env,
    user.username,
    'import_prisoner_workbook',
    '',
    { kind, applied, conflicted, reservationsWingSynced },
    'success'
  );
  return { status: 'ok', applied, conflicted };
}
