import { Env } from '../types';
import { cacheGet, cachePut, cacheRemove } from '../cache/kv';
import { signAccessToken, verifyAccessToken } from '../auth/jwt';

const SERVICE_NAME = 'ccc-backend';
const SERVICE_VERSION = '1.0.0';

let START_TIME = 0;
function startMs(): number {
  if (!START_TIME) START_TIME = Date.now();
  return START_TIME;
}

const TABLES = ['reservations', 'reservations_archive', 'prisoners', 'users', 'roles', 'event_log', 'notes', 'settings'];

interface HealthItem {
  ok: boolean;
  status: 'ok' | 'warn' | 'error';
  label: string;
  detail?: string;
}

async function tableCounts(env: Env): Promise<Array<{ name: string; rows: number }>> {
  const out: Array<{ name: string; rows: number }> = [];
  for (const t of TABLES) {
    const r = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${t}`).first<{ c: number }>();
    out.push({ name: t, rows: r ? Number(r.c) : 0 });
  }
  return out;
}

export async function handleHealthJson(env: Env, request: Request): Promise<Record<string, unknown>> {
  const checks: HealthItem[] = [];
  const colo = ((request as { cf?: Record<string, unknown> }).cf ?? {}).colo ?? null;
  const coloName = colo ? String(colo) : null;

  // D1
  try {
    const v = await env.DB.prepare('SELECT 1 as v').first<{ v: number }>();
    checks.push({ ok: v !== null, status: v !== null ? 'ok' : 'error', label: 'D1 database', detail: v !== null ? 'query ok' : 'no response' });
  } catch (e) {
    checks.push({ ok: false, status: 'error', label: 'D1 database', detail: String(e) });
  }

  // KV roundtrip
  try {
    const probe = '__health:probe:' + Date.now();
    await cachePut(env.CACHE_KV, probe, 'ok', 60);
    const got = await cacheGet(env.CACHE_KV, probe);
    await cacheRemove(env.CACHE_KV, probe);
    if (got === 'ok') {
      checks.push({ ok: true, status: 'ok', label: 'KV cache', detail: 'write/read/delete roundtrip ok' });
    } else {
      checks.push({ ok: false, status: 'error', label: 'KV cache', detail: 'roundtrip mismatch (got ' + String(got) + ')' });
    }
  } catch (e) {
    checks.push({ ok: false, status: 'error', label: 'KV cache', detail: String(e) });
  }

  // JWT
  const jwtSecret = env.JWT_SECRET || '';
  if (!jwtSecret) {
    checks.push({ ok: false, status: 'warn', label: 'JWT_SECRET', detail: 'not set — login will fail. Run: wrangler secret put JWT_SECRET' });
  } else {
    try {
      const token = await signAccessToken(jwtSecret, { username: 'health', role: 'Health', displayName: 'Health Check' });
      const verified = await verifyAccessToken(jwtSecret, token);
      checks.push({ ok: verified !== null, status: verified !== null ? 'ok' : 'error', label: 'JWT (access token)', detail: verified !== null ? 'sign/verify roundtrip ok' : 'verify failed' });
    } catch (e) {
      checks.push({ ok: false, status: 'error', label: 'JWT (access token)', detail: String(e) });
    }
  }

  // Secrets
  checks.push({
    ok: !!env.JWT_REFRESH_SECRET,
    status: env.JWT_REFRESH_SECRET ? 'ok' : 'warn',
    label: 'JWT_REFRESH_SECRET',
    detail: env.JWT_REFRESH_SECRET ? 'set' : 'not set',
  });
  checks.push({
    ok: !!env.TURNSTILE_SECRET,
    status: env.TURNSTILE_SECRET ? 'ok' : 'warn',
    label: 'TURNSTILE_SECRET',
    detail: env.TURNSTILE_SECRET ? 'set' : 'not set (public booking blocked)',
  });

  // Table counts
  let counts: Array<{ name: string; rows: number }> = [];
  try {
    counts = await tableCounts(env);
  } catch {
    // reported by the D1 check above
  }

  const url = new URL(request.url);
  const failing = checks.filter(c => c.status === 'error');

  return {
    status: failing.length === 0 ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    cacheVersion: env.CACHE_VERSION ?? '',
    region: coloName,
    uptimeSeconds: Math.floor((Date.now() - startMs()) / 1000),
    time: new Date().toISOString(),
    workerUrl: url.origin,
    checks,
    tables: counts,
  };
}

export async function handleHealthHtml(env: Env, request: Request): Promise<string> {
  const data = (await handleHealthJson(env, request)) as Record<string, unknown>;
  const checks = (data.checks ?? []) as HealthItem[];
  const tables = (data.tables ?? []) as Array<{ name: string; rows: number }>;
  const status = String(data.status);
  const overall = status === 'ok' ? 'OPERATIONAL' : 'DEGRADED';
  const overallColor = status === 'ok' ? '#22c55e' : '#f59e0b';

  const chip = (c: HealthItem): string => {
    const colors: Record<string, string> = {
      ok: '#22c55e',
      warn: '#f59e0b',
      error: '#ef4444',
    };
    return '<span class="chip" style="background:' + colors[c.status] + '">' + c.status.toUpperCase() + '</span>';
  };

  const checkRows = checks.map(c =>
    '<tr><td>' + chip(c) + '</td><td class="label">' + c.label + '</td><td>' + (c.detail ?? '') + '</td></tr>'
  ).join('');

  const tableRows = tables.map(t =>
    '<tr><td>' + t.name + '</td><td class="num">' + t.rows.toLocaleString() + '</td></tr>'
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccc-backend health</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px;
    background: #0b1220; color: #e2e8f0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 720px; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; }
  .overall { font-weight: 700; font-size: 14px; padding: 4px 10px; border-radius: 999px; }
  .meta { color: #64748b; font-size: 12px; margin: 6px 0 20px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
  th { color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .05em; }
  .chip { color: #04121a; font-weight: 700; font-size: 11px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .num { text-align: right; }
  .label { color: #e2e8f0; font-weight: 600; }
  .card { background: #111a2e; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .footer { color: #475569; font-size: 11px; margin-top: 12px; }
  button {
    background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px;
    padding: 8px 14px; font-family: inherit; font-size: 12px; cursor: pointer;
  }
  button:hover { background: #334155; }
  a { color: #7dd3fc; }
</style>
</head>
<body>
<main>
  <header>
    <h1>ccc-backend · health</h1>
    <span class="overall" style="background:${overallColor}">${overall}</span>
  </header>
  <div class="meta">
    worker: <a href="${data.workerUrl}">${data.workerUrl}</a><br>
    service ${data.service} v${data.version} · cache v${data.cacheVersion} · region: ${data.region ?? 'n/a'}<br>
    uptime ${data.uptimeSeconds}s · checked at ${String(data.time).replace('T', ' ').replace('Z', ' UTC')}
  </div>

  <div class="card">
    <h1 style="font-size:14px; margin:0 0 10px;">API checks</h1>
    <table><tbody>${checkRows}</tbody></table>
  </div>

  <div class="card">
    <h1 style="font-size:14px; margin:0 0 10px;">D1 table rows</h1>
    <table><tbody>${tableRows}</tbody></table>
  </div>

  <button onclick="location.reload()">Refresh now</button>
  <span class="footer" style="margin-left:10px">auto-refreshes every 15s</span>
  <div class="footer">JSON: <a href="/api/health">/api/health</a> · ping: <a href="/api/ping">/api/ping</a> · connection: <a href="/api/testConnection">/api/testConnection</a></div>
</main>
<script>
  setInterval(function () { fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
    var ok = !d.checks.some(function (c) { return c.status === 'error'; });
    var el = document.querySelector('.overall');
    el.textContent = ok ? 'OPERATIONAL' : 'DEGRADED';
    el.style.background = ok ? '#22c55e' : '#f59e0b';
  }).catch(function () {
    var el = document.querySelector('.overall');
    el.textContent = 'UNREACHABLE'; el.style.background = '#ef4444';
  }); }, 15000);
</script>
</body>
</html>`;
}
