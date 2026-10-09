import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import evidence from './booking-charge-evidence.json';
import { computeBookingCost, alignExtraVisitorApprovals, parseExtraVisitorNames } from '../src/services/pricing';

const migration = readFileSync('src/db/migrations/0025_reconcile_final_booking_charges.sql', 'utf8');
const approvalMigration = readFileSync('src/db/migrations/0026_approve_july_added_visitor.sql', 'utf8');
function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('src/db/migrations')
    .filter((f) => f.endsWith('.sql') && f < '0025')
    .sort())
    db.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
  db.exec('DELETE FROM reservations; DELETE FROM reservations_archive; DELETE FROM reservation_payment_locks;');
  for (const row of evidence)
    db.prepare(
      `INSERT INTO reservations_archive
    (ref,visitDateISO,status,total,version,visitorCount,adultCount,child5to8Count,childUnder5Count,extraVisitorNames,slipImage)
    VALUES(?,?,?,?,?,?,?,?,?,'Original staff-added visitor list','Original slip')`
    ).run(
      row.ref,
      row.visitDateISO,
      row.status,
      row.fromTotal,
      row.version,
      row.fromCounters.visitorCount,
      row.fromCounters.adultCount,
      row.fromCounters.child5to8Count,
      row.fromCounters.childUnder5Count
    );
  db.exec(
    "INSERT INTO reservations_archive(ref,status,total,visitorCount,extraVisitorApproved) VALUES('UNRESOLVED','เสร็จสิ้น',3000,3,'yes;;')"
  );
  return db;
}
const db = fixture();
db.exec('BEGIN');
db.exec(migration);
db.exec('COMMIT');
for (const item of evidence) {
  const row = db.prepare('SELECT * FROM reservations_archive WHERE ref=?').get(item.ref)!;
  assert.equal(row.total, item.bookingTotal);
  assert.equal(row.version, item.version + 1);
  assert.equal(row.extraVisitorNames, 'Original staff-added visitor list');
  assert.equal(row.slipImage, 'Original slip');
  for (const field of ['visitorCount', 'adultCount', 'child5to8Count', 'childUnder5Count'] as const)
    assert.equal(row[field], item.toCounters[field]);
  assert.equal(
    db.prepare('SELECT total FROM reservation_payment_locks WHERE ref=?').get(item.ref)!.total,
    item.bookingTotal
  );
  const retained = db.prepare('SELECT * FROM booking_charge_corrections WHERE ref=?').get(item.ref)!;
  assert.equal(retained.fromTotal, item.fromTotal);
  assert.ok(retained.appliedAt);
}
assert.equal(db.prepare("SELECT total FROM reservations_archive WHERE ref='UNRESOLVED'").get()!.total, 3000);
assert.equal(
  db.prepare("SELECT count(*) AS n FROM event_log WHERE action='booking_charge_reconciled'").get()!.n,
  evidence.length
);
for (const change of ['version', 'adultCount', 'paymentLock']) {
  const stale = fixture();
  if (change === 'paymentLock')
    stale.prepare('UPDATE reservation_payment_locks SET total=total+1 WHERE ref=?').run(evidence[0]!.ref);
  else stale.prepare(`UPDATE reservations_archive SET ${change}=${change}+1 WHERE ref=?`).run(evidence[0]!.ref);
  stale.exec('BEGIN');
  assert.throws(() => stale.exec(migration), /CHECK constraint/);
  stale.exec('ROLLBACK');
  assert.equal(
    stale.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='booking_charge_corrections'").get()!.n,
    0
  );
  assert.equal(
    stale.prepare('SELECT total FROM reservations_archive WHERE ref=?').get(evidence[1]!.ref)!.total,
    evidence[1]!.fromTotal
  );
}
assert.equal(parseExtraVisitorNames('One (Child), Two (Partner)').length, 2);
assert.equal(
  computeBookingCost({
    relation: 'Partner',
    extraVisitorNames: 'Rejected|R|Partner|40;;Child|C|Child|6',
    extraVisitorApproved: 'no;;yes',
  }).total,
  2500
);
assert.equal(
  alignExtraVisitorApprovals(
    'One|A|Child|6;;Two|B|Partner|40',
    'yes;;no',
    'Two|B|Partner|40;;New|C|Child|3;;One|A|Child|6'
  ),
  'no;;;;yes'
);
for (const [age, amount] of [
  [0, 2000],
  [4, 2000],
  [5, 2500],
  [8, 2500],
  [9, 3000],
])
  assert.equal(computeBookingCost({ relation: 'Partner', extraVisitorNames: `Child|C|Child|${age}` }).total, amount);
console.log(
  '538 booking corrections, preserved added visitors and slips, atomic rollback, approval identity alignment, and child age boundaries passed.'
);
const rejectedMain = computeBookingCost({
  visitorApproved: 'no',
  relation: 'Partner',
  extraVisitorNames: 'Child|C|Child|3;;Adult|A|Partner|40',
  extraVisitorApproved: 'yes;;yes',
});
assert.equal(rejectedMain.total, 2000);
assert.equal(rejectedMain.visitorCount, 2);
assert.equal(rejectedMain.childUnder5Count, 1);
function approvalFixture(): DatabaseSync {
  const db = fixture();
  db.exec(migration);
  db.exec(`INSERT INTO reservations_archive(ref,visitDateISO,status,total,version,visitorApproved,extraVisitorApproved,visitorCount,adultCount,child5to8Count,childUnder5Count,extraVisitorNames)
    VALUES('VIS-37459','2026-07-20','เสร็จสิ้น',2000,1,'yes','yes;;',2,0,0,0,'Child|C|Child|1;;Adult|A|Partner|40'),
    ('VIS-65622','2026-07-21','เสร็จสิ้น',2000,1,'no','yes;;yes',2,0,0,0,'Child|C|Child|3;;Adult|A|Partner|40')`);
  return db;
}
const approvalDb = approvalFixture();
approvalDb.exec('BEGIN');
approvalDb.exec(approvalMigration);
approvalDb.exec('COMMIT');
const approved = approvalDb
  .prepare(
    "SELECT total,visitorCount,extraVisitorApproved,childUnder5Count FROM reservations_archive WHERE ref='VIS-37459'"
  )
  .get()!;
assert.equal(approved.total, 3000);
assert.equal(approved.visitorCount, 3);
assert.equal(approved.extraVisitorApproved, 'yes;;yes');
assert.equal(approved.childUnder5Count, 1);
assert.equal(approvalDb.prepare("SELECT total FROM reservations_archive WHERE ref='VIS-65622'").get()!.total, 2000);
assert.equal(
  approvalDb.prepare("SELECT total FROM reservation_payment_locks WHERE ref='VIS-37459'").get()!.total,
  3000
);
const staleApproval = approvalFixture();
staleApproval.exec("UPDATE reservations_archive SET extraVisitorApproved='yes;;no' WHERE ref='VIS-37459'");
staleApproval.exec('BEGIN');
assert.throws(() => staleApproval.exec(approvalMigration), /CHECK constraint/);
staleApproval.exec('ROLLBACK');
assert.equal(
  staleApproval.prepare("SELECT total FROM reservation_payment_locks WHERE ref='VIS-37459'").get()!.total,
  2000
);
console.log(
  'Confirmed added adult approved with free child, other booking unchanged, and stale approval rollback passed.'
);
