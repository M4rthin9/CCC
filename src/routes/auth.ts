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

/**
 * Change a password.
 *
 * This route is reachable without a bearer token because it also serves the
 * forced first-login change, where the client may not yet hold a usable
 * session. Proof of identity therefore comes from the *current* password,
 * which is mandatory: without it, anyone could rename themselves to any
 * account in the body and take it over.
 *
 * An authenticated caller may only change their own password — a token for
 * user A cannot be used to set user B's password.
 */
export async function handleChangePassword(
  env: Env,
  body: Record<string, unknown>,
  caller: { username: string } | null,
  meta: { ip: string; userAgent: string }
): Promise<Record<string, unknown>> {
  const requested = sanitizeStr(body.username, 100);
  const username = caller ? caller.username : requested;
  if (!username) return { status: 'error', message: 'Missing username' };

  if (caller && requested && requested.toLowerCase() !== caller.username.toLowerCase()) {
    await logEvent(env, caller.username, 'password_change_denied', '', { target: requested }, 'denied', meta);
    return { status: 'error', message: 'ไม่สามารถเปลี่ยนรหัสผ่านของผู้ใช้อื่นได้' };
  }

  // Same budget as login: this endpoint verifies a password, so it is a
  // credential oracle and must not be brute-forceable.
  if (
    !(await checkRateLimit(
      env.CACHE_KV,
      rateLimitKey('changepw', username.toLowerCase()),
      MAX_LOGIN_ATTEMPTS,
      LOGIN_RATE_LIMIT_TTL
    ))
  ) {
    await logEvent(env, username, 'password_change_failed', '', { reason: 'rate_limited' }, 'error', meta);
    return { status: 'error', message: 'พยายามเปลี่ยนรหัสผ่านหลายครั้งเกินไป กรุณารอ 5 นาที' };
  }

  const newPassword = String(body.newPassword || '');
  const confirmPassword = String(body.confirmPassword || '');
  if (!newPassword || newPassword.length < 6)
    return { status: 'error', message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' };
  if (newPassword !== confirmPassword) return { status: 'error', message: 'รหัสผ่านไม่ตรงกัน' };

  const oldPassword = String(body.oldPassword || body.currentPassword || '');
  if (!oldPassword) return { status: 'error', message: 'กรุณากรอกรหัสผ่านปัจจุบัน' };

  const user = await getUserByUsername(env.DB, username);
  if (!user || !(await verifyPassword(env, username, oldPassword, user.password))) {
    await logEvent(env, username, 'password_change_failed', '', { reason: 'bad_current_password' }, 'error', meta);
    return { status: 'error', message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' };
  }
  if (newPassword === oldPassword) return { status: 'error', message: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม' };

  const hashed = await hashPassword(env, user.username, newPassword);
  await updateUserColumns(env.DB, user.username, [['password', hashed]]);
  await cacheRemove(env.CACHE_KV, cacheKeyUser(user.username));
  await resetRateLimit(env.CACHE_KV, rateLimitKey('changepw', username.toLowerCase()));
  await revokeRefreshToken(env, user.username);
  await logEvent(env, user.username, 'password_changed', '', {}, 'success', meta);
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
