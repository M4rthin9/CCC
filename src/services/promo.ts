import { MAX_PROMO_ADS, PROMO_KEY_PREFIX, PROMO_SETTING_KEY } from '../constants';
import { sanitizeStr } from '../config';
import { getSettings } from '../db/queries/settings';
import { DecodedSlip, slipsBucket } from './slipStorage';
import { Env } from '../types';

export interface PromoAd {
  /** `<uuid>.<ext>` — the R2 object is `promo/<id>`. */
  id: string;
  title: string;
  /** Optional click-through, http(s) only. */
  link: string;
  active: boolean;
}

export interface PromoConfig {
  /** Show the advert carousel as a popup when the home page opens. */
  popupEnabled: boolean;
  ads: PromoAd[];
  /** Free-text information block on the home page (plain text, no HTML). */
  notice: { enabled: boolean; title: string; body: string };
}

export const PROMO_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const PROMO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;
const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * The id is the only thing that reaches R2 from the public image route, so it
 * must be exactly the shape `putPromoImage` mints. Anything else — a path, a
 * `slips/...` key — is refused before the bucket is touched; that is what keeps
 * the private slips sharing this bucket out of reach.
 */
export function isPromoImageId(id: unknown): id is string {
  return typeof id === 'string' && PROMO_ID_RE.test(id);
}

/** Only absolute http(s) links survive — a `javascript:` href must never reach the page. */
function safeLink(value: unknown): string {
  const s = sanitizeStr(value, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/** Sanitise `admin_settings.promo`; missing or malformed means "nothing to show". */
export function parsePromo(raw: unknown): PromoConfig {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const ads: PromoAd[] = [];
  for (const item of Array.isArray(cfg.ads) ? cfg.ads : []) {
    if (ads.length >= MAX_PROMO_ADS) break;
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (!isPromoImageId(a.id) || seen.has(a.id)) continue;
    seen.add(a.id);
    ads.push({ id: a.id, title: sanitizeStr(a.title, 120), link: safeLink(a.link), active: a.active !== false });
  }
  const n = cfg.notice && typeof cfg.notice === 'object' ? (cfg.notice as Record<string, unknown>) : {};
  return {
    popupEnabled: cfg.popupEnabled !== false,
    ads,
    notice: { enabled: n.enabled === true, title: sanitizeStr(n.title, 120), body: sanitizeStr(n.body, 3000) },
  };
}

export async function getPromoConfig(env: Env): Promise<PromoConfig> {
  try {
    const settings = await getSettings(env.DB);
    return parsePromo((settings as Record<string, unknown>)[PROMO_SETTING_KEY]);
  } catch {
    return parsePromo(undefined);
  }
}

export function promoImageUrl(origin: string, id: string): string {
  return `${origin.replace(/\/$/, '')}/api/promo/image?id=${encodeURIComponent(id)}`;
}

/** Store an advert image and return its id, or '' when there is no bucket. */
export async function putPromoImage(env: Env, img: DecodedSlip): Promise<string> {
  const bucket = slipsBucket(env);
  const ext = PROMO_IMAGE_TYPES[img.contentType];
  if (!bucket || !ext) return '';
  const id = `${crypto.randomUUID()}.${ext}`;
  await bucket.put(PROMO_KEY_PREFIX + id, img.bytes as unknown as ArrayBuffer, {
    httpMetadata: { contentType: img.contentType, cacheControl: 'public, max-age=31536000, immutable' },
  });
  return id;
}

export async function getPromoImage(
  env: Env,
  id: string
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const bucket = slipsBucket(env);
  if (!bucket || !isPromoImageId(id)) return null;
  const obj = await bucket.get(PROMO_KEY_PREFIX + id);
  if (!obj) return null;
  const ext = id.slice(id.lastIndexOf('.') + 1);
  return { body: obj.body, contentType: TYPE_BY_EXT[ext] || 'application/octet-stream' };
}

export async function deletePromoImage(env: Env, id: string): Promise<void> {
  const bucket = slipsBucket(env);
  if (!bucket || !isPromoImageId(id)) return;
  await bucket.delete(PROMO_KEY_PREFIX + id);
}
