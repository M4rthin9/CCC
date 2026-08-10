/**
 * One-time CSV -> D1 migration generator.
 *
 * Reads the Google Sheets CSV exports in ./data, then writes ./data/seed.sql
 * (UTF-8) ready to be applied with:
 *
 *   wrangler d1 execute ccc-reservations --remote --file=./data/seed.sql
 *
 * Handles:
 *   - legacy/empty/Thai column headers in the reservations CSV (matched by name)
 *   - duplicate reservation refs (keeps the first occurrence)
 *   - plaintext user passwords (hashed with the legacy sha256$ format and flagged
 *     for a forced password change on next login)
 *   - UTF-8 Thai text throughout
 *
 * Run:  npm run db:seed
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const OUT_FILE = join(DATA_DIR, 'seed.sql');
const PASSWORD_SALT = 'cc-cafe-reservation-v1';

const RESERVATION_COLUMNS = [
  'ref',
  'timestamp',
  'visitorName',
  'visitorId',
  'visitorPhone',
  'relation',
  'religion',
  'allergy',
  'extraVisitorReligions',
  'extraVisitorAllergies',
  'extraVisitorNames',
  'visitorApproved',
  'extraVisitorApproved',
  'prisonerName',
  'prisonerId',
  'wing',
  'visitDate',
  'visitDateISO',
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
  'status',
  'slipImage',
  'cancelReason',
  'createdAt',
  'updatedAt',
  'version',
  'createdBy',
];

const NUMERIC_RESERVATION_COLUMNS = new Set([
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
  'version',
]);

const ROLE_PERMISSION_COLUMNS = [
  'approve',
  'reject',
  'confirm_payment',
  'reject_payment',
  'cancel',
  'visitor_approval',
  'view_slip',
  'view_detail',
  'export',
  'print',
  'manage_users',
  'view_eventlog',
  'approve_discipline',
  'reject_discipline',
  'approve_participant',
  'manage_settings',
];

const PRISONER_COLUMNS = ['prisonerId', 'prisonerName', 'wing', 'status', 'vinaiDate', 'note'];

// ── CSV parsing (RFC 4180-ish, handles quotes + "" escapes) ────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function sq(value: unknown): string {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'";
}

function hashPassword(username: string, password: string): string {
  const value = PASSWORD_SALT + '|' + String(username).toLowerCase() + '|' + String(password);
  return 'sha256$' + createHash('sha256').update(value, 'utf8').digest('hex');
}

function detectTable(headers: string[]): string | null {
  const h = new Set(headers.map((x) => String(x).trim()));
  if (h.has('username') && h.has('password')) return 'users';
  if (h.has('roleName')) return 'roles';
  if (h.has('ref') && h.has('visitDateISO') && h.has('prisonerId')) {
    if (h.has('archivedAt')) return 'archive';
    return 'reservations';
  }
  if (h.has('prisonerId') && h.has('prisonerName')) return 'prisoners';
  if (h.has('username') && h.has('action') && h.has('details')) return 'eventlog';
  if (h.has('ref') && h.has('text') && h.has('user')) return 'notes';
  return null;
}

function readCsvFile(path: string): { headers: string[]; rows: string[][] } {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const parsed = parseCsv(text);
  if (parsed.length === 0) return { headers: [], rows: [] };
  const headers = (parsed[0] ?? []).map((h) => String(h).trim());
  const rows = parsed.slice(1).filter((r) => r.length > 1 && r.some((c) => String(c).trim() !== ''));
  return { headers, rows };
}

// ── Generators ─────────────────────────────────────────────────────────────
function genUsers(
  rows: string[][],
  headers: string[]
): { sql: string[]; defaultAccounts: Record<string, string>; counts: Record<string, number> } {
  const sql: string[] = [];
  const defaultAccounts: Record<string, string> = {};
  const idx = (name: string) => headers.indexOf(name);

  const uIdx = idx('username');
  const pIdx = idx('password');
  const rIdx = idx('role');
  const dIdx = idx('displayName');
  const cIdx = idx('createdAt');

  sql.push('DELETE FROM users;');

  const values: string[] = [];
  let added = 0;
  for (const row of rows) {
    const username = String(row[uIdx] ?? '').trim();
    const password = String(row[pIdx] ?? '');
    if (!username || !password) continue;
    const stored = password.startsWith('sha256$') ? password : hashPassword(username, password);
    if (!password.startsWith('sha256$')) {
      defaultAccounts[username.toLowerCase()] = stored;
    }
    const displayName = String(row[dIdx] ?? '').trim() || username;
    const createdAt = String(row[cIdx] ?? '').trim() || new Date().toISOString();
    values.push(
      `(${sq(username)}, ${sq(stored)}, ${sq(String(row[rIdx] ?? 'User').trim())}, ${sq(displayName)}, ${sq(createdAt)}, 'TRUE')`
    );
    added++;
  }

  for (let i = 0; i < values.length; i += 200) {
    const batch = values.slice(i, i + 200);
    sql.push(
      `INSERT INTO users (username, password, role, displayName, createdAt, passwordMigrated) VALUES\n  ${batch.join(',\n  ')};`
    );
  }
  return { sql, defaultAccounts, counts: { added } };
}

function genRoles(rows: string[][], headers: string[]): string[] {
  const sql: string[] = [];
  const rIdx = headers.indexOf('roleName');
  sql.push('DELETE FROM roles;');
  const values: string[] = [];
  for (const row of rows) {
    const roleName = String(row[rIdx] ?? '').trim();
    if (!roleName) continue;
    const perms = ROLE_PERMISSION_COLUMNS.map((col) => {
      const ci = headers.indexOf(col);
      const v =
        ci >= 0
          ? String(row[ci] ?? '')
              .trim()
              .toUpperCase()
          : 'FALSE';
      return v === 'TRUE' || v === '1' ? 1 : 0;
    });
    values.push(`(${sq(roleName)}, ${perms.join(', ')})`);
  }
  for (let i = 0; i < values.length; i += 100) {
    const batch = values.slice(i, i + 100);
    sql.push(
      `INSERT OR REPLACE INTO roles (roleName, ${ROLE_PERMISSION_COLUMNS.join(', ')}) VALUES\n  ${batch.join(',\n  ')};`
    );
  }
  return sql;
}

function genPrisoners(rows: string[][], headers: string[]): { sql: string[]; counts: Record<string, number> } {
  const sql: string[] = [];
  const idx = (name: string) => headers.indexOf(name);
  const idIdx = idx('prisonerId');
  sql.push('DELETE FROM prisoners;');
  const values: string[] = [];
  let added = 0;
  for (const row of rows) {
    const prisonerId = String(row[idIdx] ?? '').trim();
    if (!prisonerId) continue;
    const vals = PRISONER_COLUMNS.map((col, i) => {
      const ci = idx(col);
      return i === 0 ? sq(prisonerId) : sq(ci >= 0 ? String(row[ci] ?? '') : '');
    });
    values.push(`(${vals.join(', ')})`);
    added++;
  }
  for (let i = 0; i < values.length; i += 200) {
    const batch = values.slice(i, i + 200);
    sql.push(`INSERT OR REPLACE INTO prisoners (${PRISONER_COLUMNS.join(', ')}) VALUES\n  ${batch.join(',\n  ')};`);
  }
  return { sql, counts: { added } };
}

function genReservations(
  rows: string[][],
  headers: string[],
  table: string
): { sql: string[]; counts: Record<string, number> } {
  const sql: string[] = [];
  const idx = (name: string) => headers.indexOf(name);
  const refIdx = idx('ref');
  sql.push(`DELETE FROM ${table};`);

  const now = new Date().toISOString();
  const values: string[] = [];
  const seenRefs = new Set<string>();
  let added = 0;
  let dupSkipped = 0;

  for (const row of rows) {
    const ref = String(row[refIdx] ?? '').trim();
    if (!ref) continue;
    if (seenRefs.has(ref)) {
      dupSkipped++;
      continue;
    }
    seenRefs.add(ref);

    const vals = RESERVATION_COLUMNS.map((col) => {
      const ci = idx(col);
      if (ci < 0) {
        if (col === 'createdAt' || col === 'updatedAt') return sq(now);
        if (col === 'version') return '1';
        return "''";
      }
      const raw = String(row[ci] ?? '');
      if (col === 'version') {
        const n = parseInt(raw, 10);
        return String(isNaN(n) ? 1 : n);
      }
      if (NUMERIC_RESERVATION_COLUMNS.has(col)) {
        const n = parseInt(raw, 10);
        return String(isNaN(n) || n < 0 ? 0 : n);
      }
      return sq(raw);
    });
    values.push(`(${vals.join(', ')})`);
    added++;
  }

  for (let i = 0; i < values.length; i += 100) {
    const batch = values.slice(i, i + 100);
    sql.push(`INSERT INTO ${table} (${RESERVATION_COLUMNS.join(', ')}) VALUES\n  ${batch.join(',\n  ')};`);
  }
  return { sql, counts: { added, dupSkipped } };
}

function genEventLog(rows: string[][], headers: string[]): string[] {
  const sql: string[] = [];
  const idx = (name: string) => headers.indexOf(name);
  const cols = ['timestamp', 'username', 'action', 'targetRef', 'details', 'result', 'ip', 'userAgent'];
  sql.push('DELETE FROM event_log;');
  const values: string[] = [];
  for (const row of rows) {
    const ts = String(row[idx('timestamp')] ?? '').trim();
    if (!ts) continue;
    const vals = cols.map((col) => sq(String(row[idx(col)] ?? '')));
    values.push(`(${vals.join(', ')})`);
  }
  for (let i = 0; i < values.length; i += 200) {
    const batch = values.slice(i, i + 200);
    sql.push(`INSERT INTO event_log (${cols.join(', ')}) VALUES\n  ${batch.join(',\n  ')};`);
  }
  return sql;
}

function genNotes(rows: string[][], headers: string[]): string[] {
  const sql: string[] = [];
  const idx = (name: string) => headers.indexOf(name);
  const cols = ['ref', 'text', 'user', 'timestamp', 'createdAt'];
  sql.push('DELETE FROM notes;');
  const values: string[] = [];
  for (const row of rows) {
    const ref = String(row[idx('ref')] ?? '').trim();
    if (!ref) continue;
    const vals = cols.map((col) => sq(String(row[idx(col)] ?? '')));
    values.push(`(${vals.join(', ')})`);
  }
  for (let i = 0; i < values.length; i += 200) {
    const batch = values.slice(i, i + 200);
    sql.push(`INSERT INTO notes (${cols.join(', ')}) VALUES\n  ${batch.join(',\n  ')};`);
  }
  return sql;
}

function genArchive(rows: string[][], headers: string[]): { sql: string[]; counts: Record<string, number> } {
  const res = genReservations(rows, headers, 'reservations_archive');
  return res;
}

// ── Main ───────────────────────────────────────────────────────────────────
if (!existsSync(DATA_DIR)) {
  console.error('data/ directory not found. Export the 7 Google Sheets as CSV into ./data first.');
  process.exit(1);
}

const files = readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
if (files.length === 0) {
  console.error('No CSV files found in ./data.');
  process.exit(1);
}

const summary: string[] = [];
const sql: string[] = [
  '-- Generated by scripts/migrate-sheets.ts. Apply with:',
  '--   wrangler d1 execute ccc-reservations --remote --file=./data/seed.sql',
  '',
];

let defaultAccounts: Record<string, string> = {};

for (const file of files) {
  const path = join(DATA_DIR, file);
  const { headers, rows } = readCsvFile(path);
  const table = detectTable(headers);
  if (!table) {
    summary.push(`SKIPPED ${file} (unrecognized headers)`);
    continue;
  }

  switch (table) {
    case 'users': {
      const r = genUsers(rows, headers);
      sql.push(...r.sql);
      defaultAccounts = { ...defaultAccounts, ...r.defaultAccounts };
      summary.push(`users: +${r.counts.added}`);
      break;
    }
    case 'roles': {
      sql.push(...genRoles(rows, headers));
      summary.push(`roles: ${rows.filter((r) => String(r[headers.indexOf('roleName')] ?? '').trim()).length} rows`);
      break;
    }
    case 'prisoners': {
      const r = genPrisoners(rows, headers);
      sql.push(...r.sql);
      summary.push(`prisoners: +${r.counts.added}`);
      break;
    }
    case 'reservations': {
      const r = genReservations(rows, headers, 'reservations');
      sql.push(...r.sql);
      summary.push(`reservations: +${r.counts.added} (${r.counts.dupSkipped} duplicate refs skipped)`);
      break;
    }
    case 'archive': {
      const r = genArchive(rows, headers);
      sql.push(...r.sql);
      summary.push(`archive: +${r.counts.added} (${r.counts.dupSkipped} duplicate refs skipped)`);
      break;
    }
    case 'eventlog': {
      sql.push(...genEventLog(rows, headers));
      summary.push('eventlog: imported');
      break;
    }
    case 'notes': {
      sql.push(...genNotes(rows, headers));
      summary.push('notes: imported');
      break;
    }
  }
}

// Force a password change on next login for every user whose old password was
// stored in plaintext.
if (Object.keys(defaultAccounts).length > 0) {
  sql.push(
    `INSERT INTO settings (key, value, savedBy, savedAt) VALUES ('default_accounts', ${sq(JSON.stringify(defaultAccounts))}, 'migration', ${sq(new Date().toISOString())})\nON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );
  summary.push(`default_accounts: ${Object.keys(defaultAccounts).length} user(s) flagged for forced password change`);
}

writeFileSync(OUT_FILE, sql.join('\n'), 'utf8');

console.log('Migration summary:');
summary.forEach((s) => console.log('  - ' + s));
console.log(`\nWrote ${OUT_FILE} (${(Buffer.byteLength(sql.join('\n'), 'utf8') / 1024).toFixed(1)} KB).`);
console.log('\nApply it with:\n  wrangler d1 execute ccc-reservations --remote --file=./data/seed.sql');
