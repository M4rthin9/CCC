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
import { computeApprovalTotals } from '../src/services/pricing';
import { buildSlipVerifyPayload, renderSlipVerifyMiniQr } from '../src/services/slipQr';
import { importPrisonersBulk, type PrisonerImportRow } from '../src/db/queries/prisoners';
import { PROMPTPAY_DEFAULTS } from '../src/services/promptpayConfig';
import { handleGetPublicSettings, readPaymentSwitch } from '../src/routes/settings';
import { handleUpdateSlipAndStatus } from '../src/routes/slip';
import { decideSlip, parseSlipDateTime } from '../src/services/slipMatch';
import type { SlipMatchInput } from '../src/services/slipMatch';
import type { PromptPayConfig } from '../src/services/promptpayConfig';
import type { SlipOcrFields } from '../src/services/slipOcr';
import type { Env } from '../src/types';
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
  merchant: { name: 'CIDA PRISON SHOP', city: 'BANGKOK' },
});
const parsedAdditional = parsePayload(payWithAdditional);
check('additionalData billNumber on wire', parsedAdditional.additionalData?.billNumber ?? '', 'VIS-00001');
// Thai text is dropped, never emitted: EMVCo lengths count characters but every
// scanner reads bytes, so a 23-char / 63-byte value desyncs the whole payload.
check('non-ascii storeLabel dropped', parsedAdditional.additionalData?.storeLabel === undefined, true);
check('payload is pure ascii', /^[\x20-\x7E]*$/.test(payWithAdditional), true);
// EMVCo marks merchant name (59) and city (60) mandatory.
check('merchant name on wire', payWithAdditional.includes('5916CIDA PRISON SHOP'), true);
check('merchant city on wire', payWithAdditional.includes('6007BANGKOK'), true);
check('crc valid with merchant tags', parsedAdditional.crc?.valid ?? false, true);

// Float baht must land on satang precision — tag 54 is length-prefixed, so a
// stray 100.30000000000001 would be read as a different number by the bank.
check(
  'amount rounded to satang',
  buildPromptPayBillPayment({ billerId, ref1: paymentRef1, amount: 0.1 + 0.2 }).includes('54040.30'),
  true
);
// Reference caps: BOT allows at most 20 chars per reference.
let refTooLong = false;
try {
  buildPromptPayBillPayment({ billerId, ref1: 'A'.repeat(21), amount: 500 });
} catch {
  refTooLong = true;
}
check('ref1 over 20 chars rejected', refTooLong, true);

// Plain PromptPay credit transfer (tag 29) — payable with no biller agreement.
const payMobile = buildPromptPayBillPayment({
  billerId,
  ref1: paymentRef1,
  amount: 250,
  recipient: { kind: 'mobile', value: '081-234-5678' },
  merchant: { name: 'CIDA PRISON SHOP', city: 'BANGKOK' },
});
const parsedMobile = parsePayload(payMobile);
check('mobile QR uses promptpay template', parsedMobile.merchant?.kind ?? '', 'promptpay');
check('mobile QR crc valid', parsedMobile.crc?.valid ?? false, true);

// Branded card render: ECC-H QR in a 600x830 SVG carrying the caption.
const cardSvg = await renderPromptPayCardSvg(payWithAdditional, {
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
check('payment-additional reason', (r3c.detail?.reason as string) ?? '', 'payment_qr_only');
const verifyAdditional = r3c.detail?.additionalData as Record<string, unknown> | undefined;
check('verify returns billNumber', (verifyAdditional?.billNumber as string) ?? '', 'VIS-00001');
// The Thai store label never reaches the wire, so it cannot come back out of a
// scanned slip either; the ASCII merchant name is what round-trips.
check('verify drops non-ascii storeLabel', verifyAdditional?.storeLabel === undefined, true);

const r4 = (await verifySlipBytes(fakeDb, await qrPng(slipVerify), booking)).result;
check('slip-verify status', r4.status, 'slip_verify');
check('slip-verify kind', r4.kind, 'slipVerify');
check('slip-verify bank', (r4.detail?.sendingBank as string) === '002', true);
check('slip-verify review flag', r4.detail?.reviewRequired === true, true);
check('slip-verify review reason', (r4.detail?.reviewReason as string) ?? '', 'backoffice_approval');

const r5 = (await verifySlipBytes(fakeDb, await qrPng(tmSlipVerify), booking)).result;
check('tm-slip-verify status', r5.status, 'slip_verify');
check('tm-slip-verify kind', r5.kind, 'trueMoneySlipVerify');

const r6 = (await verifySlipBytes(fakeDb, await combine(await qrPng(payOk), await qrPng(slipVerify)), booking)).result;
// Combined slip: the real Mini-QR wins — the slip is real, and the payment QR
// is surfaced as extra context for the backoffice approval.
check('two-qr status', r6.status, 'slip_verify');
check('two-qr qrCount>=2', r6.qrCount >= 2, true);
check(
  'two-qr detail ref1',
  (r6.detail?.paymentQr as Record<string, unknown> | undefined)?.reference1 === paymentRef1,
  true
);

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
const miniBankPayload = buildSlipVerifyPayload({
  provider: 'bank',
  sendingBank: '002',
  transRef: '0002123123121200011',
});
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

// Approve-visitor recalc (computeApprovalTotals) — the fee is recomputed from
// each visitor's age ladder (<5 free, 5-8 half, 9+ full) using only approved
// visitors. Persisted extra approvals are fed in when only the main visitor is
// approved, so extra fees are never dropped.
const mainAdult = computeApprovalTotals(
  true,
  'no;;yes',
  'A|1|บิดา / มารดา|30;;B|2|บุตร / ธิดา|6',
  'บิดา / มารดา',
  '30'
);
check('approve main-only keeps approved extra (child 5-8)', String(mainAdult.total), '2500');
check('approve main-only visitorCount', String(mainAdult.visitorCount), '2');
check('approve main-only adultCount', String(mainAdult.adultCount), '1');
check('approve main-only child5to8Count', String(mainAdult.child5to8Count), '1');
check('approve main-only childUnder5Count', String(mainAdult.childUnder5Count), '0');

const singleChildExtra = computeApprovalTotals(true, 'yes', 'B|2|บุตร / ธิดา|4', 'บิดา / มารดา', '30');
check('approve single extra child <5 free', String(singleChildExtra.total), '2000');
check('approve single extra childUnder5Count', String(singleChildExtra.childUnder5Count), '1');

const childAge9 = computeApprovalTotals(true, 'yes', 'B|2|บุตร / ธิดา|9', 'บิดา / มารดา', '30');
check('approve extra child age 9 full fee', String(childAge9.total), '3000');
check('approve extra child age 9 adultCount', String(childAge9.adultCount), '2');

const mainChild5to8 = computeApprovalTotals(true, undefined, '', 'บุตร / ธิดา', '6');
check('approve main child 5-8 half', String(mainChild5to8.total), '1500');
check('approve main child 5-8 child5to8Count', String(mainChild5to8.child5to8Count), '1');

const mainChildUnder5 = computeApprovalTotals(true, undefined, '', 'บุตร / ธิดา', '4');
check('approve main child <5 free', String(mainChildUnder5.total), '1000');
check('approve main child <5 childUnder5Count', String(mainChildUnder5.childUnder5Count), '1');

const mainRejected = computeApprovalTotals(false, 'yes', 'B|2|บุตร / ธิดา|6', 'บิดา / มารดา', '30');
check('approve main rejected total', String(mainRejected.total), '1000');
check('approve main rejected visitorCount', String(mainRejected.visitorCount), '0');
check('approve main rejected no children counted', String(mainRejected.child5to8Count), '0');

// --- prisoner import full-replace semantics ---
type CapturedStmt = { sql: string; params: unknown[] };
function makeCapDb(): { db: D1Database; stmts: CapturedStmt[]; batches: CapturedStmt[][] } {
  const stmts: CapturedStmt[] = [];
  const batches: CapturedStmt[][] = [];
  const db = {
    prepare: (sql: string) => ({
      sql,
      params: [] as unknown[],
      bind: (...params: unknown[]) => {
        const stmt = { sql, params };
        stmts.push(stmt);
        return stmt;
      },
    }),
    batch: async (list: unknown[]) => {
      batches.push(list as CapturedStmt[]);
    },
  } as unknown as D1Database;
  return { db, stmts, batches };
}

const oldList = [
  { prisonerId: 'A', prisonerName: 'เก่า A', wing: '1' },
  { prisonerId: 'B', prisonerName: 'เก่า B', wing: '2' },
  { prisonerId: 'C', prisonerName: 'เก่า C', wing: '3' },
];
const { db: capDb, stmts: capStmts, batches: capBatches } = makeCapDb();
const replaced = await importPrisonersBulk(
  capDb,
  [
    {
      prisonerId: 'A',
      prisonerName: 'ใหม่ A',
      wing: '2',
      status: 'ติดวินัย งดเยี่ยม',
      vinaiDate: '2025-01-01',
      note: 'x',
    },
    { prisonerId: 'B', prisonerName: 'เก่า B', wing: '2', status: '', vinaiDate: '', note: '' },
    { prisonerId: 'D', prisonerName: 'ใหม่ D', wing: '4', status: '', vinaiDate: '', note: '' },
  ],
  oldList
);
check('import replace added', String(replaced.added), '1');
check('import replace updated', String(replaced.updated), '2');
check('import replace removed', String(replaced.removed), '1');
check('import replace wingChanged', String(replaced.wingChanged), '1');
check('import replace wingChanges id', String(replaced.wingChanges[0]?.prisonerId), 'A');
check(
  'import replace delete leads batch',
  String(capBatches[0]![0]!.sql.trim().toUpperCase().startsWith('DELETE FROM PRISONERS')),
  'true'
);
check('import replace single batch', String(capBatches.length), '1');
const capInserts = capStmts.filter((s) => s.sql.includes('INSERT'));
check('import replace insert statements', String(capInserts.length), '1');
check('import replace insert params', String(capInserts[0]!.params.length), '18');

const { db: capDbBig, stmts: bigStmts, batches: bigBatches } = makeCapDb();
const bigRows: PrisonerImportRow[] = [];
for (let i = 0; i < 20000; i++)
  bigRows.push({ prisonerId: 'P' + i, prisonerName: 'N' + i, wing: '1', status: '', vinaiDate: '', note: '' });
const bigResult = await importPrisonersBulk(capDbBig, bigRows, []);
check('import 20k added', String(bigResult.added), '20000');
const bigInserts = bigStmts.filter((s) => s.sql.includes('INSERT'));
check('import 20k statement count', String(bigInserts.length), '1250');
check('import 20k max params per stmt', String(Math.max(...bigInserts.map((s) => s.params.length)) <= 100), 'true');
check(
  'import 20k delete first in batch 0',
  String(bigBatches[0]![0]!.sql.trim().toUpperCase().startsWith('DELETE FROM PRISONERS')),
  'true'
);
check('import 20k batch 0 size', String(bigBatches[0]!.length), '100');
check('import 20k total batches', String(bigBatches.length), '13');

const { db: capDbDup, stmts: dupStmts } = makeCapDb();
const dedup = await importPrisonersBulk(
  capDbDup,
  [
    { prisonerId: 'X', prisonerName: 'Name 1', wing: '1', status: '', vinaiDate: '', note: '' },
    { prisonerId: 'X', prisonerName: 'Name 2', wing: '9', status: '', vinaiDate: '', note: '' },
  ],
  []
);
check('import dedup total', String(dedup.total), '1');
check('import dedup added', String(dedup.added), '1');
const dupInserts = dupStmts.filter((s) => s.sql.includes('INSERT'));
check('import dedup single insert', String(dupInserts.length), '1');
check('import dedup last row name wins', String(dupInserts[0]!.params[1]), 'Name 2');
check('import dedup last row wing wins', String(dupInserts[0]!.params[2]), '9');

// -- Payment window switch --------------------------------------------------
// The flag lives in the admin_settings JSON blob. It must fail OPEN: a missing
// or malformed `payment` key can never be allowed to stop people paying.
function envWithSettings(value: string | null): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => (value === null ? null : { value }) }),
        first: async () => (value === null ? null : { value }),
      }),
    },
  } as unknown as Env;
}

const payMissing = await readPaymentSwitch(envWithSettings(null));
check('payment switch missing row defaults open', payMissing.enabled, true);

const payNoKey = await readPaymentSwitch(envWithSettings(JSON.stringify({ promptpay: { billerId: 'x' } })));
check('payment switch missing key defaults open', payNoKey.enabled, true);

const payGarbage = await readPaymentSwitch(envWithSettings(JSON.stringify({ payment: 'nonsense' })));
check('payment switch malformed key defaults open', payGarbage.enabled, true);

const payOpenFlag = await readPaymentSwitch(envWithSettings(JSON.stringify({ payment: { enabled: true } })));
check('payment switch explicit open', payOpenFlag.enabled, true);

const payClosed = await readPaymentSwitch(
  envWithSettings(JSON.stringify({ payment: { enabled: false, closedMessage: 'come back later' } }))
);
check('payment switch explicit closed', payClosed.enabled, false);
check('payment switch closed message', payClosed.closedMessage, 'come back later');

// The public endpoint must expose the payment fields and the table-booking knobs
// and nothing else -- the same blob also holds the PromptPay biller config.
const publicSettings = await handleGetPublicSettings(
  envWithSettings(JSON.stringify({ promptpay: { billerId: 'SECRET' }, payment: { enabled: false } }))
);
check('public settings exposes paymentEnabled', String(publicSettings.paymentEnabled), 'false');
check('public settings hides promptpay', String('promptpay' in publicSettings), 'false');
// status + the two payment fields + the tableBooking knobs the booking page needs.
check('public settings key count', String(Object.keys(publicSettings).length), '4');
check(
  'public settings exposes tableBooking perDay',
  String((publicSettings.tableBooking as { perDay?: number } | undefined)?.perDay),
  '10'
);

// Closed payment must block an unauthenticated slip submission before any write.
const closedEnv = envWithSettings(JSON.stringify({ payment: { enabled: false, closedMessage: 'closed now' } }));
const blocked = await handleUpdateSlipAndStatus(closedEnv, { ref: 'VIS-00001' }, { username: 'public' }, true);
check('closed payment blocks public slip submit', String(blocked.status), 'error');
check('closed payment returns admin message', String(blocked.message), 'closed now');

// ── Slip matching: what may settle a booking without a bank API ─────────
// The Mini-QR proves a slip is real; these rules decide whether the *right
// money* reached the *right payee*, off the OCR'd slip text.

check(
  'slip time parses BE numeric',
  parseSlipDateTime('15/08/2568 14:32')?.toISOString() ?? '',
  '2025-08-15T07:32:00.000Z'
);
check(
  'slip time parses Thai month',
  parseSlipDateTime('15 ส.ค. 2568 14:32')?.toISOString() ?? '',
  '2025-08-15T07:32:00.000Z'
);
check(
  'slip time parses CE + Latin month',
  parseSlipDateTime('15 Aug 2025 - 14:32')?.toISOString() ?? '',
  '2025-08-15T07:32:00.000Z'
);
check(
  'slip time parses Thai digits',
  parseSlipDateTime('๑๕/๐๘/๒๕๖๘ ๑๔:๓๒')?.toISOString() ?? '',
  '2025-08-15T07:32:00.000Z'
);
check(
  'slip time parses ISO without day-first confusion',
  parseSlipDateTime('2025-08-15 14:32')?.toISOString() ?? '',
  '2025-08-15T07:32:00.000Z'
);
check('slip time rejects junk', parseSlipDateTime('ไม่มีวันที่') === null, true);
check('slip time rejects null', parseSlipDateTime(null) === null, true);

// ref1 comes from the biller agreement — fixed by the bank, identical on every
// booking's QR, so it identifies the payee and not the booking.
const matchCfg = { merchantNameEn: 'CIDA PRISON SHOP', ref1: PROMPTPAY_DEFAULTS.ref1 } as PromptPayConfig;
const paidBooking = {
  ref: 'VIS-00001',
  total: 500,
  createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  status: 'รอชำระเงิน',
} as Reservation;
// Slips print Bangkok local time, so a "just now" fixture is UTC + 7h.
const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000 - 5 * 60 * 1000)
  .toISOString()
  .replace('T', ' ')
  .slice(0, 16);
const goodOcr: SlipOcrFields = {
  amount: 500,
  dateTimeText: bangkokNow,
  ref1: PROMPTPAY_DEFAULTS.ref1,
  receiverName: 'ร้านสงเคราะห์ผู้ต้องขัง',
  receiverAccountTail: null,
  senderName: 'สมชาย ใจดี',
};
const matchInput = (over: Partial<SlipMatchInput> = {}, ocr: Partial<SlipOcrFields> = {}): SlipMatchInput => ({
  authentic: true,
  notDuplicate: true,
  booking: paidBooking,
  ocr: { ...goodOcr, ...ocr },
  cfg: matchCfg,
  receiverNames: [],
  receiverAccountTail: '',
  maxAgeHours: 72,
  ...over,
});

check('slip auto-approves on full match', decideSlip(matchInput()).decision, 'auto_approved');
check('slip review on wrong amount', decideSlip(matchInput({}, { amount: 400 })).decision, 'review');
check('wrong amount blames amount', decideSlip(matchInput({}, { amount: 400 })).blockedBy.includes('amount'), true);
check('slip review when not authentic', decideSlip(matchInput({ authentic: false })).decision, 'review');
check('slip review when duplicate', decideSlip(matchInput({ notDuplicate: false })).decision, 'review');
check('slip review without OCR', decideSlip(matchInput({ ocr: null })).decision, 'review');
check(
  'slip review when nothing identifies the payee',
  decideSlip(matchInput({}, { ref1: null, receiverName: 'ใครก็ไม่รู้' })).blockedBy.includes('payeeIdentity'),
  true
);
check(
  'account tail alone identifies the payee',
  decideSlip(
    matchInput(
      { receiverAccountTail: 'xxx-x-x1234-x' },
      { ref1: null, receiverName: 'ใครก็ไม่รู้', receiverAccountTail: '1234' }
    )
  ).decision,
  'auto_approved'
);
check(
  'wrong account tail blocks the payee check',
  decideSlip(
    matchInput(
      { receiverAccountTail: 'xxx-x-x1234-x' },
      { ref1: null, receiverName: 'ใครก็ไม่รู้', receiverAccountTail: '9999' }
    )
  ).blockedBy.includes('payeeIdentity'),
  true
);
check(
  'slip older than the window is rejected',
  decideSlip(matchInput({ maxAgeHours: 1 }, { dateTimeText: '01/01/2568 09:00' })).blockedBy.includes('time'),
  true
);
check(
  'slip predating the booking is rejected',
  decideSlip(
    matchInput(
      { booking: { ...paidBooking, createdAt: new Date().toISOString() } as Reservation },
      {
        dateTimeText: '01/01/2568 09:00',
      }
    )
  ).blockedBy.includes('time'),
  true
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
