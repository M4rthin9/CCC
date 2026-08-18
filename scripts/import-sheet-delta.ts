/**
 * Non-destructive Google Sheets CSV -> D1 import.
 *
 * Unlike scripts/migrate-sheets.ts (which DELETEs the table first and is only
 * safe for the one-time cold migration), this generates an UPSERT so bookings
 * created through the new system survive.
 *
 * The sheet is treated as the source of truth for the columns it owns, but a
 * blank cell never overwrites a value already in D1 — the sheet has no notion
 * of the newer columns (slip_base64, slip_fingerprint, slip_image_hash,
 * payment_ref1, visitorAge), and those are left out of the statement entirely.
 *
 * Run:  npm run db:import -- "data/<sheet export>.csv"
 * Then: wrangler d1 execute ccc-reservations --remote --file=./data/import-<date>.sql
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Columns the Google Sheet owns. Anything added by migrations 0007/0008 is
// deliberately absent so an import can never clobber it.
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

const NUMERIC_COLUMNS = new Set([
  'visitorCount',
  'totalPersons',
  'total',
  'adultCount',
  'child5to8Count',
  'childUnder5Count',
  'version',
]);

// Always take the sheet's value on conflict — these are never legitimately blank.
const ALWAYS_WINS = new Set(['status', 'visitDate', 'visitDateISO']);

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

// ── Input ─────────────────────────────────────────────────────────────────
const csvArg = process.argv[2];
if (!csvArg) {
  console.error('Usage: npm run db:import -- <path-to-reservations-csv> [out.sql]');
  process.exit(1);
}
const csvPath = resolve(csvArg);
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outFile = process.argv[3] ? resolve(process.argv[3]) : join(DATA_DIR, `import-${stamp}.sql`);
const refsFile = outFile.replace(/\.sql$/, '.refs.txt');

const text = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
const parsed = parseCsv(text);
if (parsed.length < 2) {
  console.error(`No data rows in ${csvPath}`);
  process.exit(1);
}
const headers = (parsed[0] ?? []).map((h) => String(h).trim());
const rows = parsed.slice(1).filter((r) => r.length > 1 && r.some((c) => String(c).trim() !== ''));

const idx = (name: string) => headers.indexOf(name);
const refIdx = idx('ref');
if (refIdx < 0) {
  console.error(`CSV is missing a "ref" column. Headers: ${headers.join(', ')}`);
  process.exit(1);
}
const missing = RESERVATION_COLUMNS.filter((c) => idx(c) < 0);

// ── Build ─────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const values: string[] = [];
const refs: string[] = [];
const seen = new Set<string>();
let dupSkipped = 0;
let blankSkipped = 0;

for (const row of rows) {
  const ref = String(row[refIdx] ?? '').trim();
  if (!ref) {
    blankSkipped++;
    continue;
  }
  if (seen.has(ref)) {
    dupSkipped++;
    continue;
  }
  seen.add(ref);
  refs.push(ref);

  const vals = RESERVATION_COLUMNS.map((col) => {
    const ci = idx(col);
    if (ci < 0) {
      if (col === 'createdAt' || col === 'updatedAt') return sq(now);
      if (col === 'version') return '1';
      if (col === 'createdBy') return sq('legacy');
      return "''";
    }
    const raw = String(row[ci] ?? '');
    if (col === 'version') {
      const n = parseInt(raw, 10);
      return String(isNaN(n) ? 1 : n);
    }
    if (NUMERIC_COLUMNS.has(col)) {
      const n = parseInt(raw, 10);
      return String(isNaN(n) || n < 0 ? 0 : n);
    }
    if ((col === 'createdAt' || col === 'updatedAt') && raw.trim() === '') return sq(now);
    return sq(raw);
  });
  values.push(`(${vals.join(', ')})`);
}

// ON CONFLICT clause: the sheet wins whenever it has something to say.
const setClauses = RESERVATION_COLUMNS.filter((c) => c !== 'ref' && c !== 'version' && c !== 'updatedAt').map((col) => {
  if (NUMERIC_COLUMNS.has(col) || ALWAYS_WINS.has(col)) return `  ${col} = excluded.${col}`;
  return `  ${col} = CASE WHEN excluded.${col} <> '' THEN excluded.${col} ELSE reservations.${col} END`;
});
// The row genuinely changed at import time, and version drives optimistic locking.
setClauses.push(`  updatedAt = ${sq(now)}`);
setClauses.push('  version = reservations.version + 1');
const onConflict = `ON CONFLICT(ref) DO UPDATE SET\n${setClauses.join(',\n')}`;

const sql: string[] = [
  `-- Generated ${now} from ${basename(csvPath)} by scripts/import-sheet-delta.ts`,
  `-- ${values.length} reservation row(s), upsert (non-destructive).`,
];
for (let i = 0; i < values.length; i += 100) {
  const batch = values.slice(i, i + 100);
  sql.push(
    `INSERT INTO reservations (${RESERVATION_COLUMNS.join(', ')}) VALUES\n  ${batch.join(',\n  ')}\n${onConflict};`
  );
}

const body = sql.join('\n\n') + '\n';
writeFileSync(outFile, body, 'utf8');
writeFileSync(refsFile, refs.join('\n') + '\n', 'utf8');

console.log('Import summary:');
console.log(`  - source:     ${csvPath}`);
console.log(`  - data rows:  ${rows.length}`);
console.log(`  - upserted:   ${values.length}`);
console.log(`  - dup refs:   ${dupSkipped}`);
console.log(`  - blank refs: ${blankSkipped}`);
if (missing.length) console.log(`  - columns absent from CSV (defaulted): ${missing.join(', ')}`);
console.log(`\nWrote ${outFile} (${(Buffer.byteLength(body, 'utf8') / 1024).toFixed(1)} KB)`);
console.log(`Wrote ${refsFile} (${refs.length} refs, for post-import verification)`);
console.log(`\nApply it with:\n  npx wrangler d1 execute ccc-reservations --remote --file=${outFile}`);
