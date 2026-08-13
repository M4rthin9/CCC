import { renderSlipVerifyMiniQr } from '../services/slipQr';
import { sanitizeStr } from '../config';

/**
 * Slip Verify Mini-QR generator (auth-required). Builds the Mini-QR a real
 * bank slip carries — the (bank code + transaction ref) pair that lets staff
 * cross-check an uploaded slip against the issuer instead of trusting a
 * screenshot. Admin/diagnostic use: mint a test Mini-QR, scan it with
 * `verifySlip`, and confirm the pipeline reads it back.
 *
 * Body:
 *  - provider: 'bank' (default) | 'truemoney'
 *  - bank:      sendingBank (3 digits) + transRef
 *  - truemoney: eventType + transactionId + date (DDMMYYYY)
 */
export async function handleGenerateSlipVerifyQr(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const provider = sanitizeStr(body.provider, 16).toLowerCase() === 'truemoney' ? 'truemoney' : 'bank';
  const sendingBank = sanitizeStr(body.sendingBank, 3);
  const transRef = sanitizeStr(body.transRef, 64);
  const eventType = sanitizeStr(body.eventType, 32);
  const transactionId = sanitizeStr(body.transactionId, 64);
  const date = sanitizeStr(body.date, 8);

  try {
    const qr = await renderSlipVerifyMiniQr({ provider, sendingBank, transRef, eventType, transactionId, date });
    return { status: 'ok', ...qr };
  } catch (e) {
    return { status: 'error', message: String(e instanceof Error ? e.message : e) };
  }
}
