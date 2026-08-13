import {
  buildSlipVerify,
  buildTrueMoneySlipVerify,
  parsePayload,
  parseSlipVerify,
  parseTrueMoneySlipVerify,
} from '@thai-qr-payment/payload';
import UPNG from 'upng-js';
import { encode as encodeJpeg } from 'jpeg-js';
import { verifySlipBytes } from '../src/services/slipverify';
import { buildPromptPayBillPayment, renderPromptPayCardSvg } from '../src/services/promptpay';
import { buildSlipVerifyPayload, renderSlipVerifyMiniQr } from '../src/services/slipQr';
import { PROMPTPAY_DEFAULTS } from '../src/services/promptpayConfig';
import type { Reservation } from '../src/types';

const { toBuffer } = (await import('qrcode')) as unknown as {
  toBuffer: (text: string, opts: Record<string, unknown>) => Promise<Uint8Array>;
};

// Slip verification only checks whether the slip is REAL — a genuine
// bank/TrueMoney Mini-QR (which carries a real transaction id). Our own
// payment QR proves nothing about an actual payment, so a slip that is "just"
// our QR is unverified. The backoffice performs the payment approval.
const billerId = PROMPTPAY_DEFAULTS.billerId;
const paymentRef1 = PROMPTPAY_DEFAULTS.ref1;
const paymentRef2 = PROMPTPAY_DEFAULTS.ref2;
const booking = { ref: 'VIS-00001', total: 500 } as Reservation;

// No real D1 in this standalone script — stub a DB that always reports "no
// existing reservation reuses this slip" so the duplicate check is a no-op.
const fakeDb = {
  prepare: () => ({ bind: () => ({ first: async () => null }) }),
} as unknown as D1Database;

async function qrPng(text: string): Promise<Uint8Array> {
  return toBuffer(text, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
}

async function combine(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const a = UPNG.decode(left);
  const b = UPNG.decode(right);
  const aRgba = new Uint8Array(UPNG.toRGBA8(a)[0]!);
  const bRgba = new Uint8Array(UPNG.toRGBA8(b)[0]!);
  const out = new Uint8Array(a.width * (a.height + b.height) * 4);
  const aRow = a.width * 4;
  for (let y = 0; y < a.height; y += 1) {
    out.set(aRgba.subarray(y * aRow, (y + 1) * aRow), y * aRow);
  }
  const bRow = b.width * 4;
  for (let y = 0; y < b.height; y += 1) {
    out.set(bRgba.subarray(y * bRow, (y + 1) * bRow), (a.height + y) * aRow);
  }
  return new Uint8Array(UPNG.encode([out], a.width, a.height + b.height, 4));
}

async function toJpeg(png: Uint8Array): Promise<Uint8Array> {
  const p = UPNG.decode(png);
  const rgba = new Uint8Array(UPNG.toRGBA8(p)[0]!);
  const jpeg = encodeJpeg(
    { width: p.width, height: p.height, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) },
    90
  );
  return new Uint8Array(jpeg.data.buffer, jpeg.data.byteOffset, jpeg.data.byteLength);
}

let pass = 0;
let fail = 0;
function check(name: string, actual: string | boolean, expected: string | boolean): void {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: expected=${expected} actual=${actual}`);
  if (ok) pass += 1;
  else fail += 1;
}

const payOk = buildPromptPayBillPayment({
  billerId,
  ref1: paymentRef1,
  ref2: paymentRef2,
  amount: 500,
  pointOfInitiation: '12',
});
const payBadAmount = buildPromptPayBillPayment({
  billerId,
  ref1: paymentRef1,
  ref2: paymentRef2,
  amount: 999,
  pointOfInitiation: '12',
});
const payBadBiller = buildPromptPayBillPayment({
  billerId: '111111111111111',
  ref1: paymentRef1,
  ref2: paymentRef2,
  amount: 500,
  pointOfInitiation: '12',
});
// A QR carrying a different ref1 (e.g. an old dynamically-minted 'PP…' code) —
// still just our own payment QR, so equally unverified.
const payWrongRef1 = buildPromptPayBillPayment({
  billerId,
  ref1: 'PPZZ99999999',
  ref2: paymentRef2,
  amount: 500,
  pointOfInitiation: '12',
});
const slipVerify = buildSlipVerify({ sendingBank: '002', transRef: '0002123123121200011' });
const tmSlipVerify = buildTrueMoneySlipVerify({ eventType: 'P2P', transactionId: 'TXN0001234567', date: '25012024' });

// Library parity (thai-qr-payment): zero/missing amount => static QR with no
// tag 54 and POI '11'; billerIds shorter than 15 digits are zero-padded.
const payStatic = buildPromptPayBillPayment({
  billerId: '99400016550100',
  ref1: paymentRef1,
  ref2: paymentRef2,
  amount: 0,
});
const parsedStatic = parsePayload(payStatic);
check('static poi is 11', parsedStatic.pointOfInitiation === 'static', true);
check('static omits tag 54', parsedStatic.amount === null || parsedStatic.amount === undefined, true);
const parsedPadded = parsePayload(
  buildPromptPayBillPayment({ billerId: '99400016550100', ref1: paymentRef1, ref2: paymentRef2, amount: 500 })
);
const parsedMerchant = parsedPadded.merchant;
const paddedOk =
  parsedMerchant !== undefined &&
  parsedMerchant !== null &&
  parsedMerchant.kind === 'billPayment' &&
  parsedMerchant.billerId === '099400016550100';
check('biller zero-padded to 15', paddedOk, true);

// Tag-62 additional data: bill number + store label ride in the wire payload
// and round-trip through the parser, so the verify-slip return can surface them.
const payWithAdditional = buildPromptPayBillPayment({
  billerId,
  ref1: paymentRef1,
  ref2: paymentRef2,
  amount: 500,
  pointOfInitiation: '12',
  additionalData: { billNumber: 'VIS-00001', storeLabel: 'ร้านสงเคราะห์ผู้ต้องขัง' },
});
const parsedAdditional = parsePayload(payWithAdditional);
check('additionalData billNumber on wire', parsedAdditional.additionalData?.billNumber ?? '', 'VIS-00001');
check('additionalData storeLabel on wire', parsedAdditional.additionalData?.storeLabel ?? '', 'ร้านสงเคราะห์ผู้ต้องขัง');

// Branded card render: ECC-H QR in a 600x800 SVG carrying the caption.
const cardSvg = renderPromptPayCardSvg(payWithAdditional, {
  merchantName: 'ร้านสงเคราะห์ผู้ต้องขัง',
  amountLabel: '500 บาท',
});
check('card svg starts with <svg', cardSvg.startsWith('<svg'), true);
check('card svg has viewBox', cardSvg.includes('viewBox'), true);
check('card svg carries caption', cardSvg.includes('ร้านสงเคราะห์ผู้ต้องขัง'), true);

const r1 = (await verifySlipBytes(fakeDb, await qrPng(payOk), booking)).result;
// Our payment QR carries no bank transaction id — a slip that is "just" our
// QR is unverified (payment_qr_only), regardless of what fields it carries.
check('payment-only status', r1.status, 'unreadable');
check('payment-only reason', (r1.detail?.reason as string) ?? '', 'payment_qr_only');
check('payment-only kind', r1.kind, 'paymentQr');
check('payment-only ref1 present', (r1.detail?.reference1 as string) === paymentRef1, true);

const r2 = (await verifySlipBytes(fakeDb, await qrPng(payBadAmount), booking)).result;
check('payment-bad-amount status', r2.status, 'unreadable');
check('payment-bad-amount reason', (r2.detail?.reason as string) ?? '', 'payment_qr_only');

const r3 = (await verifySlipBytes(fakeDb, await qrPng(payBadBiller), booking)).result;
check('payment-bad-biller status', r3.status, 'unreadable');
check('payment-bad-biller reason', (r3.detail?.reason as string) ?? '', 'payment_qr_only');

const r3b = (await verifySlipBytes(fakeDb, await qrPng(payWrongRef1), booking)).result;
check('payment-wrong-ref1 status', r3b.status, 'unreadable');
check('payment-wrong-ref1 reason', (r3b.detail?.reason as string) ?? '', 'payment_qr_only');

const r3c = (await verifySlipBytes(fakeDb, await qrPng(payWithAdditional), booking)).result;
check('payment-additional status', r3c.status, 'unreadable');
check(
  'payment-additional reason',
  (r3c.detail?.reason as string) ?? '',
  'payment_qr_only',
);
const verifyAdditional = r3c.detail?.additionalData as Record<string, unknown> | undefined;
check('verify returns billNumber', (verifyAdditional?.billNumber as string) ?? '', 'VIS-00001');
check(
  'verify returns storeLabel',
  (verifyAdditional?.storeLabel as string) ?? '',
  'ร้านสงเคราะห์ผู้ต้องขัง',
);

const r4 = (await verifySlipBytes(fakeDb, await qrPng(slipVerify), booking)).result;
check('slip-verify status', r4.status, 'slip_verify');
check('slip-verify kind', r4.kind, 'slipVerify');
check('slip-verify bank', (r4.detail?.sendingBank as string) === '002', true);
check('slip-verify review flag', r4.detail?.reviewRequired === true, true);
check('slip-verify review reason', (r4.detail?.reviewReason as string) ?? '', 'backoffice_approval');

const r5 = (await verifySlipBytes(fakeDb, await qrPng(tmSlipVerify), booking)).result;
check('tm-slip-verify status', r5.status, 'slip_verify');
check('tm-slip-verify kind', r5.kind, 'trueMoneySlipVerify');

const r6 = (
  await verifySlipBytes(fakeDb, await combine(await qrPng(payOk), await qrPng(slipVerify)), booking)
).result;
// Combined slip: the real Mini-QR wins — the slip is real, and the payment QR
// is surfaced as extra context for the backoffice approval.
check('two-qr status', r6.status, 'slip_verify');
check('two-qr qrCount>=2', r6.qrCount >= 2, true);
check('two-qr detail ref1', (r6.detail?.paymentQr as Record<string, unknown> | undefined)?.reference1 === paymentRef1, true);

const r7 = (await verifySlipBytes(fakeDb, await toJpeg(await qrPng(payOk)), booking)).result;
check('jpeg path status', r7.status, 'unreadable');
check('jpeg path reason', (r7.detail?.reason as string) ?? '', 'payment_qr_only');

const blank = new Uint8Array(UPNG.encode([new Uint8Array(128 * 128 * 4).fill(255)], 128, 128, 4));
const r8 = (await verifySlipBytes(fakeDb, blank, booking)).result;
check('blank image status', r8.status, 'unreadable');

const dupeDb = {
  prepare: () => ({
    bind: () => ({ first: async () => ({ ref: 'VIS-99999', slip_fingerprint: '', slip_image_hash: 'x' }) }),
  }),
} as unknown as D1Database;
const r9 = (await verifySlipBytes(dupeDb, await qrPng(slipVerify), booking)).result;
check('duplicate status', r9.status, 'duplicate');
check('duplicate ref', r9.duplicateOfRef ?? '', 'VIS-99999');

// Slip Verify Mini-QR generator (thai-qr-payment `buildSlipVerify` /
// `buildTrueMoneySlipVerify`) — the anti-scammer artifact: a fake/edited slip
// has no Mini-QR (or one whose bank+transRef fails the issuer lookup).
const miniBankPayload = buildSlipVerifyPayload({ provider: 'bank', sendingBank: '002', transRef: '0002123123121200011' });
check('mini bank payload === buildSlipVerify', miniBankPayload, slipVerify);
check('mini bank parses', parseSlipVerify(miniBankPayload)?.sendingBank ?? '', '002');

const miniTmPayload = buildSlipVerifyPayload({
  provider: 'truemoney',
  eventType: 'P2P',
  transactionId: 'TXN0001234567',
  date: '25012024',
});
check('mini tm payload === buildTrueMoneySlipVerify', miniTmPayload, tmSlipVerify);
check('mini tm parses', parseTrueMoneySlipVerify(miniTmPayload)?.transactionId ?? '', 'TXN0001234567');

const rendered = await renderSlipVerifyMiniQr({ provider: 'bank', sendingBank: '014', transRef: 'PPTEST0001' });
check('mini render data-url', rendered.qrDataUrl.startsWith('data:image/svg+xml;base64,'), true);
const r10 = (await verifySlipBytes(fakeDb, await qrPng(rendered.payload), booking)).result;
check('mini rendered verifies', r10.status, 'slip_verify');
check('mini rendered kind', r10.kind, 'slipVerify');
check('mini rendered bank', (r10.detail?.sendingBank as string) ?? '', '014');

let miniBadBankThrew = false;
try {
  buildSlipVerifyPayload({ provider: 'bank', sendingBank: '00', transRef: 'X' });
} catch {
  miniBadBankThrew = true;
}
check('mini bank code validated', miniBadBankThrew, true);

let miniBadDateThrew = false;
try {
  buildSlipVerifyPayload({ provider: 'truemoney', eventType: 'P2P', transactionId: 'TXN1', date: '2501' });
} catch {
  miniBadDateThrew = true;
}
check('mini tm date validated', miniBadDateThrew, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
