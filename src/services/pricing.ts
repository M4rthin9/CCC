// Thai visitor pricing (mirrors the frontend's calcCost in booking.svelte.ts):
//   - prisoner:     1000 THB (omitted entirely for a no-prisoner "table" booking —
//                   pass includePrisonerFee: false)
//   - main visitor: 1000 THB, unless a child (relation in CHILD_RELATIONS):
//       age < 5  -> free (0)
//       age <= 8 -> 500 THB
//   - extra visitor: 1000 THB each, same child ladder.
// Server-authoritative: totals are recomputed from persisted inputs on every
// write path instead of trusting client-supplied numerics.

export const PRISONER_FEE = 1000;
export const MAIN_VISITOR_FEE = 1000;
export const EXTRA_VISITOR_FEE = 1000;
export const CHILD_MAX_FREE_AGE = 5;
export const CHILD_MAX_HALF_AGE = 8;
export const CHILD_HALF_FEE = 500;

// Mirrors `CHILD_RELATIONS` in the frontend (booking.svelte.ts:33). Compare trimmed.
export const CHILD_RELATIONS = ['บุตร / ธิดา', 'Child', '子女', 'Son/Daughter'];

// Kept as a sum so the two fee buckets cannot drift apart.
export const BASE_MAIN_FEE = PRISONER_FEE + MAIN_VISITOR_FEE;

export function isChildRelation(relation: string): boolean {
  return CHILD_RELATIONS.includes(String(relation || '').trim());
}

export function childFee(age: unknown): number | null {
  const a = parseInt(String(age), 10);
  if (isNaN(a)) return null;
  if (a < CHILD_MAX_FREE_AGE) return 0;
  if (a <= CHILD_MAX_HALF_AGE) return CHILD_HALF_FEE;
  return null;
}

export function mainVisitorFee(relation: string, age: unknown): number {
  if (isChildRelation(relation)) {
    const fee = childFee(age);
    if (fee !== null) return fee;
  }
  return MAIN_VISITOR_FEE;
}

export function extraVisitorFee(relation: string, age: unknown): number {
  if (isChildRelation(relation)) {
    const fee = childFee(age);
    if (fee !== null) return fee;
  }
  return EXTRA_VISITOR_FEE;
}

export interface ExtraVisitorFields {
  name: string;
  id: string;
  relation: string;
  age: string;
}

/** Parse the `name|id|relation|age` rows joined by `;;` persisted on the row. */
export function parseExtraVisitorNames(raw: unknown): ExtraVisitorFields[] {
  const str = String(raw || '');
  if (!str) return [];
  return str
    .split(';;')
    .map((e) => {
      const p = e.split('|');
      return {
        name: (p[0] || '').trim(),
        id: (p[1] || '').trim(),
        relation: (p[2] || '').trim(),
        age: (p[3] || '').trim(),
      };
    })
    .filter((e) => e.name);
}

export interface BookingCostInput {
  relation?: string;
  visitorAge?: string;
  extraVisitorNames?: string;
  /**
   * False for a no-prisoner "table" booking: the visitor ladder is identical,
   * but there is no prisoner to charge the PRISONER_FEE line item for.
   */
  includePrisonerFee?: boolean;
}

export interface BookingCost {
  total: number;
  visitorCount: number;
  adultCount: number;
  child5to8Count: number;
  childUnder5Count: number;
}

/** Mirrors frontend `calcCost` (booking.svelte.ts:76). `visitorCount` is the
 *  main visitor + all extra visitors; the prisoner is not counted. */
export function computeBookingCost({
  relation,
  visitorAge,
  extraVisitorNames,
  includePrisonerFee = true,
}: BookingCostInput): BookingCost {
  const mainFee = mainVisitorFee(relation ?? '', visitorAge ?? '');

  let extraFees = 0;
  let adults = 0;
  let kids5_8 = 0;
  let kidsUnder5 = 0;

  if (mainFee < MAIN_VISITOR_FEE) {
    if (mainFee === 0) kidsUnder5 += 1;
    else kids5_8 += 1;
  } else {
    adults += 1;
  }

  const extras = parseExtraVisitorNames(extraVisitorNames);
  for (const e of extras) {
    const fee = extraVisitorFee(e.relation, e.age);
    extraFees += fee;
    if (fee < EXTRA_VISITOR_FEE) {
      if (fee === 0) kidsUnder5 += 1;
      else kids5_8 += 1;
    } else {
      adults += 1;
    }
  }

  const visitorCount = 1 + extras.length;
  return {
    total: (includePrisonerFee ? PRISONER_FEE : 0) + mainFee + extraFees,
    visitorCount,
    adultCount: adults,
    child5to8Count: kids5_8,
    childUnder5Count: kidsUnder5,
  };
}

/**
 * Overwrite the pricing numerics on `data` with server-computed values.
 * Returns the client-supplied total (if any) for discrepancy logging — the
 * caller decides whether to log a tamper signal; we never fail hard.
 */
export function applyServerPricing(
  data: Record<string, unknown>,
  options: { includePrisonerFee?: boolean } = {}
): { clientTotal?: number; serverTotal: number } {
  const includePrisonerFee = options.includePrisonerFee !== false;
  const clientTotal =
    data.total !== undefined && data.total !== null && data.total !== '' ? Number(data.total) : undefined;

  const cost = computeBookingCost({
    relation: String(data.relation || ''),
    visitorAge: String(data.visitorAge || ''),
    extraVisitorNames: String(data.extraVisitorNames || ''),
    includePrisonerFee,
  });

  data.total = cost.total;
  data.visitorCount = cost.visitorCount;
  data.adultCount = cost.adultCount;
  data.child5to8Count = cost.child5to8Count;
  data.childUnder5Count = cost.childUnder5Count;
  // The prisoner occupies a seat on a visit booking but not on a table booking.
  data.totalPersons = includePrisonerFee ? cost.visitorCount + 1 : cost.visitorCount;

  return { clientTotal, serverTotal: cost.total };
}

export interface ApprovalTotals {
  visitorCount: number;
  total: number;
  adultCount: number;
  child5to8Count: number;
  childUnder5Count: number;
}

// Computes the corrected visitorCount, total, and age-bucket counts given the
// approval strings, mirroring handleUpdateVisitorApproval. Only approved
// ('yes') visitors are charged; rejected and still-pending ones are dropped.
// The age ladder (<5 free, 5-8 half, 9+ full) applies per visitor, matching
// the booking-time computeBookingCost. Extras are always parsed so a single
// extra (no ';;' separator) and legacy 'name (relation)' rows still get the
// child discount when an age is stored.
export function computeApprovalTotals(
  mainApproved: boolean,
  extraVisitorApproved: string | undefined,
  extraVisitorNames: string | undefined,
  mainRelation = '',
  mainAge = ''
): ApprovalTotals {
  // Rejecting the main visitor auto-cancels the whole booking (the route sets
  // status to ไม่อนุมัติ), so nobody attends and only the prisoner fee remains.
  if (!mainApproved) {
    return { visitorCount: 0, total: PRISONER_FEE, adultCount: 0, child5to8Count: 0, childUnder5Count: 0 };
  }

  const mainFee = mainVisitorFee(mainRelation, mainAge);
  let total = PRISONER_FEE + mainFee;
  let adultCount = 0;
  let child5to8Count = 0;
  let childUnder5Count = 0;

  if (mainFee === 0) childUnder5Count += 1;
  else if (mainFee < MAIN_VISITOR_FEE) child5to8Count += 1;
  else adultCount += 1;

  const allApprovals = String(extraVisitorApproved || '').split(';;');
  const extras = parseExtraVisitorNames(extraVisitorNames);
  let extraYesCount = 0;
  extras.forEach((v, idx) => {
    if ((allApprovals[idx] || '').trim().toLowerCase() !== 'yes') return;
    extraYesCount += 1;
    const fee = extraVisitorFee(v.relation, v.age);
    total += fee;
    if (fee === 0) childUnder5Count += 1;
    else if (fee < EXTRA_VISITOR_FEE) child5to8Count += 1;
    else adultCount += 1;
  });

  const visitorCount = 1 + extraYesCount;
  return { visitorCount, total, adultCount, child5to8Count, childUnder5Count };
}
