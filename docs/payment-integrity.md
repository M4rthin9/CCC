# Historical payment integrity

Money received is determined by payment evidence. Visitor tariffs and approval
counts describe what should be charged; they must not rewrite settled revenue.

Migration 0024 restores seven archived totals reduced by migration 0020 even
though the original stored slips show the higher amount. Each repair has an
original total, snapshot version, visit date, reviewed image SHA-256, timestamp,
and event-log entry. Approval and attendance counts are preserved. Before the
production migration, deployment checks the current row and downloads the
stored slip to verify it is the exact image reviewed. Changed evidence stops
deployment. The migration also stops on a stale booking version or amount.

`reservation_payment_locks` captures recorded totals when a booking is paid,
completed, or refunded. This snapshot alone does not assert that a legacy
payment has been reconciled with the bank. Database triggers prevent total
changes, including after a status reversal or archive move. Ordinary booking
and approval edits return an actionable error for changes that would reprice
a settled booking. Unchanged editor numerics do not recalculate guest fees.

New financial corrections require independent payment evidence and a dedicated,
audited migration. Never unlock a payment by changing its booking status or
bulk-recalculate historical totals from current visitor approvals.

## Audit and unresolved evidence

Run the **Audit production payment integrity** GitHub workflow to inspect both
booking tables. It only executes SELECT queries. Its seven-day artifact contains
reference numbers, amounts, dates, reconciliation flags and sanitized audit
events, without customer names, account numbers or slip images.

The initial 9 October audit covered 2,117 bookings. It found 41 settled bookings
without stored slips, two older approval/tariff differences, no duplicate live
and archive references, and no mismatches with fully auto-verified slip amounts.
VIS-13729's saved slip shows 1,000 while its completed record shows 2,000; a
single slip may be a partial payment, so bank reconciliation is required before
changing that total. VIS-29141's current slip was not available in the local
August backup. These uncertain amounts must not be guessed or overwritten.

The confirmed seven repairs are listed in `scripts/payment-repair-evidence.json`.
VIS-59051's saved slip supports its current 2,000 total. VIS-62668's saved slip
supports restoring 3,000. This raises the 19 August recorded daily total from
45,000 to 46,000; it does not force the total to the previously reported 42,000.

## Preservation and rollback

`payment_total_corrections` retains the original total, expected version and
evidence hash for every repair. The regression test verifies transaction rollback
on stale data, preserved attendance, payment locks through status reversal and
archiving, and unchanged unpaid pricing behavior. Deployment runs that test.

A reversal must be a dedicated transaction: verify the record still has the
repaired total and version, write a reversal event, change its payment lock to
the retained `fromTotal`, then change only the booking total and revision. Stop
if any snapshot changed. Preserve the original correction record and evidence;
do not drop the safeguards or restore an entire old database over current data.
