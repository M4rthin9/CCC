import { DatabaseSync } from 'node:sqlite';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Missing Cloudflare credentials');
async function api(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(JSON.stringify({ status: response.status, errors: data.errors }));
  return data.result;
}
const databases = await api('database');
console.log('DATABASES', JSON.stringify(databases.map(d => ({name: d.name, uuid: d.uuid}))));
for (const db of databases.filter(d => ['ccc-reservations', 'ccc-reservations-dev'].includes(d.name))) {
  const queries = [
    "SELECT count(*) AS prisoners FROM prisoners",
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%prison%' OR name LIKE '%backup%')",
    "SELECT timestamp, username, details, result FROM event_log WHERE action='import_prisoners' ORDER BY rowid DESC LIMIT 8",
    "SELECT key, length(value) AS bytes, expires_at FROM d1_cache WHERE key='prisoners'",
  ];
  for (const sql of queries) {
    try { console.log(db.name, sql, JSON.stringify(await api(`database/${db.uuid}/query`, {sql}))); }
    catch (error) { console.log(db.name, error.message); }
  }
  if (db.name === 'ccc-reservations') {
    console.log('CURRENT BOOKMARK', JSON.stringify(await api(`database/${db.uuid}/time_travel/bookmark`)));
    console.log('BEFORE INCIDENT BOOKMARK', JSON.stringify(await api(`database/${db.uuid}/time_travel/bookmark?timestamp=2026-10-15T08%3A22%3A00Z`)));
  }
}
const prod = databases.find(d => d.name === 'ccc-reservations');
const before = await api(`database/${prod.uuid}/time_travel/bookmark?timestamp=2026-10-15T08%3A22%3A00Z`);
try {
  let bookmark = before.bookmark;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await api(`database/${prod.uuid}/export`, {
      output_format: 'polling',
      current_bookmark: bookmark,
      dump_options: { tables: ['prisoners', 'event_log'], no_schema: false, no_data: false },
    });
    console.log('HISTORICAL EXPORT STATUS', result.status);
    if (result.status === 'complete') {
      const download = await fetch(result.result.signed_url);
      if (!download.ok) throw new Error('Export download failed');
      const db = new DatabaseSync(':memory:');
      db.exec(await download.text());
      console.log('EXPORTED PRISONER COUNT', db.prepare('SELECT count(*) AS count FROM prisoners').get());
      console.log('EXPORTED LAST IMPORT', db.prepare("SELECT timestamp, details FROM event_log WHERE action='import_prisoners' ORDER BY rowid DESC LIMIT 1").get());
      break;
    }
    if (result.status === 'error') throw new Error('Historical export unavailable');
    bookmark = result.at_bookmark;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} catch (error) { console.log('HISTORICAL EXPORT RESULT', error.message); }
