import { TABLES } from '../../constants';

export interface CookieConsentRow {
  consentId: string;
  policyVersion: string;
  choice: string;
  preferences: boolean;
  analytics: boolean;
  lang: string;
  ipHash: string;
  userAgent: string;
  createdAt: string;
}

export function insertCookieConsent(db: D1Database, row: CookieConsentRow): Promise<void> {
  return db
    .prepare(
      `INSERT INTO ${TABLES.cookieConsents}
       (consent_id, policy_version, choice, preferences, analytics, lang, ip_hash, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.consentId,
      row.policyVersion,
      row.choice,
      row.preferences ? 1 : 0,
      row.analytics ? 1 : 0,
      row.lang,
      row.ipHash,
      row.userAgent,
      row.createdAt
    )
    .run()
    .then(() => undefined);
}

/** Decisions per choice since `sinceIso` (ISO instant; '' = all time). */
export function countCookieConsentsByChoice(db: D1Database, sinceIso: string): Promise<Record<string, number>> {
  return db
    .prepare(`SELECT choice, COUNT(*) AS n FROM ${TABLES.cookieConsents} WHERE created_at >= ? GROUP BY choice`)
    .bind(sinceIso)
    .all<{ choice: string; n: number }>()
    .then((res) => Object.fromEntries((res.results ?? []).map((r) => [r.choice, Number(r.n) || 0])));
}

/** Newest decisions first — the hashed IP never leaves the database. */
export function getRecentCookieConsents(db: D1Database, limit: number): Promise<Omit<CookieConsentRow, 'ipHash'>[]> {
  return db
    .prepare(
      `SELECT consent_id, policy_version, choice, preferences, analytics, lang, user_agent, created_at
     FROM ${TABLES.cookieConsents} ORDER BY id DESC LIMIT ?`
    )
    .bind(limit)
    .all<Record<string, unknown>>()
    .then((res) =>
      (res.results ?? []).map((r) => ({
        consentId: String(r.consent_id ?? ''),
        policyVersion: String(r.policy_version ?? ''),
        choice: String(r.choice ?? ''),
        preferences: Number(r.preferences) === 1,
        analytics: Number(r.analytics) === 1,
        lang: String(r.lang ?? ''),
        userAgent: String(r.user_agent ?? ''),
        createdAt: String(r.created_at ?? ''),
      }))
    );
}

export function deleteCookieConsentsBefore(db: D1Database, beforeIso: string): Promise<number> {
  return db
    .prepare(`DELETE FROM ${TABLES.cookieConsents} WHERE created_at < ?`)
    .bind(beforeIso)
    .run()
    .then((res) => res.meta?.changes ?? 0);
}
