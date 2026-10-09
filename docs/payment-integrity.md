# Reservation charges and historical corrections

The operator's final instruction on 9 October 2026 is to use the final booking
charge for the Overall Report, including visitors added by staff and the child
discount. A saved slip may predate a staff addition. Receipt amounts are retained
as evidence; they do not replace the final reservation charge.

Visitor fees are 1,000 baht for adults and children aged 9 or older, 500 baht for
children aged 5–8, and zero for children under 5. Each prisoner costs 1,000 baht.
The age and relation recorded for each person determine their fee. Explicitly
rejected extra visitors are excluded. New staff-added visitors remain registered
while their approval is pending; adding them does not silently approve them.

## Historical reconciliation

Migration 0025 reconciles 538 archived bookings with complete recorded approvals.
Nine prices change: seven child discounts and two bookings that have four
approved visitors but had charged for two. Other corrections restore the stored
adult/child counts used by reports. In July, four prices change by a combined
minus 2,500 baht, giving a recorded completed-booking charge of 815,500 baht.

`scripts/booking-charge-evidence.json` contains the audited references, versions,
dates, prior totals/counts, expected totals/counts, and SHA-256 hashes of the
pricing inputs. It contains no customer names or identity numbers. Deployment
rechecks the current guest lists, ages, approvals, totals and versions against
these hashes before migrating. The SQL also stops on stale versions, totals,
counts or guard snapshots. Missing records on a cold development database are
skipped. D1 tracks the migration so successful corrections do not run again.

`booking_charge_corrections` retains the old and new values and application time.
Each applied correction creates an event-log entry. Original visitor lists,
approvals, payment slips, and migration 0024's receipt-based correction history
are preserved. Incomplete approvals are flagged for review and kept unchanged;
they must not be interpreted as rejected visitors or erased during a bulk repair.

## Staff edits and safeguards

Settled booking totals are guarded against direct database changes and arbitrary
client-supplied totals. Authorized edits to actual guest/age inputs or approval
decisions recalculate the booking charge on the server and advance the guard in
the same database transaction. Reordering visitors keeps approvals associated
with the same person. A newly added child receives their age-based rate. Rejected
visitors are not charged again when the booking editor saves.

An unchanged editor preserves the historical charge, including when the UI
submits recomputed numeric fields. Stale editors change neither the booking nor
its guard. A failure rolls back the charge, guard, and financial audit event.
Refunded bookings remain protected by the existing refund workflow.

`reservation_payment_locks` is now a guard for the settled reservation charge;
its value is not independent proof of money received. Revenue reconciliation
with bank deposits requires payment evidence separately from these booking
charges. Migration 0024's original slip review is retained for that purpose.

## Verification and rollback

Deployment runs `verify-paid-total-preservation.ts` and
`verify-booking-charge-reconciliation.ts`. They cover child age boundaries,
staff additions, rejection preservation, approval alignment, stale edits,
transaction rollback, unchanged saves, archive moves, and preserved unpaid
pricing. A read-only production audit checks the final rows after deployment.

A reversal must verify the corrected version/total/counts, write a reversal
event, and restore the retained prior counts, total and guard in one transaction.
Keep the original correction records. Do not restore an entire old database over
newer bookings or remove the triggers.
