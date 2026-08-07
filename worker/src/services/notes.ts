import type { Env, NoteRow, UserRow } from '../types';
import { sanitizeStr } from '../lib/validate';
import { nowUtc } from '../lib/dates';
import { afterWrite } from '../db/db';

export async function addNote(
  env: Env,
  user: UserRow,
  body: Record<string, unknown>,
  ip: string,
  userAgent: string,
): Promise<{ status: 'ok'; message: string } | { status: 'error'; message: string }> {
  if (!body.ref || !body.note) {
    return { status: 'error', message: 'กรุณาระบุเลขอ้างอิงและหมายเหตุ' };
  }
  const ref = sanitizeStr(body.ref, 64);
  const noteObj = body.note && typeof body.note === 'object' ? (body.note as Record<string, unknown>) : {};
  const text = sanitizeStr(noteObj.text, 2000);
  const noteUser = sanitizeStr(noteObj.user || user.username, 100);
  const timestamp = sanitizeStr(noteObj.timestamp, 100) || new Date().toLocaleString('th-TH');
  if (!text) return { status: 'error', message: 'กรุณากรอกข้อความหมายเหตุ' };

  await env.DB.prepare('INSERT INTO notes (ref, text, user, timestamp, created_at) VALUES (?, ?, ?, ?, ?)').bind(
    ref,
    text,
    noteUser,
    timestamp,
    nowUtc(),
  ).run();

  await afterWrite(env, {
    ref,
    prisonerId: null,
    event: { type: 'note_added', ref, at: nowUtc() },
    log: {
      username: user.username,
      action: 'add_note',
      targetRef: ref,
      details: { text },
      result: 'success',
      ip,
      userAgent,
    },
  });
  return { status: 'ok', message: 'เพิ่มหมายเหตุสำเร็จ' };
}

export async function getNotes(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ status: 'ok'; notes: Record<string, unknown>[] } | { status: 'error'; message: string }> {
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'Missing ref' };

  const res = await env.DB.prepare('SELECT ref, text, user, timestamp, created_at FROM notes WHERE ref = ? ORDER BY id ASC')
    .bind(ref)
    .all<NoteRow>();
  const notes = (res.results || []).map((n) => ({
    ref: n.ref,
    text: n.text,
    user: n.user || '',
    timestamp: n.timestamp || '',
    createdAt: n.created_at,
  }));
  return { status: 'ok', notes };
}
