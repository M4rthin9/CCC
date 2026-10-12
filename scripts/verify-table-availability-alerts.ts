import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { handleCancelBooking, handlePublicCancelBooking } from '../src/routes/reservations';
import { handleSubscribe } from '../src/routes/notifications';
import { broadcastTableAvailability } from '../src/services/tableAvailability';
import { getPushMessage, drainPushes } from '../src/services/notifications';
import { formatBangkok } from '../src/config';
import { TABLE_AGREEMENT_VERSION } from '../src/services/tableAgreement';
import { countActiveTableBookings, countActiveTableBookingsByDate } from '../src/db/queries/reservations';
import { isBookableDate, parseBookingWindow } from '../src/services/bookingWindow';
import {
  TABLE_NOTIFICATION_READ_BUDGET,
  TABLE_NOTIFICATION_DAILY_ATTEMPTS,
  claimTablePushAttempt,
} from '../src/db/queries/tableAvailability';
import { handleGetPublicSettings } from '../src/routes/settings';
import type { Env } from '../src/types';

// Execute the actual migrations and SQL against SQLite, with D1's serialized,
// atomic batch contract. No network deliveries or production data are used.
const sqlite = new DatabaseSync(':memory:');
const migrations = new URL('../src/db/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort();
for (const file of migrationFiles.filter((name) => !name.startsWith('0027'))) {
  sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
}
const now = new Date();
const today = formatBangkok(now).slice(0, 10);
const future = (days: number) => {
  const date = new Date(today + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const day = future(7),
  otherDay = future(8);
const settings = {
  promptpay: { billerId: 'private-test' },
  tableBooking: { enabled: true, maintenance: false, perDay: 2, opensAt: '' },
  bookingWindow: { open: true, closedDates: {} as Record<string, string>, openDates: [day, otherDay] },
  scheduledOpenings: {} as Record<string, string>,
};
const saveSettings = () =>
  sqlite
    .prepare("INSERT OR REPLACE INTO settings (key,value,savedBy,savedAt) VALUES ('admin_settings',?,'test',?)")
    .run(JSON.stringify(settings), now.toISOString());
saveSettings();
const insert = (ref: string, date = day, status = 'ชำระแล้ว', hold = '', type = 'table') =>
  sqlite
    .prepare('INSERT INTO reservations (ref,visitDateISO,status,holdExpiresAt,bookingType) VALUES (?,?,?,?,?)')
    .run(ref, date, status, hold, type);
insert('TBL-00001');
insert('TBL-00002');
for (let i = 0; i < 85; i++)
  sqlite
    .prepare('INSERT INTO push_subscriptions VALUES (?,?, ?,?,?,?,?)')
    .run(`https://example.test/optin-${i}`, '', 'key', 'auth', now.toISOString(), now.toISOString(), 1);
sqlite
  .prepare('INSERT INTO push_subscriptions VALUES (?,?, ?,?,?,?,?)')
  .run('https://example.test/status-only', 'TBL-00001', 'key', 'auth', now.toISOString(), now.toISOString(), 0);
const reservationsBefore = sqlite.prepare('SELECT * FROM reservations').all();
const subscriptionsBefore = sqlite.prepare('SELECT * FROM push_subscriptions').all();
sqlite.exec(readFileSync(new URL('0027_table_availability_alerts.sql', migrations), 'utf8'));
assert.deepEqual(sqlite.prepare('SELECT * FROM reservations').all(), reservationsBefore);
assert.deepEqual(sqlite.prepare('SELECT * FROM push_subscriptions').all(), subscriptionsBefore);
assert.equal(sqlite.prepare('SELECT wasFull FROM table_availability WHERE visitDateISO = ?').get(day)?.wasFull, 1);
sqlite.exec(readFileSync(new URL('0027_table_availability_alerts.sql', migrations), 'utf8')); // idempotent expansion

let failBatch = false,
  failKick = false,
  failSettings = false,
  kicks = 0;
let settingsReads = 0;
let batchTail: Promise<unknown> = Promise.resolve();
function prepare(sql: string) {
  let values: SQLInputValue[] = [];
  const statement = {
    bind(...params: SQLInputValue[]) {
      values = params;
      return statement;
    },
    async first() {
      if (sql.includes("key = 'admin_settings'")) settingsReads++;
      if (failSettings && sql.includes("key = 'admin_settings'")) throw new Error('Settings unavailable');
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
  batch(statements: ReturnType<typeof prepare>[]) {
    const operation = batchTail.then(async () => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const [index, statement] of statements.entries()) {
          if (failBatch && index === 4) throw new Error('Batch unavailable');
          results.push(await statement.run());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    });
    batchTail = operation.catch(() => undefined);
    return operation;
  },
};
const env = {
  DB: db,
  NOTIFY_PUSH_ENABLED: 'true',
  NOTIFY_EVENT_ALLOWLIST: 'payment_due,payment_confirmed',
  PUSH_QUEUE: {
    async send() {
      if (failKick) throw new Error('Queue unavailable');
      kicks++;
    },
  },
} as unknown as Env;
const count = () =>
  Number(sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'table_available'").get()?.n);
const scan = () => broadcastTableAvailability(env, now);
assert.equal((await scan()).queued, 0, 'full dates do not generate alerts');
assert.equal(count(), 0);
const idleChanges = sqlite.prepare('SELECT total_changes() AS n').get()?.n;
for (let i = 0; i < 10; i++) await scan();
assert.equal(
  Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n) - Number(idleChanges),
  10,
  'idle scans write only one small admission counter, no availability states'
);
assert.equal((await handleCancelBooking(env, { ref: 'TBL-00002' }, { username: 'test-staff' })).status, 'ok');
assert.equal(count(), 85, 'real staff cancellation queues every opt-in, beyond one delivery batch');
assert.equal(
  sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient = 'https://example.test/status-only'").get()
    ?.n,
  0
);
assert.equal((await scan()).queued, 0, 'repeat scans do not duplicate an available transition');
assert.equal((await handlePublicCancelBooking(env, { ref: 'TBL-00002' })).noop, true);
assert.equal(count(), 85);
const message = await getPushMessage(env, 'https://example.test/optin-0');
assert.equal(message.title, 'มีโต๊ะว่างอีกครั้ง');
assert.equal(message.url, '/#/table-booking');
assert.match(String(message.body), /จำนวนที่ว่างอาจเปลี่ยน/);
sqlite.exec("UPDATE notifications SET status = 'sent'");

// Becoming full again arms the next independent availability event.
insert('TBL-00003');
await scan();
sqlite.prepare("UPDATE reservations SET status = 'ยกเลิก' WHERE ref = 'TBL-00003'").run();
const concurrent = await Promise.all([scan(), scan(), scan()]);
assert.equal(
  concurrent.reduce((sum, result) => sum + Number(result.queued), 0),
  85
);
assert.equal(count(), 170);
sqlite.exec("UPDATE notifications SET status = 'sent'");

// A hold expiring is counted immediately, without the housekeeping sweep.
insert('TBL-00004', day, 'รอชำระเงิน', new Date(now.getTime() + 60_000).toISOString());
await scan();
assert.equal(await countActiveTableBookings(env.DB, day, now.toISOString()), 2);
const later = new Date(now.getTime() + 60_001);
assert.equal(await countActiveTableBookings(env.DB, day, later.toISOString()), 1);
assert.equal((await countActiveTableBookingsByDate(env.DB, later.toISOString()))[day], 1);
assert.equal((await broadcastTableAvailability(env, later)).queued, 85);
assert.equal(
  sqlite.prepare("SELECT status FROM reservations WHERE ref = 'TBL-00004'").get()?.status,
  'รอชำระเงิน',
  'detection does not rewrite payment evidence'
);
sqlite.exec("UPDATE notifications SET status = 'sent'");

// Locked table terms remain enforced; subscribing does not loosen cancellation.
sqlite.prepare("DELETE FROM reservations WHERE ref = 'TBL-00004'").run();
insert('TBL-00005');
sqlite
  .prepare('UPDATE reservations SET tableAgreementVersion = ? WHERE ref = ?')
  .run(TABLE_AGREEMENT_VERSION, 'TBL-00005');
await scan();
assert.equal((await handlePublicCancelBooking(env, { ref: 'TBL-00005' })).changesLocked, true);
assert.equal((await scan()).queued, 0);

// Closed, maintenance, scheduled, holiday and out-of-window dates do not alert.
sqlite.prepare("UPDATE reservations SET status = 'ยกเลิก' WHERE ref = 'TBL-00005'").run();
settings.bookingWindow.open = false;
saveSettings();
assert.equal((await scan()).queued, 0);
settings.bookingWindow.open = true;
settings.tableBooking.maintenance = true;
saveSettings();
assert.equal((await scan()).queued, 0);
settings.tableBooking.maintenance = false;
settings.tableBooking.opensAt = new Date(now.getTime() + 60_000).toISOString();
saveSettings();
assert.equal((await scan()).queued, 0);
settings.tableBooking.opensAt = '';
settings.bookingWindow.closedDates[day] = 'ปิดกิจกรรม';
saveSettings();
assert.equal((await scan()).queued, 0);
delete settings.bookingWindow.closedDates[day];
settings.scheduledOpenings[day] = new Date(now.getTime() + 60_000).toISOString();
saveSettings();
assert.equal((await scan()).queued, 0);
delete settings.scheduledOpenings[day];
env.NOTIFY_PUSH_ENABLED = 'false';
saveSettings();
assert.equal((await scan()).queued, 0);
env.NOTIFY_PUSH_ENABLED = 'true';
failSettings = true;
await assert.rejects(scan, /Settings unavailable/);
failSettings = false;
failBatch = true;
const beforeFailure = count();
await assert.rejects(scan, /Batch unavailable/);
failBatch = false;
assert.equal(count(), beforeFailure, 'outbox and transition roll back together');
assert.equal(sqlite.prepare('SELECT wasFull FROM table_availability WHERE visitDateISO = ?').get(day)?.wasFull, 1);
failKick = true;
assert.equal((await scan()).deliveryStarted, false);
assert.equal(count(), beforeFailure + 85, 'failed queue kick retains durable recipient snapshot');
failKick = false;
const beforeKicks = kicks;
assert.equal((await scan()).deliveryStarted, true);
assert.equal(kicks, beforeKicks + 1, 'next scan restarts pending delivery');
assert.equal(count(), beforeFailure + 85);
sqlite.exec("UPDATE notifications SET status = 'sent'");

// A batch freeing multiple dates produces one message per subscriber.
insert('TBL-00006');
insert('TBL-00007', otherDay);
insert('TBL-00008', otherDay);
await scan();
const beforeBulk = count();
sqlite.prepare("UPDATE reservations SET status = 'ยกเลิก' WHERE ref IN ('TBL-00006','TBL-00008')").run();
assert.equal((await scan()).queued, 85);
assert.equal(count(), beforeBulk + 85);
const combined = await getPushMessage(env, 'https://example.test/optin-0');
const dateFormat = new Intl.DateTimeFormat('th-TH', { timeZone: 'UTC', day: 'numeric', month: 'long' });
for (const date of [day, otherDay])
  assert.ok(String(combined.body).includes(dateFormat.format(new Date(date + 'T00:00:00Z'))));

// The existing subscription API adds opening alerts without losing a followed booking.
assert.equal(
  (
    await handleSubscribe(env, {
      endpoint: 'https://example.test/status-only',
      p256dh: 'new-key',
      auth: 'new-auth',
      openingAlerts: true,
    })
  ).status,
  'ok'
);
const retained = sqlite
  .prepare('SELECT ref, openingAlerts FROM push_subscriptions WHERE endpoint = ?')
  .get('https://example.test/status-only');
assert.equal(retained?.ref, 'TBL-00001');
assert.equal(retained?.openingAlerts, 1);
assert.equal(
  (await handleSubscribe(env, { endpoint: 'https://example.test/no-consent', p256dh: 'key', auth: 'auth' })).status,
  'error'
);
assert.ok(kicks > 0);
// Exhausting the daily budget defers the whole audience without losing the transition.
sqlite.exec("UPDATE notifications SET status = 'sent'");
insert('TBL-00009');
await scan();
sqlite.prepare("UPDATE reservations SET status = 'ยกเลิก' WHERE ref = 'TBL-00009'").run();
const beforeBudget = count();
const utcDay = now.toISOString().slice(0, 10);
sqlite.prepare('UPDATE table_notification_budget SET recipients = 1000 WHERE day = ?').run(utcDay);
assert.equal((await scan()).queued, 0);
assert.equal(count(), beforeBudget);
assert.equal(
  sqlite.prepare('SELECT COUNT(*) AS n FROM table_notification_events WHERE complete = 0').get()?.n,
  1,
  'deferred transition has a durable header'
);
sqlite.prepare('UPDATE table_notification_budget SET recipients = 0 WHERE day = ?').run(utcDay);
assert.equal((await scan()).queued, 86, 'every subscriber receives the deferred event when headroom is restored');
const settledChanges = sqlite.prepare('SELECT total_changes() AS n').get()?.n;
await scan();
assert.equal(
  Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n) - Number(settledChanges),
  1,
  'available-state scans only update the admission counter'
);
sqlite
  .prepare('UPDATE table_notification_budget SET readsReserved = ? WHERE day = ?')
  .run(TABLE_NOTIFICATION_READ_BUDGET, utcDay);
const pausedChanges = sqlite.prepare('SELECT total_changes() AS n').get()?.n;
assert.equal((await scan()).skipped, 'read_budget');
assert.equal(
  sqlite.prepare('SELECT total_changes() AS n').get()?.n,
  pausedChanges,
  'exhausted budget stops scans and additional counter writes'
);
// More than one day's audience is paged, rather than dropped or blocked forever.
sqlite.prepare('UPDATE table_notification_budget SET recipients = 0, readsReserved = 0 WHERE day = ?').run(utcDay);
for (let i = 0; i < 1300; i++)
  sqlite
    .prepare('INSERT INTO push_subscriptions VALUES (?,?, ?,?,?,?,?)')
    .run(
      `https://example.test/bulk-${String(i).padStart(4, '0')}`,
      '',
      'key',
      'auth',
      now.toISOString(),
      now.toISOString(),
      1
    );
insert('TBL-00010');
await scan();
sqlite.prepare("UPDATE reservations SET status = 'ยกเลิก' WHERE ref = 'TBL-00010'").run();
const beforeLarge = count();
assert.equal((await scan()).queued, 1000);
assert.equal((await scan()).queued, 0);
assert.equal(count(), beforeLarge + 1000);
const tomorrow = new Date(now.getTime() + 86400000);
assert.equal((await broadcastTableAvailability(env, tomorrow)).queued, 386);
assert.equal(count(), beforeLarge + 1386, 'all 1,386 subscribers queued across days without duplication');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM table_notification_events WHERE complete = 0').get()?.n, 0);
const readsBeforeSettings = settingsReads;
const publicSettings = await handleGetPublicSettings(env, 'https://api.example.test');
assert.equal(settingsReads - readsBeforeSettings, 1, 'public settings read one snapshot instead of seven');
assert.equal((publicSettings.tableBooking as { perDay: number }).perDay, 2);
assert.ok(!JSON.stringify(publicSettings).includes('private-test'), 'private settings never leak');
sqlite
  .prepare('UPDATE table_notification_budget SET attempts = ? WHERE day = ?')
  .run(TABLE_NOTIFICATION_DAILY_ATTEMPTS - 1, utcDay);
const attemptClaims = await Promise.all([claimTablePushAttempt(env.DB, utcDay), claimTablePushAttempt(env.DB, utcDay)]);
assert.equal(
  attemptClaims.filter(Boolean).length,
  1,
  'concurrent attempt claims cannot exceed the daily retry allowance'
);
const kicksBeforePause = kicks;
assert.equal(
  (await drainPushes(env)).more,
  false,
  'budget-deferred rows stop the queue chain instead of endlessly requeuing'
);
assert.equal(kicks, kicksBeforePause);
// A deferred event should not spend the next day's budget on a date full again.
sqlite.prepare('UPDATE table_notification_budget SET recipients = 0, readsReserved = 0 WHERE day = ?').run(utcDay);
insert('TBL-00011');
await scan();
sqlite.prepare('UPDATE table_notification_budget SET recipients = 1000 WHERE day = ?').run(utcDay);
sqlite.prepare("UPDATE reservations SET status = 'ยกเลิก' WHERE ref = 'TBL-00011'").run();
const beforeStale = count();
assert.equal((await scan()).queued, 0);
insert('TBL-00012');
sqlite.prepare('UPDATE table_notification_budget SET recipients = 0 WHERE day = ?').run(utcDay);
assert.equal((await scan()).queued, 0);
assert.equal(count(), beforeStale);
assert.equal(
  sqlite.prepare('SELECT COUNT(*) AS n FROM table_notification_events WHERE complete = 0').get()?.n,
  0,
  'stale deferred vacancy is retired'
);
const calendarNow = new Date('2026-10-12T03:00:00Z');
const window = parseBookingWindow({ open: true });
assert.equal(isBookableDate('2026-10-13', window, calendarNow), false, 'public holiday');
assert.equal(isBookableDate('2026-10-17', window, calendarNow), false, 'weekend');
assert.equal(isBookableDate('2026-11-16', window, calendarNow), false, 'not yet inside rolling window');
assert.equal(isBookableDate('2026-10-12', window, calendarNow), false, 'same-day date');
assert.equal(
  isBookableDate('2026-10-17', parseBookingWindow({ openDates: ['2026-10-17'] }), calendarNow),
  true,
  'staff weekend override'
);
console.log(
  'PASS: preservation, cancellation/expiry, dedupe, opt-in, budget pause, 1,386 recipients across days, rollback/retry, idle writes, single settings read, and deep links.'
);
