import { TABLES } from '../../constants';
import { Note } from '../../types';

export function addNote(
  db: D1Database,
  note: {
    ref: string;
    text: string;
    user: string;
    timestamp: string;
    createdAt: string;
  }
): Promise<void> {
  return db
    .prepare(
      `INSERT INTO ${TABLES.notes} (ref, text, user, timestamp, createdAt)
     VALUES (?, ?, ?, ?, ?)`
    )
    .bind(note.ref, note.text, note.user, note.timestamp, note.createdAt)
    .run()
    .then(() => undefined);
}

export function getNotesByRef(db: D1Database, ref: string): Promise<Note[]> {
  return db
    .prepare(
      `SELECT ref, text, user, timestamp, createdAt
     FROM ${TABLES.notes} WHERE ref = ? ORDER BY createdAt ASC`
    )
    .bind(ref)
    .all<Note>()
    .then((res) =>
      (res.results ?? []).map((n) => ({
        ...n,
        text: n.text ?? '',
        user: n.user ?? '',
        timestamp: n.timestamp ?? '',
        createdAt: n.createdAt ?? '',
      }))
    );
}
