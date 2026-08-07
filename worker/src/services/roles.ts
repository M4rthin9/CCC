import type { Env, UserRow } from '../types';
import { AVAILABLE_PERMISSIONS, PERMISSIONS, PUBLIC_CACHE_TTL } from '../lib/constants';
import { getVersioned, putVersioned, logEvent } from '../db/db';
import { hasPermission } from '../auth/guard';
import { sanitizeStr } from '../lib/validate';

export interface RoleEntry {
  roleName: string;
  permissions: string[];
}

export async function getRolesList(env: Env): Promise<RoleEntry[]> {
  const cached = await getVersioned<RoleEntry[]>(env, 'roles', PUBLIC_CACHE_TTL);
  if (cached) return cached;
  const res = await env.DB.prepare('SELECT role_name, permissions_json FROM roles').all<{ role_name: string; permissions_json: string }>();
  const roles: RoleEntry[] = [];
  for (const row of res.results || []) {
    let permissions: string[] = [];
    try {
      const parsed = JSON.parse(row.permissions_json);
      if (Array.isArray(parsed)) permissions = parsed.map(String);
    } catch {
      permissions = [];
    }
    roles.push({ roleName: row.role_name, permissions });
  }
  await putVersioned(env, 'roles', roles, PUBLIC_CACHE_TTL);
  return roles;
}

export async function ensureRolesSeeded(env: Env): Promise<void> {
  const stmts: D1PreparedStatement[] = Object.entries(PERMISSIONS).map(([roleName, perms]) =>
    env.DB.prepare('INSERT OR IGNORE INTO roles (role_name, permissions_json) VALUES (?, ?)').bind(roleName, JSON.stringify(perms)),
  );
  if (stmts.length > 0) await env.DB.batch(stmts);
}

export async function getValidRoleNames(env: Env): Promise<string[]> {
  const names = Object.keys(PERMISSIONS);
  const res = await env.DB.prepare('SELECT role_name FROM roles').all<{ role_name: string }>();
  for (const r of res.results || []) {
    if (!names.includes(r.role_name)) names.push(r.role_name);
  }
  return names;
}

export async function isValidRoleName(env: Env, role: string): Promise<boolean> {
  const names = await getValidRoleNames(env);
  return names.some((r) => r.toLowerCase() === String(role).toLowerCase());
}

export async function createRole(
  env: Env,
  admin: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message: string; role?: { roleName: string; permissions: string[] } }> {
  if (!(await hasPermission(env, admin, 'manage_users'))) {
    return { status: 'error', message: 'เฉพาะผู้ดูแลสูงสุดเท่านั้นที่สามารถสร้างบทบาทใหม่ได้' };
  }
  const roleName = sanitizeStr(body.roleName, 100);
  if (!roleName) return { status: 'error', message: 'กรุณาระบุชื่อบทบาท' };
  const permissions = Array.isArray(body.permissions)
    ? body.permissions.map((p) => sanitizeStr(p, 100)).filter((p) => p)
    : [];
  if (permissions.length === 0) {
    return { status: 'error', message: 'กรุณาเลือกสิทธิ์อย่างน้อย 1 สิทธิ์' };
  }
  const invalid = permissions.filter((p) => !(AVAILABLE_PERMISSIONS as readonly string[]).includes(p));
  if (invalid.length > 0) {
    return { status: 'error', message: 'สิทธิ์ไม่ถูกต้อง: ' + invalid.join(', ') };
  }
  const existing = await env.DB.prepare('SELECT role_name FROM roles WHERE role_name = ?').bind(roleName).first<{ role_name: string }>();
  if (existing) return { status: 'error', message: 'ชื่อบทบาทนี้มีอยู่แล้วในระบบ' };

  await env.DB.prepare('INSERT INTO roles (role_name, permissions_json) VALUES (?, ?)').bind(roleName, JSON.stringify(permissions)).run();
  await logEvent(env, {
    username: admin.username,
    action: 'create_role',
    targetRef: roleName,
    details: { permissions },
    result: 'success',
    ip,
    userAgent,
  });
  return { status: 'ok', message: 'สร้างบทบาทสำเร็จ', role: { roleName, permissions } };
}
