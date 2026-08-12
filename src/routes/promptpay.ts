import { buildPromptPayBillPayment } from '../services/promptpay';
import { sanitizeStr } from '../config';

export function handleGeneratePromptPayQr(body: Record<string, unknown>): Record<string, unknown> {
  const billerId = sanitizeStr(body.billerId, 15);
  const ref1 = sanitizeStr(body.ref1, 64);
  const ref2 = sanitizeStr(body.ref2, 64);
  const ref3 = sanitizeStr(body.ref3, 64) || undefined;
  const amount = sanitizeStr(body.amount, 16);
  const pointOfInitiation = sanitizeStr(body.pointOfInitiation, 2) || undefined;

  if (!billerId) return { status: 'error', message: 'Missing billerId (15-digit Biller ID: Tax ID + suffix)' };
  if (!ref1) return { status: 'error', message: 'Missing ref1 (Reference 1)' };

  try {
    const payload = buildPromptPayBillPayment({
      billerId,
      ref1,
      ref2: ref2 || undefined,
      ref3,
      amount: amount || undefined,
      pointOfInitiation: pointOfInitiation === '12' ? '12' : '11',
    });
    return { status: 'ok', payload };
  } catch (e) {
    return { status: 'error', message: String(e instanceof Error ? e.message : e) };
  }
}
