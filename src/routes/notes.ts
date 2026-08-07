import { sanitizeStr } from '../config';
import { addNote, getNotesByRef } from '../db/queries/notes';
import { logEvent } from '../services/logger';
import { Env } from '../types';

export async function handleAddNote(env: Env, body: Record<string, unknown>, user: { username: string }): Promise<Record<string, unknown>> {
  if (!body.ref || !body.note) {
    return { status: 'error', message: 'กรุณาระบุเลขอ้างอิงและหมายเหตุ' };
  }
  const ref = sanitizeStr(body.ref, 64);
  const noteObj = (body.note && typeof body.note === 'object') ? body.note as Record<string, unknown> : {};
  const text = sanitizeStr(noteObj.text, 2000);
  const noteUser = sanitizeStr(noteObj.user || user.username, 100);
  const timestamp = sanitizeStr(noteObj.timestamp, 100) || new Date().toLocaleString('th-TH');
  if (!text) return { status: 'error', message: 'กรุณากรอกข้อความหมายเหตุ' };

  await addNote(env.DB, {
    ref,
    text,
    user: noteUser,
    timestamp,
    createdAt: new Date().toISOString(),
  });
  await logEvent(env, user.username, 'add_note', ref, { text }, 'success');
  return { status: 'ok', message: 'เพิ่มหมายเหตุสำเร็จ' };
}

export async function handleGetNotes(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64);
  if (!ref) return { status: 'error', message: 'Missing ref' };
  const notes = await getNotesByRef(env.DB, ref);
  return { status: 'ok', notes };
}
