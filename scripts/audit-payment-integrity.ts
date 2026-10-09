import { mkdirSync, writeFileSync } from 'node:fs';
import { computeApprovalTotals, parseExtraVisitorNames } from '../src/services/pricing';
import reviewedEvidence from './payment-repair-evidence.json';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const database = 'c24082d0-67dd-4c21-b460-d3c07e4f3651';
if (!account || !token) throw new Error('Configured production credentials are required');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}`;

async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  // This audit can never execute a mutation, including PRAGMA assignments.
  if (!/^SELECT\s/i.test(sql)) throw new Error('Audit accepts SELECT queries only');
  const response = await fetch(`${base}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await response.json()) as {
    success: boolean;
    result?: Array<{ success: boolean; results: Record<string, unknown>[] }>;
  };
  if (!response.ok || !data.success || !data.result?.every((r) => r.success))
    throw new Error(`Production audit query failed (HTTP ${response.status})`);
  return data.result.flatMap((r) => r.results);
}

function json(raw: unknown): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const rows: Record<string, unknown>[] = [];
const lockTable = await query("SELECT name FROM sqlite_master WHERE type='table' AND name='reservation_payment_locks'");
const locks = new Map<string, number>();
if (lockTable.length) {
  for (const row of await query('SELECT ref, total FROM reservation_payment_locks'))
    locks.set(String(row.ref), Number(row.total));
}
for (const table of ['reservations', 'reservations_archive']) {
  for (let offset = 0; ; offset += 200) {
    const page = await query(
      `SELECT ref, visitDateISO, status, total, visitorCount, relation, visitorAge,
              extraVisitorNames, visitorApproved, extraVisitorApproved, extraPrisoners,
              bookingType, version, updatedAt, slip_fingerprint, slip_decision, slip_decision_json,
              slip_ocr_json, (slip_key != '' OR slip_base64 != '' OR slipImage != '') AS hasSlip
       FROM ${table} ORDER BY ref LIMIT 200 OFFSET ?`,
      [offset]
    );
    rows.push(...page.map((r) => ({ ...r, table })));
    if (page.length < 200) break;
  }
}

const totals: Record<string, { bookings: number; paid: number; pending: number; total: number }> = {};
const issues: Record<string, unknown>[] = [];
const refs = new Set<string>();
for (const row of rows) {
  const ref = String(row.ref);
  const status = String(row.status);
  const settled = ['ชำระแล้ว', 'เสร็จสิ้น', 'คืนเงินแล้ว'].includes(status);
  const total = Number(row.total);
  const summary = { ref, table: row.table, date: row.visitDateISO, status, total, version: row.version };
  if (refs.has(ref)) issues.push({ ...summary, issue: 'duplicate_ref_across_live_and_archive' });
  refs.add(ref);
  if (!Number.isFinite(total) || total < 0 || !Number.isInteger(total * 100))
    issues.push({ ...summary, issue: 'invalid_amount' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.visitDateISO))) issues.push({ ...summary, issue: 'invalid_visit_date' });
  if (!['ยกเลิก', 'ไม่อนุมัติ', 'คืนเงินแล้ว'].includes(status)) {
    const daily = (totals[String(row.visitDateISO)] ??= { bookings: 0, paid: 0, pending: 0, total: 0 });
    daily.bookings++;
    daily.total += total;
    if (['ชำระแล้ว', 'เสร็จสิ้น'].includes(status)) daily.paid += total;
    if (status === 'รอชำระเงิน') daily.pending += total;
  }
  if (!settled) continue;
  if (lockTable.length && !locks.has(ref)) issues.push({ ...summary, issue: 'settled_without_payment_lock' });
  if (locks.has(ref) && locks.get(ref) !== total) issues.push({ ...summary, issue: 'recorded_payment_lock_mismatch' });
  if (!row.hasSlip) issues.push({ ...summary, issue: 'settled_without_stored_slip' });
  const ocr = json(row.slip_ocr_json);
  const fields = ocr.fields as Record<string, unknown> | undefined;
  const decision = json(row.slip_decision_json);
  const checks = decision.checks as Record<string, unknown> | undefined;
  const verified =
    row.slip_decision === 'auto_approved' &&
    decision.decision === 'auto_approved' &&
    row.slip_fingerprint &&
    checks?.authentic === true &&
    checks.notDuplicate === true &&
    checks.amount === true &&
    checks.time === true &&
    (checks.payee === true || checks.ref1 === true);
  const paidAmount = fields?.amount;
  if (verified && typeof paidAmount === 'number' && paidAmount > 0 && paidAmount !== total)
    issues.push({ ...summary, issue: 'verified_slip_amount_mismatch', paidAmount, updatedAt: row.updatedAt });
  if (row.bookingType === 'table') continue;
  const extras = parseExtraVisitorNames(row.extraVisitorNames);
  const approvals = String(row.extraVisitorApproved || '').split(';;');
  if (row.visitorApproved !== 'yes' || extras.some((_, i) => !['yes', 'no'].includes(approvals[i] ?? ''))) continue;
  const approved = computeApprovalTotals(
    true,
    String(row.extraVisitorApproved),
    String(row.extraVisitorNames),
    String(row.relation),
    String(row.visitorAge),
    String(row.extraPrisoners)
  );
  if (approved.total !== total && !reviewedEvidence.some((e) => e.ref === ref && e.paidAmount === total))
    issues.push({
      ...summary,
      issue: 'approval_price_differs_from_recorded_total',
      approvedPrice: approved.total,
      automaticCorrectionAllowed: false,
    });
}

const events = await query(`SELECT id, timestamp, action, targetRef, details FROM event_log
 WHERE action IN ('completed_total_repriced', 'legacy_total_corrected', 'pricing_override')
 OR (targetRef IN (SELECT ref FROM reservations WHERE visitDateISO IN ('2026-08-10','2026-08-19','2026-08-27')
 UNION SELECT ref FROM reservations_archive WHERE visitDateISO IN ('2026-08-10','2026-08-19','2026-08-27'))
 AND (timestamp LIKE '2026-10-%' OR timestamp LIKE '%/10/2569%')) ORDER BY id`);
const sanitizedEvents = events.map((e) => {
  const detail = json(e.details);
  const allowed = ['from', 'to', 'total', 'clientTotal', 'serverTotal', 'newStatus', 'visitDateISO', 'via', 'reason'];
  return {
    id: e.id,
    timestamp: e.timestamp,
    action: e.action,
    ref: e.targetRef,
    details: Object.fromEntries(allowed.filter((k) => detail[k] !== undefined).map((k) => [k, detail[k]])),
  };
});
const report = {
  capturedAt: new Date().toISOString(),
  source: 'production',
  readOnly: true,
  rows: rows.length,
  protectedPayments: locks.size,
  totals,
  issues,
  events: sanitizedEvents,
  bookings: rows.map((r) => ({
    ref: r.ref,
    table: r.table,
    date: r.visitDateISO,
    status: r.status,
    total: r.total,
    hasSlip: !!r.hasSlip,
    version: r.version,
    updatedAt: r.updatedAt,
  })),
};
mkdirSync('payment-audit', { recursive: true });
writeFileSync('payment-audit/report.json', JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    rows: report.rows,
    protectedPayments: report.protectedPayments,
    issueCounts: issues.reduce<Record<string, number>>((out, r) => {
      const key = String(r.issue);
      out[key] = (out[key] || 0) + 1;
      return out;
    }, {}),
    august: Object.fromEntries(['2026-08-10', '2026-08-19', '2026-08-27'].map((d) => [d, totals[d]])),
  })
);
