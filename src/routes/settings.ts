import { getSettings, saveSettings, getAllDataVersions, bumpDataVersion } from '../db/queries/settings';
import { hasPermission } from '../db/queries/roles';
import { logEvent } from '../services/logger';
import { getTableBookingConfig } from '../services/tableCapacity';
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
  await bumpDataVersion(env.DB, 'settings');
  await logEvent(env, user.username, 'save_settings', '', settings, 'success');
  return { status: 'ok', message: 'บันทึกตั้งค่าสำเร็จ' };
}

export async function handleGetSettings(env: Env): Promise<Record<string, unknown>> {
  const settings = await getSettings(env.DB);
  return { status: 'ok', settings };
}

/**
 * Payment window flag, resolved from the `payment` key of admin_settings.
 * Defaults to OPEN: a missing or malformed key must never stop people paying.
 */
export async function readPaymentSwitch(env: Env): Promise<{ enabled: boolean; closedMessage: string }> {
  const settings = await getSettings(env.DB);
  const raw = (settings as Record<string, unknown>).payment;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: true, closedMessage: '' };
  const p = raw as Record<string, unknown>;
  return {
    enabled: p.enabled !== false,
    closedMessage: typeof p.closedMessage === 'string' ? p.closedMessage.slice(0, 500) : '',
  };
}

/**
 * Public, unauthenticated read of the handful of settings the booking site needs.
 * Only the payment fields are exposed — admin_settings also holds the PromptPay
 * biller config and default account hashes, which must never leak.
 */
export async function handleGetPublicSettings(env: Env): Promise<Record<string, unknown>> {
  const payment = await readPaymentSwitch(env);
  // The table-booking knobs are not secrets — the booking page needs them to draw
  // the calendar and to tell the visitor how long their slot is held.
  const tableBooking = await getTableBookingConfig(env);
  return {
    status: 'ok',
    paymentEnabled: payment.enabled,
    paymentClosedMessage: payment.closedMessage,
    tableBooking,
  };
}

// Polled by the dashboard on a short interval to drive live updates. One D1 read,
// no KV, no cache — `version` moves on any write, and `scopes` tells the client
// which slice changed so it can refetch just that one instead of the whole list.
export async function handleGetDataVersion(env: Env): Promise<Record<string, unknown>> {
  const { version, scopes } = await getAllDataVersions(env.DB);
  return { status: 'ok', version, scopes, serverTime: new Date().toISOString() };
}
