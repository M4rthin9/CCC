import { getSettings } from '../db/queries/settings';
import { Env } from '../types';

/** Fallback biller identity, mirrors Dashboard PROMPTPAY_DEFAULTS. */
export const PROMPTPAY_DEFAULTS = {
  billerId: '010753700088205',
  ref1: 'ML099400ZO0160208VX',
  ref2: 'CIDA',
  ref3: '0000',
  pointOfInitiation: '11',
} as const;

/** Receiving-account merchant label shown on the QR card caption and carried
 *  in tag-62 `storeLabel` (mirrors the Dashboard's "accountName"). */
export const PROMPTPAY_MERCHANT_NAME = 'ร้านสงเคราะห์ผู้ต้องขัง';

export interface PromptPayConfig {
  billerId: string;
  ref1: string;
  ref2: string;
  ref3: string;
  pointOfInitiation: '11' | '12';
}

/**
 * Resolve the PromptPay biller config saved from the Dashboard
 * (admin_settings.promptpay), falling back to PROMPTPAY_DEFAULTS. Never
 * throws; a broken settings row degrades to defaults.
 */
export async function getPromptPayConfig(env: Env): Promise<PromptPayConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const settings = await getSettings(env.DB);
    const pp = settings.promptpay;
    if (pp && typeof pp === 'object') raw = pp as Record<string, unknown>;
  } catch {
    // fall through to defaults
  }
  return {
    billerId: typeof raw.billerId === 'string' && raw.billerId ? raw.billerId : PROMPTPAY_DEFAULTS.billerId,
    ref1: typeof raw.ref1 === 'string' ? raw.ref1 : PROMPTPAY_DEFAULTS.ref1,
    ref2: typeof raw.ref2 === 'string' ? raw.ref2 : PROMPTPAY_DEFAULTS.ref2,
    ref3: typeof raw.ref3 === 'string' ? raw.ref3 : PROMPTPAY_DEFAULTS.ref3,
    pointOfInitiation: raw.pointOfInitiation === '12' ? '12' : '11',
  };
}
