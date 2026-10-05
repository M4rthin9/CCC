import {
  LINE_MESSAGE_CAP,
  NOTIFICATION_EVENTS,
  NOTIFY_MAX_BODY_BYTES,
  NOTIFY_TEMPLATES,
  NotificationEvent,
} from '../constants';
import { sanitizeStr } from '../config';
import {
  countLineMessagesForMonth,
  deletePushSubscription,
  getPendingNotifications,
  getRecentNotifications,
  insertNotificationGetId,
  lineFriendsByRef,
  markNotification,
  markPendingRetry,
  NotificationRow,
  getPendingPushNotifications,
  latestPushMessage,
  pushSubscriptionByEndpoint,
  pushSubscriptionsByRef,
  queueOpeningAlertRows,
} from '../db/queries/notifications';
import { bangkokTime, datesOpenedBetween, getBookingWindow } from './bookingWindow';
import { getLineMonthlyCap } from '../db/queries/settings';
import { Env } from '../types';
import { sendPush, PushResult } from './push';
import { pushLine, LinePushResult } from './line';
import { logEvent } from './logger';

function pushEnabled(env: Env): boolean {
  return env.NOTIFY_PUSH_ENABLED === 'true';
}

function lineEnabled(env: Env): boolean {
  return env.NOTIFY_LINE_ENABLED === 'true';
}

/**
 * Events allowed to spend delivery quota. Every call site stays in the code;
 * anything outside the list is dropped before a row is queued, so widening the
 * list is the single knob for sending more. Unset = no restriction.
 */
function eventAllowed(env: Env, type: string): boolean {
  const raw = String(env.NOTIFY_EVENT_ALLOWLIST || '').trim();
  if (!raw) return true;
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .includes(type);
}

function fillTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

type DeliveryOutcome = 'sent' | 'failed' | 'retry' | 'skipped_cap';

function isTransient(res: { ok: boolean; status?: number; error?: string }): boolean {
  if (res.status !== undefined) return res.status === 429 || res.status >= 500;
  return /network|timeout/i.test(res.error || '');
}

async function currentLineCap(env: Env): Promise<number> {
  const fromSettings = await getLineMonthlyCap(env.DB).catch(() => 0);
  const fromEnv = parseInt(env.LINE_MONTHLY_CAP || '', 10) || 0;
  return fromSettings || fromEnv || LINE_MESSAGE_CAP;
}

async function deliverPushRow(env: Env, row: NotificationRow): Promise<DeliveryOutcome> {
  const now = new Date().toISOString();
  if (row.id === undefined) return 'failed';
  const sub = await pushSubscriptionByEndpoint(env.DB, row.recipient);
  if (!sub) {
    await markNotification(env.DB, row.id, 'failed', 'subscription_gone', now);
    return 'failed';
  }
  if (row.attempts >= 5) {
    await markNotification(env.DB, row.id, 'failed', 'max_attempts', now);
    return 'failed';
  }
  // No payload: the service worker fetches this row's subject/body itself.
  const res: PushResult = await sendPush(env, sub);
  if (res.ok) {
    await markNotification(env.DB, row.id, 'sent', '', now);
    return 'sent';
  }
  if (res.remove) {
    await deletePushSubscription(env.DB, row.recipient);
    await markNotification(env.DB, row.id, 'failed', res.error || 'subscription_removed', now);
    return 'failed';
  }
  if (isTransient(res)) {
    await markPendingRetry(env.DB, row.id, res.error || 'transient');
    return 'retry';
  }
  await markNotification(env.DB, row.id, 'failed', res.error || 'failed', now);
  return 'failed';
}

async function deliverLineRow(env: Env, row: NotificationRow): Promise<DeliveryOutcome> {
  const now = new Date().toISOString();
  if (row.id === undefined) return 'failed';
  const cap = await currentLineCap(env);
  const used = await countLineMessagesForMonth(env.DB, now.slice(0, 7));
  if (used >= cap) {
    await markNotification(env.DB, row.id, 'skipped_cap', 'monthly_cap_reached', now);
    return 'skipped_cap';
  }
  if (row.attempts >= 5) {
    await markNotification(env.DB, row.id, 'failed', 'max_attempts', now);
    return 'failed';
  }
  const res: LinePushResult = await pushLine(env, row.recipient, row.body);
  if (res.ok) {
    await markNotification(env.DB, row.id, 'sent', '', now);
    return 'sent';
  }
  if (isTransient(res)) {
    await markPendingRetry(env.DB, row.id, res.error || 'transient');
    return 'retry';
  }
  await markNotification(env.DB, row.id, 'failed', res.error || 'failed', now);
  return 'failed';
}

export interface NotifyResult extends Record<string, unknown> {
  status: string;
  ref: string;
  type: string;
  queued: { push: number; line: number };
  sent: { push: number; line: number };
  failed: { push: number; line: number };
  skippedCap: { line: number };
  skipReason?: string;
}

// Core entry point. Fires status-change notifications to everyone linked to a
// booking (browser push subscriptions + LINE OA friends). Never throws.
export async function notify(env: Env, input: Record<string, unknown>): Promise<NotifyResult> {
  const base: NotifyResult = {
    status: 'ok',
    ref: '',
    type: '',
    queued: { push: 0, line: 0 },
    sent: { push: 0, line: 0 },
    failed: { push: 0, line: 0 },
    skippedCap: { line: 0 },
  };

  const ref = sanitizeStr(input.ref, 64);
  const type = sanitizeStr(input.type, 50);
  base.ref = ref;
  base.type = type;
  if (!ref) return { ...base, status: 'error', skipReason: 'missing_ref' };
  if (!NOTIFICATION_EVENTS.includes(type as never)) {
    return { ...base, status: 'error', skipReason: 'unknown_type' };
  }
  if (!eventAllowed(env, type)) return { ...base, skipReason: 'event_not_allowed' };

  const template = NOTIFY_TEMPLATES[type as NotificationEvent];
  const subject = sanitizeStr(input.subject, 200) || fillTemplate(template.subject, input);
  const body = (sanitizeStr(input.body, 2000) || fillTemplate(template.body, input)).slice(0, NOTIFY_MAX_BODY_BYTES);
  const now = new Date().toISOString();

  if (pushEnabled(env)) {
    try {
      const subs = await pushSubscriptionsByRef(env.DB, ref);
      for (const s of subs) {
        const row: NotificationRow = {
          ref,
          type,
          channel: 'push',
          recipient: s.endpoint,
          subject,
          body,
          status: 'pending',
          attempts: 0,
          error: '',
          createdAt: now,
          sentAt: '',
        };
        const id = await insertNotificationGetId(env.DB, row);
        if (id === null) continue;
        base.queued.push++;
        const outcome = await deliverPushRow(env, { ...row, id });
        if (outcome === 'sent') base.sent.push++;
        else if (outcome === 'failed') base.failed.push++;
      }
    } catch (e) {
      base.failed.push++;
      await logEvent(env, 'system', 'notify_push_error', ref, { error: String(e) }, 'error');
    }
  }

  // Web Push is free and unlimited; LINE's free tier is 200 messages a month.
  // Once the visitor has actually been reached by push, spending a LINE message
  // on the same event buys nothing. A push that failed still falls through.
  const lineFallbackOnly = String(env.NOTIFY_LINE_FALLBACK_ONLY || '') === 'true';
  if (lineEnabled(env) && !(lineFallbackOnly && base.sent.push > 0)) {
    try {
      const friends = await lineFriendsByRef(env.DB, ref);
      for (const f of friends) {
        const row: NotificationRow = {
          ref,
          type,
          channel: 'line',
          recipient: f.userId,
          subject,
          body,
          status: 'pending',
          attempts: 0,
          error: '',
          createdAt: now,
          sentAt: '',
        };
        const id = await insertNotificationGetId(env.DB, row);
        if (id === null) continue;
        base.queued.line++;
        const outcome = await deliverLineRow(env, { ...row, id });
        if (outcome === 'sent') base.sent.line++;
        else if (outcome === 'failed') base.failed.line++;
        else if (outcome === 'skipped_cap') base.skippedCap.line++;
      }
    } catch (e) {
      base.failed.line++;
      await logEvent(env, 'system', 'notify_line_error', ref, { error: String(e) }, 'error');
    }
  }

  return base;
}

/** Pushes per invocation: the Workers Free plan allows 50 external subrequests. */
const PUSH_BATCH = 40;

/**
 * Send up to PUSH_BATCH pending push rows. When a full batch went out there may
 * be more, so it queues another run — each queue invocation gets its own
 * subrequest budget, which is how a broadcast reaches every subscriber on the
 * free plan. Without the queue binding (dev) it stops after one batch.
 */
export async function drainPushes(env: Env): Promise<Record<string, unknown>> {
  const rows = await getPendingPushNotifications(env.DB, PUSH_BATCH);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const outcome = await deliverPushRow(env, row);
    if (outcome === 'sent') sent++;
    else if (outcome === 'failed') failed++;
  }
  const more = rows.length === PUSH_BATCH;
  if (more) await env.PUSH_QUEUE?.send({ drain: true });
  return { status: 'ok', sent, failed, more };
}

/** Kick delivery of queued push rows: through the queue when bound, else inline. */
async function startDrain(env: Env): Promise<void> {
  if (env.PUSH_QUEUE) await env.PUSH_QUEUE.send({ drain: true });
  else await drainPushes(env);
}

/** What a woken service worker shows: the newest message for its endpoint. */
export async function getPushMessage(env: Env, endpoint: string): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const row = endpoint ? await latestPushMessage(env.DB, endpoint, since) : null;
  if (!row) return { status: 'ok', title: 'CC Cafe', body: 'มีการแจ้งเตือนใหม่ แตะเพื่อดูรายละเอียด', url: '/' };
  const url = row.type.startsWith('booking_open') ? '/#/booking' : `/#/status?ref=${encodeURIComponent(row.ref)}`;
  return { status: 'ok', title: row.subject, body: row.body, url, tag: row.ref || row.type };
}

function thaiDate(iso: string): string {
  return new Intl.DateTimeFormat('th-TH', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(iso + 'T00:00:00Z')
  );
}

/**
 * Cron: tell opted-in browsers a bookable date is about to open ('soon', 06:50
 * Bangkok) or has just opened ('open', 07:00). Silent on mornings that open
 * nothing bookable (weekends, holidays, closed dates) or while booking is off.
 */
export async function broadcastOpening(
  env: Env,
  kind: 'soon' | 'open',
  scheduledTime: number
): Promise<Record<string, unknown>> {
  if (!pushEnabled(env)) return { status: 'ok', skipped: 'push_disabled' };
  const cfg = await getBookingWindow(env);
  if (!cfg.open) return { status: 'ok', skipped: 'booking_closed' };

  // The window rolls at 00:00 UTC: the 23:50 run looks 10 minutes ahead. Timed
  // from the schedule, so a late-running cron still names the right date.
  const roll = kind === 'soon' ? scheduledTime + 10 * 60_000 : scheduledTime;
  const dates = datesOpenedBetween(new Date(roll - 60 * 60_000), new Date(roll), cfg);
  if (dates.length === 0) return { status: 'ok', skipped: 'nothing_opens' };

  const when = dates.map(thaiDate).join(', ');
  const message =
    kind === 'soon'
      ? { title: 'อีก 10 นาทีเปิดจอง', body: `${when} จะเปิดให้จองเวลา ${bangkokTime(new Date(roll))} น.` }
      : { title: 'เปิดจองแล้ว', body: `${when} เปิดให้จองแล้ว จำนวนจำกัด จองได้เลย` };

  // One row per opted-in browser, written in a single statement; the queue
  // then delivers them PUSH_BATCH at a time.
  const queued = await queueOpeningAlertRows(env.DB, {
    ref: 'OPEN-' + dates[0],
    type: kind === 'soon' ? 'booking_open_soon' : 'booking_open',
    subject: message.title,
    body: message.body,
    now: new Date().toISOString(),
  });
  if (queued > 0) await startDrain(env);
  const summary = { status: 'ok', kind, dates, queued };
  await logEvent(env, 'system', 'opening_alert_broadcast', '', summary, 'success');
  return summary;
}

// Cron entry point: retries anything left 'pending' (network hiccups).
export async function processPendingNotifications(env: Env): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {
    status: 'ok',
    processed: 0,
    sent: { push: 0, line: 0 },
    failed: 0,
    retried: 0,
  };
  try {
    const pending = await getPendingNotifications(env.DB, 50);
    summary.processed = pending.length;
    for (const row of pending) {
      try {
        const outcome = row.channel === 'push' ? await deliverPushRow(env, row) : await deliverLineRow(env, row);
        if (outcome === 'sent') {
          const sent = summary.sent as Record<string, number>;
          sent[row.channel] = (sent[row.channel] ?? 0) + 1;
        } else if (outcome === 'failed') {
          summary.failed = Number(summary.failed) + 1;
        } else {
          summary.retried = Number(summary.retried) + 1;
        }
      } catch {
        summary.failed = Number(summary.failed) + 1;
      }
    }
  } catch (e) {
    summary.status = 'error';
    summary.error = String(e);
  }
  return summary;
}

export async function getNotificationLogs(env: Env, limit: number): Promise<Record<string, unknown>> {
  const rows = await getRecentNotifications(env.DB, limit);
  return { status: 'ok', rows };
}
