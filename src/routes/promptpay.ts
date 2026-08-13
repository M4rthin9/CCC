import { buildPromptPayBillPayment, renderPromptPayCardSvg } from '../services/promptpay';
import { getPromptPayConfig, PROMPTPAY_MERCHANT_NAME } from '../services/promptpayConfig';
import { renderQr } from '../services/qrImage';
import { getReservationByRef } from '../db/queries/reservations';
import { checkRateLimit } from '../cache/kv';
import { rateLimitKey } from '../cache/keys';
import { sanitizeStr } from '../config';
import { Env } from '../types';
import { AuthenticatedUser } from '../auth/middleware';
import type { AdditionalDataFields } from '@thai-qr-payment/payload';

const QR_RATE_LIMIT_MAX = 30;
const QR_RATE_LIMIT_TTL_SECONDS = 60;

const ADDITIONAL_DATA_KEYS = [
  'billNumber',
  'mobileNumber',
  'storeLabel',
  'loyaltyNumber',
  'referenceLabel',
  'customerLabel',
  'terminalLabel',
  'purposeOfTransaction',
  'consumerDataRequest',
] as const;

/** Pull known tag-62 sub-fields out of an arbitrary JSON body value, capped so
 *  a malicious caller can't stuff a huge tag 62 into the wire payload. */
function sanitizeAdditionalData(value: unknown): Partial<AdditionalDataFields> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<AdditionalDataFields> = {};
  for (const key of ADDITIONAL_DATA_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    out[key] = raw.trim().slice(0, 32);
  }
  return out;
}

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
    const additionalData: AdditionalDataFields = { billNumber: ref, storeLabel: PROMPTPAY_MERCHANT_NAME };
    const payload = buildPromptPayBillPayment({
      billerId: cfg.billerId,
      ref1: cfg.ref1,
      ref2: cfg.ref2,
      ref3: cfg.ref3,
      amount,
      additionalData,
    });
    const qrCardSvg = renderPromptPayCardSvg(payload, {
      merchantName: PROMPTPAY_MERCHANT_NAME,
      amountLabel: `${amount.toLocaleString()} บาท`,
    });
    const { qrDataUrl } = await renderQr(payload);
    const base = { status: 'ok', payload, qrDataUrl, qrCardSvg, amount, additionalData };
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
  const merchantName = sanitizeStr(body.merchantName, 32) || PROMPTPAY_MERCHANT_NAME;
  const additionalData = sanitizeAdditionalData(body.additionalData);

  try {
    const payload = buildPromptPayBillPayment({
      billerId,
      ref1,
      ref2: ref2 || undefined,
      ref3,
      amount: amount || undefined,
      pointOfInitiation: pointOfInitiation === '12' ? '12' : '11',
      additionalData,
    });
    const qrCardSvg = renderPromptPayCardSvg(payload, {
      merchantName,
      amountLabel: amount ? `${amount} บาท` : undefined,
    });
    const { qrDataUrl } = await renderQr(payload);
    return {
      status: 'ok',
      payload,
      qrDataUrl,
      qrCardSvg,
      amount: amount || 0,
      billerId,
      ref1,
      ref2,
      ref3,
      merchantName,
      additionalData,
    };
  } catch (e) {
    return { status: 'error', message: String(e instanceof Error ? e.message : e) };
  }
}
