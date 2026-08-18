export interface PushSubscriptionRow {
  endpoint: string;
  ref: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface LineFriendRow {
  userId: string;
  ref: string;
  displayName: string;
  createdAt: string;
}

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped_cap' | 'skipped_no_channel';

export interface NotificationRow {
  id?: number;
  ref: string;
  type: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  status: NotificationStatus;
  attempts: number;
  error: string;
  createdAt: string;
  sentAt: string;
}

export function upsertPushSubscription(
  db: D1Database,
  sub: { endpoint: string; ref: string; p256dh: string; auth: string; now: string }
): Promise<void> {
  return db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, ref, p256dh, auth, createdAt, lastActiveAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         ref = excluded.ref,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         lastActiveAt = excluded.lastActiveAt`
    )
    .bind(sub.endpoint, sub.ref, sub.p256dh, sub.auth, sub.now, sub.now)
    .run()
    .then(() => undefined);
}

export function deletePushSubscription(db: D1Database, endpoint: string): Promise<void> {
  return db
    .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`)
    .bind(endpoint)
    .run()
    .then(() => undefined);
}

export function pushSubscriptionsByRef(db: D1Database, ref: string): Promise<PushSubscriptionRow[]> {
  return db
    .prepare(`SELECT endpoint, ref, p256dh, auth, createdAt, lastActiveAt FROM push_subscriptions WHERE ref = ?`)
    .bind(ref)
    .all<PushSubscriptionRow>()
    .then((res) => res.results ?? []);
}

export function pushSubscriptionByEndpoint(db: D1Database, endpoint: string): Promise<PushSubscriptionRow | null> {
  return db
    .prepare(`SELECT endpoint, ref, p256dh, auth, createdAt, lastActiveAt FROM push_subscriptions WHERE endpoint = ?`)
    .bind(endpoint)
    .first<PushSubscriptionRow>();
}

// Upsert: a LINE friend can re-link to another booking by typing its ref.
export function addLineFriend(
  db: D1Database,
  f: { userId: string; ref: string; displayName: string; createdAt: string }
): Promise<void> {
  return db
    .prepare(
      `INSERT INTO line_friends (userId, ref, displayName, createdAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(userId) DO UPDATE SET ref = excluded.ref, displayName = excluded.displayName`
    )
    .bind(f.userId, f.ref, f.displayName, f.createdAt)
    .run()
    .then(() => undefined);
}

export function lineFriendsByRef(db: D1Database, ref: string): Promise<LineFriendRow[]> {
  return db
    .prepare(`SELECT userId, ref, displayName, createdAt FROM line_friends WHERE ref = ?`)
    .bind(ref)
    .all<LineFriendRow>()
    .then((res) => res.results ?? []);
}

// Returns the row id when the notification was newly inserted (dedupe hit → null).
export function insertNotificationGetId(db: D1Database, n: NotificationRow): Promise<number | null> {
  return db
    .prepare(
      `INSERT OR IGNORE INTO notifications (ref, type, channel, recipient, subject, body, status, attempts, error, createdAt, sentAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      n.ref,
      n.type,
      n.channel,
      n.recipient,
      n.subject,
      n.body,
      n.status,
      n.attempts,
      n.error,
      n.createdAt,
      n.sentAt
    )
    .run()
    .then(async (res) => {
      if ((res.meta?.changes ?? 0) === 0) return null;
      const row = await db
        .prepare(
          `SELECT id FROM notifications WHERE ref = ? AND type = ? AND channel = ? AND recipient = ? ORDER BY id DESC LIMIT 1`
        )
        .bind(n.ref, n.type, n.channel, n.recipient)
        .first<{ id: number }>();
      return row?.id ?? null;
    });
}

export function insertNotificationsBulk(db: D1Database, items: NotificationRow[]): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  const stmts = items.map((n) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO notifications (ref, type, channel, recipient, subject, body, status, attempts, error, createdAt, sentAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        n.ref,
        n.type,
        n.channel,
        n.recipient,
        n.subject,
        n.body,
        n.status,
        n.attempts,
        n.error,
        n.createdAt,
        n.sentAt
      )
  );
  return db.batch(stmts).then(() => undefined);
}

export function getPendingNotifications(db: D1Database, limit: number): Promise<NotificationRow[]> {
  return db
    .prepare(
      `SELECT id, ref, type, channel, recipient, subject, body, status, attempts, error, createdAt, sentAt
       FROM notifications
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<NotificationRow>()
    .then((res) => res.results ?? []);
}

export function getRecentNotifications(db: D1Database, limit: number): Promise<NotificationRow[]> {
  return db
    .prepare(
      `SELECT id, ref, type, channel, recipient, subject, body, status, attempts, error, createdAt, sentAt
       FROM notifications
       ORDER BY id DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<NotificationRow>()
    .then((res) => res.results ?? []);
}

export function markNotification(
  db: D1Database,
  id: number,
  status: NotificationStatus,
  error: string,
  sentAt: string
): Promise<void> {
  return db
    .prepare(`UPDATE notifications SET status = ?, error = ?, sentAt = ?, attempts = attempts + 1 WHERE id = ?`)
    .bind(status, error, sentAt, id)
    .run()
    .then(() => undefined);
}

// Keeps the row 'pending' (for cron retry) but records the error and bumps attempts.
export function markPendingRetry(db: D1Database, id: number, error: string): Promise<void> {
  return db
    .prepare(`UPDATE notifications SET error = ?, attempts = attempts + 1 WHERE id = ?`)
    .bind(error, id)
    .run()
    .then(() => undefined);
}

// Counts messages that were sent (or skipped for quota) for the LINE monthly cap.
// Month uses the notification createdAt so events are attributed to the month they happened.
export function countLineMessagesForMonth(db: D1Database, month: string): Promise<number> {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM notifications
       WHERE channel = 'line' AND status IN ('sent', 'skipped_cap') AND substr(createdAt, 1, 7) = ?`
    )
    .bind(month)
    .first<{ c: number }>()
    .then((r) => r?.c ?? 0);
}

/** Clear every notification-side row that points at a booking ref. Used when a
 *  reservation is hard-deleted — nothing in the schema cascades. */
export function deleteNotificationDataByRef(db: D1Database, ref: string): Promise<void> {
  return db
    .batch([
      db.prepare(`DELETE FROM notifications WHERE ref = ?`).bind(ref),
      db.prepare(`DELETE FROM push_subscriptions WHERE ref = ?`).bind(ref),
      db.prepare(`DELETE FROM line_friends WHERE ref = ?`).bind(ref),
    ])
    .then(() => undefined);
}
