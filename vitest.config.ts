import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { resolve } from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(resolve(__dirname, 'migrations'));
  return {
    test: {
      setupFiles: ['./tests/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              TEST_RUNNER: 'vitest',
              ENVIRONMENT: 'test',
              SEED_USERS_JSON: JSON.stringify([
                ['superadmin', 'initial-password', 'Superadmin', 'ผู้ดูแลระบบ'],
                ['finance1', 'initial-password', 'Finance', 'การเงิน'],
              ]),
              DISABLE_SEED_USERS: 'false',
              TURNSTILE_HOSTNAMES: 'cida.dpdns.org',
              PASSWORD_SALT: 'cc-cafe-reservation-v1',
              ARCHIVE_MONTHS: '3',
              BACKUP_RETENTION_DAYS: '30',
              d1Databases: { DB: migrations },
              kvNamespaces: { CC_CACHE: true },
              r2Buckets: { CC_SLIPS: true },
              durableObjects: { REALTIME_HUB: 'RealtimeHub' },
            },
          },
        },
      },
    },
  };
});
