import { getSettings, saveSettings, bumpDataVersion } from '../db/queries/settings';
import { hasPermission } from '../db/queries/roles';
import { applyFrontendChanges } from '../services/frontendContent';
import { logEvent } from '../services/logger';
import type { Env } from '../types';

export async function handleSaveFrontendContent(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string }
): Promise<Record<string, unknown>> {
  if (!(await hasPermission(env.DB, user.username, 'manage_users')))
    return { status: 'error', message: 'ไม่มีสิทธิ์แก้ไขเว็บไซต์' };
  const settings = await getSettings(env.DB);
  let frontendContent;
  try {
    frontendContent = applyFrontendChanges(settings.frontendContent, body.changes);
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'ข้อความไม่ถูกต้อง' };
  }
  const savedAt = new Date().toISOString();
  await saveSettings(
    env.DB,
    { ...settings, frontendContent, _savedBy: user.username, _savedAt: savedAt },
    user.username,
    savedAt
  );
  await bumpDataVersion(env.DB, 'settings');
  await logEvent(
    env,
    user.username,
    'save_frontend_content',
    '',
    { languages: Object.keys(frontendContent) },
    'success'
  );
  return { status: 'ok', frontendContent, savedAt };
}
