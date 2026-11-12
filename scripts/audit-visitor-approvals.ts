import { mkdirSync, writeFileSync } from 'node:fs';
import { parseExtraVisitorNames } from '../src/services/pricing';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Configured Cloudflare credential unavailable');
async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!/^SELECT\s/i.test(sql)) throw new Error('Read only audit');
  const r = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/0e00d9b1beeaf05140dd3777e0d2de90/d1/database/c24082d0-67dd-4c21-b460-d3c07e4f3651/query',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    }
  );
  const d = (await r.json()) as {
    success: boolean;
    result: { success: boolean; results: Record<string, unknown>[] }[];
  };
  if (!r.ok || !d.success || !d.result.every((x) => x.success)) throw new Error(`Cloudflare query failed ${r.status}`);
  return d.result.flatMap((x) => x.results);
}
const columns =
  'ref,status,participantApproved,disciplineApproved,visitorApproved,extraVisitorApproved,extraVisitorNames,visitorId,prisonerId,visitDateISO,bookingType,total,version,updatedAt,createdAt';
const live = await query(`SELECT ${columns} FROM reservations ORDER BY ref`);
const archive = await query(`SELECT ${columns} FROM reservations_archive ORDER BY ref`);
const clearances = await query('SELECT * FROM visitor_clearances');
const events = await query(
  "SELECT targetRef,action,details,timestamp,username FROM event_log WHERE action IN ('booking_stage_approved','visitor_approval_updated','update_visitor_approval','update_booking','status_changed','booking_submitted','booking_created') ORDER BY rowid"
);
mkdirSync('approval-audit', { recursive: true });
const known = new Map(
  clearances.map((c) => [`${String(c.prisonerId).trim().toUpperCase()}:${String(c.visitorId).trim().toUpperCase()}`, c])
);
const normalize = (v: unknown) =>
  String(v || '')
    .trim()
    .toLowerCase();
const pending = ['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน'];
function summary(rows: Record<string, unknown>[]) {
  const statuses: Record<string, number> = {};
  const mismatches: Record<string, unknown>[] = [];
  for (const r of rows) {
    statuses[String(r.status)] = (statuses[String(r.status)] || 0) + 1;
    if (r.bookingType === 'table' || String(r.ref).startsWith('TBL-') || !pending.includes(String(r.status))) continue;
    const extras = parseExtraVisitorNames(r.extraVisitorNames);
    const flags = String(r.extraVisitorApproved || '').split(';;');
    const main = normalize(r.visitorApproved),
      decisions = extras.map((_, i) => normalize(flags[i]));
    const resolved = main === 'yes' && decisions.every((f) => ['yes', 'no'].includes(f));
    const reusable = (id: unknown) =>
      known.get(`${String(r.prisonerId).trim().toUpperCase()}:${String(id).trim().toUpperCase()}`)?.decision === 'yes';
    const autoMain = !main && reusable(r.visitorId);
    const autoExtra = extras.map((g, i) => !decisions[i] && reusable(g.id));
    const expected = resolved
      ? r.disciplineApproved === 'yes'
        ? 'รอชำระเงิน'
        : 'รอตรวจสอบวินัย'
      : 'รอตรวจสอบผู้เข้าร่วม';
    if (expected !== r.status || resolved !== (r.participantApproved === 'yes') || autoMain || autoExtra.some(Boolean))
      mismatches.push({
        ref: r.ref,
        date: r.visitDateISO,
        status: r.status,
        participant: r.participantApproved,
        discipline: r.disciplineApproved,
        main,
        extras: decisions,
        expected,
        autoMain,
        autoExtra: autoExtra.filter(Boolean).length,
        extraCount: extras.length,
      });
  }
  return { count: rows.length, statuses, mismatches };
}
const report = { live: summary(live), archive: summary(archive), clearances: clearances.length, events: events.length };
writeFileSync('approval-audit/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
