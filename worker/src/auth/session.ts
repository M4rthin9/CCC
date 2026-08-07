import { SESSION_COOKIE, SESSION_TTL_MS } from '../lib/constants';
import { nowUtc } from '../lib/dates';
import { sha256Hex } from './password';
import type { Env, SessionRow, UserRow } from '../types';

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.substring(0, idx).trim();
    if (key === name) return part.substring(idx + 1).trim();
  }
  return null;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function createSession(
  env: Env,
  userId: number,
  ip: string,
  userAgent: string,
): Promise<{ token: string; expiresAt: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const tokenHash = await sha256Hex(token);
  const now = nowUtc();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(tokenHash, userId, now, expiresAt, ip || null, userAgent || null)
    .run();
  return { token, expiresAt };
}

export async function findSessionUser(env: Env, token: string | null): Promise<{ session: SessionRow; user: UserRow } | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(tokenHash).first<SessionRow>();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first<UserRow>();
  if (!user) return null;
  return { session, user };
}

export async function deleteSession(env: Env, token: string | null): Promise<void> {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}
