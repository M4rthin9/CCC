import { Env } from '../types';

// Canonical Cloudflare Turnstile server-side verification.
// POST https://challenges.cloudflare.com/turnstile/v0/siteverify
// with form-encoded { secret, response, remoteip? }.
// Gate on success === true; fail closed on network error / non-2xx.

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
}

export async function verifyTurnstileToken(env: Env, token: unknown, remoteIp?: string): Promise<boolean> {
  try {
    if (!env.TURNSTILE_SECRET) return false;
    if (!token) return false;

    const payload = new URLSearchParams();
    payload.set('secret', env.TURNSTILE_SECRET);
    payload.set('response', String(token).trim());
    if (remoteIp) payload.set('remoteip', String(remoteIp).trim());

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });

    if (!resp.ok) return false;
    const result = (await resp.json()) as TurnstileVerifyResult;
    return result.success === true;
  } catch {
    // Fail closed on any network/parse error.
    return false;
  }
}
