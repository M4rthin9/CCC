import { PERMISSIONS } from '../lib/constants';
import type { Env, UserRow } from '../types';
import type { Context } from 'hono';
import { getRolesList } from '../services/roles';
import { findSessionUser, parseCookie, SESSION_COOKIE } from './session';

export async function hasPermission(env: Env, user: UserRow, perm: string): Promise<boolean> {
  if (!user) return false;
  const builtin = PERMISSIONS[user.role];
  if (builtin && builtin.includes(perm)) return true;
  try {
    const roles = await getRolesList(env);
    const entry = roles.find((r) => String(r.roleName || '').toLowerCase() === String(user.role || '').toLowerCase());
    if (entry && Array.isArray(entry.permissions)) {
      return entry.permissions.includes(perm);
    }
  } catch (e) {
    console.error('hasPermission dynamic lookup failed: ' + String(e));
  }
  return false;
}

export async function requireUser<B>(c: Context<B>): Promise<UserRow | null> {
  const env = c.env as unknown as Env;
  const cookieHeader = c.req.header('cookie');
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  const found = await findSessionUser(env, token);
  if (!found) return null;
  return found.user;
}

export async function requirePermission<B>(c: Context<B>, perm: string): Promise<boolean> {
  const user = c.get('user') as UserRow | undefined;
  if (!user) return false;
  return hasPermission(c.env as unknown as Env, user, perm);
}

export function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    ''
  );
}

export function clientUa(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header('user-agent') || '';
}
