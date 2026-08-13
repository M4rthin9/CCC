import { ThaiQRPaymentBuilder } from '@thai-qr-payment/payload';
import type { AdditionalDataFields, MerchantInfo } from '@thai-qr-payment/payload';

// EMVCo BillPayment references are application-defined free text. The hard
// wire constraint is the 99-byte cap of a 2-digit length field. Most bank apps
// only accept a safe subset and reject spaces/symbols, so we enforce the safe
// set here — every payload we emit stays valid for thai-qr-payment's parser
// and the Thai bank apps alike.
export const REF_PATTERN = /^[A-Z0-9]+$/;

/** Bank of Thailand Cross-Bank BillPayment caps each reference at 20 chars. */
export const REF_MAX_LENGTH = 20;

/** EMVCo MPM §4.7: every tag-62 sub-field value is at most 25 characters. */
export const TAG62_MAX_LENGTH = 25;

/** EMVCo MPM: tag 59 ≤ 25 chars, tag 60 ≤ 15 chars, tag 61 ≤ 10 chars. */
const MERCHANT_NAME_MAX = 25;
const MERCHANT_CITY_MAX = 15;
const MERCHANT_POSTAL_MAX = 10;

/** Tag 54 is a 2-digit-length field, and the amount carries 2 decimals. */
const AMOUNT_MAX = 9_999_999_999.99;

/**
 * Reduce free text to the printable-ASCII subset a Thai bank app can parse.
 *
 * EMVCo length prefixes count *characters*, but every scanner reads the QR as
 * a byte stream — so a 23-character Thai string declared as `23` is really 63
 * UTF-8 bytes on the wire and desynchronises the parser for every tag that
 * follows it. Non-ASCII is therefore dropped, not escaped: an approximate
 * label is worth nothing next to an unscannable QR. Returns `undefined` when
 * nothing survives, so the caller omits the field entirely.
 */
export function toWireText(value: string | undefined | null, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ascii = value
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!ascii) return undefined;
  return ascii.slice(0, maxLength).trim() || undefined;
}

/** PromptPay credit-transfer target (tag 29) — payable from any bank app
 *  without a registered biller agreement. */
export type PromptPayRecipient =
  | { kind: 'mobile' | 'nationalId' | 'eWallet'; value: string }
  | { kind: 'bankAccount'; bankCode: string; accountNo: string };

export interface PromptPayMerchantInfo {
  /** Tag 59. Printable ASCII only; Thai display names belong on the card. */
  name?: string;
  /** Tag 60. */
  city?: string;
  /** Tag 61. */
  postalCode?: string;
  /** Tag 52 — 4-digit ISO 18245 Merchant Category Code. */
  categoryCode?: string;
}

export interface PromptPayBillPaymentOptions {
  billerId: string;
  ref1: string;
  ref2?: string;
  ref3?: string;
  amount?: string | number;
  pointOfInitiation?: '11' | '12';
  /** Optional tag-62 sub-fields (bill number, store label, etc.). `ref3`
   *  still rides in sub-tag 07 (terminal label) unless an explicit
   *  `terminalLabel` is given here, which then wins. */
  additionalData?: Partial<AdditionalDataFields>;
  /** Tags 52/59/60/61. EMVCo makes merchant name and city mandatory; omitting
   *  them is tolerated by most apps but flagged by strict validators. */
  merchant?: PromptPayMerchantInfo;
  /** Credit-transfer target (tag 29). When set, the QR is a plain PromptPay
   *  transfer and the biller/reference fields are ignored. */
  recipient?: PromptPayRecipient;
}

function assertRef(label: string, value: string): void {
  if (!REF_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} "${value}" (must be uppercase A-Z / 0-9, no special chars).`);
  }
  if (value.length > REF_MAX_LENGTH) {
    throw new Error(`Invalid ${label} "${value}" (max ${REF_MAX_LENGTH} characters).`);
  }
}

/** Normalise a caller-supplied amount to satang precision, rejecting values
 *  tag 54 cannot carry. Float baht like `140.1 * 3` would otherwise emit a
 *  13-digit amount the bank app reads as a different number. */
function parseAmount(amount: string | number | undefined | null): number | undefined {
  if (amount === undefined || amount === null || amount === '') return undefined;
  const num = Number(amount);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid amount "${amount}" (must be a finite, non-negative number).`);
  }
  if (num > AMOUNT_MAX) {
    throw new Error(`Invalid amount "${amount}" (max ${AMOUNT_MAX} THB).`);
  }
  return Math.round(num * 100) / 100;
}

function applyRecipient(builder: ThaiQRPaymentBuilder, recipient: PromptPayRecipient): void {
  if (recipient.kind === 'bankAccount') {
    if (!/^\d{3}$/.test(recipient.bankCode)) {
      throw new Error(`Invalid bank code "${recipient.bankCode}" (must be the 3-digit BoT code).`);
    }
    if (!/^\d{1,20}$/.test(recipient.accountNo)) {
      throw new Error(`Invalid account number "${recipient.accountNo}" (digits only).`);
    }
    builder.bankAccount(recipient.bankCode, recipient.accountNo);
    return;
  }

  const value = recipient.value.replace(/[\s-]/g, '');
  const expected = recipient.kind === 'mobile' ? /^0\d{9}$/ : recipient.kind === 'nationalId' ? /^\d{13}$/ : /^\d{15}$/;
  if (!expected.test(value)) {
    throw new Error(
      `Invalid PromptPay ${recipient.kind} "${recipient.value}" ` +
        '(mobile = 10 digits starting 0, nationalId = 13 digits, eWallet = 15 digits).'
    );
  }
  builder.promptpay(value, recipient.kind);
}

/**
 * Per-booking PromptPay QR, built on `@thai-qr-payment/payload` (EMVCo MPM 1.1
 * + Bank of Thailand supplement). The library owns the TLV assembly and the
 * CRC-16/CCITT-FALSE checksum; this wrapper enforces what a real bank app will
 * actually accept off the wire.
 *
 *  - Default template is Cross-Bank BillPayment (tag 30): biller ID zero-padded
 *    to 15 digits, `ref3` in tag 62 sub-tag 07 (terminal label).
 *  - Pass `recipient` instead for a plain PromptPay credit transfer (tag 29),
 *    which needs no biller agreement with a bank.
 *  - Merchant name/city (tags 59/60) are emitted when supplied — EMVCo marks
 *    them mandatory.
 *  - All free-text fields are reduced to printable ASCII and clipped to their
 *    spec lengths, so declared TLV lengths always match the byte stream.
 *  - A payable amount flips the point-of-initiation to dynamic (12); a missing
 *    or zero amount keeps the QR static (11) unless forced otherwise.
 */
export function buildPromptPayBillPayment({
  billerId,
  ref1,
  ref2,
  ref3 = '0000',
  amount,
  pointOfInitiation,
  additionalData,
  merchant,
  recipient,
}: PromptPayBillPaymentOptions): string {
  if (pointOfInitiation !== undefined && pointOfInitiation !== '11' && pointOfInitiation !== '12') {
    throw new Error(`Invalid point of initiation "${pointOfInitiation}" (use "11" or "12").`);
  }

  const parsedAmount = parseAmount(amount);
  const builder = new ThaiQRPaymentBuilder();

  if (recipient) {
    applyRecipient(builder, recipient);
  } else {
    if (!/^\d{1,15}$/.test(billerId)) {
      throw new Error(`Invalid Biller ID "${billerId}" (must be 1-15 digits: Tax ID + suffix).`);
    }
    if (typeof ref1 !== 'string' || ref1.length === 0) {
      throw new Error('Reference 1 (ref1) is required and must be a non-empty string.');
    }
    assertRef('Reference 1', ref1);
    if (ref2 !== undefined && ref2 !== null && ref2 !== '') assertRef('Reference 2', String(ref2));

    builder.billPayment({
      billerId: billerId.padStart(15, '0'),
      reference1: ref1,
      reference2: ref2 !== undefined && ref2 !== null && ref2 !== '' ? String(ref2) : undefined,
    });
  }

  const mergedAdditional: AdditionalDataFields = {};
  for (const [key, raw] of Object.entries(additionalData ?? {})) {
    const clean = toWireText(raw, TAG62_MAX_LENGTH);
    if (clean) mergedAdditional[key as keyof AdditionalDataFields] = clean;
  }
  if (ref3 && mergedAdditional.terminalLabel === undefined) {
    const clean = toWireText(ref3, TAG62_MAX_LENGTH);
    if (clean) mergedAdditional.terminalLabel = clean;
  }
  if (Object.keys(mergedAdditional).length > 0) builder.additionalData(mergedAdditional);

  if (merchant) {
    const info: MerchantInfo = {};
    const name = toWireText(merchant.name, MERCHANT_NAME_MAX);
    const city = toWireText(merchant.city, MERCHANT_CITY_MAX);
    const postalCode = toWireText(merchant.postalCode, MERCHANT_POSTAL_MAX);
    if (name) info.name = name;
    if (city) info.city = city;
    if (postalCode) info.postalCode = postalCode;
    if (merchant.categoryCode) {
      if (!/^\d{4}$/.test(merchant.categoryCode)) {
        throw new Error(`Invalid merchant category code "${merchant.categoryCode}" (must be 4 digits).`);
      }
      info.categoryCode = merchant.categoryCode;
    }
    if (Object.keys(info).length > 0) builder.merchant(info);
  }

  // A payable amount sets tag 54 and flips the library to POI '12' on its own;
  // the explicit point-of-initiation only matters for static QRs.
  if (parsedAmount !== undefined && parsedAmount > 0) {
    builder.amount(parsedAmount);
  } else if (pointOfInitiation === '12') {
    builder.pointOfInitiation('dynamic');
  }

  return builder.build();
}

export type { PromptPayCardOptions } from './promptpayCard';
export { renderPromptPayCardSvg } from './promptpayCard';
