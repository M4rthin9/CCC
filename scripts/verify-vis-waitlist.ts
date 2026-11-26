import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  approveReservationStage,
  getReservationByRef,
  hasReusableVis,
  hasUnpaidVisForPrisoners,
  hasUnpaidVisOnOtherDate,
  insertReservation,
} from '../src/db/queries/reservations';
import { handleVisManage } from '../src/routes/visWaitlist';
import {
  claimVisSlip,
  getVisCalendar,
  offerVisTables,
  processVisWaitlist,
  readVisPaymentState,
} from '../src/services/visWaitlist';
import { VIS_WAITING, visWaitlistEnabled } from '../src/services/visWaitlistPolicy';
import type { Env } from '../src/types';

const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('src/db/migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  sqlite.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
}

type Bind = string | number | null;
function prepare(sql: string) {
  let args: Bind[] = [];
  const stmt = {
    bind(...values: Bind[]) {
      args = values;
      return stmt;
    },
    async first() {
      return sqlite.prepare(sql).get(...args) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    async run() {
      if (/\bRETURNING\b/i.test(sql)) {
        const results = sqlite.prepare(sql).all(...args);
        return { results, meta: { changes: results.length } };
      }
      return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
    },
  };
  return stmt;
}
const env = {
  DB: {
    prepare,
    async batch(rows: Array<ReturnType<typeof prepare>>) {
      const result = [];
      sqlite.exec('BEGIN');
      try {
        for (const row of rows) result.push(await row.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
  VIS_WAITLIST_ENABLED: 'true',
} as unknown as Env;

const launch = new Date('2026-11-30T17:00:00.000Z');
assert.equal(visWaitlistEnabled(env, new Date(launch.getTime() - 1)), false);
assert.equal(visWaitlistEnabled(env, launch), true);
assert.equal(visWaitlistEnabled({}, launch), false);
const date = '2026-12-02';
const nextDate = '2026-12-03';
const now = launch.toISOString();
const cap = { perDay: 2, nowIso: now, visWaitlist: true };
const row = (ref: string, visitorId: string, prisonerId: string, visitDateISO: string, visQueuedAt = now) => ({
  ref,
  visitorId,
  prisonerId,
  visitDateISO,
  visQueuedAt,
  bookingType: 'prisoner',
  status: VIS_WAITING,
  participantApproved: 'yes',
  disciplineApproved: 'yes',
  version: 1,
  createdAt: now,
});
assert.equal(await insertReservation(env.DB, row('VIS-1', 'OWNER-A', 'P1', date), cap), true);
assert.equal(await insertReservation(env.DB, row('VIS-2', 'OWNER-B', 'P2', date), cap), true);
assert.equal(await insertReservation(env.DB, row('VIS-3', 'OWNER-C', 'P3', date), cap), true);
assert.equal(await hasUnpaidVisOnOtherDate(env.DB, ' owner-a ', nextDate, launch), true);
assert.equal(await insertReservation(env.DB, row('VIS-4', 'OWNER-A', 'P4', nextDate), cap), false);
assert.equal(await hasUnpaidVisForPrisoners(env.DB, row('VIS-4', 'OWNER-D', 'P1', nextDate), launch), true);
assert.equal(await insertReservation(env.DB, row('VIS-4', 'OWNER-D', 'P1', nextDate), cap), false);
assert.equal(await insertReservation(env.DB, row('VIS-4', 'OWNER-D', 'P1', date), cap), false);
assert.deepEqual(
  await Promise.all([offerVisTables(env.DB, date, 2, launch), offerVisTables(env.DB, date, 2, launch)]),
  [2, 0]
);
assert.equal((await getReservationByRef(env.DB, 'VIS-1'))?.status, 'รอชำระเงิน');
assert.equal((await getReservationByRef(env.DB, 'VIS-3'))?.status, VIS_WAITING);
assert.equal((await readVisPaymentState(env.DB, 'VIS-1'))?.holdExpiresAt, '2026-12-01T05:00:00.000Z');
const sameDay = '2026-12-01';
assert.equal(await insertReservation(env.DB, row('VIS-5', 'OWNER-E', 'P5', sameDay), cap), true);
assert.equal(await offerVisTables(env.DB, sameDay, 2, launch), 1);
assert.equal((await readVisPaymentState(env.DB, 'VIS-5'))?.holdExpiresAt, '2026-12-01T00:30:00.000Z');
const sameDayBooking = await getReservationByRef(env.DB, 'VIS-5');
assert.ok(sameDayBooking);
assert.equal(await claimVisSlip(env.DB, sameDayBooking, new Date('2026-12-01T00:30:00.000Z')), false);
const booking = await getReservationByRef(env.DB, 'VIS-1');
assert.ok(booking);
assert.equal(await claimVisSlip(env.DB, booking, launch), true);
assert.equal(await claimVisSlip(env.DB, booking, launch), false);
sqlite.prepare('UPDATE reservations SET status = ? WHERE ref = ?').run('ชำระแล้ว', 'VIS-1');
assert.equal(await insertReservation(env.DB, row('VIS-4', 'OWNER-A', 'P1', nextDate), cap), true);
sqlite
  .prepare("INSERT INTO settings (key, value, savedBy, savedAt) VALUES ('admin_settings', ?, '', '')")
  .run(JSON.stringify({ publicBooking: { perDay: 2 } }));
await processVisWaitlist(env, launch);
assert.equal(
  sqlite.prepare('SELECT visContactRequired FROM reservations WHERE ref = ?').get('VIS-2')?.visContactRequired,
  1
);
await processVisWaitlist(env, new Date('2026-12-01T05:00:00.000Z'));
assert.equal((await getReservationByRef(env.DB, 'VIS-2'))?.visitDateISO, '');
assert.equal((await getReservationByRef(env.DB, 'VIS-3'))?.status, 'รอชำระเงิน');
assert.equal((await getReservationByRef(env.DB, 'VIS-1'))?.status, 'ชำระแล้ว');
assert.deepEqual(await getVisCalendar(env.DB, '2026-12-01', '2026-12-03', 2), {
  counts: { [date]: 1 },
  queueFullDates: [],
});

const editTime = new Date('2026-12-01T06:00:00.000Z');
const paid = await getReservationByRef(env.DB, 'VIS-1');
assert.equal(
  (
    await handleVisManage(
      env,
      { operation: 'edit', ref: 'VIS-1', visitorId: 'OWNER-A', version: paid?.version },
      editTime
    )
  ).status,
  'error'
);
assert.equal(
  (await handleVisManage(env, { operation: 'open', ref: 'VIS-3', visitorId: 'WRONG' }, editTime)).status,
  'error'
);
sqlite
  .prepare(
    `UPDATE reservations SET visitorName = 'Main Visitor', visitorAge = '40', relation = 'Family',
  visitorApproved = 'yes' WHERE ref = 'VIS-3'`
  )
  .run();
const edit = await handleVisManage(env, { operation: 'open', ref: 'VIS-3', visitorId: 'OWNER-C' }, editTime);
assert.equal(edit.status, 'ok');
assert.equal(
  (
    await handleVisManage(
      env,
      {
        operation: 'edit',
        ref: 'VIS-3',
        visitorId: 'OWNER-C',
        version: edit.version,
        main: edit.main,
        guests: [{ name: 'New Guest', id: 'GUEST-N', relation: 'Family', age: '30' }],
      },
      editTime
    )
  ).status,
  'ok'
);
assert.equal((await getReservationByRef(env.DB, 'VIS-3'))?.status, 'รอตรวจสอบผู้เข้าร่วม');
assert.equal((await readVisPaymentState(env.DB, 'VIS-3'))?.holdExpiresAt, '');
assert.equal((await readVisPaymentState(env.DB, 'VIS-3'))?.visPaymentRemainingMs, 11 * 60 * 60 * 1000);
assert.equal((await approveReservationStage(env.DB, 'VIS-3', 'participant', true))?.status, VIS_WAITING);
await processVisWaitlist(env, new Date('2026-12-01T07:00:00.000Z'));
assert.equal((await readVisPaymentState(env.DB, 'VIS-3'))?.holdExpiresAt, '2026-12-01T18:00:00.000Z');
assert.equal(await hasReusableVis(env.DB, row('VIS-new', 'OWNER-B', 'P2', nextDate)), true);
assert.equal(await insertReservation(env.DB, row('VIS-new', 'OWNER-B', 'P2', nextDate), cap), false);
const expired = await getReservationByRef(env.DB, 'VIS-2');
assert.equal(
  (
    await handleVisManage(
      env,
      { operation: 'rebook', ref: 'VIS-2', visitorId: 'OWNER-B', version: expired?.version, visitDateISO: nextDate },
      editTime
    )
  ).status,
  'ok'
);
assert.equal((await getReservationByRef(env.DB, 'VIS-2'))?.visitDateISO, nextDate);
assert.equal(sqlite.prepare("SELECT count(*) as n FROM reservations WHERE ref='VIS-2'").get()?.n, 1);
const cancelDay = '2026-12-04';
const beforeCutoff = new Date('2026-12-04T00:00:00.000Z');
assert.equal(await insertReservation(env.DB, row('VIS-6', 'OWNER-F', 'P6', cancelDay), cap), true);
assert.equal(await insertReservation(env.DB, row('VIS-7', 'OWNER-G', 'P7', cancelDay), cap), true);
assert.equal(await offerVisTables(env.DB, cancelDay, 1, beforeCutoff), 1);
sqlite.prepare("UPDATE reservations SET status='ยกเลิก', cancelAt=? WHERE ref='VIS-6'").run(beforeCutoff.toISOString());
assert.equal(
  await offerVisTables(env.DB, cancelDay, 1, beforeCutoff),
  0,
  'a same-day cancellation still occupies its offered slot'
);
sqlite.prepare("UPDATE reservations SET cancelAt='2026-12-03T16:59:00.000Z' WHERE ref='VIS-6'").run();
assert.equal(await offerVisTables(env.DB, cancelDay, 1, beforeCutoff), 1, 'a prior-day cancellation releases capacity');
console.log(
  'VIS cutover, unpaid guards, atomic queue offers, 12-hour window, contact fallback, expiry, paid counts, protected edits, Tadtel pause and same-VIS rebooking passed.'
);
