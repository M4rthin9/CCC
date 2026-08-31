import { Env } from '../types';

const BANGKOK_DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Payment slips used to live in D1 as a base64 data URI (`slip_base64`), which
 * capped an upload at the ~2MB D1 cell limit and dragged the whole image
 * through every row read. They now go to R2 (`SLIPS` binding) and D1 keeps only
 * the object key.
 *
 * Reads still fall back to `slip_base64` so bookings uploaded before the
 * migration keep working, and writes fall back to it when the binding is
 * missing (an older deploy, or a local `wrangler dev` without R2).
 */

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export interface DecodedSlip {
  bytes: Uint8Array;
  contentType: string;
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a multi-MB slip cannot blow the argument limit of fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Split a `data:image/...;base64,...` URI into bytes + content type. */
export function parseDataUri(uri: string): DecodedSlip | null {
  const m = /^data:(image\/[a-zA-Z0-9+.-]+);base64,/.exec(uri);
  if (!m) return null;
  try {
    const bytes = base64ToBytes(uri.slice(m[0].length));
    if (bytes.length === 0) return null;
    return { bytes, contentType: (m[1] || 'image/jpeg').toLowerCase() };
  } catch {
    return null;
  }
}

export function toDataUri(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType || 'image/jpeg'};base64,${bytesToBase64(bytes)}`;
}

/** `slips/YYYY-MM-DD/<epoch-ms>.<ext>` — slips are bucketed by the Bangkok
 *  upload date. The dashboard never deletes slips, so no per-ref prefix is
 *  needed; files are addressed directly by their stored `slip_key`. */
export function buildSlipKey(_ref: string, contentType: string): string {
  const date = BANGKOK_DATE.format(new Date());
  return `slips/${date}/${Date.now()}.${EXT_BY_TYPE[contentType] || 'bin'}`;
}

export function slipsBucket(env: Env): R2Bucket | null {
  return env.SLIPS ?? null;
}

/** Store a slip and return its key, or '' when there is no bucket to store in. */
export async function putSlip(env: Env, ref: string, slip: DecodedSlip): Promise<string> {
  const bucket = slipsBucket(env);
  if (!bucket) return '';
  const key = buildSlipKey(ref, slip.contentType);
  await bucket.put(key, slip.bytes as unknown as ArrayBuffer, {
    httpMetadata: { contentType: slip.contentType, cacheControl: 'private, max-age=31536000, immutable' },
    customMetadata: { ref },
  });
  return key;
}

export async function getSlip(env: Env, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const bucket = slipsBucket(env);
  if (!bucket || !key) return null;
  const obj = await bucket.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType: obj.httpMetadata?.contentType || 'image/jpeg' };
}

/** Drop every object stored under a booking's prefix (revert / delete paths).
 *
 *  Slips are now bucketed by upload date (`slips/YYYY-MM-DD/...`) with no
 *  per-ref prefix, so a slip can no longer be located by reservation reference.
 *  The dashboard does not delete slips, so this is intentionally a no-op; the
 *  image for a reverted booking is simply orphaned in R2. */
export async function deleteSlipsForRef(_env: Env, _ref: string): Promise<void> {
  return;
}

// ── View tokens ────────────────────────────────────────────────────
// The slip image is served by the Worker rather than from a public bucket, so
// bank details are never world-readable. Staff reach it with their normal auth;
// everyone else needs a signed, ref-bound token — the same trust level as the
// ref-keyed public endpoints, but it cannot be guessed.
//
// Tokens do NOT expire. An `<img src>` cannot carry the staff Bearer token, and
// the dashboard renders whatever signed URL it got from its last reservation
// list bind — under any TTL a modal opened from a stale bind 401s and the slip
// silently fails to load. `exp = 0` is the never-expires sentinel; the HMAC
// still binds the URL to one specific ref, so it stays unguessable and the
// bucket stays private. The trade-off is that a leaked slip URL keeps working
// until JWT_SECRET is rotated.
//
// Legacy tokens minted before this switch carry a real expiry inside the token
// and keep being honoured until it lapses.
const NEVER_EXPIRES = 0;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Pass `ttlSeconds` only to mint a deliberately short-lived link; the default
 *  is a non-expiring token so slip images never break in a review modal. */
export async function signSlipToken(env: Env, ref: string, ttlSeconds?: number): Promise<string> {
  const exp = ttlSeconds === undefined ? NEVER_EXPIRES : Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacHex(env.JWT_SECRET || env.PASSWORD_SALT || '', `${ref}.${exp}`);
  return `${exp}.${sig.slice(0, 32)}`;
}

export async function verifySlipToken(env: Env, ref: string, token: string): Promise<boolean> {
  const [expStr, sig] = String(token || '').split('.');
  const exp = Number(expStr);
  // `exp === 0` is the never-expires sentinel; any other value is a legacy
  // token and is still checked against the clock. Note !Number.isFinite rather
  // than !exp, so 0 is not mistaken for a malformed token.
  if (!sig || !Number.isFinite(exp) || exp < 0) return false;
  if (exp !== NEVER_EXPIRES && exp < Math.floor(Date.now() / 1000)) return false;
  const expected = (await hmacHex(env.JWT_SECRET || env.PASSWORD_SALT || '', `${ref}.${exp}`)).slice(0, 32);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** Absolute URL the clients put in `<img src>`. The dashboard and the booking
 *  page live on different origins from the Worker, so a relative path is not
 *  usable there — `origin` comes from the request that asked for the slip. */
export function slipImageUrl(origin: string, ref: string, token: string): string {
  const q = `ref=${encodeURIComponent(ref)}&token=${encodeURIComponent(token)}`;
  return `${origin.replace(/\/$/, '')}/api/slip/image?${q}`;
}
