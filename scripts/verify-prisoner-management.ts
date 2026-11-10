import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env, Prisoner } from '../src/types';
import {
  handleGetPrisonersAdmin,
  handleUpdatePrisoner,
  handleImportPrisoners,
  handleGetPrisoners,
} from '../src/routes/prisoners';
import { handleGetBookingBlacklist, handleUpdateBookingBan } from '../src/routes/bookingBlacklist';
import { getPrisonerDiscipline } from '../src/services/disciplineService';
import { prisonerBookingBanError, threeMonthBanExpiry } from '../src/services/bookingBlacklist';
import { handleCreateBooking } from '../src/routes/reservations';
import { lastOpenDateISO } from '../src/services/bookingWindow';
import { dispatchAction } from '../src/routes/dispatcher';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync('src/db/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  db.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
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
          return db.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async run() {
          return { success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  },
  NOTIFY_EVENT_ALLOWLIST: 'skip-all',
} as unknown as Env;
const superadmin = { username: 'superadmin', role: 'Superadmin', displayName: 'Test', viaJwt: true };
const admin = { username: 'admin', role: 'Admin' };
const vinai = { username: 'vinai', role: 'Vinai' };
for (const role of ['Superadmin', 'Admin', 'Vinai', 'Finance', 'Tadtel', 'User']) {
  db.prepare("INSERT INTO users (username, password, role, displayName, createdAt) VALUES (?, 'test', ?, '', '')").run(
    role.toLowerCase(),
    role
  );
}
for (const [id, name, wing, status, date, note] of [
  ['P1', 'คนที่หนึ่ง', '1', '', '', 'หมายเหตุเดิมหนึ่ง'],
  ['P2', 'คนที่สอง', '2', 'ติดวินัย งดเยี่ยม', '2099-01-01', 'หมายเหตุเดิมสอง'],
  ['P3', 'คนที่สาม', '3', '', '', 'หมายเหตุเดิมสาม'],
] as const) {
  db.prepare('INSERT INTO prisoners VALUES (?, ?, ?, ?, ?, ?)').run(id, name, wing, status, date, note);
  db.prepare(
    "INSERT INTO reservations (ref, prisonerId, wing, status, total, visitDateISO) VALUES (?, ?, ?, 'รอชำระเงิน', 3000, ?)"
  ).run(`VIS-${id}`, id, wing, lastOpenDateISO());
}
db.exec("INSERT INTO prisoner_booking_blacklist VALUES ('P3', 1, '')");
db.exec("INSERT INTO prisoner_booking_blacklist VALUES ('FORMER', 1, '2000-01-01T00:00:00.000Z')");
const prisoner = (id: string) => db.prepare('SELECT * FROM prisoners WHERE prisonerId = ?').get(id);
const roster = () => db.prepare('SELECT * FROM prisoners ORDER BY prisonerId').all();
const bans = () => db.prepare('SELECT * FROM prisoner_booking_blacklist ORDER BY prisonerId').all();
const bookings = () => db.prepare('SELECT * FROM reservations ORDER BY ref').all();
const others = [prisoner('P2'), prisoner('P3')];
const originalBookings = bookings();
const originalBans = bans();

// The dashboard calls these actions through POST; none expose administrative
// details or mutations to public callers, even with a forged role in the body.
for (const action of ['getPrisonersAdmin', 'updatePrisoner', 'getBookingBlacklist', 'updateBookingBan']) {
  const result = await dispatchAction(
    {
      env,
      body: { prisonerId: 'P1', operation: 'ban', role: 'Superadmin' },
      request: new Request('http://localhost/', { method: 'POST' }),
      user: null,
      ip: '',
      userAgent: '',
    },
    action,
    false
  );
  assert.equal(((await result.json()) as { message: string }).message, 'Unauthorized');
}
const routedList = await dispatchAction(
  {
    env,
    body: {},
    request: new Request('http://localhost/', { method: 'POST' }),
    user: superadmin,
    ip: '',
    userAgent: '',
  },
  'getPrisonersAdmin',
  false
);
assert.equal(((await routedList.json()) as { prisoners: Prisoner[] }).prisoners.length, 3);

// The original bug: save one prisoner's discipline and retain every other row.
await handleGetPrisoners(env); // Prime the public cache before the update.
assert.equal(
  (
    await handleUpdatePrisoner(
      env,
      { prisonerId: 'P1', status: 'ติดวินัย งดเยี่ยม', vinaiDate: '2099-01-01' },
      superadmin
    )
  ).status,
  'ok'
);
assert.equal(roster().length, 3);
assert.deepEqual([prisoner('P2'), prisoner('P3')], others);
assert.equal(prisoner('P1')!.note, 'หมายเหตุเดิมหนึ่ง');
assert.equal((await getPrisonerDiscipline(env, 'P1')).restricted, true);
assert.ok(JSON.stringify(await handleGetPrisoners(env)).includes('2099-01-01'), 'public cache refreshes');
assert.deepEqual(bookings(), originalBookings, 'discipline edit preserves all booking/payment fields');
assert.deepEqual(bans(), originalBans, 'discipline and booking bans remain independent');
const full = (await handleGetPrisonersAdmin(env, superadmin)).prisoners as Prisoner[];
assert.equal(full.find((row) => row.prisonerId === 'P1')!.note, 'หมายเหตุเดิมหนึ่ง');
assert.equal(
  (
    await handleUpdatePrisoner(
      env,
      {
        ...full[0],
        prisonerId: 'P1',
        prisonerName: 'ชื่อใหม่',
        wing: '4',
        status: '',
        vinaiDate: '',
        note: 'แก้ไขหมายเหตุ',
      },
      superadmin
    )
  ).status,
  'ok'
);
assert.equal(prisoner('P1')!.prisonerName, 'ชื่อใหม่');
assert.equal(prisoner('P1')!.note, 'แก้ไขหมายเหตุ');
assert.equal((await getPrisonerDiscipline(env, 'P1')).restricted, false);
assert.equal(db.prepare("SELECT wing FROM reservations WHERE ref = 'VIS-P1'").get()!.wing, '4');
assert.deepEqual(bookings().slice(1), originalBookings.slice(1), 'wing sync touches only selected prisoner');
assert.deepEqual([prisoner('P2'), prisoner('P3')], others);
assert.equal((await handleUpdatePrisoner(env, { prisonerId: 'P2', note: 'ฝ่ายวินัยแก้ไข' }, vinai)).status, 'ok');
for (const body of [
  { prisonerId: 'MISSING', note: 'x' },
  { prisonerId: 'P1', prisonerName: '' },
  { prisonerId: 'P1', vinaiDate: '2026-02-30' },
  { prisonerId: 'P1', status: {} },
  { prisonerId: 'P1' },
]) {
  const before = roster();
  assert.equal((await handleUpdatePrisoner(env, body, superadmin)).status, 'error');
  assert.deepEqual(roster(), before);
}
for (const username of ['admin', 'finance', 'tadtel', 'user', 'unknown']) {
  assert.equal(
    (await handleUpdatePrisoner(env, { prisonerId: 'P1', note: 'forged', role: 'Superadmin' }, { username })).status,
    'error'
  );
}

// Old dashboard calls and malformed replacements must never wipe the roster.
for (const body of [
  { prisoners: [prisoner('P1')] },
  { replaceAll: 'true', prisoners: [prisoner('P1')] },
  { replaceAll: true, prisoners: [prisoner('P1'), null] },
  { replaceAll: true, prisoners: [] },
]) {
  const before = roster();
  assert.equal((await handleImportPrisoners(env, body, superadmin)).status, 'error');
  assert.deepEqual(roster(), before);
}

// Manual expiry arithmetic matches the automatic SQL trigger, including leap/month ends.
for (const occurredAt of [
  '2030-08-31T05:03:04.123Z',
  '2027-11-30T20:30:00.000Z',
  '2027-11-29T16:59:59.000Z',
  '2026-11-30T05:00:00.000Z',
]) {
  const id = `MONTH-${occurredAt}`;
  for (const ref of ['one', 'two'])
    db.prepare(
      "INSERT INTO prisoner_booking_outcomes (ref, prisonerId, kind, occurredAt) VALUES (?, ?, 'cancelled', ?)"
    ).run(ref, id, occurredAt);
  assert.equal(
    threeMonthBanExpiry(new Date(occurredAt)),
    db.prepare('SELECT bannedUntil FROM prisoner_booking_blacklist WHERE prisonerId = ?').get(id)!.bannedUntil
  );
}
const beforeP3 = db.prepare("SELECT * FROM prisoner_booking_blacklist WHERE prisonerId = 'P3'").get();
const beforeBanRoster = roster();
const beforeBanBookings = bookings();
const beforeBan = Date.now();
const ban = await handleUpdateBookingBan(
  env,
  { prisonerId: 'P1', operation: 'ban', reason: 'ระงับด้วยตนเอง' },
  superadmin
);
assert.equal(ban.status, 'ok');
assert.ok(Date.parse(String(ban.bannedUntil)) >= Date.parse(threeMonthBanExpiry(new Date(beforeBan))));
assert.notEqual(await prisonerBookingBanError(env, 'P1'), '');
assert.ok(
  !String(await prisonerBookingBanError(env, 'P1')).includes('ยกเลิกการจอง 2 ครั้ง'),
  'manual ban message does not claim automatic strikes'
);
assert.throws(
  () => db.prepare("INSERT INTO reservations (ref, prisonerId) VALUES ('BLOCKED', 'P1')").run(),
  /PRISONER_BOOKING_BANNED/
);
assert.throws(
  () =>
    db
      .prepare("INSERT INTO reservations (ref, prisonerId, extraPrisoners) VALUES ('EXTRA-BLOCKED', 'P2', 'ชื่อ|P1|4')")
      .run(),
  /PRISONER_BOOKING_BANNED/
);
assert.equal(
  (
    await handleCreateBooking(
      env,
      { prisonerId: 'P1', visitorName: 'Guest', visitDateISO: lastOpenDateISO() },
      superadmin
    )
  ).banned,
  true
);
const list = await handleGetBookingBlacklist(env, admin);
const listed = (list.rows as Array<Record<string, unknown>>).find((row) => row.prisonerId === 'P1')!;
assert.equal(listed.banned, true);
assert.ok(Number(listed.daysRemaining) >= 89 && Number(listed.daysRemaining) <= 93);
assert.ok((list.rows as Array<Record<string, unknown>>).some((row) => row.prisonerId === 'FORMER'));
const newExpiry = new Date(Date.now() + 5 * 86400000).toISOString();
assert.equal(
  (
    await handleUpdateBookingBan(
      env,
      { prisonerId: 'P1', operation: 'update', warnings: 1, bannedUntil: newExpiry },
      admin
    )
  ).status,
  'ok'
);
assert.equal((await handleUpdateBookingBan(env, { prisonerId: 'P1', operation: 'unban' }, superadmin)).status, 'ok');
assert.equal(await prisonerBookingBanError(env, 'P1'), '');
assert.equal(
  db.prepare("SELECT consecutiveCancellations FROM prisoner_booking_blacklist WHERE prisonerId = 'P1'").get()!
    .consecutiveCancellations,
  1,
  'unban retains pending warning'
);
assert.equal(
  (
    await handleUpdateBookingBan(
      env,
      { prisonerId: 'P1', operation: 'update', warnings: 0, bannedUntil: '' },
      superadmin
    )
  ).status,
  'ok'
);
for (const body of [
  { prisonerId: 'P1', operation: 'update', warnings: 2, bannedUntil: '' },
  { prisonerId: 'P1', operation: 'update', warnings: -1, bannedUntil: '' },
  { prisonerId: 'P1', operation: 'update', warnings: 1, bannedUntil: 'not-a-date' },
  { prisonerId: 'P1', operation: 'update', warnings: 1, bannedUntil: '2000-01-01T00:00:00Z' },
  { prisonerId: 'MISSING', operation: 'ban' },
  { prisonerId: 'P1', operation: 'delete' },
]) {
  const before = bans();
  assert.equal((await handleUpdateBookingBan(env, body, superadmin)).status, 'error');
  assert.deepEqual(bans(), before);
}
// Discipline staff can use every blacklist control, just like the administrators.
assert.equal((await handleGetBookingBlacklist(env, vinai)).status, 'ok');
assert.equal((await handleGetPrisonersAdmin(env, vinai)).status, 'ok');
assert.equal((await handleUpdateBookingBan(env, { prisonerId: 'P1', operation: 'ban' }, vinai)).status, 'ok');
assert.notEqual(await prisonerBookingBanError(env, 'P1'), '');
assert.equal(
  (
    await handleUpdateBookingBan(
      env,
      {
        prisonerId: 'P1',
        operation: 'update',
        warnings: 1,
        bannedUntil: newExpiry,
      },
      vinai
    )
  ).status,
  'ok'
);
assert.equal(
  db.prepare("SELECT bannedUntil FROM prisoner_booking_blacklist WHERE prisonerId = 'P1'").get()!.bannedUntil,
  newExpiry
);
assert.equal((await handleUpdateBookingBan(env, { prisonerId: 'P1', operation: 'unban' }, vinai)).status, 'ok');
assert.equal(await prisonerBookingBanError(env, 'P1'), '');
assert.equal(
  (
    await handleUpdateBookingBan(
      env,
      {
        prisonerId: 'P1',
        operation: 'update',
        warnings: 0,
        bannedUntil: '',
      },
      vinai
    )
  ).status,
  'ok'
);
for (const username of ['finance', 'tadtel', 'user', 'unknown']) {
  const before = bans();
  assert.equal((await handleGetBookingBlacklist(env, { username })).status, 'error');
  assert.equal(
    (await handleUpdateBookingBan(env, { prisonerId: 'P1', operation: 'ban', role: 'Superadmin' }, { username }))
      .status,
    'error'
  );
  assert.deepEqual(bans(), before);
}
assert.deepEqual(roster(), beforeBanRoster);
assert.deepEqual(bookings(), beforeBanBookings);
assert.deepEqual(db.prepare("SELECT * FROM prisoner_booking_blacklist WHERE prisonerId = 'P3'").get(), beforeP3);
assert.ok(
  db
    .prepare("SELECT details FROM event_log WHERE action = 'update_booking_ban'")
    .all()
    .some((row) => String(row.details).includes('ระงับด้วยตนเอง'))
);

// Explicit CSV replacement remains available and does not reset blacklist history.
const savedBans = bans();
assert.equal(
  (await handleImportPrisoners(env, { replaceAll: true, prisoners: [prisoner('P1')] }, superadmin)).status,
  'ok'
);
assert.equal(roster().length, 1);
assert.deepEqual(bans(), savedBans);
db.close();
console.log(
  'PASS: individual prisoner edits preserve the roster, notes, bookings and bans; safe imports; permissions; manual bans, expiry, warnings and audit logs.'
);
