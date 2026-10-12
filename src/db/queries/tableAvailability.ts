import { TABLE_OCCUPANCY_WHERE, tableOccupancyBinds } from './reservations';

export const TABLE_NOTIFICATION_DAILY_LIMIT = 1000;
export const TABLE_NOTIFICATION_READ_BUDGET = 2_000_000;
export const TABLE_NOTIFICATION_DAILY_ATTEMPTS = 2000;

/** Old pending rows also need a daily limit, so a retry backlog cannot flood writes. */
export async function claimTablePushAttempt(db: D1Database, day: string): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO table_notification_budget (day, attempts) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET attempts = table_notification_budget.attempts + 1
    WHERE table_notification_budget.attempts < ? RETURNING day`
    )
    .bind(day, TABLE_NOTIFICATION_DAILY_ATTEMPTS)
    .first();
  return row !== null;
}

/** Atomic admission reserves a conservative share before any availability scan. */
export async function claimTableScan(db: D1Database, day: string, reads: number): Promise<boolean> {
  if (!Number.isFinite(reads) || reads < 0 || reads > TABLE_NOTIFICATION_READ_BUDGET) return false;
  const row = await db
    .prepare(
      `INSERT INTO table_notification_budget (day, recipients, readsReserved)
    VALUES (?, 0, ?)
    ON CONFLICT(day) DO UPDATE SET readsReserved = table_notification_budget.readsReserved + excluded.readsReserved
    WHERE table_notification_budget.readsReserved + excluded.readsReserved <= ? RETURNING day`
    )
    .bind(day, reads, TABLE_NOTIFICATION_READ_BUDGET)
    .first();
  return row !== null;
}

/** Capture a full→available event once, then advance one bounded recipient page
 * atomically with its outbox and daily budget. Large audiences resume next day. */
export async function queueTableAvailability(
  db: D1Database,
  input: {
    ref: string;
    now: string;
    today: string;
    perDay: number;
    dates: { date: string; label: string }[];
    enabled: boolean;
  }
): Promise<number> {
  const occupancy = (date: string) => `(SELECT COUNT(*) FROM (SELECT 1 FROM reservations
    WHERE visitDateISO = ${date} AND ${TABLE_OCCUPANCY_WHERE} LIMIT ${input.perDay}))`;
  const binds = tableOccupancyBinds(input.now);
  const bookable = JSON.stringify(input.dates);
  const day = input.now.slice(0, 10);
  const oldest = '(SELECT id FROM table_notification_events WHERE complete = 0 ORDER BY id LIMIT 1)';
  const room = `(SELECT MAX(0, ${TABLE_NOTIFICATION_DAILY_LIMIT} - recipients) FROM table_notification_budget WHERE day = ?)`;
  const pageEnd = `COALESCE((SELECT MAX(endpoint) FROM (SELECT endpoint FROM push_subscriptions
    WHERE endpoint > table_notification_events.cursor ORDER BY endpoint LIMIT ${room})), table_notification_events.cursor)`;
  const stillAvailable = `EXISTS (SELECT 1 FROM json_each(table_notification_events.dates) d
    JOIN json_each(?) b ON d.value = json_extract(b.value, '$.date')
    WHERE ${occupancy('d.value')} < ?)`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO table_availability (visitDateISO, wasFull)
      SELECT json_extract(d.value, '$.date'), 1 FROM json_each(?) d
      WHERE ${occupancy("json_extract(d.value, '$.date')")} >= ?
      ON CONFLICT(visitDateISO) DO UPDATE SET wasFull = 1 WHERE table_availability.wasFull <> 1`
      )
      .bind(bookable, ...binds, input.perDay),
    db.prepare('INSERT OR IGNORE INTO table_notification_budget (day, recipients) VALUES (?, 0)').bind(day),
    db
      .prepare(
        `WITH reopened AS MATERIALIZED (
      SELECT s.visitDateISO, json_extract(d.value, '$.label') AS label
      FROM table_availability s JOIN json_each(?) d ON s.visitDateISO = json_extract(d.value, '$.date')
      WHERE s.wasFull = 1 AND ${occupancy('s.visitDateISO')} < ? ORDER BY s.visitDateISO
    )
    INSERT INTO table_notification_events (ref, body, dates, createdAt)
    SELECT ?, 'วันที่ ' || GROUP_CONCAT(label, ', ') ||
      ' กลับมาเปิดให้จองแล้ว แตะเพื่อตรวจสอบและจอง จำนวนที่ว่างอาจเปลี่ยนก่อนส่งคำขอ', json_group_array(visitDateISO), ?
    FROM reopened HAVING COUNT(*) > 0 AND ? = 1`
      )
      .bind(bookable, ...binds, input.perDay, input.ref, input.now, input.enabled ? 1 : 0),
    db
      .prepare(
        `UPDATE table_availability SET wasFull = 0
      WHERE wasFull = 1 AND visitDateISO IN (SELECT json_extract(value, '$.date') FROM json_each(?))
      AND ${occupancy('table_availability.visitDateISO')} < ?
      AND EXISTS (SELECT 1 FROM table_notification_events WHERE ref = ?)`
      )
      .bind(bookable, ...binds, input.perDay, input.ref),
    db
      .prepare(`UPDATE table_notification_events SET complete = 1 WHERE id = ${oldest} AND NOT ${stillAvailable}`)
      .bind(bookable, ...binds, input.perDay),
    db
      .prepare(
        `WITH event AS MATERIALIZED (SELECT * FROM table_notification_events WHERE id = ${oldest} AND ${stillAvailable}),
      page AS MATERIALIZED (SELECT endpoint, createdAt, openingAlerts FROM push_subscriptions
        WHERE endpoint > (SELECT cursor FROM event) ORDER BY endpoint LIMIT ${room})
      INSERT OR IGNORE INTO notifications (ref, type, channel, recipient, subject, body, status, attempts, error, createdAt, sentAt)
      SELECT event.ref, 'table_available', 'push', page.endpoint, 'มีโต๊ะว่างอีกครั้ง', event.body,
        'pending', 0, '', ?, '' FROM event CROSS JOIN page
      WHERE page.openingAlerts = 1 AND page.createdAt <= event.createdAt AND ? = 1`
      )
      .bind(bookable, ...binds, input.perDay, day, input.now, input.enabled ? 1 : 0),
    db
      .prepare(
        `UPDATE table_notification_events SET lastBatch = (SELECT COUNT(*) FROM notifications
        WHERE ref = table_notification_events.ref AND type = 'table_available' AND channel = 'push'
          AND recipient > table_notification_events.cursor AND recipient <= ${pageEnd}),
      cursor = ${pageEnd}
      WHERE id = ${oldest} AND ${room} > 0 AND ? = 1`
      )
      .bind(day, day, day, input.enabled ? 1 : 0),
    db
      .prepare(
        `UPDATE table_notification_budget SET recipients = recipients +
      (SELECT lastBatch FROM table_notification_events WHERE id = ${oldest})
      WHERE day = ? AND recipients < ? AND ? = 1
      AND EXISTS (SELECT 1 FROM table_notification_events WHERE id = ${oldest} AND lastBatch > 0)`
      )
      .bind(day, TABLE_NOTIFICATION_DAILY_LIMIT, input.enabled ? 1 : 0),
    db
      .prepare(
        `UPDATE table_notification_events SET complete = 1 WHERE id = ${oldest}
      AND NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint > table_notification_events.cursor) AND ? = 1`
      )
      .bind(input.enabled ? 1 : 0),
    db.prepare('DELETE FROM table_availability WHERE visitDateISO <= ?').bind(input.today),
  ]);
  return Number(results[5]?.meta?.changes ?? 0);
}
