import { sanitizeInt, sanitizeStr } from '../config';
import { LINE_MESSAGE_CAP } from '../constants';
import { jsonResponse } from '../middleware/http';
import { hasPermission } from '../db/queries/roles';
import { addLineFriend, deletePushSubscription, upsertPushSubscription } from '../db/queries/notifications';
import { getLineMonthlyCap, setLineMonthlyCap } from '../db/queries/settings';
import { notify, getNotificationLogs, processPendingNotifications } from '../services/notifications';
import { replyLine, verifyLineSignature } from '../services/line';
import { logEvent } from '../services/logger';
import { Env } from '../types';
import { AuthenticatedUser } from '../auth/middleware';

const REF_PATTERN = /^VIS-\d{5}$/i;

// POST /api/notify (authed) — manual/override re-notification, or used by the
// frontend to fire events the server already hooks internally.
export async function handleNotify(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await notify(env, body);
  return result;
}

// POST /api/notify/subscribe (public) — saves a browser Push subscription for
// a booking ref. Called right after a successful booking so status changes
// can reach the visitor.
export async function handleSubscribe(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const endpoint = sanitizeStr(body.endpoint, 500);
  const p256dh = sanitizeStr(body.p256dh, 500);
  const auth = sanitizeStr(body.auth, 200);
  const ref = sanitizeStr(body.ref, 64);
  if (!endpoint || !p256dh || !auth || !ref) {
    return { status: 'error', message: 'Missing endpoint, p256dh, auth, or ref' };
  }
  if (!/^https?:\/\//.test(endpoint)) {
    return { status: 'error', message: 'Invalid endpoint' };
  }
  await upsertPushSubscription(env.DB, {
    endpoint,
    ref,
    p256dh,
    auth,
    now: new Date().toISOString(),
  });
  return { status: 'ok' };
}

// POST /api/notify/unsubscribe (public) — removes a Push subscription.
export async function handleUnsubscribe(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const endpoint = sanitizeStr(body.endpoint, 500);
  if (!endpoint) return { status: 'error', message: 'Missing endpoint' };
  await deletePushSubscription(env.DB, endpoint);
  return { status: 'ok' };
}

// POST /api/linkLine (public) — binds a LINE userId to a booking ref. Used by
// the visitor page when the user has already added the OA as a friend.
export async function handleLinkLine(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const userId = sanitizeStr(body.userId, 100);
  const ref = sanitizeStr(body.ref, 64);
  if (!userId) return { status: 'error', message: 'Missing userId' };
  if (!ref) return { status: 'error', message: 'Missing ref' };
  const displayName = sanitizeStr(body.displayName, 100);
  await addLineFriend(env.DB, { userId, ref, displayName, createdAt: new Date().toISOString() });
  return { status: 'ok' };
}

// POST /api/line/webhook — LINE OA events (friend add + message with a ref).
export async function handleLineWebhook(env: Env, request: Request): Promise<Response> {
  if (!env.LINE_CHANNEL_SECRET) {
    return jsonResponse({ status: 'error', message: 'LINE not configured' });
  }
  const raw = await request.arrayBuffer();
  const signature = request.headers.get('X-Line-Signature');
  const valid = await verifyLineSignature(env.LINE_CHANNEL_SECRET, raw, signature);
  if (!valid) return jsonResponse({ status: 'error', message: 'Invalid signature' }, 401);

  let payload: {
    events?: Array<{
      type?: string;
      replyToken?: string;
      source?: { userId?: string };
      message?: { text?: string };
    }>;
  };
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonResponse({ status: 'error', message: 'Bad payload' }, 400);
  }

  const now = new Date().toISOString();
  for (const ev of payload.events || []) {
    const userId = ev.source?.userId;
    if (!userId) continue;
    if (ev.type === 'follow') {
      await addLineFriend(env.DB, { userId, ref: '', displayName: '', createdAt: now });
      if (ev.replyToken) {
        await replyLine(
          env,
          ev.replyToken,
          'ยินดีต้อนรับ! พิมพ์รหัสการจองของคุณ (เช่น VIS-12345) เพื่อรับการแจ้งเตือนสถานะ'
        );
      }
    } else if (ev.type === 'message') {
      const text = sanitizeStr(ev.message?.text, 64);
      if (REF_PATTERN.test(text)) {
        await addLineFriend(env.DB, { userId, ref: text.toUpperCase(), displayName: '', createdAt: now });
        if (ev.replyToken) {
          await replyLine(env, ev.replyToken, 'ผูกการจอง ' + text.toUpperCase() + ' เรียบร้อยแล้ว ✓');
        }
      } else if (text && ev.replyToken) {
        await replyLine(env, ev.replyToken, 'กรุณาพิมพ์รหัสการจอง เช่น VIS-12345');
      }
    }
  }
  return jsonResponse({ status: 'ok' });
}

/**
 * The VAPID public key the browser needs for `pushManager.subscribe`. Public by
 * design (it is the key half of a keypair) — exposed so the separate frontend
 * does not have to hardcode a copy that can drift from the deployed secret.
 */
export function getPushPublicKeyHandler(env: Env): Record<string, unknown> {
  const key = String(env.VAPID_PUBLIC_KEY || '');
  return {
    status: 'ok',
    publicKey: key,
    pushEnabled: env.NOTIFY_PUSH_ENABLED === 'true' && key !== '',
  };
}

export async function getNotificationSettingsHandler(env: Env): Promise<Record<string, unknown>> {
  const cap = await getLineMonthlyCap(env.DB).catch(() => 0);
  return {
    status: 'ok',
    pushEnabled: env.NOTIFY_PUSH_ENABLED === 'true',
    lineEnabled: env.NOTIFY_LINE_ENABLED === 'true',
    lineMonthlyCap: cap,
    lineMonthlyCapDefault: LINE_MESSAGE_CAP,
  };
}

export async function setLineMonthlyCapHandler(
  env: Env,
  body: Record<string, unknown>,
  user: AuthenticatedUser
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_settings'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการนี้' };
  }
  const cap = sanitizeInt(body.cap, 0);
  if (cap <= 0) return { status: 'error', message: 'Cap must be a positive number' };
  await setLineMonthlyCap(env.DB, cap);
  await logEvent(env, user.username, 'set_line_monthly_cap', '', { cap }, 'success');
  return { status: 'ok', cap };
}

export async function getNotificationLogsHandler(
  env: Env,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(sanitizeInt(body.limit, 50), 1), 200);
  return getNotificationLogs(env, limit);
}

// POST /api/notify/processPending (authed) — manual cron trigger for testing.
export async function processPendingHandler(env: Env, user: AuthenticatedUser): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_settings'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการนี้' };
  }
  return processPendingNotifications(env);
}
