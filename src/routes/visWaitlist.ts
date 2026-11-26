import { formatDateISO, sanitizeStr } from '../config';
import { AWAITING_PAYMENT } from '../constants';
import { getReservationByRef } from '../db/queries/reservations';
import { hasPermission } from '../db/queries/roles';
import { bookingWindowError, getBookingWindow, isBookableDate } from '../services/bookingWindow';
import { prisonerBookingBanError } from '../services/bookingBlacklist';
import { getPrisonerDiscipline } from '../services/disciplineService';
import { computeBookingCost, parseExtraPrisoners, parseExtraVisitorNames } from '../services/pricing';
import { getPublicBookingConfig, publicCapacityForDate } from '../services/publicCapacity';
import { reservationChanged } from '../services/reservationChanges';
import { refreshReturningVisitorApprovals } from '../services/visitorClearance';
import { getManagedVisPayment, visPaymentOpen } from '../services/visWaitlist';
import {
  VIS_BOOKING,
  VIS_OPEN,
  VIS_OTHER_DATE_CONDITION,
  VIS_OTHER_DATE_PRISONER,
  VIS_PAID,
  VIS_PENDING,
  VIS_STANDBY_LIMIT,
  VIS_WAITING,
  usesVisWaitlist,
  visOtherDateBinds,
  visVisitorId,
  visWaitlistEnabled,
} from '../services/visWaitlistPolicy';
import type { Env, Reservation } from '../types';

const IDENTITY_ERROR = { status: 'error', message: 'เลข VIS หรือข้อมูลผู้จองหลักไม่ตรงกัน' };
const CHANGE_ERROR = { status: 'error', message: 'ข้อมูลมีการเปลี่ยนแปลง กรุณาตรวจสอบสถานะอีกครั้ง' };
const encoder = new TextEncoder();
const VIS_REBOOKABLE = ['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', VIS_WAITING];

export async function documentMatches(provided: string, stored: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [provided, stored].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value)))
  );
  if (!a || !b) return false;
  const first = new Uint8Array(a),
    second = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < first.length; i++) difference |= first[i]! ^ second[i]!;
  return difference === 0;
}

function view(row: Reservation, payment: NonNullable<Awaited<ReturnType<typeof getManagedVisPayment>>> | null) {
  return {
    status: 'ok',
    ref: row.ref,
    bookingStatus: row.status,
    version: row.version,
    deadline: payment?.holdExpiresAt || '',
    submitted: Boolean(payment?.visSlipSubmittedAt),
    visitDateISO: row.visitDateISO || '',
    canChooseDate: VIS_REBOOKABLE.includes(String(row.status)) && !row.visitDateISO,
    main: { name: row.visitorName, id: row.visitorId, relation: row.relation, age: row.visitorAge },
    guests: parseExtraVisitorNames(row.extraVisitorNames),
  };
}

export async function handleVisManage(
  env: Env,
  body: Record<string, unknown>,
  now = new Date()
): Promise<Record<string, unknown>> {
  const ref = sanitizeStr(body.ref, 64).toUpperCase();
  const document = visVisitorId(body.visitorId);
  if (!visWaitlistEnabled(env, now) || !ref.startsWith('VIS-') || !document || document.length > 64)
    return IDENTITY_ERROR;
  const row = await getReservationByRef(env.DB, ref);
  if (!row || !visVisitorId(row.visitorId) || !(await documentMatches(document, visVisitorId(row.visitorId))))
    return IDENTITY_ERROR;
  const payment = await getManagedVisPayment(env, row, now);
  if (!payment) return IDENTITY_ERROR;
  if (body.operation === 'open') return view(row, payment);
  if (Number(body.version) !== Number(row.version || 1)) return CHANGE_ERROR;
  if (body.operation === 'rebook') return rebook(env, row, sanitizeStr(body.visitDateISO, 10), now);
  if (body.operation !== 'edit') return CHANGE_ERROR;
  if (
    payment.visSlipSubmittedAt ||
    !String(row.visitDateISO || '') ||
    String(row.visitDateISO) < formatDateISO(now) ||
    !['รอตรวจสอบผู้เข้าร่วม', 'รอตรวจสอบวินัย', VIS_WAITING, AWAITING_PAYMENT].includes(String(row.status)) ||
    (row.status === AWAITING_PAYMENT && !visPaymentOpen(row, payment, now))
  ) {
    return { status: 'error', message: 'รายการนี้แก้ไขผู้เข้าเยี่ยมไม่ได้ในสถานะปัจจุบัน' };
  }

  const main = visitorInput(body.main);
  const guests = Array.isArray(body.guests) && body.guests.length <= 9 ? body.guests.map(visitorInput) : null;
  if (!main || !guests || guests.some((guest) => !guest)) {
    return {
      status: 'error',
      message: 'กรุณาตรวจสอบชื่อ เลขบัตรประชาชนหรือหนังสือเดินทาง ความสัมพันธ์ และอายุผู้เข้าเยี่ยม',
    };
  }
  const ids = new Set([main.id]);
  for (const guest of guests) {
    if (!guest || ids.has(guest.id)) return { status: 'error', message: 'เลขเอกสารผู้เข้าเยี่ยมซ้ำกัน' };
    ids.add(guest.id);
  }
  const key = (id: unknown, name: unknown) =>
    `${visVisitorId(id)}\0${String(name || '')
      .normalize('NFC')
      .replace(/\s+/g, '')
      .toLowerCase()}`;
  const previous = new Map([[key(row.visitorId, row.visitorName), String(row.visitorApproved || '')]]);
  const flags = String(row.extraVisitorApproved || '').split(';;');
  parseExtraVisitorNames(row.extraVisitorNames).forEach((guest, index) =>
    previous.set(key(guest.id, guest.name), flags[index] || '')
  );
  const changes = {
    ...row,
    visitorName: main.name,
    visitorId: main.id,
    visitorAge: main.age,
    relation: main.relation,
    visitorApproved: previous.get(key(main.id, main.name)) || '',
    extraVisitorNames: guests.map((g) => `${g!.name}|${g!.id}|${g!.relation}|${g!.age}`).join(';;'),
    extraVisitorApproved: guests.map((g) => previous.get(key(g!.id, g!.name)) || '').join(';;'),
  };
  const normalized = changes as Record<string, unknown>;
  await refreshReturningVisitorApprovals(env.DB, normalized, true);
  const needsReview = changes.status !== AWAITING_PAYMENT;
  const wasPayable = visPaymentOpen(row, payment, now);
  const remain =
    needsReview && wasPayable ? Date.parse(payment.holdExpiresAt) - now.getTime() : payment.visPaymentRemainingMs;
  const next = needsReview ? changes.status : wasPayable ? AWAITING_PAYMENT : VIS_WAITING;
  const cost = computeBookingCost(changes);
  const stamp = now.toISOString();
  const [, today, date] = visOtherDateBinds(main.id, row.visitDateISO, now);
  const result = await env.DB.prepare(
    `UPDATE reservations SET visitorName = ?, visitorId = ?, visitorAge = ?, relation = ?,
    visitorApproved = ?, extraVisitorNames = ?, extraVisitorApproved = ?, participantApproved = ?, status = ?, total = ?,
    visitorCount = ?, totalPersons = ?, adultCount = ?, child5to8Count = ?, childUnder5Count = ?, payment_ref1 = '',
    holdExpiresAt = ?, visPaymentRemainingMs = ?, updatedAt = ?, version = version + 1
    WHERE ref = ? AND version = ? AND status = ? AND visSlipSubmittedAt = ''
     AND (? = visitorId OR NOT EXISTS (SELECT 1 FROM reservations WHERE ${VIS_OTHER_DATE_CONDITION}))`
  )
    .bind(
      main.name,
      main.id,
      main.age,
      main.relation,
      changes.visitorApproved,
      changes.extraVisitorNames,
      changes.extraVisitorApproved,
      changes.participantApproved || '',
      next,
      cost.total,
      cost.visitorCount,
      cost.visitorCount + 1 + parseExtraPrisoners(row.extraPrisoners).length,
      cost.adultCount,
      cost.child5to8Count,
      cost.childUnder5Count,
      needsReview ? '' : payment.holdExpiresAt,
      remain,
      stamp,
      ref,
      row.version || 1,
      row.status,
      main.id,
      main.id,
      today,
      date
    )
    .run();
  if (Number(result.meta.changes) !== 1) return CHANGE_ERROR;
  await reservationChanged(env);
  return { status: 'ok', bookingStatus: next, total: cost.total };
}

function visitorInput(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const fields = value as Record<string, unknown>;
  const name = sanitizeStr(fields.name, 160);
  const id = visVisitorId(fields.id);
  const age = sanitizeStr(fields.age, 3);
  const relation = sanitizeStr(fields.relation, 60);
  if (
    !name ||
    !/^[A-Z0-9-]{4,30}$/.test(id) ||
    !/^\d{1,3}$/.test(age) ||
    Number(age) > 125 ||
    !relation ||
    /[|;\r\n]/.test(name + relation)
  )
    return null;
  return { name, id, age, relation };
}

async function rebook(env: Env, row: Reservation, date: string, now: Date): Promise<Record<string, unknown>> {
  const window = await getBookingWindow(env);
  const visitClosed = bookingWindowError(window, date);
  if (!usesVisWaitlist(env, date, now) || visitClosed || !isBookableDate(date, window, now))
    return { status: 'error', message: visitClosed || 'ไม่สามารถเลือกวันดังกล่าวได้' };
  if (!VIS_REBOOKABLE.includes(String(row.status)) || row.visitDateISO) return CHANGE_ERROR;
  const prisoners = [String(row.prisonerId || ''), ...parseExtraPrisoners(row.extraPrisoners).map((p) => p.id)];
  for (const id of prisoners) {
    if (!id) return CHANGE_ERROR;
    const ban = await prisonerBookingBanError(env, id);
    if (ban) return { status: 'error', message: ban };
    const discipline = await getPrisonerDiscipline(env, id);
    if (discipline.restricted) return { status: 'error', message: discipline.message };
  }
  const perDay = publicCapacityForDate(await getPublicBookingConfig(env), date);
  const ids = JSON.stringify(prisoners);
  const [, today] = visOtherDateBinds(row.visitorId, date, now);
  const stamp = now.toISOString();
  const result = await env.DB.prepare(
    `UPDATE reservations SET visitDateISO = ?, visitDate = ?, visQueuedAt = ?,
    visOfferedAt = '', holdExpiresAt = '', visPaymentRemainingMs = 0, updatedAt = ?, version = version + 1
    WHERE ref = ? AND version = ? AND status = ? AND visitDateISO = '' AND visSlipSubmittedAt = ''
      AND (SELECT COUNT(*) FROM reservations WHERE ${VIS_BOOKING} AND visitDateISO = ? AND status IN ${VIS_OPEN}) < ?
      AND NOT EXISTS (SELECT 1 FROM reservations WHERE ${VIS_OTHER_DATE_CONDITION})
      AND NOT EXISTS (SELECT 1 FROM reservations WHERE ${VIS_OTHER_DATE_PRISONER})
      AND NOT EXISTS (SELECT 1 FROM reservations WHERE ${VIS_BOOKING} AND visitDateISO = ? AND status IN ${VIS_OPEN}
       AND EXISTS (SELECT 1 FROM json_each(?) AS ids WHERE prisonerId = ids.value
        OR instr('|' || replace(extraPrisoners, ';;', '|') || '|', '|' || ids.value || '|') > 0))`
  )
    .bind(
      date,
      date,
      stamp,
      stamp,
      row.ref,
      row.version || 1,
      row.status,
      date,
      perDay + VIS_STANDBY_LIMIT,
      visVisitorId(row.visitorId),
      today,
      date,
      today,
      date,
      ids,
      date,
      ids
    )
    .run();
  if (Number(result.meta.changes) !== 1)
    return { status: 'error', message: 'วันที่เลือกเต็มหรือยังมีรายการที่ค้างชำระ' };
  await reservationChanged(env);
  return { status: 'ok', ref: row.ref, bookingStatus: row.status };
}

export async function handleVisContactQueue(
  env: Env,
  body: Record<string, unknown>,
  user: { username: string; role: string }
) {
  if (
    !visWaitlistEnabled(env) ||
    (!['Admin', 'Superadmin'].includes(user.role) &&
      !(await hasPermission(env.DB, user.username, 'approve_participant')))
  )
    return { status: 'error', message: 'ไม่มีสิทธิ์' };
  const ref = sanitizeStr(body.ref, 64);
  if (body.operation === 'contacted' && ref) {
    await env.DB.prepare('UPDATE reservations SET visContactRequired = 0 WHERE ref = ? AND visContactRequired = 1')
      .bind(ref)
      .run();
  }
  const now = new Date();
  const [contact, days] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ref, visitorName, visitorPhone, visitDateISO, holdExpiresAt FROM reservations
      WHERE visContactRequired = 1 AND status = ? AND holdExpiresAt > ? AND visSlipSubmittedAt = '' ORDER BY holdExpiresAt LIMIT 100`
    ).bind(AWAITING_PAYMENT, now.toISOString()),
    env.DB.prepare(
      `SELECT visitDateISO AS date,
      SUM(CASE WHEN status IN ${VIS_PAID} THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status IN ${VIS_PENDING} AND visOfferedAt != '' THEN 1 ELSE 0 END) AS held,
      SUM(CASE WHEN status IN ${VIS_PENDING} AND visOfferedAt = '' THEN 1 ELSE 0 END) AS waiting
      FROM reservations WHERE ${VIS_BOOKING} AND visitDateISO >= ? AND status IN ${VIS_OPEN}
      GROUP BY visitDateISO ORDER BY visitDateISO LIMIT 32`
    ).bind(formatDateISO(now)),
  ]);
  return { status: 'ok', rows: contact?.results || [], days: days?.results || [] };
}
