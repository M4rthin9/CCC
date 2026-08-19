import { LINE_CAP_SETTING_KEY, TABLES } from '../../constants';
import { Note } from '../../types';

export function addNote(
  db: D1Database,
  n: { ref: string; text: string; user: string; timestamp: string; createdAt: string }
): Promise<void> {
  return db
    .prepare(`INSERT INTO ${TABLES.notes} (ref, text, user, timestamp, createdAt) VALUES (?, ?, ?, ?, ?)`)
    .bind(n.ref, n.text, n.user, n.timestamp, n.createdAt)
    .run()
    .then(() => undefined);
}

export function getNotesByRef(db: D1Database, ref: string): Promise<Note[]> {
  return db
    .prepare(`SELECT ref, text, user, timestamp, createdAt FROM ${TABLES.notes} WHERE ref = ? ORDER BY rowid`)
    .bind(ref)
    .all<Note>()
    .then((res) => res.results ?? []);
}

export function getSettings(db: D1Database): Promise<Record<string, unknown>> {
  return db
    .prepare(`SELECT key, value FROM ${TABLES.settings} WHERE key = 'admin_settings'`)
    .first<{ value: string }>()
    .then((row) => {
      if (!row || !row.value) return {};
      try {
        const parsed = JSON.parse(row.value);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    });
}

export function saveSettings(db: D1Database, value: unknown, savedBy: string, savedAt: string): Promise<void> {
  return db
    .prepare(
      `INSERT INTO ${TABLES.settings} (key, value, savedBy, savedAt) VALUES ('admin_settings', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, savedBy = excluded.savedBy, savedAt = excluded.savedAt`
    )
    .bind(JSON.stringify(value), savedBy, savedAt)
    .run()
    .then(() => undefined);
}

// ── Change counters ────────────────────────────────────────────────
// 'data_version' is the global "something changed" counter the dashboard polls.
// Each scope also keeps its own counter under 'data_version:<scope>' so a client
// can refetch only the slice that moved instead of the whole reservation blob,
// and so the reservation cache guard is not invalidated by unrelated writes.

export const DATA_SCOPES = ['reservations', 'prisoners', 'users', 'roles', 'settings'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

const GLOBAL_VERSION_KEY = 'data_version';
const scopeKey = (scope: DataScope): string => GLOBAL_VERSION_KEY + ':' + scope;

function bumpStatement(db: D1Database, key: string): D1PreparedStatement {
  // Seed at a unix timestamp so a counter that is reset (or a fresh DB) can
  // never hand out a version number an old cached payload already carries.
  return db
    .prepare(
      `INSERT INTO ${TABLES.settings} (key, value, savedBy, savedAt) VALUES (?, ?, 'system', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), savedAt = excluded.savedAt`
    )
    .bind(key, String(Math.floor(Date.now() / 1000)), new Date().toISOString());
}

function parseVersion(value: unknown): number {
  return parseInt(String(value ?? ''), 10) || 0;
}

export function getDataVersion(db: D1Database): Promise<number> {
  return db
    .prepare(`SELECT value FROM ${TABLES.settings} WHERE key = ?`)
    .bind(GLOBAL_VERSION_KEY)
    .first<{ value: string }>()
    .then((r) => parseVersion(r?.value));
}

export function getScopeVersion(db: D1Database, scope: DataScope): Promise<number> {
  return db
    .prepare(`SELECT value FROM ${TABLES.settings} WHERE key = ?`)
    .bind(scopeKey(scope))
    .first<{ value: string }>()
    .then((r) => parseVersion(r?.value));
}

/** Global counter plus every scope counter, in a single D1 read (polled often). */
export function getAllDataVersions(db: D1Database): Promise<{ version: number; scopes: Record<string, number> }> {
  return db
    .prepare(`SELECT key, value FROM ${TABLES.settings} WHERE key = ? OR key LIKE ?`)
    .bind(GLOBAL_VERSION_KEY, GLOBAL_VERSION_KEY + ':%')
    .all<{ key: string; value: string }>()
    .then((res) => {
      const scopes: Record<string, number> = {};
      DATA_SCOPES.forEach((s) => (scopes[s] = 0));
      let version = 0;
      (res.results ?? []).forEach((row) => {
        if (row.key === GLOBAL_VERSION_KEY) version = parseVersion(row.value);
        else scopes[row.key.slice(GLOBAL_VERSION_KEY.length + 1)] = parseVersion(row.value);
      });
      return { version, scopes };
    });
}

/** Bump the scope counter and the global counter together. */
export function bumpDataVersion(db: D1Database, scope: DataScope): Promise<void> {
  return db.batch([bumpStatement(db, scopeKey(scope)), bumpStatement(db, GLOBAL_VERSION_KEY)]).then(() => undefined);
}

// default_accounts maps lowercase username -> hashed default password. When a
// stored hash matches, the user is forced to change password on next login.
// Mirrors the legacy DEFAULT_ACCOUNTS_JSON Script Property.
export function getDefaultAccountHashes(db: D1Database): Promise<Record<string, string>> {
  return db
    .prepare(`SELECT value FROM ${TABLES.settings} WHERE key = 'default_accounts'`)
    .first<{ value: string }>()
    .then((row) => {
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
  return db
    .prepare(
      `INSERT INTO ${TABLES.settings} (key, value, savedBy, savedAt) VALUES ('default_accounts', ?, 'migration', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(JSON.stringify(map), new Date().toISOString())
    .run()
    .then(() => undefined);
}

export function clearDefaultAccountFlag(db: D1Database, username: string): Promise<void> {
  return getDefaultAccountHashes(db).then(async (map) => {
    const key = String(username || '').toLowerCase();
    if (!map[key]) return;
    delete map[key];
    await setDefaultAccountHashes(db, map);
  });
}

export function getLineMonthlyCap(db: D1Database): Promise<number> {
  return db
    .prepare(`SELECT value FROM ${TABLES.settings} WHERE key = ?`)
    .bind(LINE_CAP_SETTING_KEY)
    .first<{ value: string }>()
    .then((r) => (r ? parseInt(r.value, 10) || 0 : 0));
}

export function setLineMonthlyCap(db: D1Database, cap: number): Promise<void> {
  return db
    .prepare(
      `INSERT INTO ${TABLES.settings} (key, value, savedBy, savedAt) VALUES (?, ?, 'system', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, savedAt = excluded.savedAt`
    )
    .bind(LINE_CAP_SETTING_KEY, String(cap), new Date().toISOString())
    .run()
    .then(() => undefined);
}
