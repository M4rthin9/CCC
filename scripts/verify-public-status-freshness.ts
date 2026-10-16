import assert from 'node:assert/strict';
import { handleLookupByRef } from '../src/routes/public';
import { invalidateLookupCache, invalidateReservationsCache } from '../src/cache/invalidation';
import { lookupCacheKey } from '../src/cache/keys';
import type { Env } from '../src/types';

const cache = new Map<string, string>();
const versions = new Map<string, string>();
let versionUnavailable = false;
let reservationReads = 0;
let active = true;
const booking = {
  ref: 'VIS-FRESHNESS',
  prisonerId: 'TEST-MAIN',
  extraPrisoners: 'Co prisoner|TEST-CO|Test wing',
  visitorName: 'Main visitor',
  visitorApproved: '',
  extraVisitorNames: 'Extra visitor|PRIVATE-ID|Friend',
  extraVisitorApproved: '',
  status: 'รอตรวจสอบผู้เข้าร่วม',
};
const db = {
  async batch(statements: { run(): Promise<unknown> }[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  },
  prepare(sql: string) {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first() {
        if (sql.includes('FROM settings')) {
          if (versionUnavailable) throw new Error('Version read unavailable');
          const value = versions.get(String(params[0]));
          return value ? { value } : null;
        }
        if (sql.includes('FROM d1_cache')) {
          const value = cache.get(String(params[0]));
          return value ? { value } : null;
        }
        throw new Error(`Unexpected first: ${sql}`);
      },
      async all() {
        if (sql.includes('FROM reservations')) {
          reservationReads++;
          return { results: sql.includes('FROM reservations_archive') !== active ? [{ ...booking }] : [] };
        }
        throw new Error(`Unexpected all: ${sql}`);
      },
      async run() {
        const key = String(params[0]);
        if (sql.startsWith('INSERT INTO settings'))
          versions.set(key, String(Number(versions.get(key) ?? params[1]) + 1));
        else if (sql.startsWith('INSERT INTO d1_cache')) cache.set(key, String(params[1]));
        else if (sql.startsWith('DELETE FROM d1_cache')) cache.delete(key);
        else throw new Error(`Unexpected run: ${sql}`);
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  },
};
const env = { DB: db, CACHE_VERSION: 'test' } as unknown as Env;
const queries = [{ ref: booking.ref }, { prisonerId: 'TEST-MAIN' }, { prisonerId: 'TEST-CO' }];
async function lookup(query: (typeof queries)[number]) {
  const result = await handleLookupByRef(env, query);
  assert.equal(result.status, 'ok');
  const rows = result.rows as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.extraVisitorNames, 'Extra visitor');
  assert.equal(rows[0]!.visitorId, undefined);
  return rows[0]!;
}

for (const archived of [false, true]) {
  active = !archived;
  cache.clear();
  booking.status = 'รอตรวจสอบผู้เข้าร่วม';
  booking.visitorApproved = '';
  booking.extraVisitorApproved = '';
  for (const query of queries) await lookup(query);
  const reads = reservationReads;
  for (const query of queries) await lookup(query);
  assert.equal(reservationReads, reads, 'Unchanged reservations reuse cached lookup results');

  // Match staff writes: the reservation version advances and only the ref key is deleted.
  booking.visitorApproved = 'yes';
  booking.extraVisitorApproved = 'yes';
  booking.status = 'รอชำระเงิน';
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, booking.ref);
  for (const query of queries) {
    const row = await lookup(query);
    assert.equal(row.visitorApproved, 'yes', 'Approval must be fresh for every lookup mode');
    assert.equal(row.extraVisitorApproved, 'yes');
    assert.equal(row.status, booking.status);
  }

  booking.status = 'ชำระแล้ว';
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, booking.ref);
  for (const query of queries) assert.equal((await lookup(query)).status, 'ชำระแล้ว');
}

// Pre-upgrade cache entries must not keep the old approval labels alive.
cache.set(lookupCacheKey(env, booking.ref, null), JSON.stringify({ rows: [{ ...booking, visitorApproved: '' }] }));
assert.equal((await lookup({ ref: booking.ref })).visitorApproved, 'yes');

// If the version cannot be read, query the source and do not poison the cache.
versionUnavailable = true;
booking.status = 'เสร็จสิ้น';
const cachedBefore = new Map(cache);
for (const query of queries) assert.equal((await lookup(query)).status, 'เสร็จสิ้น');
assert.deepEqual(cache, cachedBefore);

console.log('Public status freshness passed: ref, prisoner, co-prisoner, archive, approvals and payment.');
