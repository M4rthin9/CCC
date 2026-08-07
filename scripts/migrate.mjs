#!/usr/bin/env node
// Export the current GAS data into worker/data/bookings.json so that a fresh
// Cloudflare database can be seeded with the historical reservations, users,
// and prisoners. Run: npm run db:seed

import { mkdir, writeFile, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'worker', 'data');
const outFile = resolve(outDir, 'bookings.json');

function loadJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadEnv(p) {
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    let value = t.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function getVar(name) {
  const wr = loadJson(resolve(root, 'wrangler.jsonc'));
  if (wr && wr.vars && wr.vars[name] !== undefined) return String(wr.vars[name]);
  const env = loadEnv(resolve(root, '.dev.vars'));
  if (env[name]) return env[name];
  return process.env[name] || '';
}

const gasUrl = getVar('GAS_BACKEND_URL');
const exportToken = getVar('ADMIN_EXPORT_TOKEN');

if (!gasUrl || !exportToken || exportToken === 'replace-me') {
  console.error('Set GAS_BACKEND_URL and ADMIN_EXPORT_TOKEN (wrangler vars / .dev.vars) first.');
  process.exit(1);
}

const resp = await fetch(gasUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'getAllWithArchive', includeArchive: true, exportToken }),
});

const text = await resp.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  console.error('GAS returned non-JSON response. Is the exportToken accepted?');
  console.error(text.slice(0, 500));
  process.exit(1);
}

if (!data || data.status !== 'ok' || !Array.isArray(data.rows)) {
  console.error('Unexpected GAS response shape:', JSON.stringify(data).slice(0, 500));
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify(data.rows, null, 2), 'utf8');
console.log(`Exported ${data.rows.length} reservation rows to ${outFile}`);
