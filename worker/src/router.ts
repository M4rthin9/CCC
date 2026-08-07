import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import type { Env, UserRow } from './types';
import { parseCookie, findSessionUser, deleteSession, clearSessionCookieHeader, SESSION_COOKIE } from './auth/session';
import { hasPermission, clientIp, clientUa } from './auth/guard';
import { ensureSeeded, handleLogin, handleChangePassword, createUser, updateUser, deleteUser, listUsers } from './services/users';
import { getRolesList, createRole } from './services/roles';
import { getAdminSettings, saveAdminSettings } from './services/settings';
import {
  getAllReservationsWithArchive,
  getArchivedReservations,
  getCountsByDate,
  lookupByRef,
  saveReservation,
  cancelBooking,
  updateStatus,
  updateVisitorApproval,
  updateSlipAndStatus,
  updateBooking,
  dedupeReservations,
  findDuplicateBookings,
} from './services/bookings';
import { getPrisoners, recheckPrisoner, importPrisoners, syncPrisonerWings } from './services/prisoners';
import { addNote, getNotes } from './services/notes';
import { getEventLogs, logClientEvent } from './services/eventlog';
import { getDataVersion } from './services/version';
import { uploadSlip, readSlip } from './services/slips';
import { countsByDate, funnel, revenue } from './services/reports';
import { verifyTurnstileToken } from './router/turnstile';
import { ok, error, notFound, unauthorized } from './lib/resp';

type Variables = { user: UserRow };
type App = Hono<{ Bindings: Env; Variables: Variables }>;

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

async function readJson(c: AppContext): Promise<Record<string, unknown>> {
  const text = await c.req.text().catch(() => '');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const authMiddleware = async (c: App, next: () => Promise<void>) => {
  const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE);
  const found = await findSessionUser(c.env, token);
  if (!found) {
    return unauthorized();
  }
  c.set('user', found.user);
  await next();
};

const requirePermission = (perm: string, message?: string) => async (c: App, next: () => Promise<void>) => {
  const user = c.get('user');
  if (!user || !(await hasPermission(c.env, user, perm))) {
    return error(message || 'ไม่มีสิทธิ์ดำเนินการนี้', 403);
  }
  await next();
};

export function createRouter(): App {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use('*', async (c, next) => {
    await ensureSeeded(c.env).catch(() => undefined);
    await next();
  });
  app.use('*', compress());

  // ── Public endpoints ──
  app.get('/api/health/ping', (c) =>
    ok({ pong: true, timestamp: new Date().toISOString() }, { 'Cache-Control': 'public, max-age=60' }),
  );

  app.get('/api/health/test', async (c) => {
    await c.env.DB.prepare('SELECT 1').run();
    return ok({ message: 'Connected', timestamp: new Date().toISOString() });
  });

  app.get('/api/counts', async (c) => {
    const result = await getCountsByDate(c.env);
    return result.status === 'ok'
      ? ok(result, { 'Cache-Control': 'public, max-age=60' })
      : error(result.message);
  });

  app.get('/api/prisoners', async (c) => {
    const result = await getPrisoners(c.env);
    return ok(result, { 'Cache-Control': 'public, max-age=60' });
  });

  app.get('/api/bookings/lookup', async (c) => {
    const result = await lookupByRef(c.env, c.req.query() as unknown as Record<string, unknown>);
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.get('/api/notes/:ref', async (c) => {
    const result = await getNotes(c.env, { ref: c.req.param('ref') });
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c);
    const result = await handleLogin(c.env, body, clientIp(c), clientUa(c));
    if (result.setCookie) c.header('Set-Cookie', result.setCookie);
    return result.response.status === 'ok'
      ? ok(result.response as Record<string, unknown>)
      : error(String(result.response.message || 'Login failed'));
  });

  app.post('/api/bookings', async (c) => {
    const body = await readJson(c);
    const result = await saveReservation(c.env, body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.post('/api/bookings/:ref/public-cancel', async (c) => {
    const result = await cancelBooking(c.env, null, c.req.param('ref'), '', true, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.post('/api/bookings/:ref/slip-and-status', async (c) => {
    const body = await readJson(c);
    const result = await updateSlipAndStatus(c.env, null, c.req.param('ref'), body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.post('/api/slips/upload', async (c) => {
    const body = await readJson(c);
    const origin = new URL(c.req.url).origin;
    const result = await uploadSlip(c.env, body, origin, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result) : error(String(result.message || 'Upload failed'));
  });

  app.get('/api/slips/*', async (c) => {
    const path = new URL(c.req.url).pathname;
    const key = decodeURIComponent(path.slice('/api/slips/'.length));
    if (!key) return notFound('Slip not found');
    const resp = await readSlip(c.env, key);
    return resp || notFound('Slip not found');
  });

  app.post('/api/turnstile-verify', async (c) => {
    const body = await readJson(c);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token || token.length > 2048) {
      return new Response(JSON.stringify({ success: false, error: 'INVALID_TOKEN' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const okV = await verifyTurnstileToken(c.env, token, clientIp(c));
    if (okV) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: false, error: 'VERIFY_FAILED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  app.get('/api/realtime', async (c) => {
    const url = new URL(c.req.url);
    const room = url.searchParams.get('room') || 'public';
    if (room === 'admin') {
      const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE);
      const found = await findSessionUser(c.env, token);
      if (!found) return unauthorized();
    }
    const id = c.env.REALTIME_HUB.idFromName('hub');
    const stub = c.env.REALTIME_HUB.get(id);
    return stub.fetch(c.req.raw);
  });

  // ── Authenticated endpoints ──
  app.post('/api/auth/logout', authMiddleware, async (c) => {
    const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE);
    await deleteSession(c.env, token);
    c.header('Set-Cookie', clearSessionCookieHeader());
    return ok();
  });

  app.post('/api/auth/change-password', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const result = await handleChangePassword(c.env, user, body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message || 'Error'));
  });

  app.post('/api/bookings/:ref/cancel', authMiddleware, async (c) => {
    const body = await readJson(c);
    const result = await cancelBooking(
      c.env,
      c.get('user'),
      c.req.param('ref'),
      String(body.reason || ''),
      false,
      clientIp(c),
      clientUa(c),
    );
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.patch('/api/bookings/:ref/status', authMiddleware, async (c) => {
    const body = await readJson(c);
    const result = await updateStatus(
      c.env,
      c.get('user'),
      c.req.param('ref'),
      String(body.status || ''),
      String(body.reason || ''),
      clientIp(c),
      clientUa(c),
    );
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.patch('/api/bookings/:ref/approval', authMiddleware, async (c) => {
    const body = await readJson(c);
    const result = await updateVisitorApproval(c.env, c.get('user'), c.req.param('ref'), body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.put('/api/bookings/:ref', authMiddleware, async (c) => {
    const body = await readJson(c);
    body.ref = c.req.param('ref');
    const result = await updateBooking(c.env, c.get('user'), body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.post('/api/admin/bookings/dedupe', authMiddleware, async (c) => {
    const result = await dedupeReservations(c.env, c.get('user'), clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.post('/api/admin/bookings/find-duplicates', authMiddleware, async (c) => {
    const result = await findDuplicateBookings(c.env, c.get('user'));
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.get('/api/reservations', authMiddleware, async (c) => {
    const includeArchive = c.req.query('includeArchive') === 'true';
    const result = await getAllReservationsWithArchive(c.env, includeArchive);
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.get('/api/reservations/archived', authMiddleware, async (c) => {
    const q = c.req.query();
    const result = await getArchivedReservations(c.env, q.from || '', q.to || '');
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.get('/api/version', authMiddleware, async (c) => {
    const version = await getDataVersion(c.env);
    return ok({ version });
  });

  app.get('/api/roles', authMiddleware, async (c) => {
    const roles = await getRolesList(c.env);
    return ok({ roles });
  });

  app.post('/api/roles', authMiddleware, async (c) => {
    const result = await createRole(c.env, c.get('user'), await readJson(c), clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message));
  });

  app.get('/api/users', authMiddleware, async (c) => {
    const users = await listUsers(c.env);
    return ok({ users });
  });

  app.post('/api/users', authMiddleware, async (c) => {
    const result = await createUser(c.env, c.get('user'), await readJson(c), clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message));
  });

  app.patch('/api/users/:username', authMiddleware, async (c) => {
    const body = await readJson(c);
    if (!body.targetUser) body.targetUser = c.req.param('username');
    const result = await updateUser(c.env, c.get('user'), body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message));
  });

  app.delete('/api/users/:username', authMiddleware, async (c) => {
    const body = await readJson(c);
    if (!body.targetUser) body.targetUser = c.req.param('username');
    const result = await deleteUser(c.env, c.get('user'), body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message));
  });

  app.get('/api/settings', authMiddleware, async (c) => {
    const settings = await getAdminSettings(c.env);
    return ok({ settings });
  });

  app.put('/api/settings', authMiddleware, async (c) => {
    const body = await readJson(c);
    const settings = body.settings && typeof body.settings === 'object' ? (body.settings as Record<string, unknown>) : {};
    const result = await saveAdminSettings(c.env, c.get('user'), settings, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message));
  });

  app.post('/api/event-log/client', authMiddleware, async (c) => {
    const result = await logClientEvent(c.env, c.get('user'), await readJson(c), clientIp(c), clientUa(c));
    return ok(result);
  });

  app.get('/api/event-log', authMiddleware, async (c) => {
    const result = await getEventLogs(c.env, c.get('user'), c.req.query() as Record<string, string>);
    return result.status === 'ok' ? ok(result) : error(result.message);
  });

  app.post('/api/prisoners/import', authMiddleware, async (c) => {
    const result = await importPrisoners(c.env, c.get('user'), await readJson(c), clientIp(c), clientUa(c));
    return result.status === 'ok'
      ? ok(result as Record<string, unknown>)
      : error(String(result.message || 'Error'));
  });

  app.post('/api/prisoners/sync-wings', authMiddleware, async (c) => {
    const result = await syncPrisonerWings(c.env, c.get('user'), clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message));
  });

  app.get('/api/prisoners/:id/recheck', authMiddleware, async (c) => {
    const result = await recheckPrisoner(c.env, c.req.param('id'));
    return ok(result as Record<string, unknown>);
  });

  app.post('/api/notes/:ref', authMiddleware, async (c) => {
    const body = await readJson(c);
    body.ref = c.req.param('ref');
    const result = await addNote(c.env, c.get('user'), body, clientIp(c), clientUa(c));
    return result.status === 'ok' ? ok(result as Record<string, unknown>) : error(String(result.message));
  });

  app.get('/api/diagnostics', authMiddleware, async (c) => {
    const tables = ['users', 'roles', 'bookings', 'prisoners', 'notes', 'event_log', 'settings', 'sessions'];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const r = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first<{ c: number }>();
      counts[t] = r?.c ?? 0;
    }
    const version = await getDataVersion(c.env);
    return ok({ database: 'connected', tableCounts: counts, version, worker: 'cc-cafe-reservation-api' });
  });

  app.get('/api/reports/counts-by-date', authMiddleware, async (c) => {
    const q = c.req.query();
    const result = await countsByDate(c.env, q.from || '', q.to || '');
    return ok(result as Record<string, unknown>);
  });

  app.get('/api/reports/funnel', authMiddleware, async (c) => {
    const result = await funnel(c.env);
    return ok(result as Record<string, unknown>);
  });

  app.get('/api/reports/revenue', authMiddleware, async (c) => {
    const q = c.req.query();
    const result = await revenue(c.env, q.from || '', q.to || '');
    return ok(result as Record<string, unknown>);
  });

  app.notFound((c) => {
    return notFound();
  });

  app.onError((err, c) => {
    console.error('Unhandled error: ' + String(err));
    return error('Server error: ' + String(err), 500);
  });

  return app;
}
