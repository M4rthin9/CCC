import type { Env } from '../types';
import { ACTIVE_STATUSES } from '../lib/constants';
import { sanitizeStr } from '../lib/validate';

export async function countsByDate(
  env: Env,
  from: string,
  to: string,
): Promise<{ status: 'ok'; counts: Record<string, number>; total: number }> {
  const fromVal = sanitizeStr(from, 10);
  const toVal = sanitizeStr(to, 10);
  let sql =
    'SELECT visit_date_iso, COUNT(*) AS c FROM bookings WHERE archived_at IS NULL AND status IN (?, ?, ?, ?, ?)';
  const binds: unknown[] = [...ACTIVE_STATUSES];
  if (fromVal || toVal) {
    sql += ' AND visit_date_iso >= ? AND visit_date_iso <= ?';
    binds.push(fromVal || '0000-00-00', toVal || '9999-12-31');
  }
  sql += ' GROUP BY visit_date_iso ORDER BY visit_date_iso';

  const res = await env.DB.prepare(sql).bind(...binds).all<{ visit_date_iso: string; c: number }>();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of res.results || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.visit_date_iso)) {
      counts[r.visit_date_iso] = r.c;
      total += r.c;
    }
  }
  return { status: 'ok', counts, total };
}

export async function funnel(env: Env): Promise<{ status: 'ok'; statuses: Record<string, number>; ratios: Record<string, number> }> {
  const res = await env.DB.prepare('SELECT status, COUNT(*) AS c FROM bookings WHERE archived_at IS NULL GROUP BY status').all<{
    status: string;
    c: number;
  }>();
  const statuses: Record<string, number> = {};
  for (const r of res.results || []) statuses[r.status] = r.c;

  const stageNames = ['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', 'รอชำระเงิน', 'ชำระแล้ว', 'เสร็จสิ้น'];
  const base = statuses[stageNames[0]] || 0;
  const ratios: Record<string, number> = {};
  stageNames.forEach((stage, i) => {
    ratios[stage] = base > 0 ? Math.round(((statuses[stage] || 0) / base) * 1000) / 10 : 0;
    void i;
  });
  return { status: 'ok', statuses, ratios };
}

export async function revenue(
  env: Env,
  from: string,
  to: string,
): Promise<{ status: 'ok'; revenue: number; count: number }> {
  const fromVal = sanitizeStr(from, 10);
  const toVal = sanitizeStr(to, 10);
  let sql =
    "SELECT SUM(total) AS revenue, COUNT(*) AS cnt FROM bookings WHERE archived_at IS NULL AND status IN ('ชำระแล้ว', 'เสร็จสิ้น')";
  const binds: unknown[] = [];
  if (fromVal || toVal) {
    sql += ' AND visit_date_iso >= ? AND visit_date_iso <= ?';
    binds.push(fromVal || '0000-00-00', toVal || '9999-12-31');
  }
  const res = await env.DB.prepare(sql).bind(...binds).first<{ revenue: number | null; cnt: number }>();
  return { status: 'ok', revenue: res?.revenue ?? 0, count: res?.cnt ?? 0 };
}
