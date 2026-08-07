import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function publicBooking(): Record<string, unknown> {
  return {
    ref: 'VIS-12345',
    visitorName: 'ทดสอบ ผู้มาเยี่ยม',
    visitorId: '1100123456789',
    visitorPhone: '0812345678',
    relation: 'ภรรยา',
    religion: 'พุทธ',
    allergy: 'ไม่มี',
    visitorCount: 2,
    totalPersons: 2,
    total: 2000,
    adultCount: 2,
    child5to8Count: 0,
    childUnder5Count: 0,
    prisonerName: 'นักโทษทดสอบ',
    prisonerId: 'TEST-001',
    wing: 'แดน 1',
    visitDate: '15 สิงหาคม 2026',
    visitDateISO: '2026-08-15',
    status: 'รอตรวจสอบผู้เข้าร่วม',
  };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch('https://example.com' + path, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch('https://example.com' + path, { headers });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function login(username: string, password: string): Promise<{ res: Response; cookie: string }> {
  const res = await post('/api/auth/login', { username, password });
  const setCookie = res.headers.get('set-cookie') || '';
  return { res, cookie: setCookie.split(';')[0] };
}

let adminCookie = '';

beforeEach(async () => {
  adminCookie = '';
});

afterEach(async () => {
  if (adminCookie) {
    await post('/api/auth/logout', {}, { cookie: adminCookie }).catch(() => undefined);
  }
  // Reset the database between tests for deterministic results.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM bookings'),
    env.DB.prepare('DELETE FROM prisoners'),
    env.DB.prepare('DELETE FROM notes'),
    env.DB.prepare('DELETE FROM event_log'),
    env.DB.prepare("DELETE FROM settings WHERE key NOT IN ('admin_settings', 'seed_users')"),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare("UPDATE meta SET value = '0' WHERE key = 'version'"),
  ]);
});

describe('public endpoints', () => {
  it('pings', async () => {
    const res = await get('/api/health/ping');
    const body = await readJson(res);
    expect(res.status).toBe(200);
    expect(body.pong).toBe(true);
  });

  it('tests DB connectivity', async () => {
    const res = await get('/api/health/test');
    expect((await readJson(res)).status).toBe('ok');
  });

  it('returns prisoners (seeded) and counts', async () => {
    const res = await get('/api/prisoners');
    const body = await readJson(res);
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.prisoners)).toBe(true);

    const counts = await readJson(await get('/api/counts'));
    expect(counts.status).toBe('ok');
  });

  it('saves a booking and returns its ref', async () => {
    const res = await post('/api/bookings', publicBooking());
    const body = await readJson(res);
    expect(body.status).toBe('ok');
    expect(body.ref).toBe('VIS-12345');
  });

  it('rejects a duplicate booking for the same prisoner and date', async () => {
    await post('/api/bookings', publicBooking());
    const res = await post('/api/bookings', publicBooking());
    const body = await readJson(res);
    expect(body.status).toBe('error');
    expect(String(body.message)).toContain('ไม่สามารถจองได้');
  });

  it('generates a ref when none is provided', async () => {
    const booking = publicBooking();
    delete booking.ref;
    const res = await post('/api/bookings', booking);
    const body = await readJson(res);
    expect(body.status).toBe('ok');
    expect(String(body.ref)).toMatch(/^VIS-\d{5}$/);
  });

  it('looks up a booking without leaking private fields', async () => {
    await post('/api/bookings', publicBooking());
    const res = await get('/api/bookings/lookup?ref=vis-12345');
    const body = await readJson(res);
    expect(body.status).toBe('ok');
    const rows = body.rows as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0].ref).toBe('VIS-12345');
    expect(rows[0].visitorPhone).toBeUndefined();
    expect(rows[0].visitorId).toBeUndefined();
  });

  it('allows public cancellation', async () => {
    await post('/api/bookings', publicBooking());
    const res = await post('/api/bookings/VIS-12345/public-cancel', {});
    expect((await readJson(res)).status).toBe('ok');
    const lookup = await readJson(await get('/api/bookings/lookup?ref=VIS-12345'));
    const rows = lookup.rows as Record<string, unknown>[];
    expect(rows[0].status).toBe('ยกเลิก');
  });

  it('updates slip and status to paid', async () => {
    await post('/api/bookings', publicBooking());
    const res = await post('/api/bookings/VIS-12345/slip-and-status', { status: 'ชำระแล้ว', slipImage: 'https://example.com/slip.jpg' });
    expect((await readJson(res)).status).toBe('ok');
    const lookup = await readJson(await get('/api/bookings/lookup?ref=VIS-12345'));
    const rows = lookup.rows as Record<string, unknown>[];
    expect(rows[0].status).toBe('ชำระแล้ว');
    expect(rows[0].slipImage).toContain('example.com');
  });
});

describe('auth and admin', () => {
  it('rejects unauthenticated admin requests', async () => {
    const res = await get('/api/reservations');
    expect(res.status).toBe(401);
  });

  it('logs in a seeded superadmin and forces a password change', async () => {
    const { res, cookie } = await login('superadmin', 'initial-password');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('ok');
    expect(body.mustChangePassword).toBe(true);
    adminCookie = cookie;
  });

  it('changes password and logs in with the new one', async () => {
    const { cookie } = await login('superadmin', 'initial-password');
    const changeRes = await post('/api/auth/change-password', { newPassword: 'newpass123', confirmPassword: 'newpass123' }, { cookie });
    expect((await readJson(changeRes)).status).toBe('ok');

    const failRes = await login('superadmin', 'initial-password');
    expect((await readJson(failRes)).status).toBe('error');

    const okRes = await login('superadmin', 'newpass123');
    const body = await readJson(okRes);
    expect(body.status).toBe('ok');
    expect(body.mustChangePassword).toBe(false);
    adminCookie = okRes.headers.get('set-cookie')?.split(';')[0] || '';
  });

  it('gets reservations, version, roles, users and settings as admin', async () => {
    const { cookie } = await login('superadmin', 'initial-password');
    adminCookie = cookie;

    const reservations = await readJson(await get('/api/reservations', { cookie }));
    expect(reservations.status).toBe('ok');
    expect(Array.isArray(reservations.rows)).toBe(true);

    const version = await readJson(await get('/api/version', { cookie }));
    expect(typeof version.version).toBe('number');

    const roles = await readJson(await get('/api/roles', { cookie }));
    expect(roles.status).toBe('ok');
    expect(Array.isArray(roles.roles)).toBe(true);

    const users = await readJson(await get('/api/users', { cookie }));
    expect(users.status).toBe('ok');
    expect(Array.isArray(users.users)).toBe(true);

    const settings = await readJson(await get('/api/settings', { cookie }));
    expect(settings.status).toBe('ok');
  });

  it('bumps the version after a write', async () => {
    const { cookie } = await login('superadmin', 'initial-password');
    adminCookie = cookie;
    const before = (await readJson(await get('/api/version', { cookie }))).version as number;
    await post('/api/bookings', publicBooking());
    const after = (await readJson(await get('/api/version', { cookie }))).version as number;
    expect(after).toBe(before + 1);
  });

  it('enforces the status role matrix', async () => {
    await post('/api/bookings', publicBooking());
    const { cookie } = await login('superadmin', 'initial-password');
    adminCookie = cookie;

    // Finance may not set รอตรวจสอบวินัย
    const financeLogin = await login('finance1', 'initial-password');
    const financeCookie = financeLogin.cookie;
    await post('/api/auth/change-password', { newPassword: 'finpass123', confirmPassword: 'finpass123' }, { cookie: financeCookie });
    const finance = await login('finance1', 'finpass123');
    const finRes = await post('/api/bookings/VIS-12345/status', { status: 'รอตรวจสอบวินัย' }, { cookie: finance.cookie });
    const finBody = await readJson(finRes);
    expect(finBody.status).toBe('error');
    expect(String(finBody.message)).toContain('not allowed');

    // Superadmin may advance along the happy path
    const okRes = await post('/api/bookings/VIS-12345/status', { status: 'รอตรวจสอบวินัย' }, { cookie });
    expect((await readJson(okRes)).status).toBe('ok');
    const paidRes = await post('/api/bookings/VIS-12345/status', { status: 'รอชำระเงิน' }, { cookie });
    expect((await readJson(paidRes)).status).toBe('ok');
    const doneRes = await post('/api/bookings/VIS-12345/status', { status: 'ชำระแล้ว' }, { cookie });
    expect((await readJson(doneRes)).status).toBe('ok');
  });

  it('rejects invalid transitions', async () => {
    await post('/api/bookings', publicBooking());
    const { cookie } = await login('superadmin', 'initial-password');
    adminCookie = cookie;
    const res = await post('/api/bookings/VIS-12345/status', { status: 'ชำระแล้ว' }, { cookie });
    const body = await readJson(res);
    expect(body.status).toBe('error');
    expect(String(body.message)).toContain('Cannot change');
  });

  it('creates users, roles and logs events', async () => {
    const { cookie } = await login('superadmin', 'initial-password');
    adminCookie = cookie;

    const roleRes = await post('/api/roles', { roleName: 'TestRole', permissions: ['view_detail'] }, { cookie });
    expect((await readJson(roleRes)).status).toBe('ok');

    const userRes = await post('/api/users', { username: 'tester1', password: 'testpass123', role: 'TestRole', displayName: 'เทส' }, { cookie });
    expect((await readJson(userRes)).status).toBe('ok');

    const users = await readJson(await get('/api/users', { cookie }));
    const found = (users.users as { username: string; role: string }[]).find((u) => u.username === 'tester1');
    expect(found).toBeTruthy();
    expect(found?.role).toBe('TestRole');

    const logs = await readJson(await get('/api/event-log?action=create_user', { cookie }));
    expect(logs.status).toBe('ok');
    expect((logs.logs as unknown[]).length).toBeGreaterThan(0);
  });

  it('rejects non-superadmin user creation', async () => {
    await post('/api/auth/login', { username: 'finance1', password: 'initial-password' });
    const finance = await login('finance1', 'initial-password');
    await post('/api/auth/change-password', { newPassword: 'finpass123', confirmPassword: 'finpass123' }, { cookie: finance.cookie });
    const fin = await login('finance1', 'finpass123');
    const res = await post('/api/users', { username: 'x', password: 'testpass123', role: 'User' }, { cookie: fin.cookie });
    expect((await readJson(res)).status).toBe('error');
  });

  it('imports prisoners and syncs wings', async () => {
    const { cookie } = await login('superadmin', 'initial-password');
    adminCookie = cookie;

    const importRes = await post(
      '/api/prisoners/import',
      { prisoners: [{ prisonerId: 'P-100', prisonerName: 'นักโทษ 100', wing: 'แดน 2', status: '', vinaiDate: '' }] },
      { cookie },
    );
    const importBody = await readJson(importRes);
    expect(importBody.status).toBe('ok');
    expect(importBody.added).toBe(1);

    const syncRes = await post('/api/prisoners/sync-wings', {}, { cookie });
    const syncBody = await readJson(syncRes);
    expect(syncBody.status).toBe('ok');

    const prisoners = await readJson(await get('/api/prisoners'));
    expect((prisoners.prisoners as unknown[]).some((p) => String((p as string[])[1]) === 'P-100')).toBe(true);
  });

  it('runs reports and dedupe', async () => {
    await post('/api/bookings', publicBooking());
    const { cookie } = await login('superadmin', 'initial-password');
    adminCookie = cookie;

    const counts = await readJson(await get('/api/reports/counts-by-date?from=2026-08-01&to=2026-08-31', { cookie }));
    expect(counts.status).toBe('ok');

    const funnel = await readJson(await get('/api/reports/funnel', { cookie }));
    expect(funnel.status).toBe('ok');

    const revenue = await readJson(await get('/api/reports/revenue', { cookie }));
    expect(revenue.status).toBe('ok');

    const dedupe = await post('/api/admin/bookings/dedupe', {}, { cookie });
    const dedupeBody = await readJson(dedupe);
    expect(dedupeBody.status).toBe('ok');
  });
});
