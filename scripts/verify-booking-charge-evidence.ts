import { createHash } from 'node:crypto';
import evidence from './booking-charge-evidence.json';
import { computeApprovalTotals, parseExtraVisitorNames } from '../src/services/pricing';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Configured production credentials are required');
export async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!/^SELECT\s/i.test(sql)) throw new Error('Booking evidence verification is read only');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/c24082d0-67dd-4c21-b460-d3c07e4f3651/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(60_000),
    }
  );
  const data = (await response.json()) as {
    success: boolean;
    result?: Array<{ success: boolean; results: Record<string, unknown>[] }>;
  };
  if (!response.ok || !data.success || !data.result?.every((r) => r.success))
    throw new Error(`Booking evidence query failed (HTTP ${response.status})`);
  return data.result.flatMap((r) => r.results);
}
const applied = await query("SELECT name FROM d1_migrations WHERE name='0025_reconcile_final_booking_charges.sql'");
if (applied.length)
  console.log('Final booking charge migration already applied; historical correction will not run again.');
else {
  const rows = new Map<string, Record<string, unknown>>();
  for (let offset = 0; ; offset += 200) {
    const page = await query(
      `SELECT ref,visitDateISO,status,total,version,relation,visitorAge,extraVisitorNames,
      visitorApproved,extraVisitorApproved,extraPrisoners,bookingType,visitorCount,adultCount,child5to8Count,childUnder5Count
      FROM reservations_archive ORDER BY ref LIMIT 200 OFFSET ?`,
      [offset]
    );
    page.forEach((r) => rows.set(String(r.ref), r));
    if (page.length < 200) break;
  }
  const locks = new Map(
    (await query('SELECT ref,total FROM reservation_payment_locks')).map((r) => [String(r.ref), Number(r.total)])
  );
  for (const item of evidence) {
    const row = rows.get(item.ref);
    if (
      !row ||
      row.total !== item.fromTotal ||
      row.version !== item.version ||
      row.visitDateISO !== item.visitDateISO ||
      row.status !== item.status ||
      locks.get(item.ref) !== item.fromTotal
    )
      throw new Error(`Booking ${item.ref} changed since reservation review; correction stopped`);
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          row.relation || '',
          row.visitorAge || '',
          row.extraVisitorNames || '',
          row.visitorApproved || '',
          row.extraVisitorApproved || '',
          row.extraPrisoners || '',
          row.bookingType || 'prisoner',
        ])
      )
      .digest('hex');
    const approvals = String(row.extraVisitorApproved || '').split(';;');
    if (
      hash !== item.pricingSha256 ||
      row.visitorApproved !== 'yes' ||
      parseExtraVisitorNames(row.extraVisitorNames).some((_, i) => !['yes', 'no'].includes(approvals[i] ?? ''))
    )
      throw new Error(`Booking ${item.ref} guest/child inputs changed; correction stopped`);
    const expected = computeApprovalTotals(
      true,
      String(row.extraVisitorApproved || ''),
      String(row.extraVisitorNames || ''),
      String(row.relation || ''),
      String(row.visitorAge || ''),
      String(row.extraPrisoners || '')
    );
    for (const field of ['visitorCount', 'adultCount', 'child5to8Count', 'childUnder5Count'] as const) {
      if (Number(row[field] || 0) !== item.fromCounters[field] || expected[field] !== item.toCounters[field])
        throw new Error(`Booking ${item.ref} visitor counts changed; correction stopped`);
    }
    if (expected.total !== item.bookingTotal)
      throw new Error(`Booking ${item.ref} charge no longer matches reservation rules`);
  }
  console.log(
    JSON.stringify({
      reservationEvidenceVerified: evidence.length,
      priceChanges: evidence.filter((r) => r.fromTotal !== r.bookingTotal).length,
      source: 'final booking details and recorded approvals',
    })
  );
}
