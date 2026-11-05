import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleUpdateStatus, handleBulkBookingAction } from '../src/routes/reservations';
import { getReservationByRef, archiveReservationsByRef } from '../src/db/queries/reservations';
import { validateSaveReservation } from '../src/services/reservationService';
import { handleLookupByRef } from '../src/routes/public';
import { handleUploadSlip, handleUpdateSlipAndStatus } from '../src/routes/slip';
import { handleGeneratePromptPayQr } from '../src/routes/promptpay';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const migration = '0030_parallel_booking_approvals.sql';
for (const file of readdirSync('src/db/migrations')
  .filter((f) => f.endsWith('.sql') && f < migration)
  .sort())
  db.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));

const statuses = [
  'รอตรวจสอบผู้เข้าร่วม',
  'รอตรวจสอบวินัย',
  'รอชำระเงิน',
  'ชำระแล้ว',
  'เสร็จสิ้น',
  'ไม่อนุมัติ',
  'ยกเลิก',
];
for (const table of ['reservations', 'reservations_archive'])
  for (const [i, status] of statuses.entries())
    db.prepare(`INSERT INTO ${table} (ref, status, visitorName, total) VALUES (?, ?, 'Existing', 3000)`).run(
      `${table}-${i}`,
      status
    );
const snapshot = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY ref`).all();
const before = [snapshot('reservations'), snapshot('reservations_archive')].map((rows) =>
  rows.map((row) => ({ ...row }))
);
db.exec(readFileSync(`src/db/migrations/${migration}`, 'utf8'));
for (const [i, table] of ['reservations', 'reservations_archive'].entries()) {
  const after = snapshot(table);
  assert.deepEqual(
    after.map(({ participantApproved: _p, disciplineApproved: _d, ...rest }) => rest),
    before[i]
  );
  const fixtures = after.filter((r) => String(r.ref).startsWith(`${table}-`));
  assert.deepEqual(
    fixtures.map((r) => r.participantApproved),
    ['', 'yes', 'yes', 'yes', 'yes', '', '']
  );
  assert.deepEqual(
    fixtures.map((r) => r.disciplineApproved),
    ['', '', 'yes', 'yes', 'yes', '', '']
  );
}

// Exercise current handlers against the complete schema after testing the backfill.
for (const file of readdirSync('src/db/migrations')
  .filter((f) => f.endsWith('.sql') && f > migration)
  .sort())
  db.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));

let beforeStageWrite: (() => void) | undefined;
const env = {
  NOTIFY_PUSH_ENABLED: 'true',
  DB: {
    prepare(sql: string) {
      let args: Array<string | number | null> = [];
      const statement = {
        bind(...values: Array<string | number | null>) {
          args = values;
          return statement;
        },
        async first() {
          if (sql.includes("SET participantApproved = 'yes'") || sql.includes("SET disciplineApproved = 'yes'")) {
            const hook = beforeStageWrite;
            beforeStageWrite = undefined;
            hook?.();
          }
          return db.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async run() {
          return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((s) => s.run()));
    },
  },
} as unknown as Env;
const tadtel = { username: 'tadtel', role: 'Tadtel' };
const vinai = { username: 'vinai', role: 'Vinai' };
const finance = { username: 'finance', role: 'Finance' };
const admin = { username: 'admin', role: 'Admin' };
const superadmin = { username: 'superadmin', role: 'Superadmin' };
for (const user of [
  tadtel,
  vinai,
  finance,
  admin,
  superadmin,
  { username: 'custom', role: 'CustomDiscipline' },
  { username: 'viewer', role: 'User' },
])
  db.prepare("INSERT INTO users (username, password, role, displayName, createdAt) VALUES (?, 'test', ?, '', '')").run(
    user.username,
    user.role
  );
db.exec("INSERT INTO roles (roleName, approve_discipline) VALUES ('CustomDiscipline', 1)");

function seed(ref: string, status = statuses[0]!, type = 'prisoner') {
  db.prepare(
    `INSERT INTO reservations (ref, status, bookingType, visitDateISO, visitorName, total, visitorApproved)
    VALUES (?, ?, ?, '2099-01-01', 'Guest', 2000, 'yes')`
  ).run(ref, status, type);
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, ref, p256dh, auth, createdAt, lastActiveAt)
    VALUES (?, ?, '', '', '', '')`
  ).run(`https://push.invalid/${ref}`, ref);
}
const read = (ref: string) => getReservationByRef(env.DB, ref);
const approve = (ref: string, stage: 'participant' | 'discipline', user = stage === 'participant' ? tadtel : vinai) =>
  handleUpdateStatus(
    env,
    { ref, status: stage === 'participant' ? statuses[1] : statuses[2], approvalStage: stage },
    user
  );
const paymentAlerts = (ref: string) =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE ref = ? AND type = 'payment_due'").get(ref)!.n);

for (const order of [
  ['participant', 'discipline'],
  ['discipline', 'participant'],
] as const) {
  const ref = `VIS-${order[0]}`;
  seed(ref);
  assert.equal((await approve(ref, order[0])).status, 'ok');
  assert.equal((await read(ref))!.status, order[0] === 'participant' ? statuses[1] : statuses[0]);
  assert.equal(paymentAlerts(ref), 0, 'one approval never invites payment');
  assert.equal((await handleUploadSlip(env, { ref, base64Data: 'data:image/png;base64,AAAA' })).status, 'error');
  assert.equal((await handleUpdateSlipAndStatus(env, { ref }, finance)).status, 'error');
  assert.equal((await handleUpdateSlipAndStatus(env, { ref }, { username: 'public' }, true)).status, 'error');
  assert.equal((await handleGeneratePromptPayQr(env, { ref }, null, '127.0.0.1')).status, 'error');
  const version = (await read(ref))!.version;
  assert.equal((await approve(ref, order[0])).noop, true);
  assert.equal((await read(ref))!.version, version);
  assert.equal((await handleUpdateStatus(env, { ref, status: 'ชำระแล้ว' }, finance)).status, 'error');
  assert.equal((await approve(ref, order[1])).newStatus, 'รอชำระเงิน');
  assert.equal(paymentAlerts(ref), 1);
  assert.equal((await approve(ref, order[1])).noop, true);
  assert.equal(paymentAlerts(ref), 1, 'retries do not duplicate payment notifications');
  const lookup = await handleLookupByRef(env, { ref });
  assert.ok(JSON.stringify(lookup).includes('disciplineApproved'));
  assert.equal((await handleUpdateStatus(env, { ref, status: 'ชำระแล้ว' }, finance)).status, 'ok');
  assert.equal((await handleUpdateStatus(env, { ref, status: 'เสร็จสิ้น' }, finance)).status, 'ok');
}

seed('VIS-concurrent');
assert.ok(
  (await Promise.all([approve('VIS-concurrent', 'participant'), approve('VIS-concurrent', 'discipline')])).every(
    (r) => r.status === 'ok'
  )
);
assert.equal((await read('VIS-concurrent'))!.status, 'รอชำระเงิน');
assert.equal((await read('VIS-concurrent'))!.participantApproved, 'yes');
assert.equal((await read('VIS-concurrent'))!.disciplineApproved, 'yes');
assert.equal(paymentAlerts('VIS-concurrent'), 1);
seed('VIS-double-click');
const duplicate = await Promise.all([
  approve('VIS-double-click', 'discipline'),
  approve('VIS-double-click', 'discipline'),
]);
assert.equal(duplicate.filter((result) => result.noop).length, 1);
assert.equal((await read('VIS-double-click'))!.version, 2);
assert.equal(paymentAlerts('VIS-double-click'), 0);
assert.equal(
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM event_log WHERE targetRef = 'VIS-concurrent' AND action = 'booking_stage_approved'"
    )
    .get()!.n,
  2
);

seed('VIS-roles');
for (const [stage, user] of [
  ['participant', vinai],
  ['discipline', tadtel],
  ['discipline', finance],
  ['participant', { username: 'viewer', role: 'User' }],
] as const)
  assert.equal((await approve('VIS-roles', stage, user)).status, 'error');
assert.equal((await read('VIS-roles'))!.status, statuses[0]);
assert.equal((await approve('VIS-roles', 'discipline', { username: 'custom', role: 'CustomDiscipline' })).status, 'ok');
assert.equal((await approve('VIS-roles', 'participant', admin)).newStatus, 'รอชำระเงิน');

seed('VIS-legacy');
assert.equal(
  (await handleUpdateStatus(env, { ref: 'VIS-legacy', status: 'รอชำระเงิน' }, vinai)).newStatus,
  statuses[0]
);
assert.equal(
  (await handleUpdateStatus(env, { ref: 'VIS-legacy', status: 'รอตรวจสอบวินัย' }, tadtel)).newStatus,
  'รอชำระเงิน'
);
seed('VIS-super');
assert.equal((await approve('VIS-super', 'discipline', superadmin)).newStatus, statuses[0]);
assert.equal(
  (await handleUpdateStatus(env, { ref: 'VIS-super', status: 'รอตรวจสอบผู้เข้าร่วม' }, superadmin)).status,
  'ok'
);
// A manual reset to the same displayed status must also clear a recorded check.
assert.equal((await read('VIS-super'))!.disciplineApproved, '');

for (const status of ['ไม่อนุมัติ', 'ยกเลิก', 'คืนเงินแล้ว']) {
  seed(`VIS-${status}`, status);
  assert.equal((await approve(`VIS-${status}`, 'discipline')).status, 'error');
  assert.equal((await read(`VIS-${status}`))!.status, status);
}
seed('VIS-race');
beforeStageWrite = () => db.exec("UPDATE reservations SET status = 'ยกเลิก' WHERE ref = 'VIS-race'");
assert.equal((await approve('VIS-race', 'discipline')).status, 'error');
assert.equal((await read('VIS-race'))!.status, 'ยกเลิก');
seed('TBL-independent', 'รอชำระเงิน', 'table');
assert.equal((await approve('TBL-independent', 'discipline')).status, 'error');
assert.equal((await handleUpdateStatus(env, { ref: 'TBL-independent', status: 'ชำระแล้ว' }, finance)).status, 'ok');

for (const ref of ['VIS-bulk1', 'VIS-bulk2']) seed(ref);
const bulk = (user: typeof vinai) =>
  handleBulkBookingAction(env, { operation: 'approve', refs: ['VIS-bulk1', 'VIS-bulk2'] }, user);
assert.equal((await bulk(vinai)).succeeded, 2);
assert.equal((await bulk(vinai)).succeeded, 2, 'same role retries only its own stage');
assert.equal((await read('VIS-bulk1'))!.status, statuses[0]);
const finished = await bulk(tadtel);
assert.equal(finished.succeeded, 2);
assert.ok((finished.results as Array<{ newStatus: string }>).every((r) => r.newStatus === 'รอชำระเงิน'));
const retried = await handleBulkBookingAction(
  env,
  { operation: 'approve', refs: ['VIS-bulk1', 'VIS-bulk2'], approvalStage: 'discipline' },
  vinai
);
assert.equal(retried.succeeded, 2);
assert.equal((await read('VIS-bulk1'))!.status, 'รอชำระเงิน');

const booking = validateSaveReservation({
  ref: 'VIS-client',
  status: 'รอชำระเงิน',
  participantApproved: 'yes',
  disciplineApproved: 'yes',
});
assert.ok(booking.ok);
assert.equal(booking.data.status, statuses[0]);
assert.equal(booking.data.participantApproved, undefined);
assert.equal(booking.data.disciplineApproved, undefined);
assert.equal(await archiveReservationsByRef(env.DB, ['VIS-concurrent'], '2099-02-01'), 1);
assert.equal(
  db.prepare("SELECT disciplineApproved FROM reservations_archive WHERE ref='VIS-concurrent'").get()!
    .disciplineApproved,
  'yes'
);
console.log(
  'PASS: migration preservation, both orders, simultaneous approvals, retries, permissions, bulk, payment gate, public lookup, archive.'
);
