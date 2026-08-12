import { buildPromptPayBillPayment } from '../services/promptpay';
import { getSettings } from '../db/queries/settings';
import { sanitizeStr } from '../config';
import { Env } from '../types';

/** Fallback biller identity, mirrors Dashboard PROMPTPAY_DEFAULTS. */
export const PROMPTPAY_DEFAULTS = {
  billerId: '010753700088205',
  ref1: 'ML099400ZO0160208VX',
  ref2: 'CIDA',
  ref3: '0000',
  pointOfInitiation: '11',
} as const;

/**
 * Public read of the PromptPay biller config saved from the Dashboard
 * (admin_settings.promptpay). Only the promptpay subset is exposed; the
 * rest of admin_settings stays behind the admin auth gate.
 */
export async function handleGetPromptPayConfig(env: Env): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown> = {};
  try {
    const settings = await getSettings(env.DB);
    const pp = settings.promptpay;
    if (pp && typeof pp === 'object') raw = pp as Record<string, unknown>;
  } catch {
    // fall through to defaults
  }
  return {
    status: 'ok',
    config: {
      billerId: typeof raw.billerId === 'string' && raw.billerId ? raw.billerId : PROMPTPAY_DEFAULTS.billerId,
      ref1: typeof raw.ref1 === 'string' ? raw.ref1 : PROMPTPAY_DEFAULTS.ref1,
      ref2: typeof raw.ref2 === 'string' ? raw.ref2 : PROMPTPAY_DEFAULTS.ref2,
      ref3: typeof raw.ref3 === 'string' ? raw.ref3 : PROMPTPAY_DEFAULTS.ref3,
      pointOfInitiation: raw.pointOfInitiation === '12' ? '12' : '11',
    },
  };
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
