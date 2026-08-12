import { SignJWT } from 'jose';
import { Env } from '../types';

const te = new TextEncoder();

export interface PushSubscriptionPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushResult {
  ok: boolean;
  status?: number;
  // true → the subscription is dead (410/404/401/403) and must be deleted.
  remove: boolean;
  error?: string;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function encodeUint32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function vapidJwk(publicKey: string, privateKey: string): JsonWebKey {
  const pub = b64urlDecode(publicKey);
  const priv = b64urlDecode(privateKey);
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(pub.subarray(1, 33)),
    y: b64urlEncode(pub.subarray(33, 65)),
    d: b64urlEncode(priv),
    key_ops: ['sign'],
  };
}

async function signVapidToken(
  subject: string,
  publicKey: string,
  privateKey: string,
  audience: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 12 * 60 * 60)
    .setAudience(audience)
    .sign(vapidJwk(publicKey, privateKey));
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('Content-Encoding: auth\x00') },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function hkdfExpand(prk: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function encryptPayload(
  sub: PushSubscriptionPayload,
  plaintext: Uint8Array
): Promise<{ header: Uint8Array; ciphertext: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const recordSize = 4096;

  const clientPub = b64urlDecode(sub.p256dh);
  const clientPubKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64urlEncode(clientPub.subarray(1, 33)),
      y: b64urlEncode(clientPub.subarray(33, 65)),
    } as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const ecdh = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  // workers-types renames the ECDH `public` member to `$public`; the runtime
  // uses the standard `public`. Cast through unknown to keep both happy.
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientPubKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0],
      ecdh.privateKey,
      256
    )
  );

  const keyId = new Uint8Array(65);
  keyId[0] = 0x04;
  const rawPub = (await crypto.subtle.exportKey('raw', ecdh.publicKey)) as ArrayBuffer;
  keyId.set(new Uint8Array(rawPub), 1);

  const prk = await hkdfExtract(salt, shared);
  const cek = await hkdfExpand(prk, salt, 'Content-Encoding: aes128gcm\x00', 16);
  const nonce = await hkdfExpand(prk, salt, 'Content-Encoding: nonce\x00', 12);

  const header = concat(salt, encodeUint32(recordSize), new Uint8Array([keyId.length]), keyId);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 },
      aesKey,
      plaintext
    )
  );
  return { header, ciphertext };
}

export async function sendPush(
  env: Env,
  sub: PushSubscriptionPayload,
  payload: { title: string; body: string; data?: Record<string, unknown> }
): Promise<PushResult> {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    return { ok: false, remove: false, error: 'vapid_keys_missing' };
  }

  let audience: string;
  try {
    audience = new URL(sub.endpoint).origin;
  } catch {
    return { ok: false, remove: true, error: 'push_invalid_endpoint' };
  }

  let token: string;
  try {
    token = await signVapidToken(env.VAPID_SUBJECT || 'mailto:ccc-backend@ccc.local', publicKey, privateKey, audience);
  } catch (e) {
    return { ok: false, remove: false, error: `vapid_sign_error: ${String(e)}` };
  }

  let header: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    ({ header, ciphertext } = await encryptPayload(sub, te.encode(JSON.stringify(payload))));
  } catch (e) {
    return { ok: false, remove: false, error: `encrypt_error: ${String(e)}` };
  }

  const body = concat(header, ciphertext);
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: `vapid t=${token}, k=${publicKey}`,
        TTL: '86400',
        Urgency: 'normal',
      },
      body,
    });
    const status = res.status;
    if (status === 200 || status === 201 || status === 202) return { ok: true, status, remove: false };
    if (status === 404 || status === 410) return { ok: false, status, remove: true, error: `push_gone_${status}` };
    if (status === 401 || status === 403) return { ok: false, status, remove: true, error: `push_auth_${status}` };
    if (status === 413) return { ok: false, status, remove: false, error: 'push_payload_too_large' };
    if (status === 429) return { ok: false, status, remove: false, error: 'push_rate_limited' };
    return { ok: false, status, remove: false, error: `push_error_${status}` };
  } catch (e) {
    return { ok: false, remove: false, error: `push_network_error: ${String(e)}` };
  }
}
