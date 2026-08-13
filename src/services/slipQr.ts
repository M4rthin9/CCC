import { buildSlipVerify, buildTrueMoneySlipVerify } from '@thai-qr-payment/payload';
import { renderQr } from './qrImage';

// Slip Verify Mini-QR — the small QR bank apps print on real transfer slips.
// It encodes the issuing bank code + transaction reference (or the TrueMoney
// wallet transaction id), so an uploaded slip can be cross-checked against a
// bank Open API instead of trusting a screenshot. A fabricated/edited slip
// either lacks the Mini-QR or carries a reference that fails the lookup —
// that is the scammer prevention this generator backs.

export type SlipVerifyProvider = 'bank' | 'truemoney';

export interface SlipVerifyMiniQrInput {
  provider: SlipVerifyProvider;
  /** Bank slip: 3-digit BoT bank code, e.g. '002' for Bangkok Bank. */
  sendingBank?: string;
  /** Bank slip: transaction reference printed on the slip. */
  transRef?: string;
  /** TrueMoney slip: event classification (e.g. 'P2P'). */
  eventType?: string;
  /** TrueMoney slip: wallet transaction identifier. */
  transactionId?: string;
  /** TrueMoney slip: transfer date as DDMMYYYY (8 chars). */
  date?: string;
}

export interface SlipVerifyMiniQrOutput {
  provider: SlipVerifyProvider;
  payload: string;
  svg: string;
  qrDataUrl: string;
  detail: Record<string, unknown>;
}

/** Build the wire payload for a Slip Verify Mini-QR (tag-91 CRC included). */
export function buildSlipVerifyPayload(input: SlipVerifyMiniQrInput): string {
  if (input.provider === 'truemoney') {
    const eventType = String(input.eventType || '').trim();
    const transactionId = String(input.transactionId || '').trim();
    const date = String(input.date || '').trim();
    if (!eventType) throw new Error('eventType is required for a TrueMoney Slip Verify Mini-QR.');
    if (!transactionId) throw new Error('transactionId is required for a TrueMoney Slip Verify Mini-QR.');
    if (!/^\d{8}$/.test(date)) {
      throw new Error(`date must be 8 digits (DDMMYYYY), got "${date}".`);
    }
    return buildTrueMoneySlipVerify({ eventType, transactionId, date });
  }

  const sendingBank = String(input.sendingBank || '').trim();
  const transRef = String(input.transRef || '').trim();
  if (!/^\d{3}$/.test(sendingBank)) {
    throw new Error(`sendingBank must be a 3-digit BoT bank code, got "${sendingBank}".`);
  }
  if (!transRef) throw new Error('transRef is required for a bank Slip Verify Mini-QR.');
  return buildSlipVerify({ sendingBank, transRef });
}

/** Build a Slip Verify Mini-QR payload and render it to SVG. */
export async function renderSlipVerifyMiniQr(input: SlipVerifyMiniQrInput): Promise<SlipVerifyMiniQrOutput> {
  const payload = buildSlipVerifyPayload(input);
  const { svg, qrDataUrl } = await renderQr(payload);
  const detail =
    input.provider === 'truemoney'
      ? {
          eventType: String(input.eventType || ''),
          transactionId: String(input.transactionId || ''),
          date: String(input.date || ''),
        }
      : { sendingBank: String(input.sendingBank || ''), transRef: String(input.transRef || '') };
  return { provider: input.provider, payload, svg, qrDataUrl, detail };
}
