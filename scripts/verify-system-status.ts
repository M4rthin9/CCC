import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';
import {
  parseStatus,
  readSystemStatus,
  recordSystemStatus,
  STATUS_INTERVAL,
  STATUS_IDS,
} from '../src/services/systemStatus';
import type { Env } from '../src/types';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);');
const settings = {
  bookingWindow: { open: true },
  tableBooking: { enabled: true, maintenance: false },
  payment: { enabled: true },
  promptPay: { secret: 'PRIVATE_PAYMENT_VALUE' },
  promo: { notice: { enabled: true, title: '<script>notice</script>', body: 'Public announcement' } },
};
function saveSettings(value: unknown): void {
  sqlite
    .prepare("INSERT INTO settings VALUES ('admin_settings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(value));
}
saveSettings(settings);
let queries = 0;
let databaseDown = false;
let filesDown = false;
let kvDown = false;
let puts = 0;
let gets = 0;
const store = new Map<string, string>();
const db = {
  prepare(sql: string) {
    assert.match(sql, /^SELECT key, value FROM settings WHERE key = 'admin_settings'$/);
    queries++;
    return {
      async first() {
        if (databaseDown) throw new Error('PRIVATE_DB_ERROR');
        return sqlite.prepare(sql).get() ?? null;
      },
    };
  },
};
const kv = {
  async get(key: string) {
    gets++;
    if (kvDown) throw new Error('PRIVATE_KV_ERROR');
    return store.get(key) ?? null;
  },
  async put(key: string, value: string) {
    puts++;
    if (kvDown) throw new Error('PRIVATE_KV_ERROR');
    store.set(key, value);
  },
};
const env = {
  DB: db,
  CACHE_KV: kv,
  SLIPS: {
    async head() {
      if (filesDown) throw new Error('PRIVATE_R2_ERROR');
      return null;
    },
  },
  TURNSTILE_SECRET: 'private',
  ALLOWED_ORIGINS: 'https://cida.dpdns.org',
} as unknown as Env;
const at = Math.floor(Date.now() / STATUS_INTERVAL) * STATUS_INTERVAL;
assert.equal((await readSystemStatus(env, at)).stale, true);
assert.equal(queries, 0, 'No snapshot must not trigger live database work');
await recordSystemStatus(env, at);
assert.equal(queries, 1, 'One indexed settings read per probe');
assert.equal(puts, 1);
let status = await readSystemStatus(env, at);
assert.equal(status.stale, false);
assert.ok(status.services.every((s) => s.state === 'operational'));
assert.equal(status.history.length, 1, 'History starts from a real observation');
assert.equal(status.notice?.title, '<script>notice</script>', 'Notice is plain text');
assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|private|promptPay|TURNSTILE/);
await recordSystemStatus(env, at);
assert.equal(queries, 1, 'Duplicate cron slot does not read D1');
assert.equal(puts, 1, 'Duplicate cron slot does not spend writes');
databaseDown = true;
filesDown = true;
await recordSystemStatus(env, at + STATUS_INTERVAL);
status = await readSystemStatus(env, at + STATUS_INTERVAL);
assert.equal(status.services.find((s) => s.id === 'database')?.state, 'outage');
assert.equal(status.services.find((s) => s.id === 'visit')?.state, 'outage');
assert.equal(status.services.find((s) => s.id === 'files')?.state, 'outage');
assert.doesNotMatch(JSON.stringify(status), /PRIVATE_/);
databaseDown = false;
filesDown = false;
saveSettings({ ...settings, bookingWindow: { open: false } });
await recordSystemStatus(env, at + 2 * STATUS_INTERVAL);
status = await readSystemStatus(env, at + 2 * STATUS_INTERVAL);
assert.equal(status.services.find((s) => s.id === 'visit')?.state, 'maintenance');
assert.equal(status.services.find((s) => s.id === 'database')?.state, 'operational');
saveSettings({
  ...settings,
  tableBooking: { enabled: true, maintenance: false, opensAt: new Date(at + 10 * STATUS_INTERVAL).toISOString() },
});
await recordSystemStatus(env, at + 3 * STATUS_INTERVAL);
status = await readSystemStatus(env, at + 3 * STATUS_INTERVAL);
assert.equal(status.services.find((s) => s.id === 'table')?.state, 'maintenance');
assert.equal(status.services.find((s) => s.id === 'visit')?.state, 'operational');
const stale = await readSystemStatus(env, at + 10 * STATUS_INTERVAL);
assert.ok(stale.services.every((s) => s.state === 'unknown'));
assert.equal(stale.history.length, 4, 'Stale snapshots retain evidence without displaying green');
assert.equal(parseStatus('broken', at).checkedAt, null);
assert.equal(parseStatus(JSON.stringify({ version: 99, checkedAt: new Date(at).toISOString() }), at).checkedAt, null);
const oversized = {
  ...status,
  history: Array.from({ length: 2100 }, (_, n) => ({
    at: at - (2099 - n) * STATUS_INTERVAL,
    states: STATUS_IDS.map(() => 'operational'),
  })),
};
assert.ok(parseStatus(JSON.stringify(oversized), at).history.length <= 2016);
const edge = new Map<string, Response>();
Object.defineProperty(globalThis, 'caches', {
  configurable: true,
  value: {
    default: {
      async match(request: Request) {
        return edge.get(request.url)?.clone();
      },
      async put(request: Request, response: Response) {
        edge.set(request.url, response.clone());
      },
    },
  },
});
saveSettings(settings);
await recordSystemStatus(env, at + 4 * STATUS_INTERVAL);
const beforeQueries = queries,
  beforePuts = puts,
  beforeGets = gets;
const context = { waitUntil() {} } as unknown as ExecutionContext;
for (let n = 0; n < 100; n++) {
  const response = await worker.fetch(
    new Request(`https://worker.example/api/system-status?random=${n}`, {
      headers: { Origin: 'https://cida.dpdns.org' },
    }),
    env,
    context
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://cida.dpdns.org');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal(((await response.json()) as { version: number }).version, 1);
}
assert.equal(queries, beforeQueries, 'Public viewers never read D1');
assert.equal(puts, beforePuts, 'Public viewers never write KV');
assert.equal(gets - beforeGets, 1, 'Edge cache is shared despite arbitrary query strings');
edge.clear();
kvDown = true;
const failure = await worker.fetch(new Request('https://worker.example/api/system-status'), env, context);
assert.ok(((await failure.json()) as { services: { state: string }[] }).services.every((s) => s.state === 'unknown'));
assert.equal(queries, beforeQueries, 'KV failure never falls through to D1');
sqlite.close();
console.log(
  'System status passed: real SQLite probe, no writes, outages/maintenance/scheduled gates, bounded real history, stale/corrupt safety, no private fields, 100 public requests with zero D1 access and one KV read.'
);
