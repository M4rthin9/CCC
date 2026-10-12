-- Expand before deploying the Worker. Existing clients, reservations, payment
-- evidence and subscriptions remain unchanged. Seed existing full dates so
-- the first cancellation after deployment is observed.
-- Rollback: restore the previous Worker and its two cron triggers, retaining
-- this table and the notification history. No destructive reversal is needed.
CREATE TABLE IF NOT EXISTS table_availability (
  visitDateISO TEXT PRIMARY KEY,
  wasFull INTEGER NOT NULL DEFAULT 0 CHECK (wasFull IN (0, 1))
);

INSERT OR IGNORE INTO table_availability (visitDateISO, wasFull)
SELECT visitDateISO,
  CASE WHEN COUNT(*) >= (
    SELECT CASE WHEN CAST(cap AS INTEGER) BETWEEN 1 AND 500 THEN CAST(cap AS INTEGER) ELSE 10 END
    FROM (SELECT json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.tableBooking.perDay') AS cap
          FROM settings WHERE key = 'admin_settings'
          UNION ALL SELECT 10 LIMIT 1)
  ) THEN 1 ELSE 0 END
FROM reservations
WHERE bookingType = 'table'
  AND visitDateISO > date('now', '+7 hours')
  AND status IN ('รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น')
  AND NOT (status = 'รอชำระเงิน' AND holdExpiresAt != ''
           AND holdExpiresAt < strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
GROUP BY visitDateISO;
