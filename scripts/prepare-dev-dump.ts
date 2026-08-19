/**
 * Rewrites a production `wrangler d1 export` dump into something the DEV
 * database can actually ingest.
 *
 * Two problems are solved in a single pass:
 *
 *  1. SQLITE_TOOBIG — payment slips are stored as base64 data URIs in
 *     reservations.slip_base64. Some rows exceed D1's per-statement limit
 *     (the largest observed is ~800 KB on one line), so a raw import aborts.
 *  2. PII — those same slips are photographs of real bank transfers and have
 *     no business being on a development box.
 *
 * Both are handled by blanking every string literal longer than MAX_LITERAL.
 * Nothing legitimate in this schema is that long: the next-largest text
 * columns are Thai names and note bodies, all well under a kilobyte.
 *
 * Usage:
 *   npx wrangler d1 export ccc-reservations --remote --output ./data/prod-dump.sql
 *   npm run db:prepare:dev
 *   npx wrangler d1 execute ccc-reservations-dev --remote --file=./data/dev-dump.sql
 *
 * Row-level scrubbing of names/phones/IDs is a separate step —
 * see scripts/sanitize-dev-db.sql, which runs after the import.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] ?? './data/prod-dump.sql';
const OUT = process.argv[3] ?? './data/dev-dump.sql';

/** Any single-quoted literal longer than this is treated as an embedded blob. */
const MAX_LITERAL = 2000;

const sql = readFileSync(IN, 'utf8');

let blanked = 0;
let bytesDropped = 0;

// Matches a SQL string literal, honouring '' as an escaped quote.
const out = sql.replace(/'(?:[^']|'')*'/g, (literal) => {
  if (literal.length <= MAX_LITERAL) return literal;
  blanked++;
  bytesDropped += literal.length;
  return "''";
});

writeFileSync(OUT, out);

const longestLine = out.split('\n').reduce((m, l) => Math.max(m, l.length), 0);

console.log(`Read    ${IN} (${(sql.length / 1e6).toFixed(1)} MB)`);
console.log(`Blanked ${blanked} oversized literals, dropping ${(bytesDropped / 1e6).toFixed(1)} MB`);
console.log(`Wrote   ${OUT} (${(out.length / 1e6).toFixed(1)} MB, longest line ${longestLine})`);

if (longestLine > 100_000) {
  console.warn(`\nWARNING: longest line is still ${longestLine} chars — import may hit SQLITE_TOOBIG.`);
  process.exitCode = 1;
}
