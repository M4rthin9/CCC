import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createCipheriv, publicEncrypt, constants } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { recoverMissingVis } from './vis-recovery-procedure.mjs';

if (process.env.MAINTENANCE_APPROVED !== '2026-10-09-three-cancelled-VIS') throw new Error('Explicit maintenance approval is required');
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Configured deployment credential is required');
const base = 'https://api.cloudflare.com/client/v4/accounts/0e00d9b1beeaf05140dd3777e0d2de90/d1/database/c24082d0-67dd-4c21-b460-d3c07e4f3651';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let state = { phase: 'starting', safeToResume: true };

function encrypt(file, value) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value)))), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: readFileSync('recovery-public.pem'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  writeFileSync(file, JSON.stringify({ compression: 'gzip', wrappedKey: wrappedKey.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
}
async function checkpoint(next) {
  if (next.initial) encrypt('recovery-before.enc.json', next.initial);
  if (next.originalRows) encrypt('recovery-originals.enc.json', { rows: next.originalRows, notes: next.originalNotes });
  const { initial, originalRows, originalNotes, ...safeMetadata } = next;
  state = safeMetadata;
  writeFileSync('recovery-state.json', JSON.stringify(state));
  console.log(JSON.stringify({ phase: state.phase, safeToResume: state.safeToResume }));
}
async function api(path, body) {
  const response = await fetch(`${base}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(90_000),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Cloudflare recovery API failed (${response.status}): ${JSON.stringify(result.errors)}`);
  return result.result;
}
function deploy(entry) {
  execFileSync('npx', ['wrangler', 'deploy', ...(entry ? [entry] : [])], { stdio: 'inherit', timeout: 120_000 });
}

try {
  await checkpoint(state);
  deploy('operations/recovery-maintenance-worker.mjs');
  let paused = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch('https://ccc-backend.pongsinbas.workers.dev/health.json', { signal: AbortSignal.timeout(10_000) });
    if (response.status === 503 && response.headers.get('X-Reservation-Recovery') === 'maintenance') { paused = true; break; }
    await sleep(3_000);
  }
  if (!paused) throw new Error('Maintenance was not verified; no database restore performed');
  console.log('Maintenance verified; waiting for in-flight requests to finish.');
  await sleep(90_000);
  const result = await recoverMissingVis({ api, checkpoint });
  console.log(JSON.stringify({ recovered: result }));
} finally {
  if (state.safeToResume) deploy();
  else console.error('Current database restoration requires attention. Maintenance remains active; use the saved fresh current bookmark.');
}
