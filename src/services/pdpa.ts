import { COOKIE_CONSENT_RETENTION_DAYS, DEFAULT_PDPA_POLICY_VERSION, PDPA_SETTING_KEY } from '../constants';
import { sanitizeStr } from '../config';
import { getSettings } from '../db/queries/settings';
import { deleteCookieConsentsBefore } from '../db/queries/cookieConsents';
import { Env } from '../types';

export interface PdpaConfig {
  /** Visitors whose stored consent carries another version are asked again. */
  policyVersion: string;
  /** Data-protection contact shown in the cookie policy (plain text). */
  contact: string;
}

export function parsePdpa(raw: unknown): PdpaConfig {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    policyVersion: sanitizeStr(cfg.policyVersion, 20) || DEFAULT_PDPA_POLICY_VERSION,
    contact: sanitizeStr(cfg.contact, 500),
  };
}

export async function getPdpaConfig(env: Env): Promise<PdpaConfig> {
  try {
    const settings = await getSettings(env.DB);
    return parsePdpa((settings as Record<string, unknown>)[PDPA_SETTING_KEY]);
  } catch {
    return parsePdpa(undefined);
  }
}

/**
 * Salted SHA-256 of the caller's IP, truncated. Enough to tie repeated
 * decisions from one network together as evidence, without keeping an address
 * anyone could read back.
 */
export async function hashIp(env: Env, ip: string): Promise<string> {
  if (!ip) return '';
  const data = new TextEncoder().encode(`${env.PASSWORD_SALT || ''}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Daily-cron retention sweep for the consent log. */
export function purgeOldCookieConsents(env: Env, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - COOKIE_CONSENT_RETENTION_DAYS * 86_400_000).toISOString();
  return deleteCookieConsentsBefore(env.DB, cutoff);
}
