import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { handleSaveReservation } from '../src/routes/public';
import {
  handleCancelBooking,
  handleCreateBooking,
  handlePublicCancelBooking,
  handleUpdateBooking,
  handleUpdateStatus,
  handleBulkBookingAction,
} from '../src/routes/reservations';
import { getPublicBookingConfig, publicCapacityForDate } from '../src/services/publicCapacity';
import { lastOpenDateISO } from '../src/services/bookingWindow';
import type { Env } from '../src/types';
import { insertReservation } from '../src/db/queries/reservations';

const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('src/db/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  sqlite.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
}
const env = {
  DB: {
    prepare(sql: string) {
      let args: Array<string | number | null> = [];
      const statement = {
        bind(...values: Array<string | number | null>) {
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
  TURNSTILE_SECRET: 'test-only',
  NOTIFY_EVENT_ALLOWLIST: 'skip-all',
} as unknown as Env;
const admin = { username: 'admin', role: 'Admin', displayName: 'Admin', viaJwt: true };
const superadmin = { ...admin, username: 'superadmin', role: 'Superadmin' };
for (const user of [admin, superadmin]) {
  sqlite
    .prepare('INSERT INTO users (username, password, role, displayName, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(user.username, 'test-only', user.role, user.displayName, '');
}
const date = lastOpenDateISO();
const now = new Date().toISOString();
sqlite
  .prepare("INSERT INTO settings (key, value, savedBy, savedAt) VALUES ('admin_settings', ?, '', '')")
  .run(JSON.stringify({ bookingWindow: { open: true, openDates: [date] } }));
const body = { visitDateISO: date, visitorName: 'Guest', visitorId: 'TEST', visitorPhone: '0800000000' };
function seed(ref: string, prisonerId: string, bookingType = 'prisoner', extraPrisoners = '') {
  sqlite
    .prepare(
      `INSERT INTO reservations (ref, prisonerId, bookingType, extraPrisoners, status, visitDateISO, visitorId)
    VALUES (?, ?, ?, ?, 'รอชำระเงิน', ?, 'TEST')`
    )
    .run(ref, prisonerId, bookingType, extraPrisoners, date);
}
const state = (id: string) => sqlite.prepare('SELECT * FROM prisoner_booking_blacklist WHERE prisonerId = ?').get(id);

// Inclusive capacity boundary is based on visit date, including legacy saved settings.
for (const raw of [undefined, { perDay: 20 }]) {
  sqlite
    .prepare("UPDATE settings SET value = ? WHERE key = 'admin_settings'")
    .run(JSON.stringify({ publicBooking: raw }));
  const config = await getPublicBookingConfig(env);
  assert.equal(publicCapacityForDate(config, '2026-11-08'), 20);
  assert.equal(publicCapacityForDate(config, '2026-11-09'), 25);
  assert.equal(publicCapacityForDate(config, '2027-01-01'), 25);
}
for (const [visitDateISO, cap] of [
  ['2026-11-08', 20],
  ['2026-11-09', 25],
] as const) {
  for (let n = 0; n < cap; n++) {
    assert.equal(
      await insertReservation(
        env.DB,
        { ref: `CAP-${visitDateISO}-${n}`, bookingType: 'prisoner', visitDateISO, status: 'รอชำระเงิน' },
        { perDay: cap, nowIso: now }
      ),
      true
    );
  }
  assert.equal(
    await insertReservation(
      env.DB,
      { ref: `CAP-${visitDateISO}-overflow`, bookingType: 'prisoner', visitDateISO, status: 'รอชำระเงิน' },
      { perDay: cap, nowIso: now }
    ),
    false
  );
}
sqlite.exec("DELETE FROM reservations WHERE ref LIKE 'CAP-%'");
sqlite
  .prepare("UPDATE settings SET value = ? WHERE key = 'admin_settings'")
  .run(JSON.stringify({ bookingWindow: { open: true, openDates: [date] } }));

seed('VIS-first', 'P1');
assert.ok(
  (await Promise.all([1, 2].map(() => handleCancelBooking(env, { ref: 'VIS-first' }, admin)))).every(
    (r) => r.status === 'ok'
  )
);
assert.equal(state('P1')!.consecutiveCancellations, 1);
await Promise.all([1, 2].map(() => handleCancelBooking(env, { ref: 'VIS-first' }, admin)));
assert.equal(state('P1')!.consecutiveCancellations, 1, 'retry cannot double-count');
seed('VIS-second', 'P1', 'prisoner', 'Extra|P-extra|1');
assert.equal(
  (await handleBulkBookingAction(env, { operation: 'cancel', refs: ['VIS-second'] }, superadmin)).status,
  'success'
);
assert.ok(String(state('P1')!.bannedUntil) > now);
assert.equal(state('P-extra')!.consecutiveCancellations, 1, 'shared prisoners also receive a strike');
assert.equal((await handleCreateBooking(env, { ...body, prisonerId: 'P1' }, superadmin)).banned, true);
assert.equal((await handleUpdateStatus(env, { ref: 'VIS-second', status: 'รอชำระเงิน' }, superadmin)).banned, true);
assert.equal((await handleUpdateBooking(env, { ref: 'VIS-second', status: 'รอชำระเงิน' }, superadmin)).banned, true);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ success: true }));
try {
  assert.equal(
    (
      await handleSaveReservation(
        env,
        { ...body, ref: 'VIS-bypass', prisonerId: 'P1', turnstileToken: 'test' },
        { ip: '', userAgent: '' }
      )
    ).banned,
    true
  );
} finally {
  globalThis.fetch = originalFetch;
}
assert.throws(() => seed('VIS-db-bypass', 'P1'), /PRISONER_BOOKING_BANNED/);
assert.throws(() => seed('VIS-extra-bypass', 'OTHER', 'prisoner', 'Name|P1|1'), /PRISONER_BOOKING_BANNED/);
sqlite.prepare('DELETE FROM reservations WHERE prisonerId = ?').run('P1');
assert.ok(state('P1')!.bannedUntil, 'deletion preserves the ban');
sqlite
  .prepare('UPDATE prisoner_booking_blacklist SET bannedUntil = ? WHERE prisonerId = ?')
  .run('2000-01-01T00:00:00.000Z', 'P1');
assert.equal(
  (await handleCreateBooking(env, { ...body, prisonerId: 'P1' }, superadmin)).status,
  'ok',
  'expired ban permits booking without cron'
);

// Public cancellations, other roles and TBL bookings never add staff strikes.
seed('VIS-public', 'PUBLIC');
await handlePublicCancelBooking(env, { ref: 'VIS-public', visitorId: 'TEST' });
assert.equal(state('PUBLIC'), undefined);
seed('VIS-vinai', 'VINAI');
await handleUpdateStatus(env, { ref: 'VIS-vinai', status: 'ยกเลิก' }, { username: 'vinai', role: 'Vinai' });
assert.equal(state('VINAI'), undefined);
seed('TBL-one', '', 'table');
await handleCancelBooking(env, { ref: 'TBL-one' }, admin);
assert.equal(state(''), undefined);
seed('VIS-declined', 'DECLINED');
await handleUpdateStatus(env, { ref: 'VIS-declined', status: 'ไม่อนุมัติ' }, admin);
assert.equal(state('DECLINED'), undefined);

seed('VIS-reset-first', 'RESET');
await handleCancelBooking(env, { ref: 'VIS-reset-first' }, admin);
seed('VIS-paid', 'RESET');
await handleUpdateStatus(env, { ref: 'VIS-paid', status: 'ชำระแล้ว' }, superadmin);
assert.equal(state('RESET')!.consecutiveCancellations, 0);
seed('VIS-reset-second', 'RESET');
await handleUpdateBooking(env, { ref: 'VIS-reset-second', status: 'ยกเลิก' }, superadmin);
assert.equal(state('RESET')!.consecutiveCancellations, 1);
assert.equal(state('RESET')!.bannedUntil, '');

// Calendar months clamp month ends, preserve Thai local time, and handle leap years.
for (const [at, expected] of [
  ['2027-08-31T10:30:00.000Z', '2027-11-30T10:30:00.000Z'],
  ['2027-11-30T10:30:00.000Z', '2028-02-29T10:30:00.000Z'],
  ['2027-08-31T18:30:00.000Z', '2027-11-30T18:30:00.000Z'],
] as const) {
  for (const n of [1, 2])
    sqlite
      .prepare(
        `INSERT INTO prisoner_booking_outcomes (ref, prisonerId, kind, occurredAt)
    VALUES (?, ?, 'cancelled', ?)`
      )
      .run(`DATE-${at}-${n}`, at, at);
  assert.equal(state(at)!.bannedUntil, expected);
}
sqlite.close();
console.log('Dated VIS capacity, cancellation streaks, durable bans, booking guards and three-month expiry passed.');
