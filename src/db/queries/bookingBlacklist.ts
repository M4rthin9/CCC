export interface BookingBlacklistRow {
  prisonerId: string;
  prisonerName: string;
  wing: string;
  warnings: number;
  totalWarnings: number;
  bannedUntil: string;
}

/** Include former prisoners whose warnings/bans must survive roster imports. */
export async function getBookingBlacklist(db: D1Database): Promise<BookingBlacklistRow[]> {
  const result = await db
    .prepare(
      `
    WITH ids AS (
      SELECT prisonerId FROM prisoners UNION SELECT prisonerId FROM prisoner_booking_blacklist
    ), totals AS (
      SELECT prisonerId, COUNT(*) AS totalWarnings FROM prisoner_booking_outcomes
      WHERE kind = 'cancelled' GROUP BY prisonerId
    )
    SELECT ids.prisonerId, COALESCE(p.prisonerName, '') AS prisonerName,
      COALESCE(p.wing, '') AS wing, COALESCE(b.consecutiveCancellations, 0) AS warnings,
      COALESCE(t.totalWarnings, 0) AS totalWarnings, COALESCE(b.bannedUntil, '') AS bannedUntil
    FROM ids LEFT JOIN prisoners p USING (prisonerId)
      LEFT JOIN prisoner_booking_blacklist b USING (prisonerId)
      LEFT JOIN totals t USING (prisonerId)
    ORDER BY b.bannedUntil DESC, warnings DESC, p.prisonerName COLLATE NOCASE
  `
    )
    .all<BookingBlacklistRow>();
  return result.results ?? [];
}

export function getBookingBan(db: D1Database, prisonerId: string) {
  return db
    .prepare('SELECT consecutiveCancellations, bannedUntil FROM prisoner_booking_blacklist WHERE prisonerId = ?')
    .bind(prisonerId)
    .first<{ consecutiveCancellations: number; bannedUntil: string }>();
}

export async function saveBookingBan(
  db: D1Database,
  prisonerId: string,
  warnings: number,
  bannedUntil: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO prisoner_booking_blacklist (prisonerId, consecutiveCancellations, bannedUntil)
    VALUES (?, ?, ?) ON CONFLICT(prisonerId) DO UPDATE SET
      consecutiveCancellations = excluded.consecutiveCancellations, bannedUntil = excluded.bannedUntil`
    )
    .bind(prisonerId, warnings, bannedUntil)
    .run();
}
