import { Env } from '../types';

// Canonical Cloudflare Turnstile server-side verification.
// POST https://challenges.cloudflare.com/turnstile/v0/siteverify
// with form-encoded { secret, response, remoteip? }.
// Gate on success === true; fail closed on network error / non-2xx.

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
  hostname?: string;
  action?: string;
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

    if (!resp.ok) {
      console.error('[Turnstile] siteverify HTTP error:', resp.status, await resp.text().catch(() => ''));
      return false;
    }

    const result = (await resp.json()) as TurnstileVerifyResult;

    if (result.success !== true) {
      console.error('[Turnstile] verification failed:', JSON.stringify(result));
      return false;
    }

    // Validate hostname against allowed list when configured.
    const allowedHostnames = (env.TURNSTILE_ALLOWED_HOSTNAMES || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (allowedHostnames.length > 0 && result.hostname) {
      const responseHostname = result.hostname.toLowerCase();
      const isAllowed = allowedHostnames.some(
        (allowed) => responseHostname === allowed || responseHostname.endsWith('.' + allowed)
      );
      if (!isAllowed) {
        console.error('[Turnstile] hostname mismatch:', responseHostname, 'allowed:', allowedHostnames);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.error('[Turnstile] verification error:', err);
    return false;
  }
}
