import { sanitizeStr } from '../config';
import { TABLES } from '../constants';
import {
  countBase64Slips,
  getReservationByRef,
  getReservationsByRefs,
  getSlipRecordByRef,
  listBase64Slips,
  updateArchivedReservationColumns,
  updateReservationColumns,
} from '../db/queries/reservations';
import { invalidateLookupCache, invalidateReservationsCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import { notify } from '../services/notifications';
import { persistVerify, verifyAndDecideSlip } from '../services/slipverify';
import type { SlipVerifyResult } from '../services/slipverify';
import { readPaymentSwitch } from './settings';
import {
  base64ToBytes,
  getSlip,
  parseDataUri,
  putSlip,
  signSlipToken,
  slipImageUrl,
  slipsBucket,
  toDataUri,
  verifySlipToken,
  type DecodedSlip,
} from '../services/slipStorage';
import { Env, Reservation } from '../types';

export { handleVerifySlip } from '../services/slipverify';

// D1 cells cap at ~2MB per value. That ceiling only binds on the fallback path
// now that slips go to R2, where a full-resolution phone photo fits.
const D1_SLIP_MAX_BYTES = 2 * 1024 * 1024;
const R2_SLIP_MAX_BYTES = 10 * 1024 * 1024;
const AWAITING_PAYMENT = 'รอชำระเงิน';
const PAID = 'ชำระแล้ว';

function slipMaxBytes(env: Env): number {
  return slipsBucket(env) ? R2_SLIP_MAX_BYTES : D1_SLIP_MAX_BYTES;
}

/**
 * Persist an uploaded slip: R2 when the binding exists, base64-in-D1 otherwise.
 * Returns the columns to write so the caller can batch them with whatever else
 * the request changes (a status, usually) in a single D1 write.
 */
async function slipColumns(env: Env, ref: string, dataUri: string): Promise<Array<[string, unknown]>> {
  const decoded = parseDataUri(dataUri);
  if (!decoded) return [['slip_base64', dataUri]];
  const key = await putSlip(env, ref, decoded);
  // slip_base64 is blanked on the R2 path so a stale legacy image can never be
  // served in place of the new upload.
  return key
    ? [
        ['slip_key', key],
        ['slip_base64', ''],
      ]
    : [
        ['slip_base64', dataUri],
        ['slip_key', ''],
      ];
}

/** The stored slip as a data URI — what OCR and the legacy clients want. */
async function loadSlipDataUri(env: Env, ref: string): Promise<string> {
  const rec = await getSlipRecordByRef(env.DB, ref);
  if (!rec) return '';
  if (rec.dataUri) return rec.dataUri;
  if (!rec.key) return '';
  const obj = await getSlip(env, rec.key);
  return obj ? toDataUri(obj.bytes, obj.contentType) : '';
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
    const decoded: DecodedSlip | null = parseDataUri(dataUri);
    const bytes = decoded ? decoded.bytes : base64ToBytes(dataUri);
    if (bytes.length === 0) return null;

    const { result, fingerprint, imageHash } = await verifyAndDecideSlip(env, booking, bytes, dataUri);
    await persistVerify(env, ref, result, fingerprint, imageHash);

    const approve =
      result.decision?.decision === 'auto_approved' &&
      autoApproveEnabled(env) &&
      String(booking.status || '').trim() === AWAITING_PAYMENT;
    if (!approve) return { result, autoApproved: false };

    // Clearing the hold matters for table bookings: a paid row must never be
    // caught by releaseExpiredTableHolds. It is already '' on visit bookings.
    await updateReservationColumns(env.DB, ref, [
      ['status', PAID],
      ['holdExpiresAt', ''],
    ]);
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
  waitUntil?: WaitUntil,
  origin = ''
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  if (!body.base64Data) return { status: 'error', message: 'Missing base64Data' };
  if (!ref) return { status: 'error', message: 'Missing ref' };
  if (String(body.base64Data).length > slipMaxBytes(env)) return { status: 'error', message: 'ไฟล์มีขนาดใหญ่เกินไป' };

  const dataUri = String(body.base64Data);
  const rows = await getReservationsByRefs(env.DB, ref);
  if (rows.length === 0) return { status: 'error', message: 'Ref not found' };

  const actor = String(body.username || 'public');
  try {
    await updateReservationColumns(env.DB, ref, await slipColumns(env, ref, dataUri));
    await logEvent(env, actor, 'slip_uploaded', ref, {}, 'success');
    await invalidateReservationsCache(env);
    await invalidateLookupCache(env, ref);
    // Verification used to wait for a separate verifySlip call, which meant a
    // slip sat unchecked until someone asked. Run it here instead.
    const verified = await runVerify(env, rows[0] as Reservation, dataUri, actor, waitUntil);
    return {
      status: 'ok',
      // The visitor's page shows the slip it just uploaded; hand back a signed
      // URL instead of echoing megabytes of base64 back through the response.
      url: slipsBucket(env) ? slipImageUrl(origin, ref, await signSlipToken(env, ref)) : dataUri,
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
  // Once paid, the table booking owns its slot outright — drop the payment hold
  // so the expiry sweep can never cancel it out from under the visitor.
  if (status === PAID) cols.push(['holdExpiresAt', '']);
  let uploadedDataUri = '';
  if (body.slipImage) {
    const slipVal = String(body.slipImage);
    if (slipVal.indexOf('data:image') === 0) {
      if (slipVal.length > slipMaxBytes(env)) return { status: 'error', message: 'ไฟล์มีขนาดใหญ่เกินไป' };
      cols.push(...(await slipColumns(env, ref, slipVal)));
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

/**
 * `slipImage` stays the field the clients read, but for an R2-backed booking it
 * now carries a signed URL rather than a data URI. Both render in an <img>, so
 * a client that has not been updated keeps working.
 */
export async function handleGetSlipByRef(
  env: Env,
  body: Record<string, unknown>,
  origin = ''
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'Missing ref' };

  const rec = await getSlipRecordByRef(env.DB, ref);
  if (!rec) return { status: 'ok', ref, slipImage: '' };
  if (rec.key) {
    const url = slipImageUrl(origin, ref, await signSlipToken(env, ref));
    return { status: 'ok', ref, slipImage: url, slipUrl: url, storage: 'r2' };
  }
  return { status: 'ok', ref, slipImage: rec.dataUri || rec.url, storage: rec.dataUri ? 'd1' : 'legacy' };
}

/**
 * Raw image bytes for `<img src>`. It returns binary rather than JSON, so it
 * sits outside the dispatcher and `index.ts` routes it directly. Access is
 * either normal staff auth (resolved by the caller) or the short-lived signed
 * token handed to the visitor who uploaded the slip.
 */
export async function handleGetSlipImage(env: Env, url: URL, authorized: boolean): Promise<Response> {
  const ref = sanitizeStr(url.searchParams.get('ref'), 64);
  if (!ref) return new Response('Missing ref', { status: 400 });

  const token = url.searchParams.get('token') || '';
  if (!authorized && !(await verifySlipToken(env, ref, token))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rec = await getSlipRecordByRef(env.DB, ref);
  if (!rec) return new Response('Not found', { status: 404 });

  if (rec.key) {
    const obj = await getSlip(env, rec.key);
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.bytes as unknown as ArrayBuffer, {
      // Private + short: the URL expires and the response is per-viewer.
      headers: { 'Content-Type': obj.contentType, 'Cache-Control': 'private, max-age=300' },
    });
  }

  // Pre-migration booking: rebuild the image from the base64 still in D1.
  const decoded = rec.dataUri ? parseDataUri(rec.dataUri) : null;
  if (!decoded) return new Response('Not found', { status: 404 });
  return new Response(decoded.bytes as unknown as ArrayBuffer, {
    headers: { 'Content-Type': decoded.contentType, 'Cache-Control': 'private, max-age=300' },
  });
}

/** Admin/manual re-run against the slip already stored for a booking. */
export async function handleReverifySlip(env: Env, body: Record<string, unknown>, actor: string) {
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'Missing ref' };
  const booking = await getReservationByRef(env.DB, ref);
  if (!booking) return { status: 'error', message: 'Ref not found' };
  const dataUri = await loadSlipDataUri(env, ref);
  if (!dataUri || dataUri.indexOf('data:image') !== 0) {
    return { status: 'error', message: 'No slip image available' };
  }
  const outcome = await verifyAndMaybeApprove(env, booking, dataUri, actor);
  if (!outcome) return { status: 'error', message: 'Verification failed' };
  return { status: 'ok', result: outcome.result, autoApproved: outcome.autoApproved };
}

/**
 * One-shot backfill: move slips that predate the R2 switch out of `slip_base64`
 * and into the bucket. Superadmin only, and deliberately batched — each row is
 * a multi-MB string, so a whole-table pass would blow the isolate's memory.
 *
 * Call it repeatedly until `remaining` is 0. Reads keep working throughout:
 * a row is only cleared once its object is in R2, and anything not yet moved
 * still resolves through the base64 fallback.
 */
export async function handleMigrateSlipsToR2(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string; role: string }
): Promise<Record<string, unknown>> {
  if (user.role !== 'Superadmin') {
    return { status: 'error', message: 'เฉพาะ Superadmin เท่านั้น' };
  }
  if (!slipsBucket(env)) return { status: 'error', message: 'R2 binding (SLIPS) is not configured' };

  const archived = body.archived === true || body.archived === 'true';
  const table = archived ? TABLES.archive : TABLES.reservations;
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 25);

  const rows = await listBase64Slips(env.DB, limit, table);
  let moved = 0;
  const failed: string[] = [];

  for (const row of rows) {
    const ref = String(row.ref || '');
    const decoded = parseDataUri(String(row.slip_base64 || ''));
    if (!ref || !decoded) {
      failed.push(ref || '(no ref)');
      continue;
    }
    try {
      const key = await putSlip(env, ref, decoded);
      if (!key) {
        failed.push(ref);
        continue;
      }
      const cols: Array<[string, unknown]> = [
        ['slip_key', key],
        ['slip_base64', ''],
      ];
      if (archived) await updateArchivedReservationColumns(env.DB, ref, cols);
      else await updateReservationColumns(env.DB, ref, cols);
      moved += 1;
    } catch {
      failed.push(ref);
    }
  }

  const remaining = await countBase64Slips(env.DB, table);
  await logEvent(env, user.username, 'slips_migrated_to_r2', '', { moved, failed, remaining, table }, 'success');
  if (moved > 0) await invalidateReservationsCache(env);
  return { status: 'ok', table, moved, failed, remaining };
}
