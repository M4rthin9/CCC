import { TABLES } from '../../constants';
import { EventLog } from '../../types';

export function insertEventLog(
  db: D1Database,
  entry: {
    timestamp: string;
    username: string;
    action: string;
    targetRef: string;
    details: string;
    result: string;
    ip: string;
    userAgent: string;
  }
): Promise<void> {
  return db.prepare(
    `INSERT INTO ${TABLES.eventLog} (timestamp, username, action, targetRef, details, result, ip, userAgent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    entry.timestamp, entry.username, entry.action, entry.targetRef,
    entry.details, entry.result, entry.ip, entry.userAgent
  ).run().then(() => undefined);
}

export async function getEventLogs(
  db: D1Database,
  params: {
    fromDate?: string;
    toDate?: string;
    username?: string;
    action?: string;
    search?: string;
  }
): Promise<EventLog[]> {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (params.fromDate) {
    conditions.push('timestamp >= ?');
    binds.push(params.fromDate);
  }
  if (params.toDate) {
    conditions.push('timestamp <= ?');
    binds.push(params.toDate + ' 23:59:59');
  }
  if (params.username) {
    conditions.push('lower(username) LIKE ?');
    binds.push('%' + String(params.username).toLowerCase() + '%');
  }
  if (params.action) {
    conditions.push('lower(action) LIKE ?');
    binds.push('%' + String(params.action).toLowerCase() + '%');
  }

  let sql = `SELECT timestamp, username, action, targetRef, details, result, ip, userAgent
     FROM ${TABLES.eventLog}`;
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  if (params.search) {
    // SQLite LIKE for a JSON-substring search (legacy did a JSON stringify scan).
    const like = '%' + String(params.search).toLowerCase() + '%';
    if (conditions.length > 0) {
      sql += ` AND (lower(timestamp) LIKE ? OR lower(username) LIKE ? OR lower(action) LIKE ? OR lower(targetRef) LIKE ? OR lower(details) LIKE ?)`;
    } else {
      sql += ` WHERE (lower(timestamp) LIKE ? OR lower(username) LIKE ? OR lower(action) LIKE ? OR lower(targetRef) LIKE ? OR lower(details) LIKE ?)`;
    }
    binds.push(like, like, like, like, like);
  }
  sql += ' ORDER BY rowid DESC LIMIT 500';

  return db.prepare(sql).bind(...binds).all<EventLog>().then(res => (res.results ?? []));
}
