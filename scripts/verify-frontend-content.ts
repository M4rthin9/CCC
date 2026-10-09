import assert from 'node:assert/strict';
import { applyFrontendChanges, publicFrontendContent } from '../src/services/frontendContent';
import { handleSaveFrontendContent } from '../src/routes/frontendContent';
import { handleGetPublicSettings } from '../src/routes/settings';
import type { Env } from '../src/types';

const current = { th: { homeHeroTitle: 'หัวเรื่องเดิม', homeCtaBook: 'จองเดิม' }, en: { homeCtaBook: 'Book now' } };
const updated = applyFrontendChanges(current, { th: { homeHeroTitle: 'หัวเรื่องใหม่' } });
assert.equal(updated.th?.homeHeroTitle, 'หัวเรื่องใหม่');
assert.equal(updated.th?.homeCtaBook, 'จองเดิม');
assert.equal(updated.en?.homeCtaBook, 'Book now');
assert.equal(current.th.homeHeroTitle, 'หัวเรื่องเดิม', 'patch must not mutate the original');
assert.equal(applyFrontendChanges(updated, { th: { homeHeroTitle: null } }).th?.homeHeroTitle, undefined);
assert.equal(
  applyFrontendChanges(updated, { th: { homeCtaBook: '' } }).th?.homeCtaBook,
  '',
  'empty text is an explicit override'
);
assert.equal(applyFrontendChanges({}, { th: { homePriceBaht: '{n} บาท · {n}' } }).th?.homePriceBaht, '{n} บาท · {n}');
for (const invalid of [
  null,
  [],
  { xx: {} },
  { th: [] },
  { th: { unknown: 'bad' } },
  { th: { homePriceBaht: 'missing token' } },
  { th: { homeCtaBook: '{extra}' } },
  { th: { homeCtaBook: 'x'.repeat(10001) } },
  { th: { homeCtaBook: 1 } },
])
  assert.throws(() => applyFrontendChanges({}, invalid));
assert.deepEqual(
  publicFrontendContent({
    ...current,
    promptpay: { billerId: 'secret' },
    th: { ...current.th, promptpay: 'secret', homePriceBaht: 'missing variable' },
  }),
  current
);
assert.deepEqual(publicFrontendContent({ th: ['bad'], en: null }), {});

let settings: Record<string, unknown> = {
  frontendContent: current,
  payment: { enabled: false, closedMessage: 'Payment is closed' },
  tableBooking: { enabled: false, maintenance: true, perDay: 7 },
  bookingWindow: { open: false },
  promptpay: { billerId: 'private-biller' },
  promo: { popupEnabled: false, ads: [], notice: { enabled: true, title: 'Existing promotion', body: '' } },
};
const original = structuredClone(settings);
let writes = 0;
const db = {
  prepare(sql: string) {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first() {
        if (sql.includes('FROM users'))
          return { username: params[0], role: params[0] === 'manager' ? 'Superadmin' : 'User' };
        if (sql.includes("key = 'admin_settings'")) return { value: JSON.stringify(settings) };
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        writes++;
        if (sql.includes("VALUES ('admin_settings'")) settings = JSON.parse(String(params[0]));
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  },
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  },
};
const env = { DB: db } as unknown as Env;
const denied = await handleSaveFrontendContent(
  env,
  { changes: { th: { homeCtaBook: 'Unauthorized' } } },
  { username: 'visitor' }
);
assert.equal(denied.status, 'error');
assert.equal(writes, 0, 'permission denial must not write');
const invalid = await handleSaveFrontendContent(
  env,
  { changes: { th: { homePriceBaht: 'Missing token' } } },
  { username: 'manager' }
);
assert.equal(invalid.status, 'error');
assert.equal(writes, 0, 'validation failure must not write');
const saved = await handleSaveFrontendContent(
  env,
  { changes: { th: { homeCtaBook: 'ข้อความใหม่' }, vi: { homeCtaBook: 'Đặt bàn' } } },
  { username: 'manager' }
);
assert.equal(saved.status, 'ok');
for (const key of ['payment', 'tableBooking', 'bookingWindow', 'promptpay', 'promo'])
  assert.deepEqual(settings[key], original[key], `${key} must survive a text save`);
assert.equal((settings.frontendContent as typeof current).en.homeCtaBook, 'Book now');
assert.equal(settings._savedBy, 'manager');
const publicSettings = await handleGetPublicSettings(env, 'https://api.example');
assert.equal((publicSettings.frontendContent as typeof current).th.homeCtaBook, 'ข้อความใหม่');
assert.equal('promptpay' in publicSettings, false);
assert.equal('settings' in publicSettings, false);
assert.equal(JSON.stringify(publicSettings).includes('private-biller'), false);
await handleSaveFrontendContent(env, { changes: { th: { homeCtaBook: null } } }, { username: 'manager' });
assert.equal((settings.frontendContent as typeof current).th.homeCtaBook, undefined);
assert.equal((settings.frontendContent as typeof current).th.homeHeroTitle, 'หัวเรื่องเดิม');
console.log(
  'Frontend content checks passed: validation, defaults, permissions, public allowlist, and preservation of operational settings.'
);
