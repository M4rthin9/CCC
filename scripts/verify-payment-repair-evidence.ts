import { createHash } from 'node:crypto';
import evidence from './payment-repair-evidence.json';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Configured production credentials are required');
async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
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
    throw new Error(`Payment evidence query failed (HTTP ${response.status})`);
  return data.result.flatMap((r) => r.results);
}
const applied = await query("SELECT name FROM d1_migrations WHERE name = '0024_preserve_paid_totals.sql'");
if (applied.length) {
  console.log('Payment repair already applied; historical corrections will not run again.');
} else {
  for (const item of evidence) {
    const [row] = await query(
      'SELECT total, status, visitDateISO, version, slipImage FROM reservations_archive WHERE ref = ?',
      [item.ref]
    );
    if (
      !row ||
      row.total !== item.fromTotal ||
      row.status !== 'เสร็จสิ้น' ||
      row.visitDateISO !== item.visitDateISO ||
      row.version !== item.version
    )
      throw new Error(`Booking ${item.ref} changed since evidence review; repair stopped`);
    // Legacy slips are hosted by Drive. Never fetch arbitrary database URLs or print them.
    const url = new URL(String(row.slipImage));
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com')
      throw new Error(`Booking ${item.ref} no longer has the reviewed legacy slip`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/'))
      throw new Error(`Booking ${item.ref} slip is unavailable; repair stopped`);
    const hash = createHash('sha256')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('hex');
    if (hash !== item.slipSha256) throw new Error(`Booking ${item.ref} slip changed; repair stopped`);
    console.log(`Payment evidence verified for ${item.ref}: ${item.paidAmount} THB`);
  }
}
