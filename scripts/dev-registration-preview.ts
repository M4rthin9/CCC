/** Local-only preview: real handlers, migrated in-memory SQLite, disposable fixtures. */
import { createServer } from 'node:http';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { hashPassword } from '../src/auth/password';
import { resolveAuthUser } from '../src/auth/middleware';
import { dispatchAction } from '../src/routes/dispatcher';
import { getReservationByRef } from '../src/db/queries/reservations';
import { attendanceGuests, attendanceToday, createEntryToken, entryBlockedReason } from '../src/services/attendance';
import { recordAttendance } from '../src/db/queries/attendance';
import { renderQr } from '../src/services/qrImage';
import type { Env } from '../src/types';

const api = 'http://127.0.0.1:18889';
const dashboard = 'http://127.0.0.1:18890';
const username = 'officer';
const password = 'Preview123!';
const sqlite = new DatabaseSync(':memory:');
for (const name of readdirSync('src/db/migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  sqlite.exec(readFileSync(`src/db/migrations/${name}`, 'utf8'));
}

function prepare(sql: string) {
  let args: SQLInputValue[] = [];
  const order: number[] = [];
  let next = 0;
  // D1 accepts numbered positional parameters; node:sqlite expects named bindings for those.
  const normalized = sql.replace(/\?(\d*)/g, (_match, number: string) => {
    const index = number ? Number(number) - 1 : next;
    next = Math.max(next, index + 1);
    order.push(index);
    return '?';
  });
  const values = () => order.map((index) => args[index] ?? null);
  const statement = {
    bind(...input: SQLInputValue[]) {
      args = input;
      return statement;
    },
    async first() {
      return sqlite.prepare(normalized).get(...values()) ?? null;
    },
    async all() {
      return { success: true, results: sqlite.prepare(normalized).all(...values()) };
    },
    execute() {
      const result = sqlite.prepare(normalized).run(...values());
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
    async run() {
      return statement.execute();
    },
  };
  return statement;
}
const env = {
  DB: {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
  JWT_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  JWT_REFRESH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  PASSWORD_SALT: 'local-registration-preview-only',
  CACHE_VERSION: 'local-registration-preview',
  NOTIFY_LINE_ENABLED: 'false',
  NOTIFY_PUSH_ENABLED: 'false',
  SLIP_OCR_ENABLED: 'false',
} as unknown as Env;
sqlite
  .prepare('INSERT INTO users (username, password, role, displayName, createdAt) VALUES (?, ?, ?, ?, ?)')
  .run(username, await hashPassword(env, username, password), 'Tadtel', 'เจ้าหน้าที่ทดสอบ', new Date().toISOString());
const today = attendanceToday();
const fixtureRefs = ['TBL-DEMO-001', 'TBL-DEMO-002', 'TBL-DEMO-003', 'TBL-DEMO-004', 'VIS-DEMO-001'];
const fixtureNotes: Record<string, string> = {
  'TBL-DEMO-001': 'ชำระเงินยืนยันแล้ว · รอลงทะเบียน 3 คน',
  'TBL-DEMO-002': 'ลงทะเบียนแล้ว 1 จาก 2 คน',
  'TBL-DEMO-003': 'ลงทะเบียนครบแล้ว 2 คน · ทดลองสแกนซ้ำได้',
  'TBL-DEMO-004': 'ชำระล่าช้า · ทดลองยืนยันเงินหลังส่งรายงาน',
  'VIS-DEMO-001': 'ตัวอย่างการจองเยี่ยมผู้ต้องขัง',
};
for (const [index, ref] of fixtureRefs.entries()) {
  const count = index === 0 ? 3 : 2;
  const extras = Array.from(
    { length: count - 1 },
    (_, i) => `ผู้ร่วมทดสอบ ${index + 1}.${i + 1}|DEMO-${index + 1}-${i + 1}|เพื่อน|30`
  ).join(';;');
  sqlite
    .prepare(
      `INSERT INTO reservations (ref, status, visitDateISO, visitorName, visitorId, visitorPhone,
    visitorApproved, extraVisitorNames, extraVisitorApproved, visitorCount, totalPersons, adultCount, total,
    bookingType, prisonerName, prisonerId, timestamp, createdAt, createdBy, source)
    VALUES (?, ?, ?, ?, ?, '0800000000', 'yes', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview', 'local-demo')`
    )
    .run(
      ref,
      index === 3 ? 'ชำระแล้ว' : 'เสร็จสิ้น',
      today,
      `ผู้จองทดสอบ ${index + 1}`,
      `DEMO-ID-${index + 1}`,
      extras,
      Array(count - 1)
        .fill('yes')
        .join(';;'),
      count,
      count + (index === 4 ? 1 : 0),
      count,
      (count + (index === 4 ? 1 : 0)) * 1000,
      index === 4 ? 'prisoner' : 'table',
      index === 4 ? 'ผู้ต้องขังทดสอบ' : '',
      index === 4 ? 'DEMO-PRISONER' : '',
      `${today} 08:00:00`,
      new Date().toISOString()
    );
}
for (const [ref, count] of [
  ['TBL-DEMO-002', 1],
  ['TBL-DEMO-003', 2],
] as const) {
  const booking = (await getReservationByRef(env.DB, ref))!;
  for (const guest of (await attendanceGuests(booking)).slice(0, count))
    await recordAttendance(env.DB, booking, guest, username);
}
const yesterday = new Date(`${today}T00:00:00Z`);
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
sqlite
  .prepare(
    `INSERT INTO reservations_archive (ref, status, visitDateISO, visitorName, visitorId,
  visitorApproved, visitorCount, totalPersons, adultCount, total, bookingType)
  VALUES ('TBL-DEMO-HISTORY', 'เสร็จสิ้น', ?, 'ผู้เข้าร่วมทดสอบย้อนหลัง', 'DEMO-HISTORY', 'yes', 1, 1, 1, 1000, 'table')`
  )
  .run(yesterday.toISOString().slice(0, 10));
const historyGuest = (
  await attendanceGuests({
    ref: 'TBL-DEMO-HISTORY',
    visitorName: 'ผู้เข้าร่วมทดสอบย้อนหลัง',
    visitorId: 'DEMO-HISTORY',
    visitorApproved: 'yes',
  })
)[0]!;
sqlite
  .prepare(
    'INSERT INTO visitor_attendance (ref, visitDateISO, guestKey, guestName, checkedInAt, checkedInBy) VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(
    'TBL-DEMO-HISTORY',
    yesterday.toISOString().slice(0, 10),
    historyGuest.guestKey,
    historyGuest.name,
    `${yesterday.toISOString().slice(0, 10)}T03:00:00Z`,
    username
  );

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
async function passesPage() {
  const cards: string[] = [];
  for (const ref of fixtureRefs) {
    const booking = (await getReservationByRef(env.DB, ref))!;
    let content = `<p>${escape(fixtureNotes[ref]!)}</p>`;
    if (!entryBlockedReason(booking)) {
      const payload = await createEntryToken(env.JWT_SECRET, booking);
      const { qrDataUrl } = await renderQr(payload);
      content += `<img src="${qrDataUrl}" width="260" height="260" alt="QR ทดสอบ ${ref}"><label>ข้อความ QR สำหรับคัดลอกไปวางที่เครื่องสแกน<textarea readonly rows="3">${escape(payload)}</textarea></label>`;
    } else {
      content +=
        '<form method="post" action="/fixtures/confirm-late-payment"><button>ยืนยันการชำระเงินล่าช้า (ข้อมูลทดสอบ)</button></form>';
    }
    cards.push(
      `<article><h2>${ref}</h2>${content}<small>ID ทดสอบ: ${escape(String(booking.visitorId))}</small></article>`
    );
  }
  return `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local preview · Test QR passes</title>
    <style>body{margin:0;background:#f1f5f9;color:#14283b;font:15px/1.8 system-ui,sans-serif}main{max-width:1120px;margin:32px auto;padding:0 20px}header{padding:22px;background:#0b1f33;color:white;border-radius:16px}a{color:#67d9ed}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-top:20px}article{background:white;border:1px solid #dce5ec;border-radius:14px;padding:22px}h1{font-size:24px}h2{font-size:17px}img{display:block;max-width:100%;height:auto;margin:18px auto}label{font-size:12px}textarea{display:block;box-sizing:border-box;width:100%;margin:8px 0 16px;border:1px solid #ccd8e2;border-radius:8px;padding:10px;font:11px monospace}button{padding:12px;border:0;border-radius:8px;background:#102e46;color:white;cursor:pointer}small{color:#63778b}</style>
    <main><header><h1>LOCAL DEVELOPMENT · ข้อมูลทดสอบเท่านั้น</h1><p>วันที่ ${today} · ไม่มีการเชื่อมต่อฐานข้อมูลจริง</p><p><a href="${dashboard}/#/registration" target="_blank" rel="noopener">เปิดหน้าลงทะเบียนเจ้าหน้าที่</a></p><p>Login: <b>${username}</b> / <b>${password}</b></p><p>เปิดหน้านี้อีกจอเพื่อสแกน QR หรือคัดลอกข้อความไปวางในช่องเครื่องสแกน การลงทะเบียนจะรีเซ็ตเมื่อเริ่ม API ใหม่</p></header><section>${cards.join('')}</section></main></html>`;
}

const allowedActions = new Set([
  'login',
  'refresh',
  'getAttendance',
  'checkVisitorEntry',
  'checkInVisitor',
  'getVisitorEntryQr',
  'ping',
]);
const origins = new Set([dashboard, 'http://localhost:18890', api]);
createServer(async (incoming, outgoing) => {
  const origin = incoming.headers.origin;
  if (origin && !origins.has(origin)) {
    outgoing.writeHead(403);
    outgoing.end();
    return;
  }
  if (origin) outgoing.setHeader('Access-Control-Allow-Origin', origin);
  outgoing.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  outgoing.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  outgoing.setHeader('Cache-Control', 'no-store');
  if (incoming.method === 'OPTIONS') {
    outgoing.writeHead(204);
    outgoing.end();
    return;
  }
  try {
    const url = new URL(incoming.url || '/', api);
    if (incoming.method === 'GET' && url.pathname === '/passes') {
      outgoing.setHeader('Content-Type', 'text/html; charset=utf-8');
      outgoing.end(await passesPage());
      return;
    }
    if (incoming.method === 'POST' && url.pathname === '/fixtures/confirm-late-payment') {
      sqlite
        .prepare("UPDATE reservations SET status = 'เสร็จสิ้น' WHERE ref = 'TBL-DEMO-004' AND status = 'ชำระแล้ว'")
        .run();
      outgoing.writeHead(303, { Location: '/passes' });
      outgoing.end();
      return;
    }
    if (incoming.method === 'GET' && url.pathname === '/health') {
      outgoing.setHeader('Content-Type', 'application/json');
      outgoing.end(JSON.stringify({ status: 'ok', mode: 'local-preview', date: today }));
      return;
    }
    if (incoming.method !== 'POST' || url.pathname !== '/') {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    let raw = '';
    for await (const chunk of incoming) {
      raw += String(chunk);
      if (raw.length > 65536) throw new Error('Preview request too large');
    }
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    const action = String(body.action || '');
    if (!allowedActions.has(action)) {
      outgoing.writeHead(400);
      outgoing.end('Action unavailable in local preview');
      return;
    }
    const request = new Request(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: incoming.headers.authorization || '' },
      body: raw,
    });
    const user = await resolveAuthUser(env, request, body);
    const response = await dispatchAction(
      { env, request, body, user, ip: '127.0.0.1', userAgent: 'local-registration-preview' },
      action,
      false
    );
    outgoing.setHeader('Content-Type', 'application/json; charset=utf-8');
    outgoing.end(await response.text());
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ status: 'error', message: 'Local preview error' }));
  }
}).listen(18889, '127.0.0.1', () => {
  console.log(
    `Registration preview API: ${api}\nOfficer page: ${dashboard}/#/registration\nTest QR passes: ${api}/passes\nTest login: ${username} / ${password}\nIn-memory test data only. No production bindings or secrets are loaded.`
  );
});
