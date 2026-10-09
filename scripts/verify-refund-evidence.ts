import assert from 'node:assert/strict';
import { summarizeRefundEvidence } from '../src/services/refundEvidence';
import { handleGetRefundEvidence } from '../src/routes/refundEvidence';
import { dispatchAction } from '../src/routes/dispatcher';
import type { Env, EventLog, Reservation } from '../src/types';

const booking: Reservation = {
  ref: 'VIS-12345',
  visitorName: 'Test customer',
  status: 'ยกเลิก',
  total: 2000,
  createdAt: '2026-10-01T03:00:00Z',
};
const event = (action: string, details: Record<string, unknown> = {}, overrides: Partial<EventLog> = {}): EventLog => ({
  timestamp: '2026-10-01 10:00:00',
  username: 'staff',
  action,
  targetRef: booking.ref,
  details: JSON.stringify(details),
  result: 'success',
  ip: '',
  userAgent: '',
  ...overrides,
});
const logs = [
  event('booking_submitted'),
  event('status_changed', { newStatus: 'รอชำระเงิน' }),
  event('slip_uploaded'),
  event('status_changed', { newStatus: 'เสร็จสิ้น' }),
  event('booking_cancelled', { previousStatus: 'เสร็จสิ้น' }),
];
const stages = summarizeRefundEvidence(booking, logs);
assert.match(stages[1]!.state, /พบบันทึกอนุมัติ/);
assert.match(stages[3]!.state, /พบบันทึกยืนยัน/);
assert.equal(stages[3]!.actor, 'staff');
const uploadedOnly = summarizeRefundEvidence({ ...booking, status: 'ชำระแล้ว' }, [event('slip_uploaded')]);
assert.match(uploadedOnly[3]!.state, /ไม่พบการยืนยัน/);
assert.equal(uploadedOnly[1]!.timestamp, '', 'never invent an approval date');
const unrelated = summarizeRefundEvidence(booking, [
  event('status_changed', { newStatus: 'เสร็จสิ้น' }, { targetRef: 'VIS-99999' }),
  event('status_changed', { newStatus: 'เสร็จสิ้น' }, { result: 'denied' }),
]);
assert.match(unrelated[3]!.state, /ไม่พบการยืนยัน/);
assert.match(
  summarizeRefundEvidence({ ...booking, ref: 'TBL-12345', bookingType: 'table' }, [])[1]!.state,
  /ไม่ต้องรออนุมัติ/
);
assert.match(
  summarizeRefundEvidence(booking, [event('slip_auto_approved')])[3]!.state,
  /ตรวจสลิปผ่านอัตโนมัติ; ไม่พบการยืนยัน/
);
assert.doesNotThrow(() =>
  summarizeRefundEvidence(booking, [event('status_changed', {}, { details: 'legacy plain text' })])
);

const queries: string[] = [];
let writes = 0;
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const env = {
  DB: {
    prepare(sql: string) {
      queries.push(sql);
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first() {
          if (sql.includes('FROM users'))
            return { username: args[0], role: args[0] === 'finance' ? 'Finance' : 'User' };
          if (sql.includes('slip_base64')) return { slipImage: '', slip_key: '', slip_base64: image };
          if (sql.includes('FROM reservations_archive')) return { ...booking, slip_key: 'private-key' };
          return null;
        },
        async all() {
          return { results: sql.includes('FROM event_log') ? logs : [] };
        },
        async run() {
          writes++;
          return { success: true };
        },
      };
      return statement;
    },
  },
} as unknown as Env;
const denied = await handleGetRefundEvidence(env, { ref: booking.ref, username: 'finance' }, { username: 'user' });
assert.equal(denied.status, 'error');
assert.equal(
  queries.some((sql) => sql.includes('FROM reservations')),
  false,
  'deny before reading customer records'
);
const result = await handleGetRefundEvidence(env, { ref: booking.ref }, { username: 'finance' });
assert.equal(result.status, 'ok');
const evidence = result.evidence as { booking: Reservation; slipImage: string };
assert.equal(evidence.booking._archived, true);
assert.equal(evidence.booking.slip_key, undefined);
assert.equal(evidence.slipImage, image);
assert.equal(writes, 0, 'preparing evidence must not change status or refund money');
assert.ok(queries.some((sql) => sql.includes('WHERE targetRef = ?') && !sql.includes('LIMIT 500')));
const response = await dispatchAction(
  {
    env,
    request: new Request('https://example.test/'),
    body: { ref: booking.ref },
    user: { username: 'finance', role: 'Finance', displayName: 'Finance', viaJwt: true },
    ip: '',
    userAgent: '',
  },
  'getRefundEvidence',
  false
);
assert.equal(((await response.json()) as { status: string }).status, 'ok', 'dashboard POST action is wired');
console.log(
  'Refund evidence checks passed: lifecycle history, pending payment, missing audit data, permissions, archived slips, exact reference lookup, POST route, and no mutations.'
);
