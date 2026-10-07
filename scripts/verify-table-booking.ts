import assert from 'node:assert/strict';
import { parseTableBookingConfig, tableBookingOpeningError } from '../src/services/tableCapacity';
import { TABLE_AGREEMENT_VERSION, tableAgreementError } from '../src/services/tableAgreement';
import { handleSaveTableReservation } from '../src/routes/public';
import { handleGetPublicSettings, handleSetTableBookingStatus } from '../src/routes/settings';
import type { Env } from '../src/types';
import { lastOpenDateISO } from '../src/services/bookingWindow';
import { handlePublicCancelBooking } from '../src/routes/reservations';

const opening = new Date('2026-10-07T05:00:00Z');
const config = parseTableBookingConfig({ enabled: true, maintenance: false, opensAt: opening.toISOString() });
assert.ok(tableBookingOpeningError(config, new Date(opening.getTime() - 1)));
assert.equal(tableBookingOpeningError(config, opening), null);
assert.equal(tableBookingOpeningError(config, new Date(opening.getTime() + 1)), null);
assert.ok(tableBookingOpeningError({ ...config, enabled: false }, opening));
assert.ok(tableBookingOpeningError({ ...config, maintenance: true }, opening));
assert.ok(tableBookingOpeningError(parseTableBookingConfig({ maintenance: false, opensAt: 'invalid' })));
assert.ok(tableBookingOpeningError(parseTableBookingConfig(undefined)));
assert.equal(tableBookingOpeningError(parseTableBookingConfig({ maintenance: false })), null);

const agreement = { tableAgreementAccepted: true, tableAgreementVersion: TABLE_AGREEMENT_VERSION };
assert.equal(tableAgreementError(agreement), null);
for (const body of [
  {},
  { ...agreement, tableAgreementAccepted: false },
  { ...agreement, tableAgreementAccepted: 'true' },
  { ...agreement, tableAgreementVersion: 'old' },
  { ...agreement, tableAgreementVersion: 'tbl-2026-10-07-v1' },
]) {
  assert.ok(tableAgreementError(body));
}

let settings: Record<string, unknown> = {
  promptpay: { billerId: 'private' },
  payment: { enabled: true },
  bookingWindow: { open: true },
  tableBooking: { enabled: false, maintenance: true, perDay: 7, holdMinutes: 45, seatsPerTable: 4 },
};
let writes = 0;
const savedBookings: Record<string, unknown>[] = [];
const db = {
  prepare(sql: string) {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first() {
        if (sql.includes('FROM users'))
          return { username: params[0], role: params[0] === 'manager' ? 'Superadmin' : 'Visitor' };
        if (sql.includes("key = 'admin_settings'")) return { value: JSON.stringify(settings) };
        if (sql.includes('SELECT COUNT(*) AS n FROM reservations')) return { n: savedBookings.length };
        throw new Error(`Unexpected query: ${sql}`);
      },
      async all() {
        if (sql.includes('FROM reservations WHERE ref = ?')) {
          return { results: savedBookings.filter((row) => row.ref === params[0]) };
        }
        return { results: [] };
      },
      async run() {
        writes++;
        if (sql.includes("VALUES ('admin_settings'")) settings = JSON.parse(String(params[0]));
        if (sql.startsWith('INSERT INTO reservations (')) {
          const columns = sql
            .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
            .split(',')
            .map((column) => column.trim());
          savedBookings.push(Object.fromEntries(columns.map((column, index) => [column, params[index]])));
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
    return statement;
  },
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map((s) => s.run()));
  },
};
const env = { DB: db } as unknown as Env;
const before = Date.now();
const scheduled = await handleSetTableBookingStatus(env, { enabled: true }, { username: 'manager' });
const after = Date.now();
assert.equal(scheduled.status, 'ok');
const at = Date.parse(String(scheduled.opensAt));
assert.ok(at >= before + 7_200_000 && at <= after + 7_200_000, 'opening must be exactly two hours from server time');
assert.deepEqual(settings.tableBooking, {
  enabled: true,
  maintenance: false,
  perDay: 7,
  holdMinutes: 45,
  seatsPerTable: 4,
  opensAt: scheduled.opensAt,
});
assert.deepEqual(settings.promptpay, { billerId: 'private' });
assert.deepEqual(settings.payment, { enabled: true });

const publicSettings = await handleGetPublicSettings(env, 'https://api.example');
assert.equal('promptpay' in publicSettings, false);
assert.equal((publicSettings.tableBooking as Record<string, unknown>).opensAt, scheduled.opensAt);
assert.ok(Number.isFinite(Date.parse(String((publicSettings.tableBooking as Record<string, unknown>).serverTime))));

const writesBeforeGuards = writes;
const pending = await handleSaveTableReservation(env, agreement, { ip: '', userAgent: '' });
assert.equal(pending.closed, true, 'an API submission during the countdown must be blocked');
assert.equal(pending.opensAt, scheduled.opensAt);
assert.equal(writes, writesBeforeGuards);
const denied = await handleSetTableBookingStatus(env, { enabled: false }, { username: 'visitor' });
assert.equal(denied.status, 'error');
assert.equal(writes, writesBeforeGuards, 'users without permission must not change settings');
assert.equal((await handleSetTableBookingStatus(env, { enabled: 'true' }, { username: 'manager' })).status, 'error');

await handleSetTableBookingStatus(env, { enabled: false }, { username: 'manager' });
assert.equal((settings.tableBooking as Record<string, unknown>).opensAt, '');
assert.equal((settings.tableBooking as Record<string, unknown>).maintenance, true);
assert.equal((await handleSaveTableReservation(env, agreement, { ip: '', userAgent: '' })).closed, true);
assert.deepEqual(settings.payment, { enabled: true }, 'closing TBL must preserve existing payment access');

settings.tableBooking = { enabled: true, maintenance: false, opensAt: new Date(Date.now() - 1000).toISOString() };
const writesBeforeAgreement = writes;
assert.equal((await handleSaveTableReservation(env, {}, { ip: '', userAgent: '' })).agreementRequired, true);
assert.equal(
  (await handleSaveTableReservation(env, { ...agreement, tableAgreementVersion: 'old' }, { ip: '', userAgent: '' }))
    .agreementRequired,
  true
);
assert.equal(writes, writesBeforeAgreement, 'unaccepted terms must never create a reservation');

const visitDate = lastOpenDateISO();
settings.bookingWindow = { open: true, openDates: [visitDate] };
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
try {
  const created = await handleSaveTableReservation(
    { ...env, TURNSTILE_SECRET: 'test-secret', NOTIFY_EVENT_ALLOWLIST: 'skip-all' },
    {
      ...agreement,
      turnstileToken: 'test-token',
      visitDateISO: visitDate,
      visitorName: 'Test guest',
      visitorPhone: '0800000000',
      visitorId: 'TEST12345',
      total: 1,
      tableAgreementAcceptedAt: 'fake-client-timestamp',
    },
    { ip: '', userAgent: '' }
  );
  assert.equal(created.status, 'ok');
  assert.match(String(created.ref), /^TBL-/);
  assert.equal(savedBookings.length, 1);
  assert.equal(savedBookings[0]!.tableAgreementVersion, TABLE_AGREEMENT_VERSION);
  assert.ok(Number.isFinite(Date.parse(String(savedBookings[0]!.tableAgreementAcceptedAt))));
  assert.notEqual(savedBookings[0]!.tableAgreementAcceptedAt, 'fake-client-timestamp');
  assert.equal(savedBookings[0]!.tableAgreementAcceptedAt, savedBookings[0]!.createdAt);
  assert.equal(savedBookings[0]!.status, 'รอชำระเงิน');
  assert.equal(savedBookings[0]!.total, 1000, 'table bookings retain server-authoritative pricing');
  const writesBeforeCancel = writes;
  const cancel = await handlePublicCancelBooking(env, { ref: created.ref });
  assert.equal(cancel.status, 'error');
  assert.equal(cancel.changesLocked, true);
  assert.equal(writes, writesBeforeCancel, 'public cancellation cannot alter a booking confirmed under final terms');

  savedBookings.push({ ...savedBookings[0], ref: 'TBL-LEGACY', tableAgreementVersion: 'tbl-2026-10-07-v1' });
  assert.equal(
    (await handlePublicCancelBooking({ ...env, NOTIFY_EVENT_ALLOWLIST: 'skip-all' }, { ref: 'TBL-LEGACY' })).status,
    'ok',
    'older TBL bookings retain their accepted policy'
  );
  savedBookings.push({ ...savedBookings[0], ref: 'VIS-LEGACY', bookingType: 'prisoner', tableAgreementVersion: '' });
  assert.equal(
    (await handlePublicCancelBooking({ ...env, NOTIFY_EVENT_ALLOWLIST: 'skip-all' }, { ref: 'VIS-LEGACY' })).status,
    'ok',
    'VIS cancellation remains unchanged'
  );
} finally {
  globalThis.fetch = fetchBefore;
}

console.log(
  'TBL checks passed: two-hour boundary, defaults, permissions, preserved settings, API guards, cancellation, and required agreement.'
);
