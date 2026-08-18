import { Hono } from 'hono';
import { Env } from './types';
import { makeCorsHeaders, jsonResponse, getClientIp, getUserAgent } from './middleware/http';
import { resolveAuthUser } from './auth/middleware';
import { dispatchAction, RouteCtx } from './routes/dispatcher';
import { sanitizeStr } from './config';
import { cleanupExpiredDiscipline } from './services/disciplineService';
import { archiveOldReservations } from './services/archiveService';
import { deleteExpiredRefreshTokens } from './db/queries/refreshTokens';
import { handleHealthHtml, handleHealthJson } from './routes/health';
import { handleLineWebhook } from './routes/notifications';
import { processPendingNotifications } from './services/notifications';

const app = new Hono<{ Bindings: Env }>();

// ── CORS preflight ─────────────────────────────────────────────────
app.options('*', (c) => {
  const headers = makeCorsHeaders(c.req.raw, c.env);
  return new Response(null, { status: 204, headers });
});

// ── Legacy action dispatch (1:1 with the Apps Script GET_ROUTES/POST_ROUTES).
//    GET  /?action=...      (params in query string)
//    POST / {action, ...}   (JSON or form body; defaults to saveReservation)
async function runDispatch(
  request: Request,
  env: Env,
  isGet: boolean,
  body: Record<string, unknown>
): Promise<Response> {
  const ip = sanitizeStr(body.ip, 64) || getClientIp(request);
  const userAgent = sanitizeStr(body.userAgent, 500) || getUserAgent(request);

  const user = await resolveAuthUser(env, request, body);
  const ctx: RouteCtx = { env, request, body, user, ip, userAgent };

  const action = isGet ? String(body.action || '') : String(body.action || 'saveReservation');
  const response = await dispatchAction(ctx, action, isGet);
  const headers = makeCorsHeaders(request, env);
  Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
  return response;
}

// ── REST aliases (new-frontend friendly; the action protocol remains primary) ──
// GET aliases
app.get('/api/reservations', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'getAll', ...queryToBody(c.req.raw) })
);
app.get('/api/reservations/archive', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'getArchivedReservations', ...queryToBody(c.req.raw) })
);
app.get('/api/reservations/counts', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'getCountsByDate' }));
app.get('/api/lookup', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'lookupByRef', ...queryToBody(c.req.raw) })
);
app.get('/api/prisoners', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'getPrisoners' }));
app.get('/api/prisoners/recheck', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'recheckPrisoner', ...queryToBody(c.req.raw) })
);
app.get('/api/roles', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'getRoles' }));
app.get('/api/users', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'getUsers' }));
app.get('/api/eventlog', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'getEventLogs', ...queryToBody(c.req.raw) })
);
app.get('/api/settings', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'getSettings' }));
app.get('/api/public-settings', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'getPublicSettings' }));
app.get('/api/version', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'getDataVersion' }));
app.get('/api/ping', async (c) => runDispatch(c.req.raw, c.env, true, { action: 'ping' }));

// POST aliases
app.post('/api/login', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'login', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/refresh', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'refresh', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/reservations', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'saveReservation', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/reservations/cancel', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'publicCancelBooking', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/reservations/delete', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'deleteBooking', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/reservations/slip', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'uploadSlip', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/notes', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'addNote', ...(await bodyToObj(c.req.raw)) })
);
app.get('/api/promptpay/qr', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'generatePromptPayQr', ...queryToBody(c.req.raw) })
);
app.post('/api/promptpay/qr', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'generatePromptPayQr', ...(await bodyToObj(c.req.raw)) })
);
app.get('/api/promptpay/slip-verify', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'generateSlipVerifyQr', ...queryToBody(c.req.raw) })
);
app.post('/api/promptpay/slip-verify', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'generateSlipVerifyQr', ...(await bodyToObj(c.req.raw)) })
);

// ── Notifications (Web Push + LINE) ────────────────────────────────
app.post('/api/notify', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'notify', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/notify/subscribe', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'subscribe', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/notify/unsubscribe', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'unsubscribe', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/notify/processPending', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'processPendingNotifications', ...(await bodyToObj(c.req.raw)) })
);
app.get('/api/notify/settings', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'getNotificationSettings' })
);
app.post('/api/notify/settings', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'getNotificationSettings', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/notify/cap', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'setLineMonthlyCap', ...(await bodyToObj(c.req.raw)) })
);
app.get('/api/notify/logs', async (c) =>
  runDispatch(c.req.raw, c.env, true, { action: 'getNotificationLogs', ...queryToBody(c.req.raw) })
);
app.post('/api/notify/logs', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'getNotificationLogs', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/link-line', async (c) =>
  runDispatch(c.req.raw, c.env, false, { action: 'linkLine', ...(await bodyToObj(c.req.raw)) })
);
app.post('/api/line/webhook', async (c) => {
  const response = await handleLineWebhook(c.env, c.req.raw);
  const headers = makeCorsHeaders(c.req.raw, c.env);
  Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
  return response;
});

// ── Generic action-dispatch endpoints (POST / or /api with {action}) ──
app.post('/', async (c) => runDispatch(c.req.raw, c.env, false, await bodyToObj(c.req.raw)));
app.post('/api', async (c) => runDispatch(c.req.raw, c.env, false, await bodyToObj(c.req.raw)));

// ── Health check ───────────────────────────────────────────────────
app.get('/health', async (c) => {
  const html = await handleHealthHtml(c.env, c.req.raw);
  const headers = makeCorsHeaders(c.req.raw, c.env);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
});
app.get('/api/health', async (c) => {
  const data = await handleHealthJson(c.env, c.req.raw);
  return jsonResponse(data, 200, makeCorsHeaders(c.req.raw, c.env));
});

// ── Fallback: any GET carries ?action=… ──
app.get('*', async (c) => runDispatch(c.req.raw, c.env, true, queryToBody(c.req.raw)));

function queryToBody(request: Request): Record<string, unknown> {
  const url = new URL(request.url);
  const body: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) body[k] = v;
  return body;
}

async function bodyToObj(request: Request): Promise<Record<string, unknown>> {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return (await request.json().catch(() => ({}))) as Record<string, unknown>;
  }
  const form = await request.formData().catch(() => null);
  if (form) {
    const body: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) body[k] = v;
    return body;
  }
  return {};
}

// ── Error handler ─────────────────────────────────────────────────
app.onError((err, c) => {
  const headers = makeCorsHeaders(c.req.raw, c.env);
  console.error('[Error] ' + c.req.method + ' ' + new URL(c.req.url).pathname + ':', String(err.message || err));
  return jsonResponse({ status: 'error', message: 'Internal server error' }, 500, headers);
});

// ── Worker entry ──────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(event.cron, env));
  },
};

async function runCron(cron: string, env: Env): Promise<void> {
  try {
    if (cron === '0 17 * * *') {
      const result = await cleanupExpiredDiscipline(env);
      await deleteExpiredRefreshTokens(env);
      const notif = await processPendingNotifications(env);
      console.log('[Cron] discipline cleanup:', JSON.stringify(result));
      console.log('[Cron] notifications:', JSON.stringify(notif));
    } else if (cron === '15 17 1 */3 *') {
      const result = await archiveOldReservations(env);
      console.log('[Cron] archive:', JSON.stringify(result));
    } else {
      console.log('[Cron] unknown schedule:', cron);
    }
  } catch (e) {
    console.error('[Cron] error:', String(e));
  }
}
