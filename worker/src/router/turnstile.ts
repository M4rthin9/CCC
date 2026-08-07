import type { Env } from '../types';

export async function verifyTurnstileToken(env: Env, token: string, remoteIp?: string): Promise<boolean> {
  try {
    if (env.ENVIRONMENT === 'test') return true;
    const secret = env.TURNSTILE_SECRET;
    if (!secret) return false;
    if (!token) return false;

    const expectedHostnames = new Set(
      String(env.TURNSTILE_HOSTNAMES || 'cida.dpdns.org')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    );

    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', String(token).trim());
    if (remoteIp) params.set('remoteip', String(remoteIp).trim());

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const result = (await resp.json()) as {
      success?: boolean;
      action?: string;
      hostname?: string;
      'error-codes'?: string[];
    };
    return (
      result.success === true &&
      result.action === 'booking' &&
      expectedHostnames.has(result.hostname || '')
    );
  } catch (e) {
    console.error('verifyTurnstileToken failed: ' + String(e));
    return false;
  }
}
