import { sanitizeStr } from '../config';
import {
  getReservationByRef,
  getReservationsByRefs,
  getStoredSlipByRef,
  updateReservationColumns,
} from '../db/queries/reservations';
import { invalidateLookupCache, invalidateReservationsCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import { notify } from '../services/notifications';
import { persistVerify, verifyAndDecideSlip } from '../services/slipverify';
import type { SlipVerifyResult } from '../services/slipverify';
import { readPaymentSwitch } from './settings';
import { Env, Reservation } from '../types';

export { handleVerifySlip } from '../services/slipverify';

// D1 cells cap at ~2MB per value, so the legacy 20MB limit is reduced here.
const D1_SLIP_MAX_BYTES = 2 * 1024 * 1024;
const AWAITING_PAYMENT = 'รอชำระเงิน';
const PAID = 'ชำระแล้ว';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function autoApproveEnabled(env: Env): boolean {
  return String(env.SLIP_AUTO_APPROVE_ENABLED || '') === 'true';
}

/**
 * Verify a freshly uploaded slip and, when it clears every check, settle the
 * booking without a human. Verification always runs and is always persisted —
 * `SLIP_AUTO_APPROVE_ENABLED` gates only the status write, so the decisions can
 * be watched for a while before they are allowed to move money.
 *
 * Never throws: a booking must not fail to record its slip because the
 * verifier (or Workers AI) had a bad day.
 */
async function verifyAndMaybeApprove(
  env: Env,
  booking: Reservation,
  dataUri: string,
  actor: string
): Promise<{ result: SlipVerifyResult; autoApproved: boolean } | null> {
  try {
    const ref = String(booking.ref || '');
    const bytes = base64ToBytes(dataUri.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, ''));
    if (bytes.length === 0) return null;

    const { result, fingerprint, imageHash } = await verifyAndDecideSlip(env, booking, bytes, dataUri);
    await persistVerify(env, ref, result, fingerprint, imageHash);

    const approve =
      result.decision?.decision === 'auto_approved' &&
      autoApproveEnabled(env) &&
      String(booking.status || '').trim() === AWAITING_PAYMENT;
    if (!approve) return { result, autoApproved: false };

    await updateReservationColumns(env.DB, ref, [['status', PAID]]);
    await logEvent(
      env,
      actor,
      'slip_auto_approved',
      ref,
      { score: result.decision?.score, kind: result.kind, total: booking.total },
      'success'
    );
    await invalidateReservationsCache(env);
    await invalidateLookupCache(env, ref);
    await notify(env, {
      ref,
      type: 'payment_confirmed',
      total: booking.total,
      visitDate: booking.visitDate,
    }).catch(() => undefined);
    return { result, autoApproved: true };
  } catch (e) {
    await logEvent(env, actor, 'slip_verify_failed', String(booking.ref || ''), { error: String(e) }, 'error');
    return null;
  }
}

/**
 * Run verification *after* the response is sent when the runtime gives us a
 * `waitUntil`. Decoding a slip is the only heavy thing in this request, and
 * when it dies hard (a large photo exhausting the isolate's memory) it takes
 * the whole request down with it — no response, no log, and the visitor's page
 * resets as if it reloaded. Backgrounding it means the upload is already
 * acknowledged and stored by the time verification runs, so the worst case is
 * a slip that lands in manual review instead of a visitor stuck re-uploading.
 */
function runVerify(
  env: Env,
  booking: Reservation,
  dataUri: string,
  actor: string,
  waitUntil?: WaitUntil
): Promise<{ result: SlipVerifyResult; autoApproved: boolean } | null> {
  const task = verifyAndMaybeApprove(env, booking, dataUri, actor);
  if (!waitUntil) return task;
  waitUntil(task.catch(() => undefined));
  return Promise.resolve(null);
}

export type WaitUntil = (promise: Promise<unknown>) => void;

export async function handleUploadSlip(
  env: Env,
  body: Record<string, unknown>,
  waitUntil?: WaitUntil
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  if (!body.base64Data) return { status: 'error', message: 'Missing base64Data' };
  if (!ref) return { status: 'error', message: 'Missing ref' };
  if (String(body.base64Data).length > D1_SLIP_MAX_BYTES) return { status: 'error', message: 'ไฟล์มีขนาดใหญ่เกินไป' };

  const dataUri = String(body.base64Data);
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  const actor = String(body.username || 'public');
  try {
    await updateReservationColumns(env.DB, ref, [['slip_base64', dataUri]]);
    await logEvent(env, actor, 'slip_uploaded', ref, {}, 'success');
    await invalidateReservationsCache(env);
    await invalidateLookupCache(env, ref);
    // Verification used to wait for a separate verifySlip call, which meant a
    // slip sat unchecked until someone asked. Run it here instead.
    const verified = await runVerify(env, rows[0] as Reservation, dataUri, actor, waitUntil);
    return {
      status: 'ok',
      url: dataUri,
      ...(verified ? { verify: verified.result, autoApproved: verified.autoApproved } : {}),
    };
  } catch (e) {
    await logEvent(env, actor, 'slip_upload_failed', ref, { error: String(e) }, 'error');
    return { status: 'error', message: String(e) };
  }
}

export async function handleUpdateSlipAndStatus(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string },
  isPublic = false,
  waitUntil?: WaitUntil
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
  let status = sanitizeStr(body.status, 50) || PAID;

  if (isPublic) {
    // A visitor may only settle a booking that is actually awaiting payment.
    // Without this, a re-upload (or a retried request) writes 'ชำระแล้ว' over a
    // status staff had already advanced to 'เสร็จสิ้น', so an approved booking
    // silently walks backwards and has to be approved again.
    status = PAID;
    if (currentStatus !== AWAITING_PAYMENT) {
      if (currentStatus === PAID) return { status: 'ok', noop: true };
      return { status: 'error', message: 'ไม่สามารถชำระเงินได้ในสถานะปัจจุบัน: ' + currentStatus };
    }
  }

  const cols: Array<[string, unknown]> = [['status', status]];
  let uploadedDataUri = '';
  if (body.slipImage) {
    const slipVal = String(body.slipImage);
    if (slipVal.indexOf('data:image') === 0) {
      if (slipVal.length > D1_SLIP_MAX_BYTES) return { status: 'error', message: 'ไฟล์มีขนาดใหญ่เกินไป' };
      cols.push(['slip_base64', slipVal]);
      uploadedDataUri = slipVal;
    } else {
      cols.push(['slipImage', slipVal]);
    }
  }
  await updateReservationColumns(env.DB, ref, cols);

  await logEvent(env, user.username, 'slip_and_status_updated', ref, { status }, 'success');
  await invalidateReservationsCache(env);
  await invalidateLookupCache(env, ref);
  if (status === PAID) {
    await notify(env, {
      ref,
      type: 'payment_confirmed',
      total: rows[0]?.total,
      visitDate: rows[0]?.visitDate,
    }).catch(() => undefined);
  }

  // The status is already PAID on this path, so there is nothing left to
  // auto-approve — verification still runs so the slip is on record as genuine
  // (or flagged as reused) for whoever reviews it afterwards.
  let verify: SlipVerifyResult | null = null;
  if (isPublic && uploadedDataUri) {
    const outcome = await runVerify(
      env,
      { ...rows[0], status } as Reservation,
      uploadedDataUri,
      user.username,
      waitUntil
    );
    verify = outcome ? outcome.result : null;
  }
  return { status: 'ok', ...(verify ? { verify } : {}) };
}

export async function handleGetSlipByRef(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'Missing ref' };

  const slipImage = await getStoredSlipByRef(env.DB, ref);
  return { status: 'ok', ref, slipImage };
}

/** Admin/manual re-run against the slip already stored for a booking. */
export async function handleReverifySlip(env: Env, body: Record<string, unknown>, actor: string) {
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'Missing ref' };
  const booking = await getReservationByRef(env.DB, ref);
  if (!booking) return { status: 'error', message: 'Ref not found' };
  const dataUri = await getStoredSlipByRef(env.DB, ref);
  if (!dataUri || dataUri.indexOf('data:image') !== 0) {
    return { status: 'error', message: 'No slip image available' };
  }
  const outcome = await verifyAndMaybeApprove(env, booking, dataUri, actor);
  if (!outcome) return { status: 'error', message: 'Verification failed' };
  return { status: 'ok', result: outcome.result, autoApproved: outcome.autoApproved };
}
