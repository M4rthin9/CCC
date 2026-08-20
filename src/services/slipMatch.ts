import { SlipOcrFields } from './slipOcr';
import { PROMPTPAY_MERCHANT_NAME, PROMPTPAY_MERCHANT_NAME_EN, PromptPayConfig } from './promptpayConfig';
import { Reservation } from '../types';

// Matching layer: turns transcribed slip text into per-check booleans against
// the booking. Kept out of slipverify.ts so the QR/authenticity pipeline stays
// readable, and so the rules that can settle money can be reasoned about alone.

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const AMOUNT_TOLERANCE = 0.5;
const CLOCK_SKEW_BEFORE_MS = 15 * 60 * 1000;
const CLOCK_SKEW_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 72;

const THAI_MONTHS: Record<string, number> = {
  'ม.ค.': 1,
  มกราคม: 1,
  jan: 1,
  'ก.พ.': 2,
  กุมภาพันธ์: 2,
  feb: 2,
  'มี.ค.': 3,
  มีนาคม: 3,
  mar: 3,
  'เม.ย.': 4,
  เมษายน: 4,
  apr: 4,
  'พ.ค.': 5,
  พฤษภาคม: 5,
  may: 5,
  'มิ.ย.': 6,
  มิถุนายน: 6,
  jun: 6,
  'ก.ค.': 7,
  กรกฎาคม: 7,
  jul: 7,
  'ส.ค.': 8,
  สิงหาคม: 8,
  aug: 8,
  'ก.ย.': 9,
  กันยายน: 9,
  sep: 9,
  'ต.ค.': 10,
  ตุลาคม: 10,
  oct: 10,
  'พ.ย.': 11,
  พฤศจิกายน: 11,
  nov: 11,
  'ธ.ค.': 12,
  ธันวาคม: 12,
  dec: 12,
};

/** Thai digits ๐-๙ appear on some bank slips; fold them to ASCII. */
function foldThaiDigits(text: string): string {
  return text.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
}

/** Buddhist-era years (2500+) are the norm on Thai slips. */
function toGregorianYear(year: number): number {
  if (year > 2400) return year - 543;
  if (year < 100) return 2000 + year;
  return year;
}

/**
 * Parse a slip's printed timestamp. Slips are written in Bangkok local time,
 * so the result is shifted to UTC to match everything else stored here.
 * Returns null rather than guessing when the text is not recognisable.
 */
export function parseSlipDateTime(raw: string | null): Date | null {
  if (!raw) return null;
  const text = foldThaiDigits(String(raw)).trim();
  if (!text) return null;

  let day: number;
  let month: number;
  let year: number;

  // ISO first: "2026-08-20 14:32" would otherwise be misread by the day-first
  // pattern below, which can start matching part-way through the year.
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const numeric = iso ? null : text.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (iso) {
    year = toGregorianYear(Number(iso[1]));
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = toGregorianYear(Number(numeric[3]));
  } else {
    const named = text.match(/(\d{1,2})\s*([฀-๿.]+|[A-Za-z]{3,})\.?\s*(\d{2,4})/);
    if (!named) return null;
    const key = String(named[2]).toLowerCase().slice(0, 12);
    const monthNo =
      THAI_MONTHS[key] ??
      THAI_MONTHS[key.slice(0, 3)] ??
      Object.entries(THAI_MONTHS).find(([name]) => key.startsWith(name.toLowerCase()))?.[1];
    if (!monthNo) return null;
    day = Number(named[1]);
    month = monthNo;
    year = toGregorianYear(Number(named[3]));
  }

  if (!day || !month || !year || month > 12 || day > 31) return null;

  const time = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 0;
  const second = time && time[3] ? Number(time[3]) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const bangkokWallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  const utc = new Date(bangkokWallClock - BANGKOK_OFFSET_MS);
  return Number.isNaN(utc.getTime()) ? null : utc;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s._\-'"]/g, '')
    .replace(/^(นาย|นาง|นางสาว|ร้าน|mr|mrs|miss|ms)/, '');
}

/** Slips mask most of the account number; only the visible digits can match. */
function digitTail(value: string, length = 4): string {
  const digits = foldThaiDigits(value).replace(/\D/g, '');
  return digits.length >= length ? digits.slice(-length) : digits;
}

export interface SlipChecks {
  authentic: boolean;
  notDuplicate: boolean;
  amount: boolean;
  /** Both identify the payee, not the booking. null = nothing to compare. */
  ref1: boolean | null;
  payee: boolean | null;
  time: boolean;
}

export interface SlipDecision {
  decision: 'auto_approved' | 'review';
  score: number;
  checks: SlipChecks;
  /** Names of the checks that blocked auto-approval, for the dashboard. */
  blockedBy: string[];
  paidAt: string | null;
}

export interface SlipMatchInput {
  authentic: boolean;
  notDuplicate: boolean;
  booking: Reservation;
  ocr: SlipOcrFields | null;
  cfg: PromptPayConfig;
  /** Receiver identity from admin Settings (`promptpay.receiver*`). */
  receiverNames: string[];
  receiverAccountTail: string;
  maxAgeHours: number;
}

function amountMatches(ocr: SlipOcrFields, booking: Reservation): boolean {
  const expected = Number(booking.total);
  if (!Number.isFinite(expected) || expected <= 0 || ocr.amount === null) return false;
  return Math.abs(ocr.amount - expected) <= AMOUNT_TOLERANCE;
}

/**
 * Ref1 belongs to the biller agreement: the bank fixes it, so it is identical
 * on every booking's QR and identifies the *payee*, never the booking. A plain
 * credit transfer (tag 29) prints no Ref1 at all — that must read as "not
 * applicable", never as a failed check.
 */
function ref1Matches(ocr: SlipOcrFields, cfg: PromptPayConfig): boolean | null {
  const expected = String(cfg.ref1 || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const seen = (ocr.ref1 || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!expected || !seen) return null;
  return seen === expected;
}

function payeeMatches(input: SlipMatchInput, ocr: SlipOcrFields): boolean | null {
  const expectedTail = input.receiverAccountTail ? digitTail(input.receiverAccountTail) : '';
  const seenTail = ocr.receiverAccountTail ? digitTail(ocr.receiverAccountTail) : '';
  if (expectedTail && seenTail) return seenTail === expectedTail;

  const candidates = [
    ...input.receiverNames,
    PROMPTPAY_MERCHANT_NAME,
    PROMPTPAY_MERCHANT_NAME_EN,
    input.cfg.merchantNameEn,
  ]
    .filter(Boolean)
    .map(normalizeName)
    .filter((c) => c.length >= 4);
  const seenName = ocr.receiverName ? normalizeName(ocr.receiverName) : '';
  if (!seenName || candidates.length === 0) return null;
  return candidates.some((c) => seenName.includes(c) || c.includes(seenName));
}

function timeMatches(paidAt: Date | null, booking: Reservation, maxAgeHours: number): boolean {
  if (!paidAt) return false;
  const now = Date.now();
  const paid = paidAt.getTime();
  if (paid > now + CLOCK_SKEW_AFTER_MS) return false;
  if (now - paid > maxAgeHours * 60 * 60 * 1000) return false;
  const created = Date.parse(String(booking.createdAt || ''));
  if (Number.isFinite(created) && paid < created - CLOCK_SKEW_BEFORE_MS) return false;
  return true;
}

/**
 * Decide whether a slip may settle its booking on its own. Auto-approval needs
 * a genuine unused Mini-QR, the right amount, a plausible time, and at least
 * one payee-identifying signal (the biller Ref1 or the receiving account/name).
 * Anything short of that is `review` — today's manual queue, unchanged.
 *
 * Nothing here ties a slip to one *specific* booking: the biller Ref1 is fixed
 * by the bank and identical across bookings, so amount + time + the
 * transaction-reuse check in slipverify.ts are what stand between two bookings
 * of the same price.
 */
export function decideSlip(input: SlipMatchInput): SlipDecision {
  const ocr = input.ocr;
  const paidAt = ocr ? parseSlipDateTime(ocr.dateTimeText) : null;
  const checks: SlipChecks = {
    authentic: input.authentic,
    notDuplicate: input.notDuplicate,
    amount: ocr ? amountMatches(ocr, input.booking) : false,
    ref1: ocr ? ref1Matches(ocr, input.cfg) : null,
    payee: ocr ? payeeMatches(input, ocr) : null,
    time: timeMatches(paidAt, input.booking, input.maxAgeHours || DEFAULT_MAX_AGE_HOURS),
  };

  const identified = checks.ref1 === true || checks.payee === true;
  const blockedBy: string[] = [];
  if (!checks.authentic) blockedBy.push('authentic');
  if (!checks.notDuplicate) blockedBy.push('notDuplicate');
  if (!checks.amount) blockedBy.push('amount');
  if (!checks.time) blockedBy.push('time');
  // Ref1 and payee are alternatives — either one identifies the recipient.
  if (!identified) blockedBy.push('payeeIdentity');

  const score = [checks.authentic, checks.notDuplicate, checks.amount, checks.time, identified].filter(Boolean).length;

  return {
    decision: blockedBy.length === 0 ? 'auto_approved' : 'review',
    score,
    checks,
    blockedBy,
    paidAt: paidAt ? paidAt.toISOString() : null,
  };
}
