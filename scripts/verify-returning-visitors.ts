import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  handleCreateBooking,
  handleUpdateBooking,
  handleUpdateStatus,
  handleUpdateVisitorApproval,
} from '../src/routes/reservations';
import { handleSaveReservation } from '../src/routes/public';
import { archiveReservationsByRef, getReservationByRef } from '../src/db/queries/reservations';
import { lastOpenDateISO } from '../src/services/bookingWindow';
import type { Env } from '../src/types';
import { approvalRecheckPlan, recheckUpdateSql } from './visitor-approval-recheck-plan';
import type { VisitorClearance } from '../src/services/visitorClearance';

const sqlite = new DatabaseSync(':memory:');
const migration = '0031_returning_visitor_clearances.sql';
for (const file of readdirSync('src/db/migrations')
  .filter((file) => file.endsWith('.sql') && file < migration)
  .sort())
  sqlite.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));

sqlite.exec(`
  INSERT INTO reservations_archive(ref, prisonerId, visitorId, visitorApproved, extraVisitorNames,
    extraVisitorApproved, status, updatedAt, total, visitorCount) VALUES
  ('VIS-history', ' P1 ', ' ab123 ', 'yes', 'Known extra|EX1|Partner|30;;Pending|PN1|Partner|30;;Child|EX2|Child|4',
    'yes;;;;yes', 'เสร็จสิ้น', '2026-11-04T00:00:00Z', 3000, 3),
  ('VIS-old-yes', 'P1', 'REVOKED', 'yes', '', '', 'เสร็จสิ้น', '2026-11-01T00:00:00Z', 2000, 1),
  ('VIS-new-no', 'P1', 'REVOKED', 'no', '', '', 'ไม่อนุมัติ', '2026-11-03T00:00:00Z', 1000, 0),
  ('VIS-legacy-names', 'P1', '', 'yes', 'Known extra (Partner)', 'yes', 'เสร็จสิ้น', '', 2000, 1),
  ('VIS-stage-only', 'P1', 'STAGEONLY', '', '', '', 'เสร็จสิ้น', '', 2000, 1),
  ('TBL-history', 'P1', 'TABLEONLY', 'yes', '', '', 'เสร็จสิ้น', '', 1000, 1);
  INSERT INTO reservations(ref, prisonerId, visitorId, visitorApproved, bookingType, status, updatedAt)
    VALUES ('VIS-live-history', 'P1', 'LIVE', 'yes', 'prisoner', 'รอตรวจสอบวินัย', '2026-11-04T00:00:00Z');
  INSERT INTO reservations_archive(ref, prisonerId, visitorId, participantApproved, extraVisitorNames, extraVisitorApproved)
    VALUES ('VIS-group-history', 'P1', 'GROUPMAIN', 'yes', 'Allowed|GROUPYES|Partner|30;;Denied|GROUPNO|Partner|30', ';;no');
`);
const snapshot = () =>
  JSON.stringify(
    ['reservations', 'reservations_archive'].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY ref`).all())
  );
const before = snapshot();
sqlite.exec(readFileSync(`src/db/migrations/${migration}`, 'utf8'));
assert.equal(snapshot(), before, 'backfill preserves every historical booking, amount, status and counter');
const clearance = (id: string, prisonerId = 'P1') =>
  sqlite.prepare('SELECT * FROM visitor_clearances WHERE prisonerId=? AND visitorId=?').get(prisonerId, id);
for (const id of ['AB123', 'EX1', 'EX2', 'LIVE']) assert.equal(clearance(id)?.decision, 'yes');
assert.equal(clearance('REVOKED')?.decision, 'no');
assert.equal(clearance('GROUPMAIN')?.decision, 'yes');
assert.equal(clearance('GROUPYES')?.decision, 'yes');
assert.equal(clearance('GROUPNO')?.decision, 'no');
for (const id of ['PN1', 'STAGEONLY', 'TABLEONLY', '']) assert.equal(clearance(id), undefined);
assert.equal(clearance('AB123', 'P2'), undefined);

// Exercise current handlers against the complete schema after testing the backfill.
for (const file of readdirSync('src/db/migrations')
  .filter((f) => f.endsWith('.sql') && f > migration)
  .sort())
  sqlite.exec(readFileSync(`src/db/migrations/${file}`, 'utf8'));

type Statement = { run(): Promise<{ meta: { changes: number } }> };
let beforeBatch: (() => void) | undefined;
let failBookingUpdate = false;
const env = {
  TURNSTILE_SECRET: 'test-only',
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
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          if (failBookingUpdate && sql.startsWith('UPDATE reservations SET'))
            throw new Error('injected booking update failure');
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      const hook = beforeBatch;
      beforeBatch = undefined;
      hook?.();
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
} as unknown as Env;
sqlite.exec(`INSERT INTO users (username, password, role, displayName, createdAt) VALUES
  ('admin', 'test-only', 'Superadmin', '', ''), ('clerk', 'test-only', 'Tadtel', '', ''),
  ('vinai', 'test-only', 'Vinai', '', ''), ('viewer', 'test-only', 'User', '', '');`);
const admin = { username: 'admin', role: 'Superadmin', displayName: 'Test admin', viaJwt: true };
const clerk = { username: 'clerk', role: 'Tadtel' };
const vinai = { username: 'vinai', role: 'Vinai' };
const read = (ref: string) => getReservationByRef(env.DB, ref);
let day = 1;
async function create(ref: string, visitorId = 'AB123', extraVisitorNames = '', prisonerId = 'P1') {
  const result = await handleCreateBooking(
    env,
    {
      ref,
      visitorId,
      extraVisitorNames,
      prisonerId,
      visitorName: 'Same name',
      relation: 'Partner',
      visitorAge: '35',
      visitDateISO: `2099-01-${String(day++).padStart(2, '0')}`,
    },
    admin
  );
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return (await read(ref))!;
}
async function discipline(ref: string) {
  return handleUpdateStatus(env, { ref, status: 'รอชำระเงิน', approvalStage: 'discipline' }, vinai);
}
const paymentAlerts = (ref: string) =>
  Number(sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE ref=? AND type='payment_due'").get(ref)!.n);

const lone = await create('VIS-alone');
assert.equal(lone.visitorApproved, 'yes');
assert.equal(lone.participantApproved, 'yes');
assert.equal(lone.disciplineApproved, '');
assert.equal(lone.status, 'รอตรวจสอบวินัย');
assert.equal(lone.total, 2000);
assert.equal((await discipline(lone.ref)).newStatus, 'รอชำระเงิน');

const mixed = await create('VIS-mixed', 'AB123', 'New person|NEW1|Partner|30');
assert.equal(mixed.visitorApproved, 'yes');
assert.equal(mixed.extraVisitorApproved, '');
assert.equal(mixed.participantApproved, '');
assert.equal(mixed.status, 'รอตรวจสอบผู้เข้าร่วม');
assert.equal(mixed.total, 3000, 'the initial quote includes the whole requested party');
assert.equal((await discipline(mixed.ref)).newStatus, 'รอตรวจสอบผู้เข้าร่วม');
sqlite
  .prepare("INSERT INTO push_subscriptions(endpoint,ref,p256dh,auth,createdAt,lastActiveAt) VALUES (?,?,'','','','')")
  .run('https://push.invalid/mixed', mixed.ref);
const completed = await handleUpdateVisitorApproval(env, { ref: mixed.ref, extraVisitorApproved: 'yes' }, clerk);
assert.equal(completed.status, 'ok');
assert.equal(completed.newStatus, 'รอชำระเงิน', 'the last individual decision completes the participant stage');
assert.equal(completed.participantApproved, 'yes');
assert.equal(clearance('NEW1')?.decision, 'yes');
assert.equal(clearance('NEW1')?.decidedBy, 'clerk');
assert.equal(paymentAlerts(mixed.ref), 1);
await handleUpdateVisitorApproval(env, { ref: mixed.ref, extraVisitorApproved: 'yes' }, clerk);
assert.equal(paymentAlerts(mixed.ref), 1);

const swapped = await create(
  'VIS-swapped',
  ' new1 ',
  'Former main|ab123|Partner|35;;Known extra|ex1|Partner|30;;Child now six|EX2|Child|6'
);
assert.equal(swapped.visitorApproved, 'yes');
assert.equal(swapped.extraVisitorApproved, 'yes;;yes;;yes');
assert.equal(
  swapped.participantApproved,
  'yes',
  'clearance follows identity when guest order or main/extra role changes'
);
assert.equal(swapped.total, 4500, 'the current age is priced again; old prices are never reused');

const editedReturning = await create('VIS-edited-returning', 'AB123', 'Known extra|EX1|Partner|30');
assert.equal(editedReturning.status, 'รอตรวจสอบวินัย');
const edited = await handleUpdateBooking(
  env,
  {
    ref: editedReturning.ref,
    extraVisitorNames: 'Known extra|EX1|Partner|30;;New extra|EDITNEW|Partner|30',
  },
  admin
);
assert.equal(edited.status, 'ok');
const afterEdit = (await read(editedReturning.ref))!;
assert.equal(afterEdit.visitorApproved, 'yes');
assert.equal(afterEdit.extraVisitorApproved, 'yes;;');
assert.equal(afterEdit.participantApproved, '', 'adding a new guest reopens Tadtel review');
assert.equal(afterEdit.status, 'รอตรวจสอบผู้เข้าร่วม');
const finalEditedDecision = await handleUpdateVisitorApproval(
  env,
  { ref: editedReturning.ref, extraVisitorApproved: 'yes;;yes' },
  clerk
);
assert.equal(finalEditedDecision.newStatus, 'รอตรวจสอบวินัย');
const appendKnown = await handleUpdateBooking(
  env,
  {
    ref: editedReturning.ref,
    extraVisitorNames: 'Known extra|EX1|Partner|30;;New extra|EDITNEW|Partner|30;;Returning|EX2|Child|6',
  },
  admin
);
assert.equal(appendKnown.status, 'ok');
assert.equal((await read(editedReturning.ref))!.extraVisitorApproved, 'yes;;yes;;yes');
assert.equal((await read(editedReturning.ref))!.status, 'รอตรวจสอบวินัย');
sqlite
  .prepare(
    `INSERT INTO reservations(ref,prisonerId,visitorId,visitorApproved,extraVisitorNames,participantApproved,status)
 VALUES('VIS-legacy-partial','P1','AB123','yes','Unreviewed|UNREVIEWED|Partner|30','yes','รอตรวจสอบวินัย')`
  )
  .run();
sqlite
  .prepare(
    `INSERT INTO visitor_clearances(prisonerId,visitorId,decision,sourceRef,decidedBy,decidedAt)
 VALUES('P1','UNREVIEWED','yes','VIS-legacy-partial','legacy','2026-11-12T00:00:00Z')`
  )
  .run();
await handleUpdateBooking(
  env,
  { ref: 'VIS-legacy-partial', extraVisitorNames: 'Unreviewed|UNREVIEWED|Partner|31' },
  admin
);
assert.equal((await read('VIS-legacy-partial'))!.status, 'รอตรวจสอบผู้เข้าร่วม');
const unreviewedAgain = await create('VIS-unreviewed-again', 'AB123', 'Unreviewed|UNREVIEWED|Partner|30');
assert.equal(unreviewedAgain.extraVisitorApproved, '', 'a corrected legacy stage cannot grant a new visitor history');
assert.equal(unreviewedAgain.status, 'รอตรวจสอบผู้เข้าร่วม');

const newMain = await create('VIS-new-main', 'NEWMAIN', 'Known extra|EX1|Partner|30');
assert.equal(newMain.visitorApproved, '');
assert.equal(newMain.extraVisitorApproved, 'yes');
assert.equal(newMain.participantApproved, '');
const mainDecision = await handleUpdateVisitorApproval(env, { ref: newMain.ref, visitorApproved: 'yes' }, clerk);
assert.equal(mainDecision.newStatus, 'รอตรวจสอบวินัย');
assert.equal((await read(newMain.ref))!.extraVisitorApproved, 'yes');
assert.equal(clearance('NEWMAIN')?.decision, 'yes');

const rejectedExtra = await create('VIS-extra-no', 'AB123', 'Rejected extra|DENIED|Partner|30');
const rejected = await handleUpdateVisitorApproval(env, { ref: rejectedExtra.ref, extraVisitorApproved: 'no' }, clerk);
assert.equal(
  rejected.participantApproved,
  'yes',
  'a decided rejection excludes that person without blocking approved guests'
);
assert.equal(rejected.total, 2000);
assert.equal(clearance('DENIED')?.decision, 'no');
assert.equal(
  (await create('VIS-denied-next', 'DENIED')).visitorApproved,
  '',
  'a previous rejection never grants a bypass or auto-rejects'
);

const revoke = await create('VIS-revoke');
assert.equal(
  (await handleUpdateVisitorApproval(env, { ref: revoke.ref, visitorApproved: 'no' }, clerk)).newStatus,
  'ไม่อนุมัติ'
);
assert.equal(clearance('AB123')?.decision, 'no');
const retry = await create('VIS-recheck');
assert.equal(retry.visitorApproved, '');
assert.equal(retry.participantApproved, '');
await handleUpdateVisitorApproval(env, { ref: retry.ref, visitorApproved: 'yes' }, clerk);
assert.equal((await create('VIS-reapproved')).participantApproved, 'yes');

for (const [ref, id, prisonerId] of [
  ['VIS-other-prisoner', 'AB123', 'P2'],
  ['VIS-name-match', 'SOMEONEELSE', 'P1'],
  ['VIS-missing-id', '', 'P1'],
  ['VIS-table-only', 'TABLEONLY', 'P1'],
  ['VIS-stage-only-next', 'STAGEONLY', 'P1'],
  ['VIS-revoked-history', 'REVOKED', 'P1'],
] as const)
  assert.equal((await create(ref, id, '', prisonerId)).participantApproved, '');

const group = await create('VIS-group-now', 'GROUPNEW', 'Other new|GROUPEXTRA|Partner|30');
assert.equal(
  (await handleUpdateStatus(env, { ref: group.ref, status: 'รอตรวจสอบวินัย', approvalStage: 'participant' }, clerk))
    .status,
  'ok'
);
assert.equal(clearance('GROUPNEW')?.decision, 'yes');
assert.equal(clearance('GROUPEXTRA')?.decision, 'yes');
assert.equal(
  (await create('VIS-group-next', 'GROUPNEW', 'Other new|GROUPEXTRA|Partner|30')).participantApproved,
  'yes'
);
await handleUpdateVisitorApproval(env, { ref: 'VIS-group-next', visitorApproved: 'no' }, clerk);
await handleUpdateStatus(env, { ref: group.ref, status: 'รอตรวจสอบวินัย', approvalStage: 'participant' }, clerk);
assert.equal(
  clearance('GROUPNEW')?.decision,
  'no',
  'replaying an older stage approval cannot overwrite a newer rejection'
);

const guarded = await create('VIS-guard', 'GUARDED');
for (const user of [{ username: 'viewer' }, vinai])
  assert.equal(
    (await handleUpdateVisitorApproval(env, { ref: guarded.ref, visitorApproved: 'yes' }, user)).status,
    'error'
  );
assert.equal(
  (await handleUpdateVisitorApproval(env, { ref: guarded.ref, visitorApproved: 'maybe' }, clerk)).status,
  'error'
);
assert.equal(clearance('GUARDED'), undefined);
failBookingUpdate = true;
await assert.rejects(handleUpdateVisitorApproval(env, { ref: guarded.ref, visitorApproved: 'yes' }, clerk), /injected/);
failBookingUpdate = false;
assert.equal(clearance('GUARDED'), undefined, 'a failed booking write rolls back its clearance');
assert.equal((await read(guarded.ref))!.visitorApproved, '');
beforeBatch = () => sqlite.prepare("UPDATE reservations SET status='ยกเลิก' WHERE ref=?").run(guarded.ref);
assert.equal(
  (await handleUpdateVisitorApproval(env, { ref: guarded.ref, visitorApproved: 'yes' }, clerk)).status,
  'error'
);
assert.equal(clearance('GUARDED'), undefined);
assert.equal((await read(guarded.ref))!.status, 'ยกเลิก', 'stale approval cannot revive a cancelled booking');

assert.equal(await archiveReservationsByRef(env.DB, [retry.ref], '2099-02-01'), 1);
assert.equal((await create('VIS-after-archive')).participantApproved, 'yes');

const originalFetch = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
try {
  const date = lastOpenDateISO(new Date());
  const publicKnown = await handleSaveReservation(
    env,
    {
      ref: 'VIS-public-known',
      visitorId: 'AB123',
      visitorName: 'Known',
      prisonerId: 'P1',
      visitDateISO: date,
      turnstileToken: 'test',
    },
    { ip: '', userAgent: '' }
  );
  assert.equal(publicKnown.status, 'ok');
  assert.equal(publicKnown.newStatus, 'รอตรวจสอบวินัย');
  assert.equal((await read(String(publicKnown.ref)))!.participantApproved, 'yes');
  const publicForged = await handleSaveReservation(
    env,
    {
      ref: 'VIS-public-forged',
      visitorId: 'FORGED',
      prisonerId: 'P3',
      visitDateISO: date,
      turnstileToken: 'test',
      visitorApproved: 'yes',
      participantApproved: 'yes',
      disciplineApproved: 'yes',
      status: 'รอชำระเงิน',
    },
    { ip: '', userAgent: '' }
  );
  assert.equal(publicForged.status, 'ok');
  assert.equal((await read(String(publicForged.ref)))!.participantApproved, '');
  assert.equal((await read(String(publicForged.ref)))!.disciplineApproved, '');
} finally {
  globalThis.fetch = originalFetch;
}

// Exercise the production reconciliation plan and its exact guarded UPDATE.
sqlite
  .prepare(
    `INSERT INTO reservations(ref,prisonerId,visitorId,extraVisitorNames,status,participantApproved,version,total)
 VALUES('VIS-recheck-mixed','P1','GROUPMAIN','New|NEVERREVIEW|Partner|30','รอตรวจสอบวินัย','yes',1,3000)`
  )
  .run();
sqlite
  .prepare(
    `INSERT INTO reservations(ref,prisonerId,visitorId,extraVisitorNames,status,participantApproved,version,total)
 VALUES('VIS-recheck-known','P1','GROUPMAIN','Known|GROUPYES|Partner|30','รอตรวจสอบผู้เข้าร่วม','',1,3000)`
  )
  .run();
const recheckLive = sqlite.prepare('SELECT * FROM reservations ORDER BY ref').all();
const recheckArchive = sqlite.prepare('SELECT * FROM reservations_archive ORDER BY ref').all();
const recheckClearances = sqlite.prepare('SELECT * FROM visitor_clearances').all() as unknown as Array<
  VisitorClearance & { prisonerId: string }
>;
const plan = approvalRecheckPlan(recheckLive, recheckArchive, recheckClearances, [], new Set());
const mixedPlan = plan.find((p) => p.ref === 'VIS-recheck-mixed')!;
assert.equal(mixedPlan.after.visitorApproved, 'yes');
assert.equal(mixedPlan.after.extraVisitorApproved, '');
assert.equal(mixedPlan.after.status, 'รอตรวจสอบผู้เข้าร่วม');
const knownPlan = plan.find((p) => p.ref === 'VIS-recheck-known')!;
assert.equal(knownPlan.after.extraVisitorApproved, 'yes');
assert.equal(knownPlan.after.status, 'รอตรวจสอบวินัย');
const protectedSnapshot = JSON.stringify(
  recheckLive.filter((r) => !['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน'].includes(String(r.status)))
);
sqlite.prepare("UPDATE reservations SET version=version+1 WHERE ref='VIS-recheck-known'").run();
const corrected = sqlite
  .prepare(recheckUpdateSql)
  .all(new Date().toISOString(), JSON.stringify([mixedPlan, knownPlan]));
assert.deepEqual(
  corrected.map((r) => r.ref),
  ['VIS-recheck-mixed'],
  'a concurrent edit is skipped'
);
assert.equal((await read('VIS-recheck-mixed'))!.total, 3000);
assert.equal((await read('VIS-recheck-known'))!.status, 'รอตรวจสอบผู้เข้าร่วม');
const afterRecheck = sqlite.prepare('SELECT * FROM reservations ORDER BY ref').all();
assert.equal(
  JSON.stringify(
    afterRecheck.filter((r) => !['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน'].includes(String(r.status)))
  ),
  protectedSnapshot
);
assert.deepEqual(sqlite.prepare('SELECT * FROM reservations_archive ORDER BY ref').all(), recheckArchive);

console.log(
  'PASS: history preservation, identity + prisoner scope, partial/new guests, reordered guests, rejection/reapproval, current pricing, atomic rollback/stale writes, roles, public forgery guards, archive, discipline/payment gates.'
);
