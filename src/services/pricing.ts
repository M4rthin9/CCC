// Thai visitor pricing (mirrors handleUpdateVisitorApproval in the legacy code):
//   - main visitor: 2000 THB
//   - each approved extra visitor: 1000 THB
//   - extra visitors who are children (relation 'บุตร / ธิดา'):
//       age < 5  -> free (0)
//       age <= 8 -> 500 THB
//   - otherwise 1000 THB each

export const BASE_MAIN_FEE = 2000;
export const EXTRA_VISITOR_FEE = 1000;
export const CHILD_MAX_FREE_AGE = 5;
export const CHILD_MAX_HALF_AGE = 8;
export const CHILD_HALF_FEE = 500;

export function extraVisitorFee(relation: string, age: unknown): number {
  if (String(relation || '').trim() === 'บุตร / ธิดา') {
    const a = parseInt(String(age), 10);
    if (!isNaN(a) && a < CHILD_MAX_FREE_AGE) return 0;
    if (!isNaN(a) && a <= CHILD_MAX_HALF_AGE) return CHILD_HALF_FEE;
  }
  return EXTRA_VISITOR_FEE;
}

// Computes the corrected visitorCount and total given the approval strings,
// mirroring handleUpdateVisitorApproval exactly.
export function computeApprovalTotals(
  mainApproved: boolean,
  extraVisitorApproved: string | undefined,
  extraVisitorNames: string | undefined
): { visitorCount: number; total: number } {
  let correctTotal = BASE_MAIN_FEE;
  let extraYesCount = 0;

  if (extraVisitorApproved) {
    const allApprovals = String(extraVisitorApproved).split(';;');
    extraYesCount = allApprovals.filter((v) => (v || '').trim().toLowerCase() === 'yes').length;

    const raw = String(extraVisitorNames || '');
    if (raw.includes(';;')) {
      const extras = raw
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
