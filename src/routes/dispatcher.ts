import { Env } from '../types';
import { AuthenticatedUser } from '../auth/middleware';
import { jsonResponse } from '../middleware/http';
import { checkRateLimit } from '../cache/kv';
import { rateLimitKey } from '../cache/keys';
import { logEvent } from '../services/logger';
import {
  handlePing,
  handleGetBackendUrl,
  handleResolveUrl,
  handleTestConnection,
  handleGetSheetInfo,
  handleSaveReservation,
  handleLookupByRef,
} from './public';
import {
  getAllReservations,
  getAllReservationsWithArchive,
  getArchivedReservationsHandler,
  getCountsByDate,
  handleDedupeReservations,
  handleFindDuplicateBookings,
  handleCancelBooking,
  handleDeleteBooking,
  handlePublicCancelBooking,
  handleUpdateStatus,
  handleUpdateVisitorApproval,
  handleUpdateBooking,
  handleCreateBooking,
  handleBulkBookingAction,
} from './reservations';
import { handleGetPrisoners, handleImportPrisoners, handleSyncPrisonerWings, handleRecheckPrisoner } from './prisoners';
import { getUsersHandler, handleCreateUser, handleUpdateUser, handleDeleteUser } from './users';
import { getRolesHandler, handleCreateRole } from './roles';
import { handleGetEventLogs, handleLogClientEvent } from './eventlog';
import { handleAddNote, handleGetNotes } from './notes';
import { handleSaveSettings, handleGetSettings, handleGetPublicSettings, handleGetDataVersion } from './settings';
import {
  handleUploadSlip,
  handleUpdateSlipAndStatus,
  handleGetSlipByRef,
  handleVerifySlip,
  handleReverifySlip,
} from './slip';
import { handleLogin, handleChangePassword, handleRefresh } from './auth';
import { handleGeneratePromptPayQr } from './promptpay';
import { handleGenerateSlipVerifyQr } from './slipQr';
import {
  handleNotify,
  handleLinkLine,
  handleSubscribe,
  handleUnsubscribe,
  getNotificationSettingsHandler,
  getPushPublicKeyHandler,
  setLineMonthlyCapHandler,
  getNotificationLogsHandler,
  processPendingHandler,
} from './notifications';

export interface RouteCtx {
  env: Env;
  request: Request;
  body: Record<string, unknown>;
  user: AuthenticatedUser | null;
  ip: string;
  userAgent: string;
  /** Lets a handler finish slow work after the response is sent. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type LegacyHandler = (ctx: RouteCtx) => Promise<Record<string, unknown>>;

interface Route {
  auth: boolean;
  handler: LegacyHandler;
  /**
   * Per-IP budget for actions that are reachable without a session.
   *
   * A booking ref is only `VIS-` plus five digits, so the unauthenticated
   * actions that take one are guessable by brute force. These budgets are far
   * above what a real visitor does (look up a booking, pay, maybe cancel) but
   * far below what enumerating a ~90k keyspace needs. Staff sessions are
   * exempt — a busy dashboard would otherwise trip them.
   */
  rateLimit?: { ns: string; max: number; ttl: number };
  /**
   * High-frequency pollers: an expired tab keeps calling these every few
   * seconds, so a denied attempt must not write an event-log row (that turned
   * one stale dashboard into hundreds of `unauthorized` entries).
   */
  quiet?: boolean;
}

// Public ref-taking actions: generous for humans, useless for enumeration.
const PUBLIC_REF_LIMIT = { max: 30, ttl: 60 };
// Slip handling decodes and scans images, so it is the expensive one.
const PUBLIC_SLIP_LIMIT = { max: 12, ttl: 60 };

function meta(ctx: RouteCtx) {
  return { ip: ctx.ip, userAgent: ctx.userAgent };
}

const GET_ROUTES: Record<string, Route> = {
  getBackendUrl: { auth: false, handler: async (ctx) => handleGetBackendUrl(ctx.request) },
  resolveUrl: { auth: false, handler: async (ctx) => handleResolveUrl(ctx.request) },
  getAll: { auth: true, handler: async (ctx) => getAllReservations(ctx.env) },
  getAllWithArchive: { auth: true, handler: async (ctx) => getAllReservationsWithArchive(ctx.env, ctx.body) },
  getCountsByDate: { auth: false, handler: async (ctx) => getCountsByDate(ctx.env) },
  lookupByRef: {
    auth: false,
    handler: async (ctx) => handleLookupByRef(ctx.env, ctx.body),
    rateLimit: { ns: 'lookup', ...PUBLIC_REF_LIMIT },
  },
  getSlipByRef: { auth: true, handler: async (ctx) => handleGetSlipByRef(ctx.env, ctx.body) },
  getArchivedReservations: { auth: true, handler: async (ctx) => getArchivedReservationsHandler(ctx.env, ctx.body) },
  getDataVersion: { auth: true, quiet: true, handler: async (ctx) => handleGetDataVersion(ctx.env) },
  getEventLogs: {
    auth: true,
    handler: async (ctx) =>
      handleGetEventLogs(ctx.env, ctx.body, { username: (ctx.body.username as string) || ctx.user?.username || '' }),
  },
  getPrisoners: { auth: false, handler: async (ctx) => handleGetPrisoners(ctx.env) },
  getRoles: { auth: true, handler: async (ctx) => getRolesHandler(ctx.env) },
  getUsers: { auth: true, handler: async (ctx) => getUsersHandler(ctx.env) },
  ping: { auth: false, handler: async () => handlePing() },
  testConnection: { auth: false, handler: async (ctx) => handleTestConnection(ctx.env) },
  getSheetInfo: { auth: true, handler: async (ctx) => handleGetSheetInfo(ctx.env) },
  getSettings: { auth: true, handler: async (ctx) => handleGetSettings(ctx.env) },
  getPublicSettings: { auth: false, handler: async (ctx) => handleGetPublicSettings(ctx.env) },
  getPushPublicKey: { auth: false, handler: async (ctx) => getPushPublicKeyHandler(ctx.env) },
  recheckPrisoner: { auth: true, handler: async (ctx) => handleRecheckPrisoner(ctx.env, ctx.body) },
  generatePromptPayQr: {
    auth: false,
    handler: async (ctx) => handleGeneratePromptPayQr(ctx.env, ctx.body, ctx.user, ctx.ip),
  },
  generateSlipVerifyQr: { auth: true, handler: async (ctx) => handleGenerateSlipVerifyQr(ctx.body) },
  verifySlip: {
    auth: false,
    handler: async (ctx) => handleVerifySlip(ctx.env, ctx.body),
    rateLimit: { ns: 'slipverify', ...PUBLIC_SLIP_LIMIT },
  },
  reverifySlip: {
    auth: true,
    handler: async (ctx) => handleReverifySlip(ctx.env, ctx.body, ctx.user?.username || ''),
  },
};

const POST_ROUTES: Record<string, Route> = {
  ping: { auth: false, handler: async () => handlePing() },
  login: { auth: false, handler: async (ctx) => handleLogin(ctx.env, ctx.body, meta(ctx)) },
  refresh: { auth: false, handler: async (ctx) => handleRefresh(ctx.env, ctx.body) },
  changePassword: {
    auth: false,
    handler: async (ctx) => handleChangePassword(ctx.env, ctx.body, ctx.user, meta(ctx)),
  },
  saveReservation: { auth: false, handler: async (ctx) => handleSaveReservation(ctx.env, ctx.body, meta(ctx)) },
  dedupeReservations: { auth: true, handler: async (ctx) => handleDedupeReservations(ctx.env, ctx.body, ctx.user!) },
  findDuplicateBookings: {
    auth: true,
    handler: async (ctx) => handleFindDuplicateBookings(ctx.env, ctx.body, ctx.user!),
  },
  getAll: { auth: true, handler: async (ctx) => getAllReservations(ctx.env) },
  getAllWithArchive: { auth: true, handler: async (ctx) => getAllReservationsWithArchive(ctx.env, ctx.body) },
  getCountsByDate: { auth: false, handler: async (ctx) => getCountsByDate(ctx.env) },
  lookupByRef: {
    auth: false,
    handler: async (ctx) => handleLookupByRef(ctx.env, ctx.body),
    rateLimit: { ns: 'lookup', ...PUBLIC_REF_LIMIT },
  },
  getSlipByRef: { auth: true, handler: async (ctx) => handleGetSlipByRef(ctx.env, ctx.body) },
  getArchivedReservations: { auth: true, handler: async (ctx) => getArchivedReservationsHandler(ctx.env, ctx.body) },
  getDataVersion: { auth: true, quiet: true, handler: async (ctx) => handleGetDataVersion(ctx.env) },
  publicCancelBooking: {
    auth: false,
    handler: async (ctx) => handlePublicCancelBooking(ctx.env, ctx.body),
    rateLimit: { ns: 'cancel', ...PUBLIC_REF_LIMIT },
  },
  uploadSlip: {
    auth: false,
    handler: async (ctx) => handleUploadSlip(ctx.env, ctx.body, ctx.waitUntil),
    rateLimit: { ns: 'slipupload', ...PUBLIC_SLIP_LIMIT },
  },
  updateSlipAndStatus: {
    auth: false,
    handler: async (ctx) =>
      handleUpdateSlipAndStatus(
        ctx.env,
        ctx.body,
        { username: ctx.user?.username || 'public' },
        !ctx.user,
        ctx.waitUntil
      ),
    rateLimit: { ns: 'slipstatus', ...PUBLIC_SLIP_LIMIT },
  },
  getNotes: {
    auth: false,
    handler: async (ctx) => handleGetNotes(ctx.env, ctx.body),
    rateLimit: { ns: 'notes', ...PUBLIC_REF_LIMIT },
  },
  cancelBooking: { auth: true, handler: async (ctx) => handleCancelBooking(ctx.env, ctx.body, ctx.user!) },
  deleteBooking: { auth: true, handler: async (ctx) => handleDeleteBooking(ctx.env, ctx.body, ctx.user!) },
  bulkBookingAction: { auth: true, handler: async (ctx) => handleBulkBookingAction(ctx.env, ctx.body, ctx.user!) },
  updateStatus: { auth: true, handler: async (ctx) => handleUpdateStatus(ctx.env, ctx.body, ctx.user!) },
  updateVisitorApproval: {
    auth: true,
    handler: async (ctx) => handleUpdateVisitorApproval(ctx.env, ctx.body, ctx.user!),
  },
  createBooking: { auth: true, handler: async (ctx) => handleCreateBooking(ctx.env, ctx.body, ctx.user!) },
  createUser: { auth: true, handler: async (ctx) => handleCreateUser(ctx.env, ctx.body, meta(ctx)) },
  createRole: { auth: true, handler: async (ctx) => handleCreateRole(ctx.env, ctx.body, ctx.user!) },
  updateUser: { auth: true, handler: async (ctx) => handleUpdateUser(ctx.env, ctx.body, ctx.user!) },
  deleteUser: { auth: true, handler: async (ctx) => handleDeleteUser(ctx.env, ctx.body, ctx.user!) },
  updateBooking: { auth: true, handler: async (ctx) => handleUpdateBooking(ctx.env, ctx.body, ctx.user!) },
  saveSettings: { auth: true, handler: async (ctx) => handleSaveSettings(ctx.env, ctx.body, ctx.user!) },
  getSettings: { auth: true, handler: async (ctx) => handleGetSettings(ctx.env) },
  addNote: { auth: true, handler: async (ctx) => handleAddNote(ctx.env, ctx.body, ctx.user!) },
  importPrisoners: { auth: true, handler: async (ctx) => handleImportPrisoners(ctx.env, ctx.body, ctx.user!) },
  syncPrisonerWings: { auth: true, handler: async (ctx) => handleSyncPrisonerWings(ctx.env, ctx.body, ctx.user!) },
  getUsers: { auth: true, handler: async (ctx) => getUsersHandler(ctx.env) },
  getRoles: { auth: true, handler: async (ctx) => getRolesHandler(ctx.env) },
  getEventLogs: { auth: true, handler: async (ctx) => handleGetEventLogs(ctx.env, ctx.body, ctx.user!) },
  recheckPrisoner: { auth: true, handler: async (ctx) => handleRecheckPrisoner(ctx.env, ctx.body) },
  logClientEvent: { auth: true, handler: async (ctx) => handleLogClientEvent(ctx.env, ctx.body, ctx.user!) },
  generatePromptPayQr: {
    auth: false,
    handler: async (ctx) => handleGeneratePromptPayQr(ctx.env, ctx.body, ctx.user, ctx.ip),
  },
  generateSlipVerifyQr: { auth: true, handler: async (ctx) => handleGenerateSlipVerifyQr(ctx.body) },
  verifySlip: {
    auth: false,
    handler: async (ctx) => handleVerifySlip(ctx.env, ctx.body),
    rateLimit: { ns: 'slipverify', ...PUBLIC_SLIP_LIMIT },
  },
  reverifySlip: {
    auth: true,
    handler: async (ctx) => handleReverifySlip(ctx.env, ctx.body, ctx.user?.username || ''),
  },
  subscribe: { auth: false, handler: async (ctx) => handleSubscribe(ctx.env, ctx.body) },
  unsubscribe: { auth: false, handler: async (ctx) => handleUnsubscribe(ctx.env, ctx.body) },
  linkLine: { auth: false, handler: async (ctx) => handleLinkLine(ctx.env, ctx.body) },
  notify: { auth: true, handler: async (ctx) => handleNotify(ctx.env, ctx.body) },
  getPushPublicKey: { auth: false, handler: async (ctx) => getPushPublicKeyHandler(ctx.env) },
  getNotificationSettings: { auth: true, handler: async (ctx) => getNotificationSettingsHandler(ctx.env) },
  setLineMonthlyCap: {
    auth: true,
    handler: async (ctx) => setLineMonthlyCapHandler(ctx.env, ctx.body, ctx.user!),
  },
  getNotificationLogs: { auth: true, handler: async (ctx) => getNotificationLogsHandler(ctx.env, ctx.body) },
  processPendingNotifications: {
    auth: true,
    handler: async (ctx) => processPendingHandler(ctx.env, ctx.user!),
  },
};

// ── Bulk fan-out ───────────────────────────────────────────────────
// Every action above is bulk-capable through the single `bulk` action, so a
// new capability gets batching for free — there is no per-action bulk handler
// to write or keep in sync.

/** Hard cap per request: keeps one Worker invocation inside its CPU budget
 *  and bounds the D1 write burst. */
const MAX_BULK_ITEMS = 50;

interface BulkItemResult {
  index: number;
  action: string;
  status: 'success' | 'error';
  message?: string;
  result?: Record<string, unknown>;
}

/** Items may arrive as an array or, on GET, as a JSON-encoded string. */
function parseBulkItems(raw: unknown): Record<string, unknown>[] | null {
  let list: unknown = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const out: Record<string, unknown>[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    out.push(item as Record<string, unknown>);
  }
  return out;
}

/**
 * Run any number of ordinary actions in one request.
 *
 *   POST / { action: 'bulk', status: 'อนุมัติ', items: [
 *     { action: 'updateStatus', ref: 'VIS-0001' },
 *     { action: 'updateStatus', ref: 'VIS-0002' },
 *   ] }
 *
 * Fields on the outer body are defaults for every item (`status` above); a
 * field on the item wins. Items may also nest their params under `params`.
 *
 * Items run sequentially: several handlers read-modify-write the same rows
 * (counts, dedupe, status history) and D1 gives us no transaction across
 * them, so parallel execution would race. Per-item failures are collected
 * rather than thrown — the caller gets a row-by-row report and an overall
 * `success` / `partial` / `error` status. Pass `stopOnError: true` to halt at
 * the first failure instead.
 *
 * Auth is enforced per item against the already-resolved caller, so a public
 * bulk can only reach public actions. Nested bulk is rejected.
 */
async function handleBulk(ctx: RouteCtx, isGet: boolean): Promise<Record<string, unknown>> {
  const items = parseBulkItems(ctx.body.items);
  if (!items) return { status: 'error', message: 'bulk requires an "items" array of objects' };
  if (items.length === 0) return { status: 'error', message: 'bulk requires at least one item' };
  if (items.length > MAX_BULK_ITEMS) {
    return { status: 'error', message: `bulk accepts at most ${MAX_BULK_ITEMS} items (got ${items.length})` };
  }

  // A GET bulk may only reach GET routes — batching must not become a way to
  // perform writes over GET.
  const routes = isGet ? GET_ROUTES : POST_ROUTES;
  const stopOnError = ctx.body.stopOnError === true || ctx.body.stopOnError === 'true';
  const { action: _action, items: _items, stopOnError: _stopOnError, ...defaults } = ctx.body;

  const results: BulkItemResult[] = [];
  let succeeded = 0;

  for (const [i, item] of items.entries()) {
    const name = String(item.action || '');
    const nested = item.params;
    const params =
      nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : item;

    const reject = (message: string) => results.push({ index: i, action: name, status: 'error', message });

    if (name === 'bulk') reject('Nested bulk is not allowed');
    else if (!routes[name]) reject('Unknown action');
    else if (routes[name].auth && !ctx.user) reject('Unauthorized');
    else {
      try {
        const result = await routes[name].handler({ ...ctx, body: { ...defaults, ...params, action: name } });
        if (result.status === 'error') {
          results.push({
            index: i,
            action: name,
            status: 'error',
            message: String(result.message || 'Failed'),
            result,
          });
        } else {
          succeeded++;
          results.push({ index: i, action: name, status: 'success', result });
        }
      } catch (e) {
        console.error('[Bulk:' + name + ']', String(e));
        reject('Server error');
      }
    }

    if (stopOnError && results[results.length - 1]?.status === 'error') break;
  }

  const failed = results.length - succeeded;
  const status = failed === 0 ? 'success' : succeeded > 0 ? 'partial' : 'error';
  await logEvent(
    ctx.env,
    ctx.user?.username || 'public',
    'bulk',
    '',
    { requested: items.length, processed: results.length, succeeded, failed },
    status,
    meta(ctx)
  );

  return { status, requested: items.length, processed: results.length, succeeded, failed, results };
}

GET_ROUTES.bulk = { auth: false, handler: async (ctx) => handleBulk(ctx, true) };
POST_ROUTES.bulk = { auth: false, handler: async (ctx) => handleBulk(ctx, false) };

export async function dispatchAction(ctx: RouteCtx, action: string, isGet: boolean): Promise<Response> {
  const routes = isGet ? GET_ROUTES : POST_ROUTES;
  const route = routes[action];
  if (!route) return jsonResponse({ status: 'error', message: 'Unknown action' });

  // Authenticated staff bypass the public budgets; everyone else is metered
  // per IP before the handler runs, so a rejected call costs no D1 work.
  if (route.rateLimit && !ctx.user) {
    const { ns, max, ttl } = route.rateLimit;
    const allowed = await checkRateLimit(ctx.env.CACHE_KV, rateLimitKey(ns, ctx.ip), max, ttl);
    if (!allowed) {
      await logEvent(
        ctx.env,
        'public',
        action,
        (ctx.body.ref as string) || '',
        { reason: 'rate_limited', ip: ctx.ip },
        'denied',
        meta(ctx)
      );
      return jsonResponse({ status: 'error', message: 'มีการเรียกใช้งานถี่เกินไป กรุณารอสักครู่' });
    }
  }

  if (route.auth && !ctx.user) {
    if (!route.quiet) {
      await logEvent(
        ctx.env,
        (ctx.body.username as string) || 'unknown',
        action,
        (ctx.body.ref as string) || '',
        { reason: 'unauthorized' },
        'denied',
        meta(ctx)
      );
    }
    return jsonResponse({ status: 'error', message: 'Unauthorized' });
  }

  try {
    const result = await route.handler(ctx);
    return jsonResponse(result);
  } catch (e) {
    console.error('[Dispatch:' + action + ']', String(e));
    await logEvent(
      ctx.env,
      ctx.user?.username || 'system',
      action + '_error',
      (ctx.body.ref as string) || '',
      { error: String(e) },
      'error',
      meta(ctx)
    );
    return jsonResponse({ status: 'error', message: 'Server error' });
  }
}
