# July 2026 booking review

The operator selected the final reservation charge, including staff-added
visitors and child discounts, as the Overall Report source on 9 October 2026.
The review covers all 476 current July reservations: 328 completed, 123
cancelled, and 25 rejected. Cancelled and rejected bookings do not contribute
to completed-booking charges.

## Confirmed child charge corrections

| Date    | Booking   | Child age | Previous booking total | Correct booking total |
| ------- | --------- | --------: | ---------------------: | --------------------: |
| 1 July  | VIS-19649 |         6 |                  3,000 |                 2,500 |
| 16 July | VIS-55903 |         5 |                  3,000 |                 2,500 |
| 23 July | VIS-37212 |         8 |                  3,000 |                 2,500 |
| 24 July | VIS-81233 |         1 |                  3,000 |                 2,000 |

The child corrections reduce July's recorded completed-booking charge by 2,500 baht.
The operator also confirmed approving the additional adult on VIS-37459
(20 July): its total changes from 2,000 to 3,000, with its 1-year-old child free.
After both corrections, July's total is **816,500 baht** (previously 818,000).
The affected daily totals are 34,500 on 1 July, 47,500 on 16 July, 45,000 on
23 July, 47,000 on 24 July, and 44,500 on 20 July. Other July daily totals stay unchanged.

Stored visitor counts are also reconciled where all approvals are recorded.
226 July records qualify for a count or price correction; only the four listed
above change price. The wider database repair corrects 538 records and nine
prices. It preserves the original main/additional visitor details, approvals,
and slips, with old values retained for reversal.

## Records requiring booking review

Twelve completed July bookings have approval/status records needing staff review:
VIS-28540, VIS-30350, VIS-34685, VIS-36486, VIS-42115,
VIS-42579, VIS-58757, VIS-70161, VIS-78623, VIS-80577,
VIS-96481, and VIS-99085. Their totals are preserved. Missing approvals are
not treated as a rejection or proof that a staff-added visitor did not attend.

VIS-65622 (21 July) was explicitly confirmed correct by the operator and is
preserved at 2,000 baht. Its child aged 3 is free, its additional adult attends,
and its rejected main visitor is not charged. VIS-37459's additional adult is
approved by migration 0026, with the original approval/count/charge retained.

VIS-57432 (4 July, previously 2,000 baht) is absent from the current database.
The event log records an explicit archived-booking deletion on 26 August.
It is not restored automatically. Two other missing backup references had
pending status and explicit deletion events.

Receipt discrepancies found during the earlier review are retained as payment
reconciliation notes. They do not replace booking charges under the selected
reporting rule. The four proposed receipt-only reductions were not applied.

## Prevention and verification

Authorized staff can add a visitor to a settled reservation. The backend
calculates the charge from their relation and age, preserves explicit
rejections, and keeps approvals attached to the same person when the list is
reordered. Unchanged saves preserve the charge; direct numeric overrides are
blocked. Charge changes and the guard update together in a transaction.

The repair was tested against a private copy of all 2,115 current production
records, proving that every other stored field and all other records are
preserved. Automated tests cover ages 0, 4, 5, 8, and 9, staff additions,
reordering, rejected visitors, concurrent changes, rollback and refunds.
