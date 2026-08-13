// Thai visitor pricing (mirrors the frontend's calcCost in booking.svelte.ts):
//   - prisoner:     1000 THB
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
export function computeBookingCost({ relation, visitorAge, extraVisitorNames }: BookingCostInput): BookingCost {
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
    total: PRISONER_FEE + mainFee + extraFees,
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
export function applyServerPricing(data: Record<string, unknown>): { clientTotal?: number; serverTotal: number } {
  const clientTotal =
    data.total !== undefined && data.total !== null && data.total !== '' ? Number(data.total) : undefined;

  const cost = computeBookingCost({
    relation: String(data.relation || ''),
    visitorAge: String(data.visitorAge || ''),
    extraVisitorNames: String(data.extraVisitorNames || ''),
  });

  data.total = cost.total;
  data.visitorCount = cost.visitorCount;
  data.adultCount = cost.adultCount;
  data.child5to8Count = cost.child5to8Count;
  data.childUnder5Count = cost.childUnder5Count;
  data.totalPersons = cost.visitorCount + 1;

  return { clientTotal, serverTotal: cost.total };
}

// Computes the corrected visitorCount and total given the approval strings,
// mirroring handleUpdateVisitorApproval. D.3a: the main visitor now earns the
// child discount too (inputs finally available via the visitorAge column).
export function computeApprovalTotals(
  mainApproved: boolean,
  extraVisitorApproved: string | undefined,
  extraVisitorNames: string | undefined,
  mainRelation = '',
  mainAge = ''
): { visitorCount: number; total: number } {
  const mainFee = mainApproved ? mainVisitorFee(mainRelation, mainAge) : MAIN_VISITOR_FEE;
  let correctTotal = PRISONER_FEE + mainFee;
  let extraYesCount = 0;

  if (extraVisitorApproved) {
    const allApprovals = String(extraVisitorApproved).split(';;');
    extraYesCount = allApprovals.filter((v) => (v || '').trim().toLowerCase() === 'yes').length;

    const raw = String(extraVisitorNames || '');
    if (raw.includes(';;')) {
      const extras = parseExtraVisitorNames(raw);
      let extraFeeSum = 0;
      extras.forEach((v, idx) => {
        if ((allApprovals[idx] || '').trim().toLowerCase() === 'yes') {
          extraFeeSum += extraVisitorFee(v.relation, v.age);
        }
      });
      correctTotal += extraFeeSum;
    } else {
      correctTotal += extraYesCount * EXTRA_VISITOR_FEE;
    }
  }

  const correctVisitorCount = (mainApproved ? 1 : 0) + extraYesCount;
  return { visitorCount: correctVisitorCount, total: correctTotal };
}
