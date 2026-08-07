import { verifyAccessToken, AccessPayload } from './jwt';
import { verifyPassword } from './password';
import { getUserByUsername } from '../db/queries/users';
import { Env, User } from '../types';

export type AuthenticatedUser = {
  username: string;
  role: string;
  displayName: string;
  viaJwt: boolean;
};

export async function authenticateLegacy(env: Env, username: string, pass: string): Promise<User | null> {
  const uname = String(username || '').trim();
  if (!uname || pass === undefined || pass === null) return null;
  const user = await getUserByUsername(env.DB, uname);
  if (!user) return null;
  const ok = await verifyPassword(env, uname, String(pass), user.password);
  if (!ok) return null;
  return user;
}

export function authFromBearer(env: Env, header: string): Promise<AccessPayload | null> {
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return Promise.resolve(null);
  return verifyAccessToken(env.JWT_SECRET, token);
}

// Resolves an authenticated user from either a JWT Bearer header or the legacy
// username+pass fields in the request body/query params.
export async function resolveAuthUser(
  env: Env,
  request: Request,
  body: Record<string, unknown>
): Promise<AuthenticatedUser | null> {
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader) {
    const payload = await authFromBearer(env, authHeader);
    if (payload) {
      return {
        username: payload.username,
        role: payload.role,
        displayName: payload.displayName,
        viaJwt: true,
      };
    }
  }

  const username = String(body.username ?? body.user ?? '').trim();
  const pass = String(body.pass ?? body.password ?? '');
  if (username) {
    const user = await authenticateLegacy(env, username, pass);
    if (user) {
      return {
        username: user.username,
        role: user.role,
        displayName: user.displayName || user.username,
        viaJwt: false,
      };
    }
  }
  return null;
}
