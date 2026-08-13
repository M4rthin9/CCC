import { buildSlipVerify, buildTrueMoneySlipVerify } from '@thai-qr-payment/payload';
import UPNG from 'upng-js';
import { encode as encodeJpeg } from 'jpeg-js';
import { verifySlipBytes } from '../src/services/slipverify';
import { buildPromptPayBillPayment } from '../src/services/promptpay';
import { PROMPTPAY_DEFAULTS } from '../src/services/promptpayConfig';
import type { PromptPayConfig } from '../src/services/promptpayConfig';
import type { Reservation } from '../src/types';

const { toBuffer } = (await import('qrcode')) as unknown as {
  toBuffer: (text: string, opts: Record<string, unknown>) => Promise<Uint8Array>;
};

const cfg: PromptPayConfig = {
  billerId: PROMPTPAY_DEFAULTS.billerId,
  ref1: PROMPTPAY_DEFAULTS.ref1,
  ref2: PROMPTPAY_DEFAULTS.ref2,
  ref3: PROMPTPAY_DEFAULTS.ref3,
  pointOfInitiation: '11',
};

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
  billerId: cfg.billerId,
  ref1: cfg.ref1,
  ref2: cfg.ref2,
  ref3: cfg.ref3,
  amount: 500,
  pointOfInitiation: '12',
});
const payBadAmount = buildPromptPayBillPayment({
  billerId: cfg.billerId,
  ref1: cfg.ref1,
  ref2: cfg.ref2,
  ref3: cfg.ref3,
  amount: 999,
  pointOfInitiation: '12',
});
const payBadBiller = buildPromptPayBillPayment({
  billerId: '111111111111111',
  ref1: cfg.ref1,
  ref2: cfg.ref2,
  ref3: cfg.ref3,
  amount: 500,
  pointOfInitiation: '12',
});
const slipVerify = buildSlipVerify({ sendingBank: '002', transRef: '0002123123121200011' });
const tmSlipVerify = buildTrueMoneySlipVerify({ eventType: 'P2P', transactionId: 'TXN0001234567', date: '25012024' });

const r1 = (await verifySlipBytes(fakeDb, await qrPng(payOk), cfg, booking)).result;
// paymentQr carries no transaction id, so even a full field match only
// clears it for manual review — it can't prove a real payment happened.
check('payment-ok status', r1.status, 'slip_verify');
check('payment-ok biller', r1.match?.biller === true, true);
check('payment-ok refs', r1.match?.refs === true, true);
check('payment-ok amount', r1.match?.amount === true, true);

const r2 = (await verifySlipBytes(fakeDb, await qrPng(payBadAmount), cfg, booking)).result;
check('payment-bad-amount status', r2.status, 'mismatch');
check('payment-bad-amount flag', (r2.mismatch ?? []).includes('amount'), true);

const r3 = (await verifySlipBytes(fakeDb, await qrPng(payBadBiller), cfg, booking)).result;
check('payment-bad-biller status', r3.status, 'mismatch');
check('payment-bad-biller flag', (r3.mismatch ?? []).includes('biller'), true);

const r4 = (await verifySlipBytes(fakeDb, await qrPng(slipVerify), cfg, booking)).result;
check('slip-verify status', r4.status, 'slip_verify');
check('slip-verify kind', r4.kind, 'slipVerify');
check('slip-verify bank', (r4.detail?.sendingBank as string) === '002', true);
check('slip-verify review flag', r4.detail?.reviewRequired === true, true);

const r5 = (await verifySlipBytes(fakeDb, await qrPng(tmSlipVerify), cfg, booking)).result;
check('tm-slip-verify status', r5.status, 'slip_verify');
check('tm-slip-verify kind', r5.kind, 'trueMoneySlipVerify');

const r6 = (await verifySlipBytes(fakeDb, await combine(await qrPng(payOk), await qrPng(slipVerify)), cfg, booking))
  .result;
// Combined slip: the paymentQr envelope is preferred when both are present,
// but (as above) a clean match still only clears it for manual review.
check('two-qr status', r6.status, 'slip_verify');
check('two-qr qrCount>=2', r6.qrCount >= 2, true);
check('two-qr detail refs', (r6.detail?.reference1 as string) === cfg.ref1, true);

const r7 = (await verifySlipBytes(fakeDb, await toJpeg(await qrPng(payOk)), cfg, booking)).result;
check('jpeg path status', r7.status, 'slip_verify');

const blank = new Uint8Array(UPNG.encode([new Uint8Array(128 * 128 * 4).fill(255)], 128, 128, 4));
const r8 = (await verifySlipBytes(fakeDb, blank, cfg, booking)).result;
check('blank image status', r8.status, 'unreadable');

const dupeDb = {
  prepare: () => ({
    bind: () => ({ first: async () => ({ ref: 'VIS-99999', slip_fingerprint: '', slip_image_hash: 'x' }) }),
  }),
} as unknown as D1Database;
const r9 = (await verifySlipBytes(dupeDb, await qrPng(payOk), cfg, booking)).result;
check('duplicate status', r9.status, 'duplicate');
check('duplicate ref', r9.duplicateOfRef ?? '', 'VIS-99999');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
