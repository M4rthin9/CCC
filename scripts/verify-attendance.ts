import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { SignJWT } from 'jose';
import { handleGetVisitorEntryQr, handleCheckVisitorEntry, handleGetAttendance } from '../src/routes/attendance';
import { attendanceToday, createEntryToken, readEntryToken, validAttendanceDate } from '../src/services/attendance';
import { getReservationByRef } from '../src/db/queries/reservations';
import { dispatchAction } from '../src/routes/dispatcher';
import type { Env } from '../src/types';

const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('src/db/migrations')
  .filter((file) => file.endsWith('.sql'))
  .sort())
  sqlite.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));
let beforeInsert: (() => void) | undefined;
const env = {
  JWT_SECRET: 'attendance-test-secret-only-at-least-32-characters',
  DB: {
    prepare(sql: string) {
      let args: Array<string | number | null> = [];
      const statement = {
        bind(...values: Array<string | number | null>) {
          args = values;
          return statement;
        },
        async first() {
          // D1 accepts SQLite's numbered parameters as positional bindings.
          return (
            sqlite
              .prepare(sql.replace(/\?\d+/g, '?'))
              .get(...(sql.includes('?4') ? [args[0]!, args[1]!, args[2]!, args[3]!, args[3]!, args[2]!] : args)) ??
            null
          );
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          if (sql.startsWith('INSERT INTO visitor_attendance')) {
            const inject = beforeInsert;
            beforeInsert = undefined;
            inject?.();
          }
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        },
      };
      return statement;
    },
  },
} as unknown as Env;
sqlite.exec(
  "INSERT INTO users (username, password, role, displayName, createdAt) VALUES ('reception', 'test', 'Tadtel', 'Reception', ''), ('finance', 'test', 'Finance', 'Finance', ''), ('viewer', 'test', 'User', 'Viewer', '')"
);
const today = attendanceToday();
const reception = { username: 'reception' };
const snapshot = () => JSON.stringify(sqlite.prepare('SELECT * FROM reservations ORDER BY ref').all());
function seed(ref: string, status = 'เสร็จสิ้น', date = today) {
  sqlite
    .prepare(
      `INSERT INTO reservations (ref, status, visitDateISO, visitorName, visitorId, visitorApproved,
    extraVisitorNames, extraVisitorApproved, visitorCount, total, bookingType)
    VALUES (?, ?, ?, 'Main guest', 'AB123', 'yes', 'Approved guest|ID2|Friend|30;;Rejected guest|ID3|Friend|30;;Pending guest|ID4|Friend|30', 'yes;;no;;', 2, 3000, ?)`
    )
    .run(ref, status, date, ref.startsWith('TBL') ? 'table' : 'prisoner');
}
async function issue(ref: string, visitorId = ' ab123 ') {
  return handleGetVisitorEntryQr(env, { ref, visitorId }, `test:${ref}:${visitorId}`);
}
async function scan(qr: string, guestKey?: string) {
  const result = await handleCheckVisitorEntry(env, { qr, guestKey }, reception, !!guestKey);
  assert.equal(result.status, 'ok', 'message' in result ? result.message : '');
  assert.ok('entry' in result);
  return result;
}

seed('VIS-TODAY');
const original = snapshot();
assert.equal((await issue('VIS-TODAY', 'wrong')).status, 'error');
assert.equal((await issue('VIS-TODAY', '')).status, 'error');
const pass = await issue('VIS-TODAY');
assert.ok('payload' in pass);
assert.match(pass.qrDataUrl, /^data:image\/svg\+xml;base64,/);
assert.ok(!pass.payload.includes('AB123') && !pass.payload.includes('Main guest'));
const modules = QRCode.create(pass.payload).modules;
const scale = 4,
  margin = 4,
  width = (modules.size + margin * 2) * scale;
const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
for (let y = 0; y < modules.size; y++)
  for (let x = 0; x < modules.size; x++) {
    if (!modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++)
      for (let dx = 0; dx < scale; dx++) {
        const offset = (((y + margin) * scale + dy) * width + (x + margin) * scale + dx) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
  }
assert.equal(jsQR(pixels, width, width)?.data, pass.payload, 'entry QR survives a real encoder/decoder round trip');
assert.equal(
  (await handleCheckVisitorEntry(env, { qr: pass.payload, username: 'reception' }, { username: 'viewer' })).status,
  'error'
);
assert.equal((await handleGetAttendance(env, {}, { username: 'viewer' })).status, 'error');
assert.equal((await handleCheckVisitorEntry(env, { qr: 'VIS-TODAY' }, reception)).status, 'error');
assert.equal(
  (await handleCheckVisitorEntry(env, { qr: pass.payload.slice(0, -5) + 'xxxxx' }, reception)).status,
  'error'
);
assert.equal(await readEntryToken('wrong-secret', pass.payload), null);
const authToken = await new SignJWT({ ref: 'VIS-TODAY', visitDateISO: today })
  .setProtectedHeader({ alg: 'HS256' })
  .sign(new TextEncoder().encode(env.JWT_SECRET));
assert.equal(await readEntryToken(env.JWT_SECRET, `CCC-ENTRY:${authToken}`), null, 'other JWT types are rejected');
const checked = await scan(pass.payload);
assert.equal(checked.entry.allowed, true);
assert.equal(checked.entry.guests.filter((guest) => guest.approved).length, 2);
assert.equal(snapshot(), original, 'issuing and scanning never edits the booking');
const mainKey = checked.entry.guests[0]!.guestKey;
const extraKey = checked.entry.guests[1]!.guestKey;
assert.equal(
  (await handleCheckVisitorEntry(env, { qr: pass.payload, guestKey: 'made-up' }, reception, true)).status,
  'error'
);
const simultaneous = await Promise.all([scan(pass.payload, mainKey), scan(pass.payload, mainKey)]);
assert.equal(simultaneous.filter((result) => result.recorded).length, 1);
assert.equal(simultaneous.filter((result) => result.alreadyCheckedIn).length, 1);
assert.equal((await scan(pass.payload, extraKey)).recorded, true);
assert.equal((await scan(pass.payload, extraKey)).alreadyCheckedIn, true);
assert.equal(snapshot(), original, 'attendance leaves every booking/report field unchanged');
const records = await handleGetAttendance(env, { date: today }, { username: 'finance' });
assert.ok('rows' in records);
assert.equal(records.rows.length, 2);
assert.equal(records.rows[0]!.checkedInBy, 'reception');
assert.equal((await handleGetAttendance(env, { date: '2026-02-30' }, reception)).status, 'error');
assert.equal(validAttendanceDate('invalid'), false);
for (const guest of checked.entry.guests.slice(2))
  assert.equal(
    (await scan(pass.payload, guest.guestKey)).recorded,
    true,
    'Completed payment overrides legacy individual flags'
  );
assert.equal(snapshot(), original, 'Payment-based check-in preserves original approval and report fields');

for (const status of ['รอชำระเงิน', 'ชำระแล้ว', 'ยกเลิก', 'คืนเงินแล้ว', 'ไม่อนุมัติ']) {
  const ref = `VIS-STATE-${status}`;
  seed(ref, status);
  assert.equal((await issue(ref)).status, 'error');
}
seed('VIS-FUTURE', 'เสร็จสิ้น', '2099-01-01');
const futurePass = await issue('VIS-FUTURE');
assert.ok('payload' in futurePass);
assert.equal((await scan(futurePass.payload)).entry.allowed, false);
assert.equal(
  (await handleCheckVisitorEntry(env, { qr: futurePass.payload, guestKey: mainKey }, reception, true)).status,
  'error'
);
seed('VIS-PAST', 'เสร็จสิ้น', '2020-01-01');
assert.equal((await issue('VIS-PAST')).status, 'error');
assert.equal(
  await readEntryToken(
    env.JWT_SECRET,
    await createEntryToken(env.JWT_SECRET, (await getReservationByRef(env.DB, 'VIS-PAST'))!)
  ),
  null
);
seed('TBL-TODAY');
sqlite
  .prepare(
    `UPDATE reservations SET visitorPhone = '0800000000', relation = 'Parent', visitorAge = '42',
  religion = 'Test main religion', allergy = 'Peanuts', extraVisitorReligions = 'Test extra religion;;Other;;',
  extraVisitorAllergies = 'Milk;;Eggs;;', totalPersons = 2, adultCount = 2,
  timestamp = '2026-11-02 08:30:00', createdBy = 'booking-staff', source = 'public',
  slip_key = 'private/slip/key', slip_verify_json = '{"private":"verification"}' WHERE ref = 'TBL-TODAY'`
  )
  .run();
const tablePass = await issue('TBL-TODAY');
assert.ok('payload' in tablePass);
const tableBeforeScan = snapshot();
const tableScan = await scan(tablePass.payload);
assert.equal(tableScan.entry.reservation.ref, 'TBL-TODAY');
assert.equal(tableScan.entry.reservation.bookingType, 'table');
assert.equal(tableScan.entry.reservation.visitDateISO, today);
assert.equal(tableScan.entry.reservation.visitorName, 'Main guest');
assert.equal(tableScan.entry.reservation.visitorId, 'AB123');
assert.equal(tableScan.entry.reservation.visitorPhone, '0800000000');
assert.equal(tableScan.entry.reservation.visitorCount, 2);
assert.equal(tableScan.entry.reservation.totalPersons, 2);
assert.equal(tableScan.entry.reservation.adultCount, 2);
assert.equal(tableScan.entry.reservation.total, 3000);
assert.equal(tableScan.entry.reservation.status, 'เสร็จสิ้น');
assert.equal(tableScan.entry.reservation.timestamp, '2026-11-02 08:30:00');
assert.equal(tableScan.entry.reservation.createdBy, 'booking-staff');
assert.equal(tableScan.entry.reservation.source, 'public');
assert.equal('slip_key' in tableScan.entry.reservation, false);
assert.equal('slip_verify_json' in tableScan.entry.reservation, false);
assert.equal(tableScan.entry.guests[0]!.id, 'AB123');
assert.equal(tableScan.entry.guests[0]!.relation, 'Parent');
assert.equal(tableScan.entry.guests[0]!.age, '42');
assert.equal(tableScan.entry.guests[0]!.religion, 'Test main religion');
assert.equal(tableScan.entry.guests[0]!.allergy, 'Peanuts');
assert.equal(tableScan.entry.guests[0]!.main, true);
assert.equal(tableScan.entry.guests[1]!.id, 'ID2');
assert.equal(tableScan.entry.guests[1]!.relation, 'Friend');
assert.equal(tableScan.entry.guests[1]!.age, '30');
assert.equal(tableScan.entry.guests[1]!.religion, 'Test extra religion');
assert.equal(tableScan.entry.guests[1]!.allergy, 'Milk');
assert.equal(tableScan.entry.guests[1]!.main, false);
assert.equal(tableScan.entry.guests[2]!.approval, 'no');
assert.equal(tableScan.entry.guests[3]!.approval, '');
assert.equal(snapshot(), tableBeforeScan, 'full reservation display does not change the daily report source');
const tableCheckIn = await scan(tablePass.payload, mainKey);
assert.equal(tableCheckIn.recorded, true);
assert.deepEqual(
  tableCheckIn.entry.reservation,
  tableScan.entry.reservation,
  'check-in retains the same full booking details'
);
assert.equal(tableCheckIn.entry.guests[0]!.attendance?.checkedInBy, 'reception');
assert.equal(snapshot(), tableBeforeScan, 'recording attendance leaves TBL daily report fields untouched');
async function dailyTables(date = today) {
  const response = await handleGetAttendance(env, { date }, reception);
  assert.ok('tables' in response);
  assert.ok(response.asOf && !Number.isNaN(Date.parse(response.asOf)));
  return response.tables;
}

seed('TBL-LATE-PAYMENT', 'รอชำระเงิน');
const sentReport = sqlite
  .prepare(
    "SELECT ref, status, visitorCount FROM reservations WHERE visitDateISO = ? AND status = 'เสร็จสิ้น' ORDER BY ref"
  )
  .all(today);
assert.equal(
  sentReport.some((row) => row.ref === 'TBL-LATE-PAYMENT'),
  false,
  'the sent report predates this payment'
);
let overview = await dailyTables();
let lateTable = overview.find((table) => table.ref === 'TBL-LATE-PAYMENT')!;
assert.equal(lateTable.registrationStatus, 'not_registered');
assert.equal(lateTable.checkedInCount, 0);
assert.equal(lateTable.remainingCount, 4);
assert.equal(lateTable.paymentConfirmed, false);
assert.equal(lateTable.eligible, false);
sqlite.prepare("UPDATE reservations SET status = 'เสร็จสิ้น' WHERE ref = 'TBL-LATE-PAYMENT'").run();
overview = await dailyTables();
lateTable = overview.find((table) => table.ref === 'TBL-LATE-PAYMENT')!;
assert.equal(
  lateTable.paymentConfirmed,
  true,
  'the live overview reflects payment confirmed after the report was sent'
);
assert.equal(lateTable.eligible, true);
assert.equal(lateTable.registrationStatus, 'not_registered', 'confirmed payment does not mean the table has arrived');
const latePass = await issue('TBL-LATE-PAYMENT');
assert.ok('payload' in latePass);
const afterLatePayment = snapshot();
await scan(latePass.payload, mainKey);
lateTable = (await dailyTables()).find((table) => table.ref === 'TBL-LATE-PAYMENT')!;
assert.equal(lateTable.registrationStatus, 'partial');
assert.equal(lateTable.checkedInCount, 1);
assert.equal(lateTable.remainingCount, 3);
assert.equal(lateTable.guests[0]!.checkedInBy, 'reception');
await scan(latePass.payload, extraKey);
await scan(latePass.payload, extraKey);
lateTable = (await dailyTables()).find((table) => table.ref === 'TBL-LATE-PAYMENT')!;
assert.equal(lateTable.registrationStatus, 'partial');
assert.equal(lateTable.checkedInCount, 2, 'duplicate scans never inflate the table registration count');
assert.equal(lateTable.remainingCount, 2);
for (const guest of (await scan(latePass.payload)).entry.guests.slice(2)) await scan(latePass.payload, guest.guestKey);
lateTable = (await dailyTables()).find((table) => table.ref === 'TBL-LATE-PAYMENT')!;
assert.equal(lateTable.registrationStatus, 'registered');
assert.equal(lateTable.checkedInCount, 4);
assert.equal(lateTable.remainingCount, 0);
assert.equal(snapshot(), afterLatePayment, 'late arrivals update attendance only');
assert.equal(
  sentReport.some((row) => row.ref === 'TBL-LATE-PAYMENT'),
  false,
  'the original sent report remains unchanged'
);
sqlite
  .prepare(
    "INSERT INTO reservations_archive (ref, status, visitDateISO, visitorName, visitorId, visitorApproved, visitorCount, bookingType) VALUES ('TBL-OLD-DAY', 'เสร็จสิ้น', '2020-01-01', 'Historical guest', 'AB123', 'yes', 1, '')"
  )
  .run();
sqlite
  .prepare(
    "INSERT INTO visitor_attendance (ref, visitDateISO, guestKey, guestName, checkedInAt, checkedInBy) VALUES ('TBL-OLD-DAY', '2020-01-01', ?, 'Historical guest', '2020-01-01T02:00:00Z', 'historical-officer')"
  )
  .run(mainKey);
assert.equal(
  (await dailyTables()).some((table) => table.ref === 'TBL-OLD-DAY'),
  false,
  'days stay separate'
);
const historical = (await dailyTables('2020-01-01')).find((table) => table.ref === 'TBL-OLD-DAY')!;
assert.equal(historical.registrationStatus, 'registered');
assert.equal(historical.bookingType, 'table', 'legacy TBL prefixes are supported');
assert.equal(historical.eligible, false, 'historical lists cannot authorize backdated check-in');
assert.equal(historical.guests[0]!.checkedInBy, 'historical-officer');
sqlite
  .prepare(
    "INSERT INTO reservations_archive (ref, status, visitDateISO, visitorName, total, bookingType) VALUES ('TBL-LATE-PAYMENT', 'ยกเลิก', ?, 'Outdated duplicate', 3000, 'table')"
  )
  .run(today);
const livePreferred = (await dailyTables()).filter((table) => table.ref === 'TBL-LATE-PAYMENT');
assert.equal(livePreferred.length, 1, 'an archive copy never duplicates or overrides the live booking');
assert.equal(livePreferred[0]!.visitorName, 'Main guest');
sqlite.prepare("UPDATE reservations SET status = 'ยกเลิก' WHERE ref = 'TBL-TODAY'").run();
const cancelledTable = (await dailyTables()).find((table) => table.ref === 'TBL-TODAY')!;
assert.equal(cancelledTable.active, false);
assert.equal(cancelledTable.eligible, false);
assert.equal(cancelledTable.checkedInCount, 1, 'cancellation preserves existing check-in evidence');
assert.equal((await scan(tablePass.payload)).entry.allowed, false, 'cancellation invalidates a previously issued QR');
assert.equal(
  (await handleCheckVisitorEntry(env, { qr: tablePass.payload, guestKey: extraKey }, reception, true)).status,
  'error'
);

for (const [index, change] of [
  "status = 'ยกเลิก'",
  "status = 'ชำระแล้ว'",
  "extraVisitorNames = 'Replacement|NEW|Friend|30'",
  "visitDateISO = '2099-01-01'",
].entries()) {
  const ref = `VIS-RACE-${index}`;
  seed(ref);
  const qr = await issue(ref);
  assert.ok('payload' in qr);
  beforeInsert = () => {
    sqlite.prepare(`UPDATE reservations SET ${change} WHERE ref = ?`).run(ref);
  };
  assert.equal(
    (await handleCheckVisitorEntry(env, { qr: qr.payload, guestKey: extraKey }, reception, true)).status,
    'error',
    change
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM visitor_attendance WHERE ref = ?').get(ref)?.n, 0);
}
seed('VIS-APPROVAL-RACE');
const approvalRaceQr = await issue('VIS-APPROVAL-RACE');
assert.ok('payload' in approvalRaceQr);
beforeInsert = () => {
  sqlite
    .prepare(
      "UPDATE reservations SET visitorApproved = '', extraVisitorApproved = 'no;;no;;' WHERE ref = 'VIS-APPROVAL-RACE'"
    )
    .run();
};
assert.equal(
  (await scan(approvalRaceQr.payload, extraKey)).recorded,
  true,
  'Approval-only edits do not invalidate confirmed payment'
);
seed('VIS-REFUND-HISTORY');
sqlite
  .prepare(
    "INSERT INTO event_log (timestamp, action, targetRef, result) VALUES ('', 'booking_refunded', 'VIS-REFUND-HISTORY', 'success')"
  )
  .run();
assert.equal((await issue('VIS-REFUND-HISTORY')).status, 'error');
const refundedTable = (await dailyTables()).find((table) => table.ref === 'VIS-REFUND-HISTORY')!;
assert.equal(refundedTable.active, false);
assert.equal(refundedTable.paymentConfirmed, false);
assert.equal(refundedTable.eligible, false);
for (let i = 0; i < 20; i++) await handleGetVisitorEntryQr(env, { ref: 'VIS-TODAY', visitorId: 'wrong' }, 'limited-ip');
const limited = await handleGetVisitorEntryQr(env, { ref: 'VIS-TODAY', visitorId: 'AB123' }, 'limited-ip');
assert.equal(limited.status, 'error');
assert.ok('message' in limited && limited.message.includes('รอสักครู่'));
const response = await dispatchAction(
  { env, body: {}, user: null, ip: 'test', userAgent: '', request: new Request('https://test.invalid') },
  'checkInVisitor',
  false
);
assert.equal(((await response.json()) as { message: string }).message, 'Unauthorized');

// Finance-confirmed bookings use payment status as the admission authority.
// Legacy individual flags must not prevent an ID-verified guest getting a QR.
for (const prefix of ['VIS', 'TBL']) {
  for (const approval of ['', 'no', 'pending']) {
    const ref = `${prefix}-PAID-FLAG-${String(approval)}`;
    seed(ref);
    sqlite
      .prepare(
        `UPDATE reservations SET visitorApproved = ?, extraVisitorApproved = '',
      extraVisitorNames = 'Extra guest|ID2|Friend|30', visitorCount = 2 WHERE ref = ?`
      )
      .run(approval, ref);
    const before = snapshot();
    assert.equal((await issue(ref, 'wrong-id')).status, 'error');
    const paidQr = await issue(ref);
    assert.ok('payload' in paidQr, 'message' in paidQr ? paidQr.message : 'Paid bookings must issue an ID-verified QR');
    const paidEntry = await scan(paidQr.payload);
    assert.equal(paidEntry.entry.allowed, true);
    assert.equal(paidEntry.entry.guests[0]!.approved, false, 'Original approval flags remain truthful');
    for (const guest of paidEntry.entry.guests)
      assert.equal((await scan(paidQr.payload, guest.guestKey)).recorded, true);
    const paidTable = (await dailyTables()).find((table) => table.ref === ref)!;
    assert.equal(paidTable.registrationStatus, 'registered');
    assert.equal(paidTable.remainingCount, 0);
    assert.equal(snapshot(), before, 'Payment-based entry never edits approval or report fields');
  }
}
console.log(
  'Attendance checks passed: live daily table registration, late payments/arrivals, full TBL details, identity/auth, date isolation, duplicate/racing scans, archive handling, refunds, and unchanged sent reports.'
);
