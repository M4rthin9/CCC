import { SignJWT, jwtVerify } from 'jose';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '../constants';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export interface AccessPayload {
  sub: string;
  username: string;
  role: string;
  displayName: string;
  type: 'access';
}

export interface RefreshPayload {
  sub: string;
  username: string;
  type: 'refresh';
}

export async function signAccessToken(secret: string, user: { username: string; role: string; displayName: string }): Promise<string> {
  return new SignJWT({ username: user.username, role: user.role, displayName: user.displayName, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.username)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function signRefreshToken(secret: string, username: string): Promise<string> {
  return new SignJWT({ username, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== 'access' || !payload.username) return null;
    return {
      sub: String(payload.sub ?? ''),
      username: String(payload.username),
      role: String(payload.role ?? ''),
      displayName: String(payload.displayName ?? ''),
      type: 'access',
    };
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(secret: string, token: string): Promise<RefreshPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== 'refresh' || !payload.username) return null;
    return { sub: String(payload.sub ?? ''), username: String(payload.username), type: 'refresh' };
  } catch {
    return null;
  }
}

export function hashToken(token: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    .then(d => Array.from(new Uint8Array(d)).map(b => ('0' + b.toString(16)).slice(-2)).join(''));
}
