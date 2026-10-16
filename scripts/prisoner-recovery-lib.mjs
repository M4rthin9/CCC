import {DatabaseSync} from 'node:sqlite';
import {createHash, createCipheriv, publicEncrypt, randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
export const databaseId = 'c24082d0-67dd-4c21-b460-d3c07e4f3651';
export const worker = 'workers/scripts/ccc-backend';
export const dbPath = `d1/database/${databaseId}`;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const assert = (condition, message) => { if (!condition) throw new Error(message); };
export async function api(path, body, method) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  assert(token && account, 'Missing Cloudflare credentials');
  const multipart = body instanceof FormData;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {Authorization: `Bearer ${token}`, ...(multipart ? {} : {'Content-Type': 'application/json'})},
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(180000),
  });
  const data = await response.json();
  assert(response.ok && data.success, `Cloudflare API ${path.split('?')[0]} failed: ${JSON.stringify(data.errors)}`);
  return data.result;
}
export async function query(sql, params = []) {
  const result = await api(`${dbPath}/query`, {sql, params});
  assert(result.every(r => r.success), 'Database query failed');
  return result.flatMap(r => r.results);
}
export async function exportSql() {
  let bookmark;
  for (let i = 0; i < 120; i++) {
    const result = await api(`${dbPath}/export`, {output_format:'polling', current_bookmark:bookmark, dump_options:{no_schema:false,no_data:false,tables:[]}});
    if (result.status === 'complete') {
      const response = await fetch(result.result.signed_url, {signal:AbortSignal.timeout(180000)});
      assert(response.ok, 'Database export download failed');
      return await response.text();
    }
    assert(result.status !== 'error', 'Database export failed');
    bookmark = result.at_bookmark;
    await sleep(1000);
  }
  throw new Error('Database export timed out');
}
export function sqlite(sql) {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  return db;
}
export function tableProof(db) {
  const result = {};
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row => JSON.stringify(row)).sort();
    result[name] = {count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  }
  return result;
}
export function encrypt(name, content) {
  mkdirSync('recovery-artifacts', {recursive:true});
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(content)),cipher.final()]);
  writeFileSync(`recovery-artifacts/${name}.encrypted.json`, JSON.stringify({
    algorithm:'RSA-OAEP-SHA256+AES-256-GCM+gzip',
    key:publicEncrypt({key:readFileSync('scripts/prisoner-recovery-public.pem'),oaepHash:'sha256'},key).toString('base64'),
    iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64'),
  }));
}
export const savePlan = plan => writeFileSync('recovery-plan.json', JSON.stringify(plan,null,2));
export const loadPlan = () => JSON.parse(readFileSync('recovery-plan.json','utf8'));
export async function deploy(versions, message) {
  return api(`${worker}/deployments`, {strategy:'percentage',versions,annotations:{'workers/message':message}});
}
