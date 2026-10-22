import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import {
  parseBookingWindow,
  scheduledOpeningsError,
  isBookableDate,
  bookingWindowError,
} from '../src/services/bookingWindow';
import { handleGetPublicSettings, handleSaveSettings } from '../src/routes/settings';
import { handleSaveReservation, handleSaveTableReservation } from '../src/routes/public';
import { lastOpenDateISO } from '../src/services/bookingWindow';
import { TABLE_AGREEMENT_VERSION } from '../src/services/tableAgreement';
import type { Env } from '../src/types';

const roundDate = '2026-10-25';
const at = '2026-10-22T03:01:00.000Z';
const schedule = { [roundDate]: at };
assert.equal(scheduledOpeningsError(undefined), null);
assert.equal(scheduledOpeningsError({}), null);
assert.equal(scheduledOpeningsError(schedule), null);
for (const bad of [
  null,
  [],
  'bad',
  { bad: at },
  { [roundDate]: 'bad' },
  { [roundDate]: '2026-10-22T10:01' },
  { [roundDate]: `${roundDate}T00:00:00+07:00` },
]) {
  assert.ok(scheduledOpeningsError(bad));
}
const window = parseBookingWindow({ open: true, openDates: [roundDate] }, schedule);
assert.equal(isBookableDate(roundDate, window, new Date(Date.parse(at) - 1)), false);
assert.equal(isBookableDate(roundDate, window, new Date(at)), true);
assert.equal(isBookableDate(roundDate, { ...window, open: false }, new Date(at)), false);
assert.equal(isBookableDate(roundDate, { ...window, closedDates: { [roundDate]: 'closed' } }, new Date(at)), false);

const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('src/db/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  sqlite.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
}
const env = {
  DB: {
    prepare(sql: string) {
      let args: SQLInputValue[] = [];
      const statement = {
        bind(...values: SQLInputValue[]) {
          args = values;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((s) => s.run()));
    },
  },
} as unknown as Env;
sqlite.exec(
  "INSERT INTO users (username,password,role,displayName,createdAt) VALUES ('manager','','Superadmin','',''),('viewer','','User','','')"
);
const settings = {
  payment: { enabled: false },
  promptpay: { billerId: 'private' },
  bookingWindow: { open: true, openDates: [roundDate], closedDates: {} },
  scheduledOpenings: schedule,
};
assert.equal((await handleSaveSettings(env, { settings }, { username: 'viewer' })).status, 'error');
assert.equal((await handleSaveSettings(env, { settings }, { username: 'manager' })).status, 'ok');
const saved = sqlite.prepare("SELECT value FROM settings WHERE key='admin_settings'").get()!.value;
assert.equal(
  (
    await handleSaveSettings(
      env,
      { settings: { ...settings, scheduledOpenings: { [roundDate]: 'broken' } } },
      { username: 'manager' }
    )
  ).status,
  'error'
);
assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='admin_settings'").get()!.value, saved);
const published = await handleGetPublicSettings(env, 'https://test.invalid');
assert.deepEqual((published.bookingWindow as { openAt: unknown }).openAt, schedule);
assert.equal(published.paymentEnabled, false);
assert.equal(published.promptpay, undefined);

// Public callers cannot book early by skipping the countdown UI, in either pool.
const date = lastOpenDateISO();
const future = new Date(Date.now() + 60_000).toISOString();
const pending = {
  ...settings,
  bookingWindow: { open: true, openDates: [date] },
  scheduledOpenings: { [date]: future },
  tableBooking: { enabled: true, maintenance: false },
};
assert.equal((await handleSaveSettings(env, { settings: pending }, { username: 'manager' })).status, 'ok');
assert.ok(bookingWindowError(parseBookingWindow(pending.bookingWindow, pending.scheduledOpenings), date));
const body = { ref: 'VIS-EARLY', visitDateISO: date };
assert.equal((await handleSaveReservation(env, body, { ip: '', userAgent: '' })).closed, true);
assert.equal(
  (
    await handleSaveTableReservation(
      env,
      { ...body, tableAgreementAccepted: true, tableAgreementVersion: TABLE_AGREEMENT_VERSION },
      { ip: '', userAgent: '' }
    )
  ).closed,
  true
);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get()!.n, 0);
sqlite.close();
console.log('Special opening validation, permissions, publication, boundary and early-booking checks passed.');
