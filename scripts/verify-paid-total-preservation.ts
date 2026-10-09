import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import evidence from './payment-repair-evidence.json';
import { archiveReservationsByRef, updateBookingChargeColumns } from '../src/db/queries/reservations';
import { handleUpdateBooking, handleUpdateVisitorApproval } from '../src/routes/reservations';
import type { Env } from '../src/types';

const repair = readFileSync('src/db/migrations/0024_preserve_paid_totals.sql', 'utf8');
function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('src/db/migrations')
    .filter((f) => f.endsWith('.sql') && f < '0024')
    .sort())
    db.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
  for (const item of evidence)
    db.prepare(
      `INSERT INTO reservations_archive
      (ref, visitDateISO, total, version, status, visitorApproved, extraVisitorApproved, visitorCount, extraVisitorNames)
      VALUES (?, ?, ?, ?, 'เสร็จสิ้น', 'yes', 'yes', 2, 'Test child|TEST|Child|4')`
    ).run(item.ref, item.visitDateISO, item.fromTotal, item.version);
  return db;
}
const sqlite = fixture();
sqlite.exec('BEGIN');
sqlite.exec(repair);
sqlite.exec('COMMIT');
for (const item of evidence) {
  const row = sqlite
    .prepare('SELECT total, version, visitorCount, extraVisitorApproved FROM reservations_archive WHERE ref = ?')
    .get(item.ref)!;
  assert.equal(row.total, item.paidAmount);
  assert.equal(row.version, item.version + 1);
  assert.equal(row.visitorCount, 2, 'money correction must preserve attendance');
  assert.equal(row.extraVisitorApproved, 'yes');
  const backup = sqlite
    .prepare('SELECT fromTotal, paidAmount, appliedAt FROM payment_total_corrections WHERE ref = ?')
    .get(item.ref)!;
  assert.equal(backup.fromTotal, item.fromTotal);
  assert.equal(backup.paidAmount, item.paidAmount);
  assert.ok(backup.appliedAt);
}
assert.equal(
  sqlite.prepare("SELECT count(*) AS n FROM event_log WHERE action='payment_total_corrected_from_slip'").get()!.n,
  7
);
// No unaudited record is eligible, and stale evidence aborts without a partial repair.
const stale = fixture();
stale.prepare('UPDATE reservations_archive SET total=total+100 WHERE ref=?').run(evidence[0]!.ref);
stale.exec('BEGIN');
assert.throws(() => stale.exec(repair), /CHECK constraint/);
stale.exec('ROLLBACK');
assert.equal(
  stale.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='payment_total_corrections'").get()!.n,
  0
);
assert.equal(
  stale.prepare('SELECT total FROM reservations_archive WHERE ref=?').get(evidence[1]!.ref)!.total,
  evidence[1]!.fromTotal
);

type Statement = { run(): Promise<{ success: boolean; meta: { changes: number } }> };
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
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
} as unknown as Env;
const admin = { username: 'test-admin', role: 'Superadmin' };
sqlite.exec(`INSERT INTO reservations
  (ref, status, total, relation, visitorApproved, extraVisitorNames, extraVisitorApproved,
   visitorCount, totalPersons, adultCount, visitDateISO, createdAt)
  VALUES ('VIS-PAID', 'เสร็จสิ้น', 2000, 'Partner', 'yes', 'Rejected|TEST|Partner|30', 'no',
          1, 2, 1, '2026-08-10', '2026-08-01T00:00:00Z'),
         ('VIS-UNPAID', 'รอชำระเงิน', 2000, 'Partner', 'yes', '', '', 1, 2, 1, '2026-10-12', ''),
         ('TBL-PAID', 'ชำระแล้ว', 1000, 'Partner', 'yes', '', '', 1, 1, 1, '2026-10-12', '');`);
// Saving the editor's unchanged price fields formerly charged the rejected extra again.
assert.equal(
  (
    await handleUpdateBooking(
      env,
      {
        ref: 'VIS-PAID',
        visitorName: 'Corrected name',
        total: 2000,
        visitorCount: 1,
        totalPersons: 2,
        adultCount: 1,
        child5to8Count: 0,
        childUnder5Count: 0,
      },
      admin
    )
  ).status,
  'ok'
);
assert.equal(sqlite.prepare("SELECT total FROM reservations WHERE ref='VIS-PAID'").get()!.total, 2000);
assert.equal(
  (
    await handleUpdateBooking(
      env,
      {
        ref: 'VIS-PAID',
        relation: 'Partner',
        visitorAge: '',
        extraVisitorNames: 'Rejected|TEST|Partner|30',
        visitorName: 'Unchanged guest list',
        total: 3000,
        visitorCount: 2,
        adultCount: 2,
        totalPersons: 3,
      },
      admin
    )
  ).status,
  'ok'
);
assert.equal(sqlite.prepare("SELECT total FROM reservations WHERE ref='VIS-PAID'").get()!.total, 2000);
assert.equal((await handleUpdateBooking(env, { ref: 'VIS-PAID', total: 3000 }, admin)).status, 'error');
assert.equal(
  (
    await handleUpdateBooking(
      env,
      {
        ref: 'VIS-PAID',
        extraVisitorNames: 'Rejected|TEST|Partner|30;;Child|KID|Child|4',
      },
      admin
    )
  ).status,
  'ok'
);
assert.equal(sqlite.prepare("SELECT total FROM reservations WHERE ref='VIS-PAID'").get()!.total, 2000);
assert.equal(
  sqlite.prepare("SELECT childUnder5Count FROM reservations WHERE ref='VIS-PAID'").get()!.childUnder5Count,
  1
);
assert.equal(
  (
    await handleUpdateBooking(
      env,
      {
        ref: 'VIS-PAID',
        extraVisitorNames: 'Child|KID|Child|5;;Rejected|TEST|Partner|30',
      },
      admin
    )
  ).status,
  'ok'
);
assert.equal(sqlite.prepare("SELECT total FROM reservations WHERE ref='VIS-PAID'").get()!.total, 2500);
assert.equal(
  sqlite.prepare("SELECT extraVisitorApproved FROM reservations WHERE ref='VIS-PAID'").get()!.extraVisitorApproved,
  ';;no'
);
assert.equal(
  (
    await handleUpdateVisitorApproval(
      env,
      { ref: 'VIS-PAID', visitorApproved: 'yes', extraVisitorApproved: ';;no' },
      admin
    )
  ).status,
  'ok'
);
assert.equal(
  (await handleUpdateVisitorApproval(env, { ref: 'VIS-PAID', extraVisitorApproved: 'yes;;no' }, admin)).status,
  'ok'
);
assert.equal(sqlite.prepare("SELECT total FROM reservations WHERE ref='VIS-PAID'").get()!.total, 2500);
const staleVersion = Number(sqlite.prepare("SELECT version FROM reservations WHERE ref='VIS-PAID'").get()!.version) - 1;
assert.equal(
  await updateBookingChargeColumns(env.DB, 'VIS-PAID', false, [['total', 3500]], staleVersion, 2500, admin.username),
  false
);
assert.equal(sqlite.prepare("SELECT total FROM reservation_payment_locks WHERE ref='VIS-PAID'").get()!.total, 2500);
sqlite.exec(`CREATE TRIGGER test_charge_abort BEFORE UPDATE ON reservations WHEN NEW.visitorName='forced failure'
  BEGIN SELECT RAISE(ABORT,'forced failure'); END;`);
await assert.rejects(
  updateBookingChargeColumns(
    env.DB,
    'VIS-PAID',
    false,
    [
      ['total', 3500],
      ['visitorName', 'forced failure'],
    ],
    staleVersion + 1,
    2500,
    admin.username
  ),
  /forced failure/
);
assert.equal(sqlite.prepare("SELECT total FROM reservation_payment_locks WHERE ref='VIS-PAID'").get()!.total, 2500);
sqlite.exec('DROP TRIGGER test_charge_abort');
assert.throws(() => sqlite.exec("UPDATE reservations SET total=3000 WHERE ref='VIS-PAID'"), /locked/);
sqlite.exec("UPDATE reservations SET status='รอชำระเงิน' WHERE ref='VIS-PAID'");
assert.throws(
  () => sqlite.exec("UPDATE reservations SET total=3000 WHERE ref='VIS-PAID'"),
  /locked/,
  'status reversal must not unlock payment'
);
assert.equal(await archiveReservationsByRef(env.DB, ['VIS-PAID'], '2026-10-09'), 1);
assert.throws(() => sqlite.exec("UPDATE reservations_archive SET total=3000 WHERE ref='VIS-PAID'"), /locked/);
assert.throws(
  () => sqlite.exec("INSERT INTO reservations (ref,total,status) VALUES ('VIS-PAID',3000,'รอชำระเงิน')"),
  /locked/
);
assert.equal((await handleUpdateBooking(env, { ref: 'TBL-PAID', total: 2000 }, admin)).status, 'error');
assert.equal(
  (await handleUpdateBooking(env, { ref: 'VIS-UNPAID', extraVisitorNames: 'Extra|TEST|Partner|30' }, admin)).status,
  'ok'
);
assert.equal(sqlite.prepare("SELECT total FROM reservations WHERE ref='VIS-UNPAID'").get()!.total, 3000);
sqlite.exec("UPDATE reservations SET status='ชำระแล้ว' WHERE ref='VIS-UNPAID'");
assert.throws(() => sqlite.exec("UPDATE reservations SET total=2000 WHERE ref='VIS-UNPAID'"), /locked/);
console.log(
  'Historical preservation, child additions and approval alignment, atomic charge changes, stale editors, rollback, and unpaid pricing passed.'
);
