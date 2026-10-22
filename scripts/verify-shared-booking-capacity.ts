import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import {
  countReservationsByDate,
  countPublicPrisonerBookings,
  countActiveTableBookings,
  insertReservation,
} from '../src/db/queries/reservations';
import { getCountsByDate, getTableCountsByDate, handleCreateBooking } from '../src/routes/reservations';
import { handleSaveReservation, handleSaveTableReservation } from '../src/routes/public';
import { lastOpenDateISO } from '../src/services/bookingWindow';
import { TABLE_AGREEMENT_VERSION } from '../src/services/tableAgreement';
import { CANCELLED, CANCEL_RELEASE_DAYS } from '../src/constants';
import type { Env } from '../src/types';

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
const date = lastOpenDateISO();
const now = new Date().toISOString();
const admin = { username: 'admin', role: 'Superadmin', displayName: 'Admin', viaJwt: true };
sqlite.exec(
  "INSERT INTO users (username, password, role, displayName, createdAt) VALUES ('admin', 'test-only', 'Superadmin', 'Admin', '')"
);
sqlite.prepare("INSERT INTO settings (key, value, savedBy, savedAt) VALUES ('admin_settings', ?, '', '')").run(
  JSON.stringify({
    bookingWindow: { open: true, openDates: [date] },
    publicBooking: { perDay: 2 },
    tableBooking: { enabled: true, maintenance: false, perDay: 1 },
  })
);

function seed(ref: string, status: string, source = '', bookingType = 'prisoner', cancelAt = '', holdExpiresAt = '') {
  sqlite
    .prepare(
      `INSERT INTO reservations (ref, status, source, bookingType, visitDateISO, cancelAt, holdExpiresAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ref, status, source, bookingType, date, cancelAt, holdExpiresAt);
}
seed('VIS-admin', 'รอตรวจสอบผู้เข้าร่วม', 'admin');
seed('VIS-public', 'ไม่อนุมัติ');
const early = new Date(`${date}T00:00:00+07:00`);
early.setUTCDate(early.getUTCDate() - CANCEL_RELEASE_DAYS);
seed('VIS-released', CANCELLED, 'admin', 'prisoner', early.toISOString());
seed('VIS-late-cancel', CANCELLED, 'admin', 'prisoner', `${date}T00:00:00Z`);
seed('TBL-admin', 'ชำระแล้ว', 'admin-table', 'table');
seed('TBL-expired', 'รอชำระเงิน', 'public-table', 'table', '', '2000-01-01T00:00:00Z');
assert.equal(await countPublicPrisonerBookings(env.DB, date), 3, 'admin and public rows share cancellation rules');
assert.deepEqual(await countReservationsByDate(env.DB), { [date]: 3 });
assert.equal(
  await countActiveTableBookings(env.DB, date, now),
  1,
  'table pool stays independent and ignores expired holds'
);
sqlite.exec('DELETE FROM reservations');

// Warm the calendar cache before staff creates a booking; its next read must refresh.
assert.deepEqual((await getCountsByDate(env)).counts, {});
const body = { visitDateISO: date, visitorName: 'Test guest', visitorId: 'TEST', visitorPhone: '0800000000' };
assert.equal((await handleCreateBooking(env, { ...body, ref: 'VIS-admin-new', prisonerId: 'P1' }, admin)).status, 'ok');
assert.equal(((await getCountsByDate(env)).counts as Record<string, number>)[date], 1);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ success: true }));
try {
  assert.equal(
    (
      await handleSaveReservation(
        env,
        { ...body, ref: 'VIS-public-new', prisonerId: 'P2', turnstileToken: 'test' },
        { ip: '', userAgent: '' }
      )
    ).status,
    'ok'
  );
  const extraAdmin = await handleCreateBooking(env, { ...body, ref: 'VIS-admin-over', prisonerId: 'P3' }, admin);
  assert.equal(extraAdmin.status, 'ok', 'staff can exceed the public quota');
  assert.equal(((await getCountsByDate(env)).counts as Record<string, number>)[date], 3);
  const deniedPublic = await handleSaveReservation(
    env,
    {
      ...body,
      ref: 'VIS-public-over',
      prisonerId: 'P4',
      turnstileToken: 'test',
      source: 'admin',
      bypassCapacity: true,
    },
    { ip: '', userAgent: '' }
  );
  assert.equal(deniedPublic.full, true);
  assert.equal(await countPublicPrisonerBookings(env.DB, date), 3);

  assert.equal(
    (await handleCreateBooking(env, { ...body, ref: 'TBL-admin-new', bookingType: 'table' }, admin)).status,
    'ok'
  );
  assert.equal(((await getTableCountsByDate(env)).counts as Record<string, number>)[date], 1);
  const deniedTable = await handleSaveTableReservation(
    env,
    { ...body, turnstileToken: 'test', tableAgreementAccepted: true, tableAgreementVersion: TABLE_AGREEMENT_VERSION },
    { ip: '', userAgent: '' }
  );
  assert.equal(deniedTable.full, true);
  assert.equal((await handleCreateBooking(env, { ...body, bookingType: 'table' }, admin)).status, 'ok');
  assert.equal(((await getTableCountsByDate(env)).counts as Record<string, number>)[date], 2);
  assert.equal(
    (
      await handleSaveTableReservation(
        env,
        {
          ...body,
          turnstileToken: 'test',
          tableAgreementAccepted: true,
          tableAgreementVersion: TABLE_AGREEMENT_VERSION,
          source: 'admin-table',
          bypassCapacity: true,
        },
        { ip: '', userAgent: '' }
      )
    ).full,
    true,
    'public table requests cannot bypass the cap'
  );
} finally {
  globalThis.fetch = originalFetch;
}

// Competing public inserts cannot both take the last slot, regardless of pool.
for (const bookingType of ['prisoner', 'table']) {
  sqlite.exec('DELETE FROM reservations');
  const results = await Promise.all(
    ['public-one', 'public-two'].map((source) =>
      insertReservation(
        env.DB,
        {
          ...body,
          ref: `${bookingType}-${source}`,
          bookingType,
          source,
          status: 'รอชำระเงิน',
        },
        { perDay: 1, nowIso: now }
      )
    )
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get()!.n, 1);
}
sqlite.close();
console.log('Staff quota override, shared calendar counts and atomic public last-slot checks passed.');
