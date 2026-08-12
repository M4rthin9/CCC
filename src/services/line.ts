import { Env } from '../types';

const te = new TextEncoder();

export interface LinePushResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function pushLine(env: Env, userId: string, text: string): Promise<LinePushResult> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'line_token_missing' };
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: detail.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: `line_network_error: ${String(e)}` };
  }
}

// Replies to a user within 1 minute of their message (uses the replyToken).
export async function replyLine(env: Env, replyToken: string, text: string): Promise<LinePushResult> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'line_token_missing' };
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: detail.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: `line_network_error: ${String(e)}` };
  }
}

// Validates the X-Line-Signature header against the channel secret
// (HMAC-SHA256 of the raw request body, base64).
export async function verifyLineSignature(
  secret: string,
  rawBody: ArrayBuffer,
  signature: string | null
): Promise<boolean> {
  if (!signature || !secret) return false;
  try {
    const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
    let bin = '';
    for (const b of sig) bin += String.fromCharCode(b);
    const expected = btoa(bin);
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
