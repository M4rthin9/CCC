import { applyD1Migrations } from '@cloudflare/vitest-pool-workers';

export default async function applyMigrations(): Promise<void> {
  await applyD1Migrations();
}
