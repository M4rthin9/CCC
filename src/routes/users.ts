import { sanitizeStr } from '../config';
import { cacheKeyUsers } from '../cache/keys';
import { cacheRemoveLarge } from '../cache/kv';
import { getAllUsers, createUser, updateUserColumns, deleteUser, userExists } from '../db/queries/users';
import { isValidRoleName } from '../db/queries/roles';
import { hashPassword } from '../auth/password';
import { hasPermission } from '../db/queries/roles';
import {
  invalidateUserCache, invalidateAllUsersCache
} from '../cache/invalidation';
import { clearDefaultAccountFlag } from '../db/queries/settings';
import { logEvent } from '../services/logger';
import { Env } from '../types';

export async function getUsersHandler(env: Env): Promise<Record<string, unknown>> {
  const users = await getAllUsers(env.DB);
  return { status: 'ok', users };
}

export async function handleCreateUser(env: Env, body: Record<string, unknown>, meta: { ip: string; userAgent: string }): Promise<Record<string, unknown>> {
  const adminUser = body.adminUser || body.username;
  if (String(adminUser).toLowerCase() !== 'superadmin' && !(await hasPermission(env.DB, String(adminUser), 'manage_users'))) {
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
  if (!(await isValidRoleName(env.DB, newRole))) {
    return { status: 'error', message: 'บทบาทไม่ถูกต้อง: ' + newRole };
  }

  if (await userExists(env.DB, newUsername)) {
    return { status: 'error', message: 'ชื่อผู้ใช้นั้นมีอยู่แล้ว' };
  }

  await createUser(env.DB, {
    username: newUsername,
    password: await hashPassword(env, newUsername, newPassword),
    role: newRole,
    displayName: newDisplayName,
    createdAt: new Date().toISOString(),
  });
  await invalidateUserCache(env, String(adminUser));
  await invalidateUserCache(env, newUsername);
  await invalidateAllUsersCache(env);
  await logEvent(env, String(adminUser), 'create_user', newUsername, { role: newRole }, 'success', meta);
  return { status: 'ok', message: 'ผู้ใช้ถูกสร้างสำเร็จ', user: { username: newUsername, role: newRole } };
}

export async function handleUpdateUser(env: Env, body: Record<string, unknown>, user: { username: string }): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'เฉพาะผู้ดูแลสูงสุดเท่านั้นที่สามารถแก้ไขผู้ใช้ได้' };
  }

  const targetUser = sanitizeStr(body.targetUser, 100);
  if (!targetUser) return { status: 'error', message: 'กรุณาระบุผู้ใช้ที่ต้องการแก้ไข' };
  if (!(await userExists(env.DB, targetUser))) return { status: 'error', message: 'ไม่พบผู้ใช้ที่ระบุ' };

  const cols: Array<[string, unknown]> = [];
  if (body.role !== undefined) {
    const role = sanitizeStr(body.role, 100);
    if (!(await isValidRoleName(env.DB, role))) return { status: 'error', message: 'บทบาทไม่ถูกต้อง: ' + role };
    cols.push(['role', role]);
  }
  if (body.displayName !== undefined) {
    cols.push(['displayName', sanitizeStr(body.displayName, 200)]);
  }
  if (body.newPassword) {
    const np = String(body.newPassword);
    if (np.length < 6) return { status: 'error', message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร' };
    cols.push(['password', await hashPassword(env, targetUser, np)]);
    await clearDefaultAccountFlag(env.DB, targetUser);
  }

  if (cols.length > 0) await updateUserColumns(env.DB, targetUser, cols);
  await invalidateUserCache(env, targetUser);
  await invalidateAllUsersCache(env);
  await logEvent(env, user.username, 'update_user', targetUser, { role: body.role, displayName: body.displayName }, 'success');
  return { status: 'ok', message: 'อัปเดตผู้ใช้สำเร็จ' };
}

export async function handleDeleteUser(env: Env, body: Record<string, unknown>, user: { username: string }): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'เฉพาะผู้ดูแลสูงสุดเท่านั้นที่สามารถลบผู้ใช้ได้' };
  }

  const targetUser = sanitizeStr(body.targetUser, 100);
  if (!targetUser) return { status: 'error', message: 'กรุณาระบุผู้ใช้ที่ต้องการลบ' };
  if (String(targetUser).toLowerCase() === String(user.username).toLowerCase()) {
    return { status: 'error', message: 'ไม่สามารถลบตัวเองได้' };
  }
  if (!(await userExists(env.DB, targetUser))) return { status: 'error', message: 'ไม่พบผู้ใช้ที่ระบุ' };

  await deleteUser(env.DB, targetUser);
  await invalidateUserCache(env, targetUser);
  await invalidateAllUsersCache(env);
  await logEvent(env, user.username, 'delete_user', targetUser, {}, 'success');
  return { status: 'ok', message: 'ลบผู้ใช้สำเร็จ' };
}
