export interface Announcement {
  id: string;
  subject: string;
  body: string;
  url: string;
  createdBy: string;
  createdAt: string;
}

export interface AnnouncementSummary extends Announcement {
  total: number;
  pending: number;
  sent: number;
  failed: number;
}

export function announcementById(db: D1Database, id: string): Promise<Announcement | null> {
  return db.prepare('SELECT * FROM push_announcements WHERE id = ?').bind(id).first<Announcement>();
}

/** The header and recipient snapshot commit atomically. Retries never add new recipients. */
export async function queueAnnouncement(db: D1Database, a: Announcement): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO push_announcements (id, subject, body, url, createdBy, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(a.id, a.subject, a.body, a.url, a.createdBy, a.createdAt),
    db
      .prepare(
        `INSERT OR IGNORE INTO notifications
      (ref, type, channel, recipient, subject, body, status, attempts, error, createdAt, sentAt)
      SELECT a.id, 'announcement', 'push', p.endpoint, a.subject, a.body, 'pending', 0, '', a.createdAt, ''
      FROM push_announcements a CROSS JOIN push_subscriptions p
      WHERE a.id = ? AND a.state = 'queueing' AND p.openingAlerts = 1`
      )
      .bind(a.id),
    db.prepare("UPDATE push_announcements SET state = 'queued' WHERE id = ?").bind(a.id),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

export function listAnnouncements(db: D1Database): Promise<AnnouncementSummary[]> {
  return db
    .prepare(
      `SELECT a.id, a.subject, a.body, a.url, a.createdBy, a.createdAt,
    COUNT(n.id) AS total,
    COALESCE(SUM(n.status = 'pending'), 0) AS pending,
    COALESCE(SUM(n.status = 'sent'), 0) AS sent,
    COALESCE(SUM(n.status = 'failed'), 0) AS failed
    FROM push_announcements a LEFT JOIN notifications n ON n.ref = a.id AND n.type = 'announcement'
    GROUP BY a.id ORDER BY a.createdAt DESC, a.id DESC LIMIT 20`
    )
    .all<AnnouncementSummary>()
    .then((r) => r.results ?? []);
}
