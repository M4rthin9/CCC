import { createCipheriv, randomBytes, publicEncrypt, constants } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Existing production credentials are required');
async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!/^SELECT\s/i.test(sql)) throw new Error('July investigation is read only');
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
    throw new Error(`July audit failed (HTTP ${response.status})`);
  return data.result.flatMap((r) => r.results);
}
const bookings: Record<string, unknown>[] = [];
const identities: Record<string, unknown>[] = [];
for (const table of ['reservations', 'reservations_archive']) {
  bookings.push(
    ...(
      await query(`SELECT ref, timestamp, visitDateISO, total, visitorCount, status, visitorApproved,
    extraVisitorApproved, extraVisitorNames, visitorName, visitorId, prisonerId, prisonerName, relation,
    visitorAge, extraPrisoners, bookingType, adultCount, child5to8Count, childUnder5Count, totalPersons, createdAt, updatedAt,
    version, slipImage, slip_key, slip_fingerprint, slip_image_hash, slip_ocr_json, slip_decision_json,
    cancelReason, ${table === 'reservations_archive' ? 'archivedAt' : "'' AS archivedAt"} FROM ${table}
    ORDER BY ref`)
    ).map((r) => ({ ...r, table }))
  );
  for (let offset = 0; ; offset += 300) {
    const rows = await query(
      `SELECT ref, visitDateISO, status, total, visitorId, prisonerId FROM ${table} ORDER BY ref LIMIT 300 OFFSET ?`,
      [offset]
    );
    identities.push(...rows.map((r) => ({ ...r, table })));
    if (rows.length < 300) break;
  }
}
const events = await query(`SELECT id, timestamp, username, action, targetRef, details, result FROM event_log
 WHERE targetRef IN (SELECT ref FROM reservations_archive WHERE visitDateISO LIKE '2026-07-%')
 OR targetRef IN ('VIS-57432','VIS-24775','VIS-90137')
 OR action IN ('completed_total_repriced','legacy_total_corrected','payment_total_corrected_from_slip') ORDER BY id`);
const locks = await query('SELECT ref,total,lockedAt FROM reservation_payment_locks');
const corrections = await query('SELECT * FROM payment_total_corrections');
const payload = { capturedAt: new Date().toISOString(), bookings, identities, events, locks, corrections };
const key = randomBytes(32),
  iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]);
const wrappedKey = publicEncrypt(
  {
    key: readFileSync('operations/july-audit-public.pem'),
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  },
  key
);
mkdirSync('july-evidence', { recursive: true });
writeFileSync(
  'july-evidence/evidence.enc.json',
  JSON.stringify({
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  })
);
console.log(JSON.stringify({ readOnly: true, bookings: bookings.length, events: events.length, encrypted: true }));
