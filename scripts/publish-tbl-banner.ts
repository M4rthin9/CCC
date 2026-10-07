import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PROMO_ADS } from '../src/constants';

const SOURCE = 'https://cida.dpdns.org/banners/tbl-public-opening.png';
const SHA256 = 'f31279f3ec6fb988eedfc582c6cc328650908b3828188685e65bebb7d7ca7dc5';
const AD = {
  id: 'f31279f3-ec6f-4988-aedf-c582c6cc3286.png',
  title: 'การจองโต๊ะสำหรับบุคคลและองค์กรภายนอก (TBL)',
  link: 'https://cida.dpdns.org/#/table-booking',
  active: true,
};

/** Append only the advert; keep existing banners, popup, notice and booking controls. */
export function withTableBanner(settings: Record<string, unknown>): Record<string, unknown> {
  const promo = settings.promo as { ads?: Array<{ id: string }> } | undefined;
  if (!promo || !Array.isArray(promo.ads)) throw new Error('Existing promotion settings are required.');
  if (promo.ads.some((ad) => ad.id === AD.id)) return settings;
  if (promo.ads.length >= MAX_PROMO_ADS) throw new Error('Promotion banner limit reached.');
  return { ...settings, promo: { ...promo, ads: [...promo.ads, AD] } };
}

function wrangler(args: string[]): string {
  try {
    return execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // CLI exceptions include arguments; never log SQL containing private settings.
    const failure = error as { status?: number; stderr?: string; stdout?: string };
    const output = String(failure.stderr ?? '') + String(failure.stdout ?? '');
    // Image-upload output contains only the public object path, never settings SQL.
    if (args[0] === 'r2') console.error(output.slice(-2000));
    const codes = Array.from(output.matchAll(/\[code:\s*(\d+)\]/g), (match) => match[1]);
    throw new Error(
      `Cloudflare ${args[0]} ${args[1]} failed (exit ${failure.status ?? 'unknown'}${codes.length ? `, API code ${codes.join(',')}` : ''}). Check workflow credentials and resource permissions.`,
      { cause: error }
    );
  }
}

function readSettings(): string {
  const result = JSON.parse(
    wrangler([
      'd1',
      'execute',
      'ccc-reservations',
      '--remote',
      '--json',
      '--command',
      "SELECT value FROM settings WHERE key = 'admin_settings'",
    ])
  );
  const raw = result[0]?.results?.[0]?.value;
  if (typeof raw !== 'string') throw new Error('Production settings were not found.');
  return raw;
}

async function main(): Promise<void> {
  const image = await fetch(SOURCE);
  if (!image.ok) throw new Error('Cannot download the existing TBL banner.');
  const bytes = Buffer.from(await image.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== SHA256) throw new Error('Banner checksum mismatch.');
  if (!process.argv.includes('--publish')) {
    const response = await fetch('https://ccc-backend.pongsinbas.workers.dev/api/public-settings');
    if (!response.ok) throw new Error('Cannot read public promotion settings.');
    const current = (await response.json()) as Record<string, unknown>;
    withTableBanner(current);
    console.log('Banner checksum and promotion capacity verified. No live changes made.');
    return;
  }
  const raw = readSettings();
  const current = JSON.parse(raw);
  const updated = withTableBanner(current);
  if (updated === current) {
    console.log('TBL promotion banner is already registered; existing settings preserved.');
    return;
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  if (!/^[0-9a-f]{32}$/.test(account) || !accessKeyId || !secretAccessKey) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for the S3 upload.');
  }
  // Bucket-scoped R2 credentials use SigV4 through S3, not Wrangler's REST API.
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const uploaded = await client.fetch(`https://${account}.r2.cloudflarestorage.com/ccc-slips/promo/${AD.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
    body: new Uint8Array(bytes).buffer,
  });
  if (!uploaded.ok)
    throw new Error(`R2 S3 banner upload failed (HTTP ${uploaded.status}). Check the bucket-scoped credentials.`);
  // Verify storage before publishing its ID in settings; failed uploads cannot leave a broken advert.
  const stored = await client.fetch(`https://${account}.r2.cloudflarestorage.com/ccc-slips/promo/${AD.id}`);
  if (
    !stored.ok ||
    createHash('sha256')
      .update(Buffer.from(await stored.arrayBuffer()))
      .digest('hex') !== SHA256
  ) {
    throw new Error('Stored banner checksum verification failed; promotion settings were not changed.');
  }
  const temp = mkdtempSync(join(tmpdir(), 'ccc-tbl-promo-'));
  const sqlPath = join(temp, 'settings.sql');
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  try {
    const now = new Date().toISOString();
    writeFileSync(
      sqlPath,
      `UPDATE settings SET value=${quote(JSON.stringify(updated))}, savedBy='github-actions:tbl-banner', savedAt=${quote(now)} WHERE key='admin_settings' AND value=${quote(raw)};`
    );
    const result = JSON.parse(
      wrangler(['d1', 'execute', 'ccc-reservations', '--remote', '--json', '--file', sqlPath, '--yes'])
    );
    if (result[0]?.meta?.changes !== 1) throw new Error('Settings changed during upload; rerun to append safely.');
    writeFileSync(
      sqlPath,
      ['data_version', 'data_version:settings']
        .map(
          (key) =>
            `INSERT INTO settings (key,value,savedBy,savedAt) VALUES (${quote(key)},${quote(String(Math.floor(Date.now() / 1000)))},'system',${quote(now)}) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),savedAt=excluded.savedAt;`
        )
        .join('\n')
    );
    wrangler(['d1', 'execute', 'ccc-reservations', '--remote', '--file', sqlPath, '--yes']);
    const verified = JSON.parse(readSettings());
    if (!verified.promo.ads.some((ad: { id: string }) => ad.id === AD.id))
      throw new Error('Published banner was not found.');
    console.log(`Published TBL banner ${AD.id}. Existing banners and reservation controls preserved.`);
  } finally {
    try {
      unlinkSync(sqlPath);
    } catch {
      /* no SQL file if writing failed */
    }
    rmdirSync(temp);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
