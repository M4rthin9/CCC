import assert from 'node:assert/strict';
import worker from '../src/index';
import type { Env } from '../src/types';

const cancelled = ['VIS-90290', 'VIS-73239', 'VIS-21775'];
const statements: string[] = [];
const db = {
  batch: (items: { run: () => Promise<unknown> }[]) => Promise.all(items.map((item) => item.run())),
  prepare(sql: string) {
    statements.push(sql);
    const statement = {
      bind: (..._params: unknown[]) => statement,
      first: async () => (/COUNT\(\*\)/i.test(sql) ? { n: 0 } : null),
      all: async () => ({
        // If the removed two-day cleanup is reintroduced, it sees the three
        // cancelled fixtures instead of silently passing on an empty result.
        results: /WHERE status = \?[\s\S]*visitDateISO < date/i.test(sql) ? cancelled.map((ref) => ({ ref })) : [],
        success: true,
      }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    };
    return statement;
  },
};
const env = {
  DB: db,
  NOTIFY_PUSH_ENABLED: 'false',
  NOTIFY_LINE_ENABLED: 'false',
} as unknown as Env;
const pending: Promise<unknown>[] = [];
await worker.scheduled(
  { cron: '0 * * * *', scheduledTime: Date.parse('2026-10-08T17:00:00Z') } as ScheduledController,
  env,
  { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext
);
await Promise.all(pending);

assert.ok(
  statements.some((sql) => /UPDATE prisoners/i.test(sql)),
  'Daily housekeeping ran'
);
assert.ok(
  statements.some((sql) => /DELETE FROM refresh_tokens/i.test(sql)),
  'Expired sessions still cleaned'
);
assert.ok(
  statements.some((sql) => /COUNT\(\*\)[\s\S]*reservations/i.test(sql)),
  'Normal archive sweep still ran'
);
assert.ok(!statements.some((sql) => /visitDateISO < date/i.test(sql)), 'No two-day cancellation expiry');
assert.ok(!statements.some((sql) => /DELETE FROM reservations\b/i.test(sql)), 'Recent cancelled bookings retained');
assert.ok(!statements.some((sql) => /DELETE FROM notes\b/i.test(sql)), 'Cancellation notes retained');
assert.ok(
  !statements.some((sql) => /DELETE FROM (?:notifications|notification_subscriptions)\b/i.test(sql)),
  'Cancellation history retained'
);
console.log('Cancelled reservation retention checks passed.');
