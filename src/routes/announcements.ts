import { AuthenticatedUser } from '../auth/middleware';
import { announcementById, listAnnouncements, queueAnnouncement } from '../db/queries/announcements';
import { countPushSubscribers } from '../db/queries/notifications';
import { hasPermission } from '../db/queries/roles';
import { logEvent } from '../services/logger';
import { startDrain } from '../services/notifications';
import { Env } from '../types';

export async function getAnnouncementsHandler(env: Env, user: AuthenticatedUser): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดูการแจ้งเตือน' };
  }
  const [summary, rows] = await Promise.all([countPushSubscribers(env.DB), listAnnouncements(env.DB)]);
  return { status: 'ok', recipients: summary.openingAlerts, pushEnabled: env.NOTIFY_PUSH_ENABLED === 'true', rows };
}

export async function sendAnnouncementHandler(
  env: Env,
  body: Record<string, unknown>,
  user: AuthenticatedUser
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ส่งการแจ้งเตือน' };
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.body === 'string' ? body.body.trim() : '';
  const url = typeof body.url === 'string' ? body.url : '';
  if (
    !/^ANN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    !subject ||
    subject.length > 100 ||
    !message ||
    message.length > 500 ||
    !['/', '/#/booking', '/#/table-booking'].includes(url)
  ) {
    return {
      status: 'error',
      message: 'กรุณาระบุหัวข้อไม่เกิน 100 ตัวอักษร ข้อความไม่เกิน 500 ตัวอักษร และหน้าปลายทางให้ถูกต้อง',
    };
  }
  let existing = await announcementById(env.DB, id);
  if (!existing) {
    if (env.NOTIFY_PUSH_ENABLED !== 'true') return { status: 'error', message: 'ระบบส่งการแจ้งเตือนยังไม่เปิดใช้งาน' };
    if ((await countPushSubscribers(env.DB)).openingAlerts === 0)
      return { status: 'error', message: 'ยังไม่มีผู้สมัครรับการแจ้งเตือน' };
    const created = await queueAnnouncement(env.DB, {
      id,
      subject,
      body: message,
      url,
      createdBy: user.username,
      createdAt: new Date().toISOString(),
    });
    existing = await announcementById(env.DB, id);
    if (created) await logEvent(env, user.username, 'send_push_announcement', id, { subject, url }, 'success');
  }
  if (!existing || existing.subject !== subject || existing.body !== message || existing.url !== url) {
    return { status: 'error', message: 'รหัสการส่งนี้ถูกใช้แล้ว กรุณาสร้างข้อความใหม่' };
  }
  // The durable outbox is accepted even if the queue kick fails. Retrying this
  // same ID safely restarts delivery; daily notification processing also retries.
  let deliveryStarted = false;
  if (env.NOTIFY_PUSH_ENABLED === 'true') {
    try {
      await startDrain(env);
      deliveryStarted = true;
    } catch {
      await logEvent(env, user.username, 'announcement_drain_pending', id, {}, 'error');
    }
  }
  return { status: 'ok', id, deliveryStarted };
}
