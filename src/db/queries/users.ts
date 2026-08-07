import { TABLES } from '../../constants';
import { PublicUser, User } from '../../types';

export function getUserByUsername(db: D1Database, username: string): Promise<User | null> {
  return db.prepare(
    `SELECT username, password, role, displayName, createdAt, passwordMigrated
     FROM ${TABLES.users} WHERE lower(username) = lower(?) LIMIT 1`
  ).bind(username).first<User>();
}

export function getAllUsers(db: D1Database): Promise<PublicUser[]> {
  return db.prepare(
    `SELECT username, role, displayName, createdAt FROM ${TABLES.users} ORDER BY rowid`
  ).all<PublicUser>().then(res => (res.results ?? []).map(u => ({
    username: u.username,
    role: u.role,
    displayName: u.displayName || u.username,
    createdAt: u.createdAt,
  })));
}

export function createUser(
  db: D1Database,
  u: { username: string; password: string; role: string; displayName: string; createdAt: string }
): Promise<void> {
  return db.prepare(
    `INSERT INTO ${TABLES.users} (username, password, role, displayName, createdAt, passwordMigrated)
     VALUES (?, ?, ?, ?, ?, 'FALSE')`
  ).bind(u.username, u.password, u.role, u.displayName, u.createdAt).run().then(() => undefined);
}

export function updateUserColumns(
  db: D1Database,
  username: string,
  cols: Array<[string, unknown]>
): Promise<void> {
  if (cols.length === 0) return Promise.resolve();
  const setSql = cols.map(([c]) => `${c} = ?`).join(', ');
  return db.prepare(
    `UPDATE ${TABLES.users} SET ${setSql} WHERE lower(username) = lower(?)`
  ).bind(...cols.map(([, v]) => v), username).run().then(() => undefined);
}

export function deleteUser(db: D1Database, username: string): Promise<void> {
  return db.prepare(`DELETE FROM ${TABLES.users} WHERE lower(username) = lower(?)`).bind(username).run().then(() => undefined);
}

export function userExists(db: D1Database, username: string): Promise<boolean> {
  return db.prepare(`SELECT 1 FROM ${TABLES.users} WHERE lower(username) = lower(?)`)
    .bind(username).first().then(r => !!r);
}
