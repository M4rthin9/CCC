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
    "SELECT timestamp, username, details, result FROM event_logs WHERE action='import_prisoners' ORDER BY rowid DESC LIMIT 8",
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
