import { TABLES } from '../../constants';
import { Note } from '../../types';

export function addNote(
  db: D1Database,
  n: { ref: string; text: string; user: string; timestamp: string; createdAt: string }
): Promise<void> {
  return db.prepare(
    `INSERT INTO ${TABLES.notes} (ref, text, user, timestamp, createdAt) VALUES (?, ?, ?, ?, ?)`
  ).bind(n.ref, n.text, n.user, n.timestamp, n.createdAt).run().then(() => undefined);
}

export function getNotesByRef(db: D1Database, ref: string): Promise<Note[]> {
  return db.prepare(
    `SELECT ref, text, user, timestamp, createdAt FROM ${TABLES.notes} WHERE ref = ? ORDER BY rowid`
  ).bind(ref).all<Note>().then(res => (res.results ?? []));
}

export function getSettings(db: D1Database): Promise<Record<string, unknown>> {
  return db.prepare(
    `SELECT key, value FROM ${TABLES.settings} WHERE key = 'admin_settings'`
  ).first<{ value: string }>().then(row => {
    if (!row || !row.value) return {};
    try {
      const parsed = JSON.parse(row.value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
}

export function saveSettings(
  db: D1Database,
  value: unknown,
  savedBy: string,
  savedAt: string
): Promise<void> {
  return db.prepare(
    `INSERT INTO ${TABLES.settings} (key, value, savedBy, savedAt) VALUES ('admin_settings', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, savedBy = excluded.savedBy, savedAt = excluded.savedAt`
  ).bind(JSON.stringify(value), savedBy, savedAt).run().then(() => undefined);
}

export function getDataVersion(db: D1Database): Promise<number> {
  return db.prepare(`SELECT value FROM ${TABLES.settings} WHERE key = 'data_version'`)
    .first<{ value: string }>().then(r => (r ? parseInt(r.value, 10) || 0 : 0));
}

export function bumpDataVersion(db: D1Database): Promise<void> {
  const current = Math.floor(Date.now() / 1000);
  return db.prepare(
    `INSERT INTO ${TABLES.settings} (key, value, savedBy, savedAt) VALUES ('data_version', ?, 'system', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
  ).bind(String(current), new Date().toISOString()).run().then(() => undefined);
}

// default_accounts maps lowercase username -> hashed default password. When a
// stored hash matches, the user is forced to change password on next login.
// Mirrors the legacy DEFAULT_ACCOUNTS_JSON Script Property.
export function getDefaultAccountHashes(db: D1Database): Promise<Record<string, string>> {
  return db.prepare(`SELECT value FROM ${TABLES.settings} WHERE key = 'default_accounts'`)
    .first<{ value: string }>().then(row => {
      if (!row || !row.value) return {};
      try {
        const parsed = JSON.parse(row.value);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    });
}

export function setDefaultAccountHashes(db: D1Database, map: Record<string, string>): Promise<void> {
  return db.prepare(
    `INSERT INTO ${TABLES.settings} (key, value, savedBy, savedAt) VALUES ('default_accounts', ?, 'migration', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(JSON.stringify(map), new Date().toISOString()).run().then(() => undefined);
}

export function clearDefaultAccountFlag(db: D1Database, username: string): Promise<void> {
  return getDefaultAccountHashes(db).then(async map => {
    const key = String(username || '').toLowerCase();
    if (!map[key]) return;
    delete map[key];
    await setDefaultAccountHashes(db, map);
  });
}
