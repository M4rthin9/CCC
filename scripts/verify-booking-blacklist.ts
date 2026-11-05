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
import { countPublicPrisonerBookings, insertReservation } from '../src/db/queries/reservations';
import { formatBangkok } from '../src/config';
import { CANCEL_RELEASE_DAYS } from '../src/constants';

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
const todayBangkok = formatBangkok(new Date()).slice(0, 10);
sqlite
  .prepare("INSERT INTO settings (key, value, savedBy, savedAt) VALUES ('admin_settings', ?, '', '')")
  .run(JSON.stringify({ bookingWindow: { open: true, openDates: [date] } }));
const body = { visitDateISO: date, visitorName: 'Guest', visitorId: 'TEST', visitorPhone: '0800000000' };
function seed(
  ref: string,
  prisonerId: string,
  bookingType = 'prisoner',
  extraPrisoners = '',
  visitDateISO = todayBangkok
) {
  sqlite
    .prepare(
      `INSERT INTO reservations (ref, prisonerId, bookingType, extraPrisoners, status, visitDateISO, visitorId)
    VALUES (?, ?, ?, ?, 'รอชำระเงิน', ?, 'TEST')`
    )
    .run(ref, prisonerId, bookingType, extraPrisoners, visitDateISO);
}
const state = (id: string) => sqlite.prepare('SELECT * FROM prisoner_booking_blacklist WHERE prisonerId = ?').get(id);

// All staff cancellation paths exempt the exact same dates that free capacity.
const earlyDate = new Date(`${todayBangkok}T00:00:00+07:00`);
earlyDate.setUTCDate(earlyDate.getUTCDate() + CANCEL_RELEASE_DAYS);
const releasedDate = formatBangkok(earlyDate).slice(0, 10);
for (const [i, cancel] of [
  (ref: string) => handleCancelBooking(env, { ref }, admin),
  (ref: string) => handleUpdateStatus(env, { ref, status: 'ยกเลิก' }, superadmin),
  (ref: string) => handleUpdateBooking(env, { ref, status: 'ยกเลิก' }, superadmin),
  (ref: string) => handleBulkBookingAction(env, { operation: 'cancel', refs: [ref] }, admin),
].entries()) {
  const ref = `EARLY-${i}`;
  seed(ref, ref, 'prisoner', `Extra|EXTRA-${i}|1`, releasedDate);
  assert.equal(await countPublicPrisonerBookings(env.DB, releasedDate), 1);
  const result = await cancel(ref);
  assert.ok(['ok', 'success'].includes(String(result.status)));
  assert.equal(await countPublicPrisonerBookings(env.DB, releasedDate), 0);
  assert.equal(state(ref), undefined, 'returned slot never adds a strike');
  assert.equal(state(`EXTRA-${i}`), undefined, 'shared prisoners are also exempt');
}

// Controlled timestamps prove the inclusive four-day cutoff and Bangkok midnight.
for (const [ref, cancelledAt, shouldCount] of [
  ['FIVE-DAYS', '2030-01-04T05:00:00.000Z', false],
  ['FOUR-DAYS', '2030-01-05T05:00:00.000Z', false],
  ['BEFORE-MIDNIGHT', '2030-01-05T16:59:59.999Z', false],
  ['AT-MIDNIGHT', '2030-01-05T17:00:00.000Z', true],
  ['THREE-DAYS', '2030-01-06T05:00:00.000Z', true],
  ['SAME-DAY', '2030-01-09T05:00:00.000Z', true],
] as const) {
  seed(ref, ref, 'prisoner', '', '2030-01-09');
  sqlite
    .prepare("UPDATE reservations SET status = 'ยกเลิก', cancellationRole = 'Admin', cancelAt = ? WHERE ref = ?")
    .run(cancelledAt, ref);
  const occupied = await countPublicPrisonerBookings(env.DB, '2030-01-09');
  assert.equal(state(ref)?.consecutiveCancellations ?? 0, shouldCount ? 1 : 0);
  assert.equal(occupied, shouldCount ? 1 : 0, 'strike and capacity release agree');
  sqlite.prepare('DELETE FROM reservations WHERE ref = ?').run(ref);
}

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
seed('VIS-between-early', 'P1', 'prisoner', '', releasedDate);
await handleCancelBooking(env, { ref: 'VIS-between-early' }, admin);
assert.equal(state('P1')!.consecutiveCancellations, 1, 'an exempt cancellation leaves the streak unchanged');
assert.equal(state('P1')!.bannedUntil, '');
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

// Upgrade a populated 0032 database: remove exempt strikes without erasing valid
// bans, paid resets, shared-prisoner history or events whose bookings were deleted.
const legacy = new DatabaseSync(':memory:');
const correction = '0033_exempt_released_booking_cancellations.sql';
for (const file of readdirSync('src/db/migrations')
  .filter((f) => f.endsWith('.sql') && f < correction)
  .sort()) {
  legacy.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
}
const cancellations: Array<() => void> = [];
function oldBooking(ref: string, prisonerId: string, early: boolean, minute: string, extraPrisoners = '') {
  legacy
    .prepare(
      `INSERT INTO reservations (ref, prisonerId, visitDateISO, status, extraPrisoners)
    VALUES (?, ?, ?, 'รอชำระเงิน', ?)`
    )
    .run(ref, prisonerId, early ? '2030-05-08' : '2030-05-02', extraPrisoners);
  cancellations.push(() =>
    legacy
      .prepare(
        `UPDATE reservations
    SET status = 'ยกเลิก', cancellationRole = 'Admin', cancelAt = ? WHERE ref = ?`
      )
      .run(`2030-05-01T05:${minute}:00.000Z`, ref)
  );
}
oldBooking('OLD-E1', 'EARLYONLY', true, '01', 'Shared|SHARED|1');
oldBooking('OLD-E2', 'EARLYONLY', true, '02', 'Shared|SHARED|1');
oldBooking('OLD-M1', 'MIXED', true, '01');
oldBooking('OLD-M2', 'MIXED', false, '02');
oldBooking('OLD-B1', 'STILLBANNED', true, '01');
oldBooking('OLD-B2', 'STILLBANNED', false, '02');
oldBooking('OLD-B3', 'STILLBANNED', false, '03');
oldBooking('OLD-P1', 'PAIDRESET', false, '01');
oldBooking('OLD-P2', 'PAIDRESET', true, '02');
oldBooking('OLD-U1', 'UNAFFECTED', false, '01');
oldBooking('OLD-U2', 'UNAFFECTED', false, '02');
oldBooking('OLD-D1', 'DELETED', true, '01');
oldBooking('OLD-D2', 'DELETED', true, '02');
for (const cancel of cancellations) cancel();
legacy.exec(`INSERT INTO prisoner_booking_outcomes (ref, prisonerId, kind, occurredAt)
  VALUES ('OLD-PAID', 'PAIDRESET', 'paid', '2030-05-01T05:03:00.000Z');
  INSERT INTO reservations_archive (ref, prisonerId, visitDateISO, status, cancelAt)
    SELECT ref, prisonerId, visitDateISO, status, cancelAt FROM reservations WHERE ref = 'OLD-E2';
  DELETE FROM reservations WHERE ref = 'OLD-E2' OR prisonerId = 'DELETED';`);
const oldState = (id: string) =>
  legacy.prepare('SELECT * FROM prisoner_booking_blacklist WHERE prisonerId = ?').get(id);
const unaffected = oldState('UNAFFECTED');
const deleted = oldState('DELETED');
assert.ok(oldState('EARLYONLY')!.bannedUntil);
const bookings = () =>
  JSON.stringify(
    ['reservations', 'reservations_archive'].map((table) => legacy.prepare(`SELECT * FROM ${table} ORDER BY ref`).all())
  );
const preservedBookings = bookings();
legacy.exec(readFileSync(`src/db/migrations/${correction}`, 'utf8'));
assert.equal(oldState('EARLYONLY'), undefined);
assert.equal(oldState('SHARED'), undefined);
assert.equal(oldState('MIXED')!.consecutiveCancellations, 1);
assert.equal(oldState('MIXED')!.bannedUntil, '');
assert.equal(oldState('STILLBANNED')!.bannedUntil, '2030-08-01T05:03:00.000Z');
assert.equal(oldState('STILLBANNED')!.consecutiveCancellations, 0);
assert.equal(oldState('PAIDRESET')!.consecutiveCancellations, 0);
assert.equal(oldState('PAIDRESET')!.bannedUntil, '');
assert.deepEqual(oldState('UNAFFECTED'), unaffected);
assert.deepEqual(oldState('DELETED'), deleted);
assert.equal(bookings(), preservedBookings, 'migration does not alter any reservation or payment field');
assert.equal(
  legacy
    .prepare(
      "SELECT COUNT(*) AS n FROM prisoner_booking_outcomes WHERE ref IN ('OLD-E1', 'OLD-E2', 'OLD-M1', 'OLD-B1', 'OLD-P2')"
    )
    .get()!.n,
  0
);
assert.equal(
  legacy
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('_released_booking_strikes', '_booking_blacklist_replay')"
    )
    .get()!.n,
  0
);
legacy.close();
console.log(
  'Dated VIS capacity, four-day release exemption, cancellation streaks, booking guards, expiry and existing-ban correction passed.'
);
