import { buildPromptPayBillPayment } from '../services/promptpay';
import { getPromptPayConfig } from '../services/promptpayConfig';
import { sanitizeStr } from '../config';
import { Env } from '../types';

export { PROMPTPAY_DEFAULTS } from '../services/promptpayConfig';

/**
 * Public read of the PromptPay biller config saved from the Dashboard
 * (admin_settings.promptpay). Only the promptpay subset is exposed; the
 * rest of admin_settings stays behind the admin auth gate.
 */
export async function handleGetPromptPayConfig(env: Env): Promise<Record<string, unknown>> {
  const config = await getPromptPayConfig(env);
  return { status: 'ok', config };
}

export function handleGeneratePromptPayQr(body: Record<string, unknown>): Record<string, unknown> {
  const billerId = sanitizeStr(body.billerId, 15);
  const ref1 = sanitizeStr(body.ref1, 64);
  const ref2 = sanitizeStr(body.ref2, 64);
  const ref3 = sanitizeStr(body.ref3, 64) || undefined;
  const amount = sanitizeStr(body.amount, 16);
  const pointOfInitiation = sanitizeStr(body.pointOfInitiation, 2) || undefined;

  if (!billerId) return { status: 'error', message: 'Missing billerId (15-digit Biller ID: Tax ID + suffix)' };
  if (!ref1) return { status: 'error', message: 'Missing ref1 (Reference 1)' };

  try {
    const payload = buildPromptPayBillPayment({
      billerId,
      ref1,
      ref2: ref2 || undefined,
      ref3,
      amount: amount || undefined,
      pointOfInitiation: pointOfInitiation === '12' ? '12' : '11',
    });
    return { status: 'ok', payload };
  } catch (e) {
    return { status: 'error', message: String(e instanceof Error ? e.message : e) };
  }
}
