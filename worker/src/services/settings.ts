import type { Env, UserRow } from '../types';
import { logEvent } from '../db/db';
import { hasPermission } from '../auth/guard';

export async function getSettingsValue(env: Env, key: string): Promise<unknown | null> {
  const row = await env.DB.prepare('SELECT value_json FROM settings WHERE key = ?').bind(key).first<{ value_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

export async function saveSettingsValue(env: Env, key: string, value: unknown, savedBy = ''): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value_json, saved_by, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, saved_by = excluded.saved_by, saved_at = excluded.saved_at',
  )
    .bind(key, JSON.stringify(value), savedBy, new Date().toISOString())
    .run();
}

export async function getAdminSettings(env: Env): Promise<Record<string, unknown>> {
  const value = await getSettingsValue(env, 'admin_settings');
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function getDefaultAccountHashes(env: Env): Promise<Record<string, string>> {
  const value = await getSettingsValue(env, 'seed_users');
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

export async function clearDefaultAccountFlag(env: Env, username: string): Promise<void> {
  const map = await getDefaultAccountHashes(env);
  const key = String(username || '').toLowerCase();
  if (map[key]) {
    delete map[key];
    await saveSettingsValue(env, 'seed_users', map);
  }
}

export async function saveAdminSettings(
  env: Env,
  user: UserRow,
  settings: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: string; message: string }> {
  if (!(await hasPermission(env, user, 'manage_users'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์บันทึกตั้งค่า' };
  }
  const settingsObj = settings && typeof settings === 'object' ? settings : {};
  settingsObj._savedBy = user.username;
  settingsObj._savedAt = new Date().toISOString();
  await saveSettingsValue(env, 'admin_settings', settingsObj, user.username);
  await logEvent(env, {
    username: user.username,
    action: 'save_settings',
    targetRef: '',
    details: settingsObj,
    result: 'success',
    ip,
    userAgent,
  });
  return { status: 'ok', message: 'บันทึกตั้งค่าสำเร็จ' };
}
