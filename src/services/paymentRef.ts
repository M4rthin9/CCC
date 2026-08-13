import { invalidateLookupCache, invalidateReservationsCache } from '../cache/invalidation';
import { Env } from '../types';

// Per-booking PromptPay Reference 1: `PP` + 10 chars from a no-lookalike
// alphabet (no 0/O, 1/I/L/Q). Minted lazily on first QR / slip-verify access
// and pinned to the row by a partial unique index (migration 0008), so a
// booking's QR ref never changes after it is first generated.

export const REF_PREFIX = 'PP';
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REF_TAIL_LENGTH = 10;
const MAX_ATTEMPTS = 5;

export function generatePaymentRef(): string {
  let tail = '';
  for (let i = 0; i < REF_TAIL_LENGTH; i += 1) {
    tail += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return REF_PREFIX + tail;
}

async function readPaymentRef(env: Env, ref: string): Promise<string> {
  const row = await env.DB.prepare('SELECT payment_ref1 FROM reservations WHERE ref = ?')
    .bind(ref)
    .first<{ payment_ref1: string | null }>();
  return String(row?.payment_ref1 || '');
}

/**
 * Returns the booking's stable promptpay ref1, minting it on first call.
 * Concurrency-safe: only the first writer wins; collisions on the unique
 * index regenerate and retry.
 */
export async function ensureBookingPaymentRef(env: Env, ref: string): Promise<string> {
  const existing = await readPaymentRef(env, ref);
  if (existing) return existing;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = generatePaymentRef();
    try {
      const res = await env.DB.prepare("UPDATE reservations SET payment_ref1 = ? WHERE ref = ? AND payment_ref1 = ''")
        .bind(candidate, ref)
        .run();
      if (res.meta.changes > 0) {
        await invalidateReservationsCache(env);
        await invalidateLookupCache(env, ref);
        return candidate;
      }
      const winner = await readPaymentRef(env, ref);
      if (winner) return winner;
    } catch {
      // Unique-index violation: another request minted this exact value.
      // Regenerate and retry (bounded).
    }
  }
  throw new Error('Could not allocate a unique payment reference');
}
