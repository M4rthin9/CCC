import { MAX_LOGIN_ATTEMPTS, LOGIN_RATE_LIMIT_TTL } from '../constants';
import { cacheKeyUser, rateLimitKey } from '../cache/keys';
import { checkRateLimit, resetRateLimit, cacheRemove } from '../cache/kv';
import { hashPassword, verifyPassword } from '../auth/password';
import { signAccessToken, signRefreshToken, hashToken } from '../auth/jwt';
import { getUserByUsername, updateUserColumns } from '../db/queries/users';
import { getDefaultAccountHashes } from '../db/queries/settings';
import { insertRefreshToken, revokeRefreshToken } from '../db/queries/refreshTokens';
import { logEvent } from '../services/logger';
import { sanitizeStr } from '../config';
import { Env } from '../types';

export async function handleLogin(
  env: Env,
  body: Record<string, unknown>,
  meta: { ip: string; userAgent: string }
): Promise<Record<string, unknown>> {
  const rawUsername = String(body.username || '').trim();
  const username = rawUsername.toLowerCase();

  if (
    !(await checkRateLimit(env.CACHE_KV, rateLimitKey('login', username), MAX_LOGIN_ATTEMPTS, LOGIN_RATE_LIMIT_TTL))
  ) {
    await logEvent(env, rawUsername, 'login_failed', '', { reason: 'rate_limited' }, 'error', meta);
    return { status: 'error', message: 'การพยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 5 นาที' };
  }

  const user = await getUserByUsername(env.DB, rawUsername);
  if (!user || !(await verifyPassword(env, rawUsername, String(body.password || ''), user.password))) {
    await logEvent(env, rawUsername, 'login_failed', '', { reason: 'bad_credentials' }, 'error', meta);
    return { status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }

  if (String(user.password || '').indexOf('sha256$') !== 0) {
    await updateUserColumns(env.DB, rawUsername, [
      ['password', await hashPassword(env, rawUsername, String(body.password || ''))],
    ]);
    await cacheRemove(env.CACHE_KV, cacheKeyUser(rawUsername));
  }

  await resetRateLimit(env.CACHE_KV, rateLimitKey('login', username));

  const defaultHashes = await getDefaultAccountHashes(env.DB);
  const mustChangePassword = defaultHashes[username] === user.password;

  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(env.JWT_SECRET, {
      username: user.username,
      role: user.role,
      displayName: user.displayName || user.username,
    }),
    signRefreshToken(env.JWT_REFRESH_SECRET, user.username),
  ]);
  await insertRefreshToken(env, user.username, await hashToken(refreshToken), 7 * 24 * 60 * 60);

  if (mustChangePassword) {
    await logEvent(env, username, 'login_default_password', '', { action: 'force_password_change' }, 'warning', meta);
  }
  await logEvent(env, username, 'login', '', { action: 'login_success' }, 'success', meta);

  return {
    status: 'ok',
    user: { username: user.username, role: user.role, displayName: user.displayName || user.username },
    mustChangePassword: mustChangePassword || false,
    accessToken,
    refreshToken,
  };
}

export async function handleChangePassword(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const newPassword = String(body.newPassword || '');
  const confirmPassword = String(body.confirmPassword || '');
  if (!newPassword || newPassword.length < 6)
    return { status: 'error', message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' };
  if (newPassword !== confirmPassword) return { status: 'error', message: 'รหัสผ่านไม่ตรงกัน' };

  const username = sanitizeStr(body.username, 100);
  if (!username) return { status: 'error', message: 'Missing username' };

  const hashed = await hashPassword(env, username, newPassword);
  await updateUserColumns(env.DB, username, [['password', hashed]]);
  await cacheRemove(env.CACHE_KV, cacheKeyUser(username));
  await revokeRefreshToken(env, username);
  await logEvent(env, username, 'password_changed', '', { method: 'first_time_login' }, 'success');
  return { status: 'ok', message: 'เปลี่ยนรหัสผ่านสำเร็จ กรุณาเข้าระบบใหม่' };
}

export async function handleRefresh(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = String(body.refreshToken || '');
  if (!token) return { status: 'error', message: 'Missing refreshToken' };

  const { verifyRefreshToken } = await import('../auth/jwt');
  const payload = await verifyRefreshToken(env.JWT_REFRESH_SECRET, token);
  if (!payload) return { status: 'error', message: 'Invalid refresh token' };

  const tokenHash = await hashToken(token);
  const { findRefreshToken } = await import('../db/queries/refreshTokens');
  const stored = await findRefreshToken(env, payload.username, tokenHash);
  if (!stored || stored.revoked === 1) return { status: 'error', message: 'Invalid refresh token' };
  if (new Date(stored.expiresAt).getTime() < Date.now()) return { status: 'error', message: 'Refresh token expired' };

  const user = await getUserByUsername(env.DB, payload.username);
  if (!user) return { status: 'error', message: 'Invalid refresh token' };

  const accessToken = await signAccessToken(env.JWT_SECRET, {
    username: user.username,
    role: user.role,
    displayName: user.displayName || user.username,
  });
  return {
    status: 'ok',
    accessToken,
    user: { username: user.username, role: user.role, displayName: user.displayName || user.username },
  };
}
