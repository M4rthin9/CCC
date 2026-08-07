import type { Env, UserRow } from '../types';
import { PUBLIC_CACHE_TTL } from '../lib/constants';
import { getVersioned, putVersioned, logEvent, checkRateLimit, resetRateLimit } from '../db/db';
import { hasPermission } from '../auth/guard';
import { hashPasswordNew, verifyPassword } from '../auth/password';
import { createSession, sessionCookieHeader, SESSION_COOKIE } from '../auth/session';
import { sanitizeStr } from '../lib/validate';
import { nowUtc } from '../lib/dates';
import { getDefaultAccountHashes, clearDefaultAccountFlag, saveSettingsValue } from './settings';
import { ensureRolesSeeded, isValidRoleName } from './roles';

export async function getUserByUsername(env: Env, username: string): Promise<UserRow | null> {
  const uname = String(username || '').trim();
  if (!uname) return null;
  return env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(uname).first<UserRow>();
}

export async function getAllUsers(env: Env): Promise<UserRow[]> {
  const cached = await getVersioned<UserRow[]>(env, 'users', PUBLIC_CACHE_TTL);
  if (cached) return cached;
  const res = await env.DB.prepare('SELECT * FROM users ORDER BY username').all<UserRow>();
  const users = res.results || [];
  await putVersioned(env, 'users', users, PUBLIC_CACHE_TTL);
  return users;
}

export async function listUsers(env: Env): Promise<{ username: string; role: string; displayName: string; createdAt: string }[]> {
  const users = await getAllUsers(env);
  return users.map((u) => ({
    username: u.username,
    role: u.role,
    displayName: u.display_name || u.username,
    createdAt: u.created_at,
  }));
}

// ── First-run seeding (parity with seedDefaultUsers + DISABLE_SEED_USERS gate) ──
let seedPromise: Promise<void> | null = null;

export function ensureSeeded(env: Env): Promise<void> {
  if (!seedPromise) seedPromise = doSeed(env);
  return seedPromise;
}

export function resetSeeded(): void {
  seedPromise = null;
}

async function doSeed(env: Env): Promise<void> {
  await ensureRolesSeeded(env);
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();
  if (count && count.c > 0) return;
  const raw = env.SEED_USERS_JSON;
  if (env.DISABLE_SEED_USERS === 'true' || !raw) return;
  let seeds: unknown;
  try {
    seeds = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(seeds)) return;
  const defaultHashes: Record<string, string> = {};
  const now = nowUtc();
  const stmts: D1PreparedStatement[] = [];
  for (const u of seeds) {
    if (!Array.isArray(u) || u.length < 2) continue;
    const username = String(u[0]).trim();
    const password = String(u[1]);
    const role = String(u[2] || 'User').trim();
    const displayName = String(u[3] || username).trim();
    if (!username || !password) continue;
    const hash = await hashPasswordNew(password);
    defaultHashes[username.toLowerCase()] = hash;
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO users (username, password_hash, salt, algo, role, display_name, must_change_password, created_at) VALUES (?, ?, '', 'pbkdf2', ?, ?, 1, ?)",
      ).bind(username, hash, role, displayName, now),
    );
  }
  if (stmts.length === 0) return;
  await env.DB.batch(stmts);
  if (Object.keys(defaultHashes).length > 0) {
    await saveSettingsValue(env, 'seed_users', defaultHashes);
  }
}

// ── Login (parity with handleLogin) ──
export interface LoginResult {
  response: { status: string; message?: string; user?: { username: string; role: string; displayName: string }; mustChangePassword?: boolean };
  setCookie?: string;
}

export async function handleLogin(env: Env, body: Record<string, unknown>, ip: string, userAgent: string): Promise<LoginResult> {
  const rawUsername = String(body.username || '').trim();
  const username = rawUsername.toLowerCase();
  const password = String(body.password || '');

  const rateKeyUser = 'login:' + username;
  const rateKeyIp = 'login_ip:' + ip;
  if (!(await checkRateLimit(env, rateKeyUser, 5, 300)) || !(await checkRateLimit(env, rateKeyIp, 5, 300))) {
    await logEvent(env, {
      username: rawUsername,
      action: 'login_failed',
      targetRef: '',
      details: { reason: 'rate_limited' },
      result: 'error',
      ip,
      userAgent,
    });
    return {
      response: { status: 'error', message: 'การพยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 5 นาที' },
    };
  }

  const user = await getUserByUsername(env, rawUsername);
  if (!user || !(await verifyPassword(rawUsername, password, user.password_hash, user.algo, user.salt)).ok) {
    await logEvent(env, {
      username: rawUsername,
      action: 'login_failed',
      targetRef: '',
      details: { reason: 'bad_credentials' },
      result: 'error',
      ip,
      userAgent,
    });
    return { response: { status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' } };
  }

  // Legacy SHA-256 hashes are upgraded to PBKDF2 on first successful login.
  const verifyResult = await verifyPassword(rawUsername, password, user.password_hash, user.algo, user.salt);
  if (verifyResult.algo !== 'pbkdf2') {
    const newHash = await hashPasswordNew(password);
    await env.DB.prepare("UPDATE users SET password_hash = ?, algo = 'pbkdf2', salt = '' WHERE id = ?")
      .bind(newHash, user.id)
      .run();
    user.password_hash = newHash;
    user.algo = 'pbkdf2';
  }

  await resetRateLimit(env, rateKeyUser);
  await resetRateLimit(env, rateKeyIp);

  const defaultHashes = await getDefaultAccountHashes(env);
  const mustChangePassword = defaultHashes[username] === user.password_hash || user.must_change_password === 1;

  if (mustChangePassword) {
    await logEvent(env, {
      username,
      action: 'login_default_password',
      targetRef: '',
      details: { action: 'force_password_change' },
      result: 'warning',
      ip,
      userAgent,
    });
  }
  await logEvent(env, {
    username,
    action: 'login',
    targetRef: '',
    details: { action: 'login_success' },
    result: 'success',
    ip,
    userAgent,
  });

  const session = await createSession(env, user.id, ip, userAgent);
  const secure = env.ENVIRONMENT === 'production';
  return {
    response: {
      status: 'ok',
      user: { username: user.username, role: user.role, displayName: user.display_name || user.username },
      mustChangePassword: mustChangePassword || false,
    },
    setCookie: sessionCookieHeader(session.token, secure),
  };
}

export async function handleChangePassword(
  env: Env,
  user: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message?: string }> {
  const newPassword = String(body.newPassword || '');
  const confirmPassword = String(body.confirmPassword || '');
  if (!newPassword || newPassword.length < 6) {
    return { status: 'error', message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' };
  }
  if (newPassword !== confirmPassword) {
    return { status: 'error', message: 'รหัสผ่านไม่ตรงกัน' };
  }
  const newHash = await hashPasswordNew(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ?, algo = 'pbkdf2', salt = '', must_change_password = 0 WHERE id = ?")
    .bind(newHash, user.id)
    .run();
  await clearDefaultAccountFlag(env, user.username);
  await logEvent(env, {
    username: user.username,
    action: 'password_changed',
    targetRef: '',
    details: { method: 'first_time_login' },
    result: 'success',
    ip,
    userAgent,
  });
  return { status: 'ok', message: 'เปลี่ยนรหัสผ่านสำเร็จ กรุณาเข้าระบบใหม่' };
}

// ── User management (parity with handleCreateUser / handleUpdateUser / handleDeleteUser) ──
export async function createUser(
  env: Env,
  admin: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message: string; user?: { username: string; role: string } }> {
  const isSuperadmin = String(admin.username).toLowerCase() === 'superadmin';
  if (!isSuperadmin && !(await hasPermission(env, admin, 'manage_users'))) {
    return { status: 'error', message: 'เฉพาะผู้ดูแลสูงสุดเท่านั้นที่สามารถสร้างผู้ใช้ได้' };
  }
  const newUsername = sanitizeStr(body.username, 100);
  const newPassword = String(body.password || '');
  const newRole = sanitizeStr(body.role, 100);
  const newDisplayName = sanitizeStr(body.displayName, 200) || newUsername;

  if (!newUsername || !newPassword || !newRole) {
    return { status: 'error', message: 'กรุณากรอกข้อมูลให้ครบ (username, password, role)' };
  }
  if (newPassword.length < 6) {
    return { status: 'error', message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' };
  }
  if (!(await isValidRoleName(env, newRole))) {
    return { status: 'error', message: 'บทบาทไม่ถูกต้อง: ' + newRole };
  }
  const existing = await env.DB.prepare('SELECT username FROM users WHERE username = ? COLLATE NOCASE')
    .bind(newUsername)
    .first<{ username: string }>();
  if (existing) return { status: 'error', message: 'ชื่อผู้ใช้นั้นมีอยู่แล้ว' };

  const hash = await hashPasswordNew(newPassword);
  await env.DB.prepare(
    "INSERT INTO users (username, password_hash, salt, algo, role, display_name, must_change_password, created_at) VALUES (?, ?, '', 'pbkdf2', ?, ?, 0, ?)",
  )
    .bind(newUsername, hash, newRole, newDisplayName, nowUtc())
    .run();
  await logEvent(env, {
    username: admin.username,
    action: 'create_user',
    targetRef: newUsername,
    details: { role: newRole },
    result: 'success',
    ip,
    userAgent,
  });
  return { status: 'ok', message: 'ผู้ใช้ถูกสร้างสำเร็จ', user: { username: newUsername, role: newRole } };
}

export async function updateUser(
  env: Env,
  admin: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message: string }> {
  if (!(await hasPermission(env, admin, 'manage_users'))) {
    return { status: 'error', message: 'เฉพาะผู้ดูแลสูงสุดเท่านั้นที่สามารถแก้ไขผู้ใช้ได้' };
  }
  const targetUser = sanitizeStr(body.targetUser, 100);
  if (!targetUser) return { status: 'error', message: 'กรุณาระบุผู้ใช้ที่ต้องการแก้ไข' };
  const user = await getUserByUsername(env, targetUser);
  if (!user) return { status: 'error', message: 'ไม่พบผู้ใช้ที่ระบุ' };

  const cols: string[] = [];
  const binds: unknown[] = [];

  if (body.role !== undefined) {
    const role = sanitizeStr(body.role, 100);
    if (!(await isValidRoleName(env, role))) return { status: 'error', message: 'บทบาทไม่ถูกต้อง: ' + role };
    cols.push('role = ?');
    binds.push(role);
  }
  if (body.displayName !== undefined) {
    cols.push('display_name = ?');
    binds.push(sanitizeStr(body.displayName, 200));
  }
  if (body.newPassword) {
    const np = String(body.newPassword);
    if (np.length < 6) return { status: 'error', message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' };
    const hash = await hashPasswordNew(np);
    cols.push("password_hash = ?");
    binds.push(hash);
    cols.push("algo = 'pbkdf2'");
    await clearDefaultAccountFlag(env, targetUser);
  }
  if (cols.length > 0) {
    binds.push(user.id);
    await env.DB.prepare('UPDATE users SET ' + cols.join(', ') + ' WHERE id = ?').bind(...binds).run();
  }
  await logEvent(env, {
    username: admin.username,
    action: 'update_user',
    targetRef: targetUser,
    details: { role: body.role, displayName: body.displayName },
    result: 'success',
    ip,
    userAgent,
  });
  return { status: 'ok', message: 'อัปเดตผู้ใช้สำเร็จ' };
}

export async function deleteUser(
  env: Env,
  admin: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message: string }> {
  if (!(await hasPermission(env, admin, 'manage_users'))) {
    return { status: 'error', message: 'เฉพาะผู้ดูแลสูงสุดเท่านั้นที่สามารถลบผู้ใช้ได้' };
  }
  const targetUser = sanitizeStr(body.targetUser, 100);
  if (!targetUser) return { status: 'error', message: 'กรุณาระบุผู้ใช้ที่ต้องการลบ' };
  if (String(targetUser).toLowerCase() === String(admin.username).toLowerCase()) {
    return { status: 'error', message: 'ไม่สามารถลบตัวเองได้' };
  }
  const user = await getUserByUsername(env, targetUser);
  if (!user) return { status: 'error', message: 'ไม่พบผู้ใช้ที่ระบุ' };
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  await logEvent(env, {
    username: admin.username,
    action: 'delete_user',
    targetRef: targetUser,
    details: {},
    result: 'success',
    ip,
    userAgent,
  });
  return { status: 'ok', message: 'ลบผู้ใช้สำเร็จ' };
}

export { SESSION_COOKIE };
