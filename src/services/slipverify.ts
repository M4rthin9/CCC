import jsQR, { QRCode } from 'jsqr';
import { decode as decodeJpeg } from 'jpeg-js';
import UPNG from 'upng-js';
import { parsePayload, parseSlipVerify, parseTrueMoneySlipVerify } from '@thai-qr-payment/payload';
import { formatBangkok } from '../config';
import { getReservationByRef, getStoredSlipByRef, updateReservationColumns } from '../db/queries/reservations';
import { invalidateLookupCache, invalidateReservationsCache } from '../cache/invalidation';
import { getPromptPayConfig, PromptPayConfig } from './promptpayConfig';
import { logEvent } from './logger';
import { Env, Reservation } from '../types';

export type SlipVerifyStatus = 'ok' | 'mismatch' | 'slip_verify' | 'unreadable';

export interface SlipVerifyResult {
  status: SlipVerifyStatus;
  kind: 'paymentQr' | 'slipVerify' | 'trueMoneySlipVerify' | 'none';
  qrCount: number;
  at: string;
  detail: Record<string, unknown> | null;
  match?: Record<string, unknown>;
  mismatch?: string[];
}

type EnvelopeKind = 'paymentQr' | 'slipVerify' | 'trueMoneySlipVerify';

interface ParsedEnvelope {
  kind: EnvelopeKind;
  payload: string;
  detail: Record<string, unknown>;
}

interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const MAX_MEGAPIXELS = 25;
const BANK_NAMES: Record<string, string> = {
  '002': 'Bangkok Bank (BBL)',
  '004': 'Kasikorn (KBank)',
  '006': 'Krung Thai (KTB)',
  '008': 'Krungsri (BAY)',
  '010': 'CIMB Thai',
  '011': 'TTB',
  '014': 'SCB',
  '022': 'CIMBT',
  '024': 'UOB',
  '025': 'Bank of China (BOC)',
  '030': 'GHB',
  '031': 'HSBC',
  '032': 'TISCO',
  '033': 'Government Savings Bank (GSB)',
  '039': 'Mizuho',
  '065': 'TBank (TMB)',
  '067': 'LH Bank',
  '098': 'Krungsri (KRUNGSRI)',
  '099': 'Krungsri (KRUNGSRI)',
  '224': 'KKP',
  '225': 'MBank',
};

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stripDataUri(uri: string): string {
  return String(uri).replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const width = ((bytes[16] ?? 0) << 24) | ((bytes[17] ?? 0) << 16) | ((bytes[18] ?? 0) << 8) | (bytes[19] ?? 0);
  const height = ((bytes[20] ?? 0) << 24) | ((bytes[21] ?? 0) << 16) | ((bytes[22] ?? 0) << 8) | (bytes[23] ?? 0);
  if (!width || !height) return null;
  return { width, height };
}

// jsQR's cost scales with pixel count, so phone-camera slip photos (often
// 8-12MP) are downscaled before scanning — otherwise verifySlipBytes can
// burn enough CPU time to hit the Worker's CPU limit (observed: a 503 with
// outcome "exceededCpu" on a single large-slip verify request).
const MAX_SCAN_DIM = 1600;

function downscaleImage(img: DecodedImage, maxDim: number): DecodedImage {
  const { width, height, data } = img;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) return img;
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(newWidth * newHeight * 4);
  for (let y = 0; y < newHeight; y += 1) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < newWidth; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const si = (sy * width + sx) * 4;
      const di = (y * newWidth + x) * 4;
      out[di] = data[si] ?? 0;
      out[di + 1] = data[si + 1] ?? 0;
      out[di + 2] = data[si + 2] ?? 0;
      out[di + 3] = data[si + 3] ?? 0;
    }
  }
  return { width: newWidth, height: newHeight, data: out };
}

function decodeSlipImage(bytes: Uint8Array): DecodedImage | null {
  try {
    const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpeg) return null;

    if (isPng) {
      const dims = pngDimensions(bytes);
      if (!dims || dims.width * dims.height > MAX_MEGAPIXELS * 1_000_000) return null;
      const png = UPNG.decode(bytes);
      const frame = UPNG.toRGBA8(png)[0];
      if (!frame) return null;
      return downscaleImage({ width: png.width, height: png.height, data: new Uint8ClampedArray(frame) }, MAX_SCAN_DIM);
    }

    const jpeg = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_MEGAPIXELS,
      maxMemoryUsageInMB: 512,
    });
    return downscaleImage(
      { width: jpeg.width, height: jpeg.height, data: new Uint8ClampedArray(jpeg.data) },
      MAX_SCAN_DIM
    );
  } catch {
    return null;
  }
}

function maskOut(src: Uint8ClampedArray, width: number, height: number, loc: QRCode['location']): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
  const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
  const minX = Math.max(0, Math.floor(Math.min(...xs)) - 8);
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)) + 8);
  const minY = Math.max(0, Math.floor(Math.min(...ys)) - 8);
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)) + 8);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const i = (y * width + x) * 4;
      out[i] = 255;
      out[i + 1] = 255;
      out[i + 2] = 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Two-pass scan: slips often carry both the Mini-QR and the payment QR. */
function scanQrs(img: DecodedImage): string[] {
  const first = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (!first) return [];
  const second = maskOut(img.data, img.width, img.height, first.location);
  const third = jsQR(second, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return third && third.data !== first.data ? [first.data, third.data] : [first.data];
}

function parseEnvelope(payload: string): ParsedEnvelope | null {
  const slip = parseSlipVerify(payload);
  if (slip) {
    return {
      kind: 'slipVerify',
      payload,
      detail: {
        sendingBank: slip.sendingBank,
        sendingBankName: BANK_NAMES[slip.sendingBank] || '',
        transRef: slip.transRef,
      },
    };
  }

  const trueMoney = parseTrueMoneySlipVerify(payload);
  if (trueMoney) {
    return {
      kind: 'trueMoneySlipVerify',
      payload,
      detail: {
        eventType: trueMoney.eventType,
        transactionId: trueMoney.transactionId,
        date: trueMoney.date,
        provider: 'TrueMoney Wallet',
      },
    };
  }

  try {
    const parsed = parsePayload(payload);
    if (!parsed.crc.valid) return null;
    const merchant = parsed.merchant;
    if (!merchant || merchant.kind !== 'billPayment') return null;
    return {
      kind: 'paymentQr',
      payload,
      detail: {
        billerId: merchant.billerId,
        reference1: merchant.reference1 ?? '',
        reference2: merchant.reference2 ?? '',
        reference3: parsed.getTagValue('62', '07') ?? '',
        amount: parsed.amount,
        currency: parsed.currency,
        pointOfInitiation: parsed.pointOfInitiation,
        crcValid: parsed.crc.valid,
        crcTruncated: parsed.crc.truncated,
      },
    };
  } catch {
    return null;
  }
}

function buildPaymentResult(
  payment: ParsedEnvelope,
  cfg: PromptPayConfig,
  booking: Reservation,
  qrCount: number
): SlipVerifyResult {
  const d = payment.detail;
  const expectedAmount = Number(booking.total);
  const expectedAmountKnown = Number.isFinite(expectedAmount) && booking.total !== undefined && booking.total !== null;
  const foundAmount = typeof d.amount === 'number' ? d.amount : null;

  const billerMatch = d.billerId === cfg.billerId;
  const refsMatch = d.reference1 === cfg.ref1 && d.reference2 === cfg.ref2 && (d.reference3 ?? '') === cfg.ref3;
  const amountMatch =
    expectedAmountKnown && foundAmount !== null ? Math.abs(foundAmount - expectedAmount) < 0.005 : null;

  const mismatch: string[] = [];
  if (!billerMatch) mismatch.push('biller');
  if (!refsMatch) mismatch.push('refs');
  if (amountMatch === false) mismatch.push('amount');

  return {
    status: mismatch.length === 0 ? 'ok' : 'mismatch',
    kind: 'paymentQr',
    qrCount,
    at: formatBangkok(new Date()),
    detail: {
      ...d,
      payload: payment.payload,
    },
    match: {
      biller: billerMatch,
      refs: refsMatch,
      amount: amountMatch,
      amountExpected: expectedAmountKnown ? expectedAmount : null,
      amountFound: foundAmount,
    },
    mismatch,
  };
}

function buildSlipVerifyOnlyResult(slip: ParsedEnvelope, qrCount: number): SlipVerifyResult {
  return {
    status: 'slip_verify',
    kind: slip.kind,
    qrCount,
    at: formatBangkok(new Date()),
    detail: {
      ...slip.detail,
      payload: slip.payload,
      // The Mini-QR has no amount or biller identity — manual review required.
      reviewRequired: true,
    },
  };
}

async function persistVerify(env: Env, ref: string, result: SlipVerifyResult): Promise<void> {
  const json = JSON.stringify(result);
  const cols: Array<[string, unknown]> = [
    ['slip_verify_status', result.status],
    ['slip_verify_json', json],
    ['slip_verify_at', result.at],
  ];
  await updateReservationColumns(env.DB, ref, cols);
  await logEvent(env, 'public', 'slip_verify', ref, { status: result.status, kind: result.kind }, 'success');
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
}

export async function verifySlipBytes(
  imageBytes: Uint8Array,
  cfg: PromptPayConfig,
  booking: Reservation
): Promise<SlipVerifyResult> {
  const img = decodeSlipImage(imageBytes);
  if (!img) {
    return {
      status: 'unreadable',
      kind: 'none',
      qrCount: 0,
      at: formatBangkok(new Date()),
      detail: { reason: 'unsupported_or_corrupt_image' },
    };
  }

  const payloads = scanQrs(img);
  const envelopes: ParsedEnvelope[] = [];
  for (const p of payloads) {
    const e = parseEnvelope(p);
    if (e) envelopes.push(e);
  }
  if (envelopes.length === 0) {
    return {
      status: 'unreadable',
      kind: 'none',
      qrCount: payloads.length,
      at: formatBangkok(new Date()),
      detail: { reason: payloads.length ? 'no_supported_qr' : 'no_qr_found' },
    };
  }

  const payment = envelopes.find((e) => e.kind === 'paymentQr') ?? null;
  const slip = envelopes.find((e) => e.kind === 'slipVerify' || e.kind === 'trueMoneySlipVerify') ?? null;

  return payment
    ? buildPaymentResult(payment, cfg, booking, payloads.length)
    : slip
      ? buildSlipVerifyOnlyResult(slip, payloads.length)
      : ({
          status: 'unreadable',
          kind: 'none',
          qrCount: payloads.length,
          at: formatBangkok(new Date()),
          detail: { reason: 'no_supported_qr' },
        } satisfies SlipVerifyResult);
}

export async function handleVerifySlip(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = String(body.ref || '').trim();
  if (!ref) return { status: 'error', message: 'Missing ref' };

  const booking = await getReservationByRef(env.DB, ref);
  if (!booking) return { status: 'error', message: 'Ref not found' };

  const inline = String(body.base64Data || '').trim();
  let imageBytes: Uint8Array | null = null;
  if (inline) {
    try {
      imageBytes = base64ToBytes(stripDataUri(inline));
    } catch {
      imageBytes = null;
    }
  }
  if (!imageBytes || imageBytes.length === 0) {
    const stored = await getStoredSlipByRef(env.DB, ref);
    const stripped = stored ? stripDataUri(stored) : '';
    if (!stripped) return { status: 'error', message: 'No slip image available' };
    try {
      imageBytes = base64ToBytes(stripped);
    } catch {
      imageBytes = null;
    }
  }
  if (!imageBytes || imageBytes.length === 0) {
    return { status: 'error', message: 'No slip image available' };
  }

  const cfg = await getPromptPayConfig(env);
  const result = await verifySlipBytes(imageBytes, cfg, booking);
  await persistVerify(env, ref, result);
  return { status: 'ok', result };
}
