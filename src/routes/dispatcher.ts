import { Env } from '../types';
import { AuthenticatedUser } from '../auth/middleware';
import { jsonResponse } from '../middleware/http';
import { logEvent } from '../services/logger';
import {
  handlePing, handleGetBackendUrl, handleResolveUrl, handleTestConnection,
  handleGetSheetInfo, handleSaveReservation, handleLookupByRef
} from './public';
import {
  getAllReservations, getAllReservationsWithArchive, getArchivedReservationsHandler,
  getCountsByDate, handleDedupeReservations, handleFindDuplicateBookings,
  handleCancelBooking, handlePublicCancelBooking, handleUpdateStatus,
  handleUpdateVisitorApproval, handleUpdateBooking
} from './reservations';
import {
  handleGetPrisoners, handleImportPrisoners, handleSyncPrisonerWings, handleRecheckPrisoner
} from './prisoners';
import { getUsersHandler, handleCreateUser, handleUpdateUser, handleDeleteUser } from './users';
import { getRolesHandler, handleCreateRole } from './roles';
import { handleGetEventLogs, handleLogClientEvent } from './eventlog';
import { handleAddNote, handleGetNotes } from './notes';
import { handleSaveSettings, handleGetSettings, handleGetDataVersion } from './settings';
import { handleUploadSlip, handleUpdateSlipAndStatus } from './slip';
import { handleLogin, handleChangePassword, handleRefresh } from './auth';

export interface RouteCtx {
  env: Env;
  request: Request;
  body: Record<string, unknown>;
  user: AuthenticatedUser | null;
  ip: string;
  userAgent: string;
}

export type LegacyHandler = (ctx: RouteCtx) => Promise<Record<string, unknown>>;

interface Route {
  auth: boolean;
  handler: LegacyHandler;
}

function meta(ctx: RouteCtx) {
  return { ip: ctx.ip, userAgent: ctx.userAgent };
}

const GET_ROUTES: Record<string, Route> = {
  getBackendUrl: { auth: false, handler: async (ctx) => handleGetBackendUrl(ctx.request) },
  resolveUrl: { auth: false, handler: async (ctx) => handleResolveUrl(ctx.request) },
  getAll: { auth: true, handler: async (ctx) => getAllReservations(ctx.env) },
  getAllWithArchive: { auth: true, handler: async (ctx) => getAllReservationsWithArchive(ctx.env, ctx.body) },
  getCountsByDate: { auth: false, handler: async (ctx) => getCountsByDate(ctx.env) },
  lookupByRef: { auth: false, handler: async (ctx) => handleLookupByRef(ctx.env, ctx.body) },
  getArchivedReservations: { auth: true, handler: async (ctx) => getArchivedReservationsHandler(ctx.env, ctx.body) },
  getDataVersion: { auth: true, handler: async (ctx) => handleGetDataVersion(ctx.env) },
  getEventLogs: { auth: true, handler: async (ctx) => handleGetEventLogs(ctx.env, ctx.body, { username: ctx.body.username as string || ctx.user?.username || '' }) },
  getPrisoners: { auth: false, handler: async (ctx) => handleGetPrisoners(ctx.env) },
  getRoles: { auth: true, handler: async (ctx) => getRolesHandler(ctx.env) },
  getUsers: { auth: true, handler: async (ctx) => getUsersHandler(ctx.env) },
  ping: { auth: false, handler: async () => handlePing() },
  testConnection: { auth: false, handler: async (ctx) => handleTestConnection(ctx.env) },
  getSheetInfo: { auth: true, handler: async (ctx) => handleGetSheetInfo(ctx.env) },
  getSettings: { auth: true, handler: async (ctx) => handleGetSettings(ctx.env) },
  recheckPrisoner: { auth: true, handler: async (ctx) => handleRecheckPrisoner(ctx.env, ctx.body) },
};

const POST_ROUTES: Record<string, Route> = {
  ping: { auth: false, handler: async () => handlePing() },
  login: { auth: false, handler: async (ctx) => handleLogin(ctx.env, ctx.body, meta(ctx)) },
  refresh: { auth: false, handler: async (ctx) => handleRefresh(ctx.env, ctx.body) },
  changePassword: { auth: false, handler: async (ctx) => handleChangePassword(ctx.env, ctx.body) },
  saveReservation: { auth: false, handler: async (ctx) => handleSaveReservation(ctx.env, ctx.body, meta(ctx)) },
  dedupeReservations: { auth: true, handler: async (ctx) => handleDedupeReservations(ctx.env, ctx.body, ctx.user!) },
  findDuplicateBookings: { auth: true, handler: async (ctx) => handleFindDuplicateBookings(ctx.env, ctx.body, ctx.user!) },
  getAll: { auth: true, handler: async (ctx) => getAllReservations(ctx.env) },
  getAllWithArchive: { auth: true, handler: async (ctx) => getAllReservationsWithArchive(ctx.env, ctx.body) },
  getCountsByDate: { auth: false, handler: async (ctx) => getCountsByDate(ctx.env) },
  lookupByRef: { auth: false, handler: async (ctx) => handleLookupByRef(ctx.env, ctx.body) },
  getArchivedReservations: { auth: true, handler: async (ctx) => getArchivedReservationsHandler(ctx.env, ctx.body) },
  getDataVersion: { auth: true, handler: async (ctx) => handleGetDataVersion(ctx.env) },
  publicCancelBooking: { auth: false, handler: async (ctx) => handlePublicCancelBooking(ctx.env, ctx.body) },
  uploadSlip: { auth: false, handler: async (ctx) => handleUploadSlip(ctx.env, ctx.body) },
  updateSlipAndStatus: { auth: false, handler: async (ctx) => handleUpdateSlipAndStatus(ctx.env, ctx.body, { username: ctx.user?.username || 'public' }) },
  getNotes: { auth: false, handler: async (ctx) => handleGetNotes(ctx.env, ctx.body) },
  cancelBooking: { auth: true, handler: async (ctx) => handleCancelBooking(ctx.env, ctx.body, ctx.user!) },
  updateStatus: { auth: true, handler: async (ctx) => handleUpdateStatus(ctx.env, ctx.body, ctx.user!) },
  updateVisitorApproval: { auth: true, handler: async (ctx) => handleUpdateVisitorApproval(ctx.env, ctx.body, ctx.user!) },
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
};

export async function dispatchAction(ctx: RouteCtx, action: string, isGet: boolean): Promise<Response> {
  const routes = isGet ? GET_ROUTES : POST_ROUTES;
  const route = routes[action];
  if (!route) return jsonResponse({ status: 'error', message: 'Unknown action' });

  if (route.auth && !ctx.user) {
    await logEvent(ctx.env, ctx.body.username as string || 'unknown', action, ctx.body.ref as string || '', { reason: 'unauthorized' }, 'denied', meta(ctx));
    return jsonResponse({ status: 'error', message: 'Unauthorized' });
  }

  try {
    const result = await route.handler(ctx);
    return jsonResponse(result);
  } catch (e) {
    await logEvent(ctx.env, ctx.user?.username || 'system', action + '_error', ctx.body.ref as string || '', { error: String(e) }, 'error', meta(ctx));
    return jsonResponse({ status: 'error', message: 'Server error: ' + String(e) });
  }
}
