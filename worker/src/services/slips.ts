import type { Env } from '../types';
import { MAX_SLIP_BYTES } from '../lib/constants';
import { logEvent } from '../db/db';
import { sanitizeStr } from '../lib/validate';
import { publishRealtime } from '../realtime/hub';
import { nowUtc } from '../lib/dates';

export function extFromMime(mimeType: string): string {
  return mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
}

export function parseBase64Data(base64Data: string): { mimeType: string; rawBase64: string } {
  const matches = base64Data.match(/^data:([a-zA-Z0-9+/]+\/[a-zA-Z0-9+/]+);base64,(.+)$/);
  if (matches) {
    return { mimeType: matches[1], rawBase64: matches[2] };
  }
  throw new Error('Invalid base64 format');
}

export function resolveSlipImage(slipKey: string | null): string {
  if (!slipKey) return '';
  if (/^https?:\/\//i.test(slipKey)) return slipKey;
  return '/api/slips/' + slipKey.split('/').map(encodeURIComponent).join('/');
}

export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function uploadSlipToR2(
  env: Env,
  ref: string,
  base64Data: string,
  mimeTypeOverride: string,
): Promise<string> {
  if (String(base64Data).length > MAX_SLIP_BYTES) {
    throw new Error('ไฟล์มีขนาดใหญ่เกินไป');
  }
  let mimeType: string;
  let rawBase64: string;
  try {
    const parsed = parseBase64Data(base64Data);
    mimeType = mimeTypeOverride || parsed.mimeType;
    rawBase64 = parsed.rawBase64;
  } catch {
    if (mimeTypeOverride) {
      mimeType = mimeTypeOverride;
      rawBase64 = base64Data;
    } else {
      throw new Error('Invalid base64 format');
    }
  }
  const ext = extFromMime(mimeType);
  const key = `slips/${ref}-${Date.now()}.${ext}`;
  await env.CC_SLIPS.put(key, base64ToBytes(rawBase64), {
    httpMetadata: { contentType: mimeType },
  });
  return key;
}

export async function uploadSlip(
  env: Env,
  body: Record<string, unknown>,
  origin: string,
  ip: string,
  userAgent: string,
): Promise<{ status: string; url?: string; message?: string }> {
  const ref = sanitizeStr(body.ref, 64);
  if (!body.base64Data) return { status: 'error', message: 'Missing base64Data' };
  if (!ref) return { status: 'error', message: 'Missing ref' };
  try {
    const key = await uploadSlipToR2(env, ref, String(body.base64Data), String(body.mimeType || ''));
    await logEvent(env, {
      username: sanitizeStr(body.username, 100) || 'public',
      action: 'slip_uploaded',
      targetRef: ref,
      details: {},
      result: 'success',
      ip,
      userAgent,
    });
    await publishRealtime(env, { type: 'slip_uploaded', ref, at: nowUtc() });
    return { status: 'ok', url: origin + '/api/slips/' + key.split('/').map(encodeURIComponent).join('/') };
  } catch (e) {
    await logEvent(env, {
      username: sanitizeStr(body.username, 100) || 'public',
      action: 'slip_upload_failed',
      targetRef: ref,
      details: { error: e instanceof Error ? e.toString() : String(e) },
      result: 'error',
      ip,
      userAgent,
    });
    return { status: 'error', message: e instanceof Error ? e.toString() : String(e) };
  }
}

export async function readSlip(env: Env, key: string): Promise<Response | null> {
  const object = await env.CC_SLIPS.get(key);
  if (!object) return null;
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { status: 200, headers });
}
