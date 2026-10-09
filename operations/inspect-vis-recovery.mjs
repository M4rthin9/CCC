import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createCipheriv, publicEncrypt, constants } from 'node:crypto';

const account = '0e00d9b1beeaf05140dd3777e0d2de90';
const database = 'c24082d0-67dd-4c21-b460-d3c07e4f3651';
const refs = ['VIS-90290', 'VIS-73239', 'VIS-21775'];
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Cloudflare credential is not configured');

async function query(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`D1 request failed: ${response.status}; ${JSON.stringify(data.errors)}`);
  if (data.result.some(result => !result.success)) throw new Error('D1 query failed');
  return data.result[0].results;
}

const snapshot = { capturedAt: new Date().toISOString(), refs, tables: {}, schemas: {}, events: [] };
const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'reservations%'");
for (const { name } of tables) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected table name');
  snapshot.schemas[name] = await query(`PRAGMA table_info(${name})`);
  snapshot.tables[name] = await query(`SELECT * FROM ${name} WHERE ref IN (?, ?, ?)`, refs);
  console.log(JSON.stringify({ table: name, rows: snapshot.tables[name].map(r => ({ ref: r.ref, status: r.status, visitDateISO: r.visitDateISO, updatedAt: r.updatedAt, cancelAt: r.cancelAt, slipStored: !!(r.slip_key || r.slip_base64 || r.slipImage) })) }));
}
snapshot.events = await query('SELECT rowid, * FROM event_log WHERE targetRef IN (?, ?, ?) ORDER BY rowid ASC', refs);
console.log(JSON.stringify({ events: snapshot.events.map(e => ({ ref: e.targetRef, timestamp: e.timestamp, action: e.action, result: e.result })) }));

// Only the public key leaves the local workstation. Customer data and slips
// remain encrypted in the artifact; no private data is printed in Actions logs.
const key = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
const wrappedKey = publicEncrypt({ key: readFileSync('recovery-public.pem'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
writeFileSync('recovery-encrypted.json', JSON.stringify({ wrappedKey: wrappedKey.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
