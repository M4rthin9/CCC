import { getSettings, saveSettings, getDataVersion } from '../db/queries/settings';
import { hasPermission } from '../db/queries/roles';
import { logEvent } from '../services/logger';
import { Env } from '../types';

export async function handleSaveSettings(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users'))) {
    return { status: 'error', message: 'ไม่มีสิทธิ์บันทึกตั้งค่า' };
  }

  const settings =
    body.settings && typeof body.settings === 'object' ? { ...(body.settings as Record<string, unknown>) } : {};
  settings._savedBy = user.username;
  settings._savedAt = new Date().toISOString();
  await saveSettings(env.DB, settings, user.username, new Date().toISOString());
  await logEvent(env, user.username, 'save_settings', '', settings, 'success');
  return { status: 'ok', message: 'บันทึกตั้งค่าสำเร็จ' };
}

export async function handleGetSettings(env: Env): Promise<Record<string, unknown>> {
  const settings = await getSettings(env.DB);
  return { status: 'ok', settings };
}

export async function handleGetDataVersion(env: Env): Promise<Record<string, unknown>> {
  const version = await getDataVersion(env.DB);
  return { status: 'ok', version };
}
