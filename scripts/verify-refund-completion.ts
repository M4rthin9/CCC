import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { handleCompleteRefund, handleGetRefundEvidence } from '../src/routes/refundEvidence';
import {
  handlePublicCancelBooking,
  handleUpdateBooking,
  handleUpdateStatus,
  handleUpdateVisitorApproval,
} from '../src/routes/reservations';
import { handleUploadSlip, handleUpdateSlipAndStatus } from '../src/routes/slip';
import { dispatchAction } from '../src/routes/dispatcher';
import type { Env } from '../src/types';

// Exercise the actual SQL against the repository's migrated SQLite schema.
const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('src/db/migrations')
  .filter((file) => file.endsWith('.sql'))
  .sort())
  sqlite.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
type Statement = { run(): Promise<{ success: boolean; meta: { changes: number } }> };
let beforeBatch: (() => void) | undefined;
let failUpdate = false;
let batchQueue: Promise<unknown> = Promise.resolve();
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
          if (failUpdate && /^UPDATE reservations SET status/.test(sql)) throw new Error('injected update failure');
          const result = sqlite.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      const task = batchQueue.then(async () => {
        beforeBatch?.();
        beforeBatch = undefined;
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec('COMMIT');
          return results;
        } catch (cause) {
          sqlite.exec('ROLLBACK');
          throw cause;
        }
      });
      batchQueue = task.catch(() => undefined);
      return task;
    },
  },
} as unknown as Env;
sqlite.exec(
  "INSERT INTO users (username, password, role, displayName, createdAt) VALUES ('finance', 'test-only', 'Finance', 'Finance', ''), ('viewer', 'test-only', 'User', 'Viewer', ''), ('admin', 'test-only', 'Superadmin', 'Admin', '')"
);
const user = { username: 'finance', role: 'Finance' };
const slip =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function seed(ref: string, status = 'เสร็จสิ้น', archived = false, withSlip = true) {
  const table = archived ? 'reservations_archive' : 'reservations';
  sqlite
    .prepare(
      `INSERT INTO ${table} (ref, status, total, visitorName, slip_base64, version) VALUES (?, ?, 2000, 'Test customer', ?, 1)`
    )
    .run(ref, status, withSlip ? slip : '');
}
function body(ref: string, amount = 500.5) {
  return { ref, amount, reason: 'Customer refund request', recipient: 'Test customer', account: 'Test account' };
}
function status(ref: string, archived = false) {
  return sqlite
    .prepare(`SELECT status FROM ${archived ? 'reservations_archive' : 'reservations'} WHERE ref = ?`)
    .get(ref)?.status;
}
function eventCount(ref: string) {
  return Number(
    sqlite.prepare("SELECT count(*) AS n FROM event_log WHERE targetRef = ? AND action = 'booking_refunded'").get(ref)
      ?.n
  );
}

seed('VIS-PARTIAL');
assert.equal(
  (await handleCompleteRefund(env, { ...body('VIS-PARTIAL'), username: 'finance' }, { username: 'viewer' })).status,
  'error',
  'authenticated permissions cannot be spoofed'
);
for (const amount of [0, -1, 2001, 0.001, 'invalid'])
  assert.equal((await handleCompleteRefund(env, { ...body('VIS-PARTIAL'), amount }, user)).status, 'error');
assert.equal((await handleCompleteRefund(env, { ...body('VIS-PARTIAL'), reason: '' }, user)).status, 'error');
assert.equal((await handleCompleteRefund(env, { ...body('VIS-PARTIAL'), recipient: '' }, user)).status, 'error');
assert.equal(status('VIS-PARTIAL'), 'เสร็จสิ้น');
assert.equal(eventCount('VIS-PARTIAL'), 0);
assert.equal((await handleCompleteRefund(env, body('VIS-PARTIAL'), user)).status, 'ok');
assert.equal(status('VIS-PARTIAL'), 'คืนเงินแล้ว');
const evidence = (await handleGetRefundEvidence(env, { ref: 'VIS-PARTIAL' }, user)).evidence as {
  refund: { amount: number; actor: string };
  canCompleteRefund: boolean;
  slipImage: string;
};
assert.equal(evidence.refund.amount, 500.5);
assert.equal(evidence.refund.actor, 'finance');
assert.equal(evidence.canCompleteRefund, false);
assert.equal(evidence.slipImage, slip, 'original payment slip survives refund');
assert.equal((await handleCompleteRefund(env, body('VIS-PARTIAL'), user)).status, 'error');
assert.equal(eventCount('VIS-PARTIAL'), 1);
const admin = { username: 'admin', role: 'Superadmin' };
assert.equal((await handleUpdateStatus(env, { ref: 'VIS-PARTIAL', status: 'ชำระแล้ว' }, admin)).status, 'error');
assert.equal((await handleUpdateBooking(env, { ref: 'VIS-PARTIAL', status: 'ชำระแล้ว' }, admin)).status, 'error');
assert.equal((await handlePublicCancelBooking(env, { ref: 'VIS-PARTIAL' })).status, 'error');
assert.equal(
  (await handleUpdateVisitorApproval(env, { ref: 'VIS-PARTIAL', visitorApproved: 'yes' }, admin)).status,
  'error'
);
assert.equal((await handleUploadSlip(env, { ref: 'VIS-PARTIAL', base64Data: slip })).status, 'error');
assert.equal(
  (await handleUpdateSlipAndStatus(env, { ref: 'VIS-PARTIAL', status: 'ชำระแล้ว' }, admin, false)).status,
  'error'
);

seed('TBL-FULL', 'ชำระแล้ว', true);
assert.equal((await handleCompleteRefund(env, body('TBL-FULL', 2000), user)).status, 'ok');
assert.equal(status('TBL-FULL', true), 'คืนเงินแล้ว');
assert.equal((await handleUpdateStatus(env, { ref: 'TBL-FULL', status: 'ชำระแล้ว' }, admin)).status, 'error');
seed('VIS-UNPAID', 'รอชำระเงิน');
assert.equal((await handleCompleteRefund(env, body('VIS-UNPAID'), user)).status, 'error');
assert.equal(
  (await handleUpdateSlipAndStatus(env, { ref: 'VIS-UNPAID', status: 'คืนเงินแล้ว', base64Data: slip }, admin, false))
    .status,
  'error',
  'generic slip endpoint cannot bypass refund ledger'
);
seed('VIS-REVERTED', 'ยกเลิก');
for (const [action, details] of [
  ['status_changed', { newStatus: 'ชำระแล้ว' }],
  ['booking_payment_reverted', { previousStatus: 'ชำระแล้ว' }],
  ['booking_cancelled', { previousStatus: 'รอชำระเงิน' }],
] as const) {
  sqlite
    .prepare(
      "INSERT INTO event_log (timestamp, action, targetRef, details, result) VALUES ('2026-10-01 10:00:00', ?, 'VIS-REVERTED', ?, 'success')"
    )
    .run(action, JSON.stringify(details));
}
assert.equal(
  (await handleCompleteRefund(env, body('VIS-REVERTED'), user)).status,
  'error',
  'old paid status must not prove payment after reversion'
);
seed('VIS-NOSLIP', 'เสร็จสิ้น', false, false);
assert.equal((await handleCompleteRefund(env, body('VIS-NOSLIP'), user)).status, 'error');
seed('VIS-CANCELLED', 'ยกเลิก');
sqlite
  .prepare(
    "INSERT INTO event_log (timestamp, username, action, targetRef, details, result) VALUES ('2026-10-01 10:00:00', 'finance', 'booking_cancelled', ?, ?, 'success')"
  )
  .run('VIS-CANCELLED', JSON.stringify({ previousStatus: 'เสร็จสิ้น' }));
assert.equal(
  (await handleCompleteRefund(env, body('VIS-CANCELLED'), user)).status,
  'ok',
  'cancelled paid booking is eligible'
);

seed('VIS-RACE');
const concurrent = await Promise.all([
  handleCompleteRefund(env, body('VIS-RACE'), user),
  handleCompleteRefund(env, body('VIS-RACE'), user),
]);
assert.deepEqual(concurrent.map((result) => result.status).sort(), ['error', 'ok']);
assert.equal(eventCount('VIS-RACE'), 1, 'only one completion is committed');
seed('VIS-STALE');
beforeBatch = () => {
  sqlite.prepare('UPDATE reservations SET total = 1500 WHERE ref = ?').run('VIS-STALE');
};
assert.equal((await handleCompleteRefund(env, body('VIS-STALE'), user)).status, 'error');
assert.equal(eventCount('VIS-STALE'), 0);
assert.equal(status('VIS-STALE'), 'เสร็จสิ้น');
seed('VIS-ROLLBACK');
failUpdate = true;
await assert.rejects(handleCompleteRefund(env, body('VIS-ROLLBACK'), user), /injected update failure/);
failUpdate = false;
assert.equal(eventCount('VIS-ROLLBACK'), 0, 'failed status update rolls back audit record');
assert.equal(status('VIS-ROLLBACK'), 'เสร็จสิ้น');

seed('VIS-ROUTE');
const response = await dispatchAction(
  {
    env,
    request: new Request('https://example.test/'),
    body: body('VIS-ROUTE'),
    user: { ...user, displayName: 'Finance', viaJwt: true },
    ip: '',
    userAgent: '',
  },
  'completeRefund',
  false
);
assert.equal(((await response.json()) as { status: string }).status, 'ok');
assert.equal(status('VIS-ROUTE'), 'คืนเงินแล้ว');
sqlite.close();
console.log(
  'Refund completion passed: partial/full, archived/cancelled, permissions, validation, slip retention, immutable status, concurrent retries, stale booking, transactional rollback, and POST route.'
);
