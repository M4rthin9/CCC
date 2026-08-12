export const PROMPTPAY_AID = 'A000000677010112';

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
  if (!/^\d{15}$/.test(billerId)) {
    throw new Error(`Invalid Biller ID "${billerId}" (must be exactly 15 digits: Tax ID + suffix).`);
  }
  if (typeof ref1 !== 'string' || ref1.length === 0) {
    throw new Error('Reference 1 (ref1) is required and must be a non-empty string.');
  }
  if (pointOfInitiation !== '11' && pointOfInitiation !== '12') {
    throw new Error(`Invalid point of initiation "${pointOfInitiation}" (use "11" or "12").`);
  }

  const format = buildTlv('00', '01');
  const poi = buildTlv('01', pointOfInitiation);

  const merchantFields = [
    buildTlv('00', PROMPTPAY_AID),
    buildTlv('01', billerId),
    buildTlv('02', ref1),
    ref2 ? buildTlv('03', ref2) : null,
  ]
    .filter((s): s is string => s !== null)
    .join('');
  const merchantInfo = buildTlv('30', merchantFields);

  const currency = buildTlv('53', '764');
  const amountTlv =
    amount !== undefined && amount !== null && amount !== '' ? buildTlv('54', Number(amount).toFixed(2)) : '';

  const country = buildTlv('58', 'TH');
  const additionalData = buildTlv('62', buildTlv('07', ref3));

  const withoutCrc = format + poi + merchantInfo + currency + amountTlv + country + additionalData;
  const withCrcMarker = `${withoutCrc}6304`;
  return `${withCrcMarker}${crc16(withCrcMarker)}`;
}
