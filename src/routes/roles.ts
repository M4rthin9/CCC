import { sanitizeStr } from '../config';
import { AVAILABLE_PERMISSIONS, PUBLIC_CACHE_TTL } from '../constants';
import { cacheKeyRoles } from '../cache/keys';
import { d1CacheGet, d1CachePut, d1CacheRemove } from '../cache/d1Cache';
import { getRoles, createRole, roleExists } from '../db/queries/roles';
import { hasPermission } from '../db/queries/roles';
import { invalidateRolesCache } from '../cache/invalidation';
import { logEvent } from '../services/logger';
import { Env } from '../types';

export async function getRolesHandler(env: Env): Promise<Record<string, unknown>> {
  const cacheKey = cacheKeyRoles(env);
  const cached = await d1CacheGet<string>(env.DB, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return { status: 'ok', roles: parsed };
    } catch {
      await d1CacheRemove(env.DB, cacheKey).catch(() => undefined);
    }
  }
  const roles = await getRoles(env.DB);
  await d1CachePut(env.DB, cacheKey, JSON.stringify(roles), PUBLIC_CACHE_TTL);
  return { status: 'ok', roles };
}

export async function handleCreateRole(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'เฉพาะผู้ดูแลสูงสุดเท่านั้นที่สามารถสร้างบทบาทใหม่ได้' };
  }

  const roleName = sanitizeStr(body.roleName, 100);
  const permissionsInput = Array.isArray(body.permissions) ? body.permissions.map((p) => String(p)) : [];

  if (!roleName) return { status: 'error', message: 'กรุณากรอกชื่อบทบาท' };
  if (permissionsInput.length === 0) {
    return { status: 'error', message: 'กรุณาเลือกอย่างน้อยหนึ่งสิทธิ์สำหรับบทบาท' };
  }

  const invalidPermissions = permissionsInput.filter((p) => !(AVAILABLE_PERMISSIONS as readonly string[]).includes(p));
  if (invalidPermissions.length > 0) {
    return { status: 'error', message: 'สิทธิ์ต่อไปนี้ไม่ถูกต้อง: ' + invalidPermissions.join(', ') };
  }

  if (await roleExists(env.DB, roleName)) {
    return { status: 'error', message: 'ชื่อบทบาทนี้มีอยู่แล้วในระบบ' };
  }

  await createRole(env.DB, roleName, permissionsInput);
  await invalidateRolesCache(env);
  await logEvent(env, user.username, 'create_role', roleName, { permissions: permissionsInput }, 'success');
  return { status: 'ok', message: 'สร้างบทบาทสำเร็จ', role: { roleName, permissions: permissionsInput } };
}
