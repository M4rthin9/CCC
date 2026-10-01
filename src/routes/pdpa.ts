import { COOKIE_CONSENT_CHOICES } from '../constants';
import { sanitizeStr } from '../config';
import { hasPermission } from '../db/queries/roles';
import {
  countCookieConsentsByChoice,
  getRecentCookieConsents,
  insertCookieConsent,
} from '../db/queries/cookieConsents';
import { getPdpaConfig, hashIp } from '../services/pdpa';
import { Env } from '../types';

const CONSENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_LIMIT = 20;

/**
 * Public: log one cookie-banner decision as PDPA consent evidence. The browser
 * keeps the decision itself; this row is what the institution can show later.
 */
export async function handleRecordCookieConsent(
  env: Env,
  body: Record<string, unknown>,
  meta: { ip: string; userAgent: string }
): Promise<Record<string, unknown>> {
  const consentId = sanitizeStr(body.consentId, 64);
  const choice = sanitizeStr(body.choice, 20);
  if (!CONSENT_ID_RE.test(consentId)) return { status: 'error', message: 'Invalid consentId' };
  if (!(COOKIE_CONSENT_CHOICES as readonly string[]).includes(choice)) {
    return { status: 'error', message: 'Invalid choice' };
  }

  // Log the version the visitor was actually shown (a tab opened before a
  // policy bump still shows the old text); fall back to the current one.
  const { policyVersion } = await getPdpaConfig(env);
  const shownVersion = sanitizeStr(body.policyVersion, 20);

  await insertCookieConsent(env.DB, {
    consentId: consentId.toLowerCase(),
    policyVersion: shownVersion || policyVersion,
    choice,
    preferences: body.preferences === true,
    analytics: body.analytics === true,
    lang: sanitizeStr(body.lang, 8),
    ipHash: await hashIp(env, meta.ip),
    userAgent: sanitizeStr(meta.userAgent, 300),
    createdAt: new Date().toISOString(),
  });
  return { status: 'ok', policyVersion };
}

/** Staff: consent totals (30 days + all time) and the latest decisions. */
export async function handleGetCookieConsentStats(
  env: Env,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดูข้อมูลความยินยอม' };
  }
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [last30Days, allTime, recent] = await Promise.all([
    countCookieConsentsByChoice(env.DB, since30),
    countCookieConsentsByChoice(env.DB, ''),
    getRecentCookieConsents(env.DB, RECENT_LIMIT),
  ]);
  return { status: 'ok', last30Days, allTime, recent };
}
