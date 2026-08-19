import { sanitizeStr } from '../config';
import { getReservationsByRefs, getStoredSlipByRef, updateReservationColumns } from '../db/queries/reservations';
import { invalidateLookupCache, invalidateReservationsCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import { notify } from '../services/notifications';
import { readPaymentSwitch } from './settings';
import { Env } from '../types';

export { handleVerifySlip } from '../services/slipverify';

// D1 cells cap at ~2MB per value, so the legacy 20MB limit is reduced here.
const D1_SLIP_MAX_BYTES = 2 * 1024 * 1024;

export async function handleUploadSlip(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  if (!body.base64Data) return { status: 'error', message: 'Missing base64Data' };
  if (!ref) return { status: 'error', message: 'Missing ref' };
  if (String(body.base64Data).length > D1_SLIP_MAX_BYTES) return { status: 'error', message: 'ไฟล์มีขนาดใหญ่เกินไป' };

  const dataUri = String(body.base64Data);
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  try {
    await updateReservationColumns(env.DB, ref, [['slip_base64', dataUri]]);
    await logEvent(env, String(body.username || 'public'), 'slip_uploaded', ref, {}, 'success');
    await invalidateReservationsCache(env);
    await invalidateLookupCache(env, ref);
    return { status: 'ok', url: dataUri };
  } catch (e) {
    await logEvent(env, String(body.username || 'public'), 'slip_upload_failed', ref, { error: String(e) }, 'error');
    return { status: 'error', message: String(e) };
  }
}

export async function handleUpdateSlipAndStatus(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string },
  isPublic = false
): Promise<Record<string, unknown>> {
  // The payment window only applies to visitors paying themselves. Staff acting
  // from the dashboard are authenticated and can always settle a booking.
  if (isPublic) {
    const payment = await readPaymentSwitch(env);
    if (!payment.enabled) {
      return {
        status: 'error',
        message: payment.closedMessage || 'ขณะนี้ปิดรับชำระเงินชั่วคราว กรุณากลับมาชำระเงินอีกครั้งภายหลัง',
      };
    }
  }

  const ref = sanitizeStr(body.ref, 64);
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  const currentStatus = String(rows[0]?.status || '').trim();
  let status = sanitizeStr(body.status, 50) || 'ชำระแล้ว';

  if (isPublic) {
    // A visitor may only settle a booking that is actually awaiting payment.
    // Without this, a re-upload (or a retried request) writes 'ชำระแล้ว' over a
    // status staff had already advanced to 'เสร็จสิ้น', so an approved booking
    // silently walks backwards and has to be approved again.
    status = 'ชำระแล้ว';
    if (currentStatus !== 'รอชำระเงิน') {
      if (currentStatus === 'ชำระแล้ว') return { status: 'ok', noop: true };
      return { status: 'error', message: 'ไม่สามารถชำระเงินได้ในสถานะปัจจุบัน: ' + currentStatus };
    }
  }

  const cols: Array<[string, unknown]> = [['status', status]];
  if (body.slipImage) {
    const slipVal = String(body.slipImage);
    if (slipVal.indexOf('data:image') === 0) {
      if (slipVal.length > D1_SLIP_MAX_BYTES) return { status: 'error', message: 'ไฟล์มีขนาดใหญ่เกินไป' };
      cols.push(['slip_base64', slipVal]);
    } else {
      cols.push(['slipImage', slipVal]);
    }
  }
  await updateReservationColumns(env.DB, ref, cols);

  await logEvent(env, user.username, 'slip_and_status_updated', ref, { status }, 'success');
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  if (status === 'ชำระแล้ว') {
    await notify(env, {
      ref,
      type: 'payment_confirmed',
      total: rows[0]?.total,
      visitDate: rows[0]?.visitDate,
    }).catch(() => undefined);
  }
  return { status: 'ok' };
}

export async function handleGetSlipByRef(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'Missing ref' };

  const slipImage = await getStoredSlipByRef(env.DB, ref);
  return { status: 'ok', ref, slipImage };
}
