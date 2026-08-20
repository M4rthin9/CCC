import { getSettings } from '../db/queries/settings';
import type { PromptPayRecipient } from './promptpay';
import { Env } from '../types';

/** Fallback biller identity, mirrors Dashboard PROMPTPAY_DEFAULTS. */
export const PROMPTPAY_DEFAULTS = {
  billerId: '010753700088205',
  ref1: 'ML099400ZO0160208VX',
  ref2: 'CIDA',
  ref3: '0000',
  pointOfInitiation: '11',
} as const;

/** Receiving-account merchant label shown on the QR card caption (mirrors the
 *  Dashboard's "accountName"). Display only — Thai text cannot go on the wire,
 *  see `toWireText` in `services/promptpay.ts`. */
export const PROMPTPAY_MERCHANT_NAME = 'ร้านสงเคราะห์ผู้ต้องขัง';

/** EMVCo tags 59/60 are mandatory and must be printable ASCII. These are the
 *  wire-side counterparts of PROMPTPAY_MERCHANT_NAME; override from admin
 *  Settings (`promptpay.merchantNameEn` / `promptpay.merchantCity`). */
export const PROMPTPAY_MERCHANT_NAME_EN = 'CIDA PRISON SHOP';
export const PROMPTPAY_MERCHANT_CITY = 'BANGKOK';

export interface PromptPayConfig {
  billerId: string;
  ref1: string;
  ref2: string;
  ref3: string;
  pointOfInitiation: '11' | '12';
  /** Tag 59 — ASCII merchant name. */
  merchantNameEn: string;
  /** Tag 60 — ASCII merchant city. */
  merchantCity: string;
  /** Tag 52 — 4-digit MCC, omitted when unset. */
  merchantCategoryCode?: string;
  /** When set, mint a plain PromptPay credit transfer (tag 29) instead of a
   *  BillPayment QR — payable without a registered biller agreement. */
  recipient?: PromptPayRecipient;
  /** Receiving account holder names as printed on a payer's slip. Used only to
   *  match slip OCR against the real payee (`promptpay.receiverNames`). */
  receiverNames: string[];
  /** Trailing visible digits of the receiving account, e.g. "1234" for
   *  "xxx-x-x1234-x" (`promptpay.receiverAccountTail`). */
  receiverAccountTail: string;
}

/** Slips mask all but the last few digits of the receiving account. */
function readReceiverAccountTail(raw: Record<string, unknown>, recipient?: PromptPayRecipient): string {
  const explicit = typeof raw.receiverAccountTail === 'string' ? raw.receiverAccountTail : '';
  const fromRecipient = recipient && recipient.kind === 'bankAccount' ? recipient.accountNo : '';
  const digits = (explicit || fromRecipient).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function readReceiverNames(raw: Record<string, unknown>): string[] {
  const value = raw.receiverNames ?? raw.accountName;
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

/** Read the optional tag-29 recipient out of the settings blob. Anything
 *  malformed degrades to `undefined`, i.e. the BillPayment path. */
function readRecipient(raw: Record<string, unknown>): PromptPayRecipient | undefined {
  const kind = typeof raw.recipientType === 'string' ? raw.recipientType : '';
  if (kind === 'bankAccount') {
    const bankCode = typeof raw.bankCode === 'string' ? raw.bankCode : '';
    const accountNo = typeof raw.accountNo === 'string' ? raw.accountNo : '';
    return bankCode && accountNo ? { kind, bankCode, accountNo } : undefined;
  }
  if (kind !== 'mobile' && kind !== 'nationalId' && kind !== 'eWallet') return undefined;
  const value = typeof raw.recipient === 'string' ? raw.recipient.trim() : '';
  return value ? { kind, value } : undefined;
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
    merchantNameEn:
      typeof raw.merchantNameEn === 'string' && raw.merchantNameEn.trim()
        ? raw.merchantNameEn.trim()
        : PROMPTPAY_MERCHANT_NAME_EN,
    merchantCity:
      typeof raw.merchantCity === 'string' && raw.merchantCity.trim()
        ? raw.merchantCity.trim()
        : PROMPTPAY_MERCHANT_CITY,
    merchantCategoryCode:
      typeof raw.merchantCategoryCode === 'string' && /^\d{4}$/.test(raw.merchantCategoryCode)
        ? raw.merchantCategoryCode
        : undefined,
    recipient: readRecipient(raw),
    receiverNames: readReceiverNames(raw),
    receiverAccountTail: readReceiverAccountTail(raw, readRecipient(raw)),
  };
}
