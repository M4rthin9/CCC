import { ThaiQRPaymentBuilder } from '@thai-qr-payment/payload';

// EMVCo BillPayment references are application-defined free text. The hard
// wire constraint is the 99-byte cap of a 2-digit length field. Most bank apps
// only accept a safe subset and reject spaces/symbols, so we enforce the safe
// set here — every payload we emit stays valid for thai-qr-payment's parser
// and the Thai bank apps alike.
export const REF_PATTERN = /^[A-Z0-9]+$/;

export interface PromptPayBillPaymentOptions {
  billerId: string;
  ref1: string;
  ref2?: string;
  ref3?: string;
  amount?: string | number;
  pointOfInitiation?: '11' | '12';
}

/**
 * Per-booking PromptPay Bill Payment QR, built on `@thai-qr-payment/payload`
 * (EMVCo MPM 1.1 + Bank of Thailand supplement). The library owns the TLV
 * assembly and the CRC-16/CCITT-FALSE checksum; this wrapper only validates the
 * biller identity and references the wire can actually carry.
 *
 * Wire parity with the old hand-rolled builder is preserved:
 *  - Biller ID zero-padded to 15 digits.
 *  - `ref3` rides in tag 62 sub-tag 07 (terminal label).
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
}: PromptPayBillPaymentOptions): string {
  if (!/^\d{1,15}$/.test(billerId)) {
    throw new Error(`Invalid Biller ID "${billerId}" (must be 1-15 digits: Tax ID + suffix).`);
  }
  if (typeof ref1 !== 'string' || ref1.length === 0) {
    throw new Error('Reference 1 (ref1) is required and must be a non-empty string.');
  }
  if (!REF_PATTERN.test(ref1)) {
    throw new Error(`Invalid Reference 1 "${ref1}" (must be uppercase A-Z / 0-9, no special chars).`);
  }
  if (ref2 !== undefined && ref2 !== null && !REF_PATTERN.test(String(ref2))) {
    throw new Error(`Invalid Reference 2 "${ref2}" (must be uppercase A-Z / 0-9, no special chars).`);
  }
  if (pointOfInitiation !== undefined && pointOfInitiation !== '11' && pointOfInitiation !== '12') {
    throw new Error(`Invalid point of initiation "${pointOfInitiation}" (use "11" or "12").`);
  }

  const effBillerId = billerId.padStart(15, '0');
  const effRef2 = ref2 !== undefined && ref2 !== null ? String(ref2) : undefined;

  let parsedAmount: number | undefined;
  if (amount !== undefined && amount !== null && amount !== '') {
    const num = Number(amount);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`Invalid amount "${amount}" (must be a finite, non-negative number).`);
    }
    parsedAmount = num;
  }

  const builder = new ThaiQRPaymentBuilder().billPayment({
    billerId: effBillerId,
    reference1: ref1,
    reference2: effRef2,
  });

  if (ref3) builder.additionalData({ terminalLabel: ref3 });

  // A payable amount sets tag 54 and flips the library to POI '12' on its own;
  // the explicit point-of-initiation only matters for static QRs.
  if (parsedAmount !== undefined && parsedAmount > 0) {
    builder.amount(parsedAmount);
  } else if (pointOfInitiation === '12') {
    builder.pointOfInitiation('dynamic');
  }

  return builder.build();
}
