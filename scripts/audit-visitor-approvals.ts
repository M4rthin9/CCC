import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseExtraVisitorNames } from '../src/services/pricing';
import { reusableVisitorClearance, type VisitorClearance } from '../src/services/visitorClearance';
import { approvalRecheckPlan, recheckGuard, recheckUpdateSql } from './visitor-approval-recheck-plan';
const token = process.env.CLOUDFLARE_API_TOKEN;
const apply = process.env.APPLY_VISITOR_RECHECK === 'true';
if (!token) throw new Error('Configured Cloudflare credential unavailable');
async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!apply && !/^SELECT\s/i.test(sql)) throw new Error('Read only audit');
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
const clearances = (await query('SELECT * FROM visitor_clearances')) as unknown as Array<
  VisitorClearance & { prisonerId: string }
>;
const locked = new Set((await query('SELECT ref FROM reservation_payment_locks')).map((row) => String(row.ref)));
const events = await query(
  "SELECT targetRef,action,details,timestamp,username FROM event_log WHERE action IN ('booking_stage_approved','visitor_approval_updated','update_visitor_approval','update_booking','status_changed','booking_submitted','booking_created') ORDER BY rowid"
);
mkdirSync('approval-audit', { recursive: true });
const known = new Map(
  clearances.map((c) => [`${String(c.prisonerId).trim().toUpperCase()}:${String(c.visitorId).trim().toUpperCase()}`, c])
);
const sources = new Map([...archive, ...live].map((row) => [String(row.ref), row]));
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
    const reusable = (id: unknown) => {
      const clearance = known.get(`${String(r.prisonerId).trim().toUpperCase()}:${String(id).trim().toUpperCase()}`);
      return !!clearance && reusableVisitorClearance(clearance, sources.get(clearance.sourceRef), String(r.ref));
    };
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
const plan = approvalRecheckPlan(live, archive, clearances, events, locked);
const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const report: Record<string, unknown> = {
  live: summary(live),
  archive: summary(archive),
  clearances: clearances.length,
  events: events.length,
  planHash,
  planned: plan.length,
  plan,
};
writeFileSync('approval-audit/report.json', JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      live: live.length,
      archived: archive.length,
      planned: plan.length,
      planHash,
      transitions: plan.reduce<Record<string, number>>((counts, p) => {
        const key = `${p.before.status} → ${p.after.status}`;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
    },
    null,
    2
  )
);
if (apply) {
  if (!/^[a-f0-9]{64}$/.test(process.env.EXPECTED_PLAN_HASH || '') || process.env.EXPECTED_PLAN_HASH !== planHash)
    throw new Error('Plan changed; no reservations updated. Review a fresh audit before applying.');
  if (!plan.length) throw new Error('No corrections to apply');
  const payload = JSON.stringify(plan),
    now = new Date().toISOString();
  // Persist the reviewed preimage before touching a reservation, including rollback fields.
  await query(
    `INSERT INTO event_log(timestamp,username,action,targetRef,details,result)
    SELECT ?, 'system:visitor-recheck','visitor_approval_recheck_planned',r.ref,p.value,'pending'
    FROM reservations r,json_each(?) p WHERE ${recheckGuard}`,
    [now, payload]
  );
  let applied: Record<string, unknown>[];
  try {
    // One UPDATE is atomic. Every row also rechecks its exact reviewed snapshot.
    applied = await query(recheckUpdateSql, [now, payload]);
  } finally {
    await query(
      "DELETE FROM d1_cache WHERE key IN ('v5:allReservations','v5:counts:shared-admin','v5:tableCounts') OR key LIKE 'v5:lookup:%'"
    );
    for (const key of ['data_version', 'data_version:reservations'])
      await query(
        `INSERT INTO settings(key,value,savedBy,savedAt) VALUES (?,?,'system',?)
      ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),savedAt=excluded.savedAt`,
        [key, String(Math.floor(Date.now() / 1000)), now]
      );
  }
  await query(
    `INSERT INTO event_log(timestamp,username,action,targetRef,details,result)
    SELECT ?,'system:visitor-recheck','visitor_approval_reconciled',json_extract(value,'$.ref'),json_object('planHash',?,'version',json_extract(value,'$.version')),'success' FROM json_each(?)`,
    [now, planHash, JSON.stringify(applied)]
  );
  const afterLive = await query(`SELECT ${columns} FROM reservations ORDER BY ref`);
  const remaining = approvalRecheckPlan(afterLive, archive, clearances, events, locked);
  report.applied = applied.length;
  report.skipped = plan.length - applied.length;
  report.remaining = remaining;
  report.after = summary(afterLive);
  writeFileSync('approval-audit/report.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ applied: applied.length, skipped: plan.length - applied.length, remaining: remaining.length })
  );
  if (applied.length !== plan.length || remaining.length)
    throw new Error('Recheck incomplete; concurrent or remaining changes need a fresh audit');
}
