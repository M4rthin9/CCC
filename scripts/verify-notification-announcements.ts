import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { getAnnouncementsHandler, sendAnnouncementHandler } from '../src/routes/announcements';
import { getPushMessage } from '../src/services/notifications';
import { dispatchAction, type RouteCtx } from '../src/routes/dispatcher';
import type { Env } from '../src/types';

// Real SQLite executes the production SQL, including D1's atomic batch contract.
const sqlite = new DatabaseSync(':memory:');
for (const file of ['0005_add_notifications.sql', '0021_push_opening_alerts.sql', '0023_push_announcements.sql']) {
  sqlite.exec(readFileSync(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
}
sqlite.exec(`CREATE TABLE users (username TEXT, password TEXT, role TEXT, displayName TEXT, createdAt TEXT, passwordMigrated INTEGER);
  INSERT INTO users VALUES ('manager', '', 'Superadmin', '', '', 0), ('staff', '', 'Admin', '', '', 0);`);
let failBatch = false;
function prepare(sql: string) {
  let values: SQLInputValue[] = [];
  const statement = {
    bind(...params: SQLInputValue[]) {
      values = params;
      return statement;
    },
    async first() {
      return sqlite.prepare(sql).get(...values) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...values) };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  };
  return statement;
}
const db = {
  prepare,
  async batch(statements: ReturnType<typeof prepare>[]) {
    sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const [i, statement] of statements.entries()) {
        if (failBatch && i === 1) throw new Error('Simulated database failure');
        results.push(await statement.run());
      }
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};
let kicks = 0;
let failKick = false;
const env = {
  DB: db,
  NOTIFY_PUSH_ENABLED: 'true',
  PUSH_QUEUE: {
    async send() {
      if (failKick) throw new Error('Queue unavailable');
      kicks++;
    },
  },
} as unknown as Env;
const manager = { username: 'manager', role: 'Superadmin', displayName: '', viaJwt: true };
const staff = { ...manager, username: 'staff', role: 'Admin' };
const fresh = () => ({
  id: `ANN-${crypto.randomUUID()}`,
  subject: 'เปิดจองโต๊ะแล้ว',
  body: 'เชิญจองโต๊ะสำหรับบุคคลและองค์กรภายนอก',
  url: '/#/table-booking',
});
const count = () => Number(sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get()?.n);

assert.equal((await sendAnnouncementHandler(env, fresh(), staff)).status, 'error');
assert.equal((await getAnnouncementsHandler(env, staff)).status, 'error');
assert.equal((await sendAnnouncementHandler(env, fresh(), manager)).status, 'error', 'no recipients is actionable');
const now = new Date().toISOString();
const insertSub = sqlite.prepare(`INSERT INTO push_subscriptions VALUES (?, ?, 'key', 'auth', ?, ?, ?)`);
for (let i = 0; i < 85; i++) insertSub.run(`https://example.test/optin-${i}`, '', now, now, 1);
for (let i = 0; i < 3; i++) insertSub.run(`https://example.test/booking-${i}`, 'VIS-12345', now, now, 0);
for (const invalid of [
  { subject: '' },
  { subject: 'x'.repeat(101) },
  { body: 'x'.repeat(501) },
  { body: 123 },
  { url: 'https://outside.test/' },
  { url: 'javascript:alert(1)' },
  { id: 'bad' },
]) {
  assert.equal((await sendAnnouncementHandler(env, { ...fresh(), ...invalid }, manager)).status, 'error');
}
assert.equal(count(), 0);
env.NOTIFY_PUSH_ENABLED = 'false';
assert.equal((await sendAnnouncementHandler(env, fresh(), manager)).status, 'error');
env.NOTIFY_PUSH_ENABLED = 'true';

const announcement = fresh();
failBatch = true;
await assert.rejects(() => sendAnnouncementHandler(env, announcement, manager), /Simulated/);
assert.equal(
  sqlite.prepare('SELECT COUNT(*) AS n FROM push_announcements').get()?.n,
  0,
  'header rolls back with outbox'
);
assert.equal(count(), 0);
failBatch = false;
failKick = true;
assert.equal((await sendAnnouncementHandler(env, announcement, manager)).deliveryStarted, false);
assert.equal(count(), 85, 'every opt-in, including beyond one delivery batch, is queued');
assert.equal(kicks, 0);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient LIKE '%booking-%'").get()?.n, 0);
insertSub.run('https://example.test/later', '', now, now, 1);
failKick = false;
assert.equal((await sendAnnouncementHandler(env, announcement, manager)).deliveryStarted, true);
assert.equal(count(), 85, 'retry keeps original recipient snapshot');
assert.equal(kicks, 1);
assert.equal((await sendAnnouncementHandler(env, { ...announcement, body: 'changed' }, manager)).status, 'error');
assert.equal(kicks, 1, 'conflicting reuse does not restart delivery');
const message = await getPushMessage(env, 'https://example.test/optin-0');
assert.equal(message.title, announcement.subject);
assert.equal(message.body, announcement.body);
assert.equal(message.url, '/#/table-booking');
assert.equal(message.tag, announcement.id);
sqlite.prepare("UPDATE notifications SET createdAt = '2020-01-01T00:00:00Z' WHERE id = 1").run();
assert.equal(
  (await getPushMessage(env, 'https://example.test/optin-0')).body,
  announcement.body,
  'delayed pending announcement keeps its content'
);
sqlite.prepare("UPDATE notifications SET status = 'sent', sentAt = ? WHERE id = 1").run(now);
assert.equal(
  (await getPushMessage(env, 'https://example.test/optin-0')).body,
  announcement.body,
  'newly delivered older announcement keeps its content'
);
sqlite.prepare("UPDATE notifications SET status = 'failed' WHERE id = 2").run();
const overview = await getAnnouncementsHandler(env, manager);
assert.equal(overview.recipients, 86);
const history = overview.rows as { total: number; pending: number; sent: number; failed: number }[];
assert.ok(history[0]);
assert.equal(history[0].total, 85);
assert.equal(history[0].pending, 83);
assert.equal(history[0].sent, 1);
assert.equal(history[0].failed, 1);
assert.ok(!JSON.stringify(overview).includes('https://example.test/'), 'history contains no endpoint capabilities');
sqlite
  .prepare(
    `INSERT INTO notifications (ref,type,channel,recipient,subject,body,createdAt)
  VALUES ('VIS-12345','payment_confirmed','push','https://example.test/booking-0','Paid','Booking status',?)`
  )
  .run(now);
assert.equal((await getPushMessage(env, 'https://example.test/booking-0')).url, '/#/status?ref=VIS-12345');
sqlite
  .prepare(
    `INSERT INTO notifications (ref,type,channel,recipient,subject,body,createdAt)
  VALUES ('OPEN-test','booking_open','push','https://example.test/booking-1','Open','Booking opens',?)`
  )
  .run(now);
assert.equal((await getPushMessage(env, 'https://example.test/booking-1')).url, '/#/booking');

const ctx = {
  env,
  request: new Request('https://example.test/'),
  body: {},
  user: null,
  ip: '',
  userAgent: '',
} as unknown as RouteCtx;
for (const [action, isGet] of [
  ['getPushAnnouncements', true],
  ['getPushAnnouncements', false],
  ['sendPushAnnouncement', false],
] as const) {
  assert.equal(
    ((await (await dispatchAction(ctx, action, isGet)).json()) as { message: string }).message,
    'Unauthorized'
  );
}
ctx.user = manager;
assert.equal(
  ((await (await dispatchAction(ctx, 'getPushAnnouncements', true)).json()) as { status: string }).status,
  'ok'
);
assert.equal(
  ((await (await dispatchAction(ctx, 'sendPushAnnouncement', true)).json()) as { status: string }).status,
  'error',
  'GET cannot send'
);
sqlite.close();
console.log(
  'Notification announcement checks passed: authorization, SQL atomicity, opt-in recipients, retry deduplication, delivery history and existing push destinations. No network delivery used.'
);
