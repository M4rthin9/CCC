import { buildPromptPayBillPayment } from '../services/promptpay';
import { getPromptPayConfig } from '../services/promptpayConfig';
import { renderQr } from '../services/qrImage';
import { getReservationByRef } from '../db/queries/reservations';
import { checkRateLimit } from '../cache/kv';
import { rateLimitKey } from '../cache/keys';
import { sanitizeStr } from '../config';
import { Env } from '../types';
import { AuthenticatedUser } from '../auth/middleware';

const QR_RATE_LIMIT_MAX = 30;
const QR_RATE_LIMIT_TTL_SECONDS = 60;

/**
 * PromptPay Bill Payment QR.
 *
 * Two paths:
 *  - body.ref set  -> public, per-booking: amount = the booking's
 *                     server-authoritative total; biller identity and
 *                     ref1/ref2/ref3 come from the resolved PromptPay config
 *                     (admin Settings), falling back to the fixed
 *                     PROMPTPAY_DEFAULTS. Rate-limited per IP (30/60s).
 *  - body.ref empty -> sample/diagnostic path, admin-only: builds a QR from
 *                     explicit billerId/ref1/ref2/ref3/amount fields.
 */
export async function handleGeneratePromptPayQr(
  env: Env,
  body: Record<string, unknown>,
  user: AuthenticatedUser | null,
  ip: string
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);

  if (!ref) {
    if (!user) return { status: 'error', message: 'Unauthorized' };
    return handleSampleQr(env, body);
  }

  if (!(await checkRateLimit(env.CACHE_KV, rateLimitKey('qr', ip), QR_RATE_LIMIT_MAX, QR_RATE_LIMIT_TTL_SECONDS))) {
    return { status: 'error', message: 'Too many requests — please try again later' };
  }

  const booking = await getReservationByRef(env.DB, ref);
  if (!booking) return { status: 'error', message: 'Ref not found' };

  const cfg = await getPromptPayConfig(env);
  const amount = Number(booking.total);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { status: 'error', message: 'Booking has no payable total — cannot mint a fixed-amount QR' };
  }

  try {
    const payload = buildPromptPayBillPayment({
      billerId: cfg.billerId,
      ref1: cfg.ref1,
      ref2: cfg.ref2,
      ref3: cfg.ref3,
      amount,
    });
    const { qrDataUrl } = await renderQr(payload);
    const base = { status: 'ok', payload, qrDataUrl, amount };
    if (user) {
      return { ...base, billerId: cfg.billerId, ref1: cfg.ref1, ref2: cfg.ref2, ref3: cfg.ref3 };
    }
    return base;
  } catch (e) {
    return { status: 'error', message: String(e instanceof Error ? e.message : e) };
  }
}

async function handleSampleQr(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = await getPromptPayConfig(env);
  const billerId = sanitizeStr(body.billerId, 15) || cfg.billerId;
  const ref1 = sanitizeStr(body.ref1, 64) || cfg.ref1;
  const ref2 = sanitizeStr(body.ref2, 64) || cfg.ref2;
  const ref3 = sanitizeStr(body.ref3, 64) || cfg.ref3;
  const amount = sanitizeStr(body.amount, 16);
  const pointOfInitiation = sanitizeStr(body.pointOfInitiation, 2) || undefined;

  try {
    const payload = buildPromptPayBillPayment({
      billerId,
      ref1,
      ref2: ref2 || undefined,
      ref3,
      amount: amount || undefined,
      pointOfInitiation: pointOfInitiation === '12' ? '12' : '11',
    });
    const { qrDataUrl } = await renderQr(payload);
    return { status: 'ok', payload, qrDataUrl, amount: amount || 0, billerId, ref1, ref2, ref3 };
  } catch (e) {
    return { status: 'error', message: String(e instanceof Error ? e.message : e) };
  }
}
