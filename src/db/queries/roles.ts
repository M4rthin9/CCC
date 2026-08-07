import { AVAILABLE_PERMISSIONS, PERMISSIONS, TABLES } from '../../constants';
import { RolePermission } from '../../types';
import { getUserByUsername } from './users';

const PERMISSION_COLUMNS = AVAILABLE_PERMISSIONS as readonly string[];

export function getRoles(db: D1Database): Promise<RolePermission[]> {
  return db.prepare(
    `SELECT roleName, ${PERMISSION_COLUMNS.join(', ')} FROM ${TABLES.roles}`
  ).all<Record<string, unknown>>().then(res => {
    const out: RolePermission[] = [];
    for (const r of res.results ?? []) {
      const permissions: string[] = [];
      for (const col of PERMISSION_COLUMNS) {
        const v = r[col];
        if (v === 1 || v === true || String(v).toUpperCase() === 'TRUE') {
          permissions.push(col);
        }
      }
      out.push({ roleName: String(r.roleName), permissions });
    }
    return out;
  });
}

export async function getValidRoleNames(db: D1Database): Promise<string[]> {
  const names = Object.keys(PERMISSIONS);
  const roles = await getRoles(db);
  for (const r of roles) {
    if (!names.some(n => n.toLowerCase() === String(r.roleName).toLowerCase())) {
      names.push(String(r.roleName));
    }
  }
  return names;
}

export async function isValidRoleName(db: D1Database, role: string): Promise<boolean> {
  const names = await getValidRoleNames(db);
  return names.some(n => n.toLowerCase() === String(role).toLowerCase());
}

export function roleExists(db: D1Database, roleName: string): Promise<boolean> {
  return db.prepare(`SELECT 1 FROM ${TABLES.roles} WHERE lower(roleName) = lower(?)`)
    .bind(roleName).first().then(r => !!r);
}

export function createRole(db: D1Database, roleName: string, permissions: string[]): Promise<void> {
  const cols = ['roleName', ...PERMISSION_COLUMNS];
  const values = [roleName, ...PERMISSION_COLUMNS.map(p => permissions.includes(p) ? 1 : 0)];
  return db.prepare(
    `INSERT INTO ${TABLES.roles} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).bind(...values).run().then(() => undefined);
}

export async function hasPermission(
  db: D1Database,
  username: string,
  perm: string
): Promise<boolean> {
  const user = await getUserByUsername(db, username);
  if (!user) return false;
  const builtIn = PERMISSIONS[user.role as keyof typeof PERMISSIONS];
  if (builtIn && (builtIn as readonly string[]).includes(perm)) return true;
  try {
    const roles = await getRoles(db);
    const roleEntry = roles.find(r => String(r.roleName).toLowerCase() === String(user.role).toLowerCase());
    if (roleEntry && Array.isArray(roleEntry.permissions)) {
      return roleEntry.permissions.includes(perm);
    }
  } catch {
    // ignore — fall back to false
  }
  return false;
}
