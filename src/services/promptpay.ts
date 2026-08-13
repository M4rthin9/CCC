export const PROMPTPAY_AID = 'A000000677010112';

// EMVCo BillPayment references are application-defined free text (library
// posture); the hard wire constraint is the 99-byte cap of a 2-digit length
// field. Most bank apps only accept a safe subset and reject spaces/symbols,
// so we enforce the safe set here — every payload we emit stays valid for
// thai-qr-payment's parser and the Thai bank apps alike.
export const REF_PATTERN = /^[A-Z0-9]+$/;

export function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

export function buildTlv(tag: string, value: string): string {
  if (!/^\d{2}$/.test(tag)) {
    throw new Error(`Invalid EMVCo tag "${tag}" (must be exactly 2 digits).`);
  }
  if (value.length > 99) {
    throw new Error(
      `EMVCo value for tag "${tag}" is ${value.length} chars, exceeds the 99-char max for a 2-digit length field.`
    );
  }
  const length = String(value.length).padStart(2, '0');
  return `${tag}${length}${value}`;
}

export interface PromptPayBillPaymentOptions {
  billerId: string;
  ref1: string;
  ref2?: string;
  ref3?: string;
  amount?: string | number;
  pointOfInitiation?: '11' | '12';
}

export function buildPromptPayBillPayment({
  billerId,
  ref1,
  ref2,
  ref3 = '0000',
  amount,
  pointOfInitiation = '11',
}: PromptPayBillPaymentOptions): string {
  if (!/^\d{1,15}$/.test(billerId)) {
    throw new Error(`Invalid Biller ID "${billerId}" (must be 1-15 digits: Tax ID + suffix).`);
  }
  const effBillerId = billerId.padStart(15, '0');
  if (typeof ref1 !== 'string' || ref1.length === 0) {
    throw new Error('Reference 1 (ref1) is required and must be a non-empty string.');
  }
  if (!REF_PATTERN.test(ref1)) {
    throw new Error(`Invalid Reference 1 "${ref1}" (must be uppercase A-Z / 0-9, no special chars).`);
  }
  if (ref2 !== undefined && ref2 !== null && !REF_PATTERN.test(String(ref2))) {
    throw new Error(`Invalid Reference 2 "${ref2}" (must be uppercase A-Z / 0-9, no special chars).`);
  }
  if (pointOfInitiation !== '11' && pointOfInitiation !== '12') {
    throw new Error(`Invalid point of initiation "${pointOfInitiation}" (use "11" or "12").`);
  }

  // Amount posture mirrors the library: two-decimal wire value; a missing,
  // zero, or non-finite amount means "static QR" — no tag 54 at all, so the
  // payee's banking app prompts for the amount. Negative/NaN/Infinity throw.
  let effAmount: string | null = null;
  if (amount !== undefined && amount !== null && amount !== '') {
    const num = Number(amount);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`Invalid amount "${amount}" (must be a finite, non-negative number).`);
    }
    if (num > 0) effAmount = num.toFixed(2);
  }

  // Auto-POI: a payable QR (amount present and > 0) must use POI '12' so the
  // payee isn't asked to key in the amount. An explicit '12' with no amount is
  // accepted as-is (some banks still render a payment-only QR for it).
  const effPoi = effAmount !== null ? '12' : pointOfInitiation;

  const format = buildTlv('00', '01');
  const poi = buildTlv('01', effPoi);

  const merchantFields = [
    buildTlv('00', PROMPTPAY_AID),
    buildTlv('01', effBillerId),
    buildTlv('02', ref1),
    ref2 ? buildTlv('03', ref2) : null,
  ]
    .filter((s): s is string => s !== null)
    .join('');
  const merchantInfo = buildTlv('30', merchantFields);

  const currency = buildTlv('53', '764');
  const amountTlv = effAmount !== null ? buildTlv('54', effAmount) : '';

  const country = buildTlv('58', 'TH');
  const additionalData = buildTlv('62', buildTlv('07', ref3));

  const withoutCrc = format + poi + merchantInfo + currency + amountTlv + country + additionalData;
  const withCrcMarker = `${withoutCrc}6304`;
  return `${withCrcMarker}${crc16(withCrcMarker)}`;
}
