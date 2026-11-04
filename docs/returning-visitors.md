# Returning visitor approvals

Reuse is scoped to a visitor's ID card/passport number AND the booking's primary
prisoner ID. Both are trimmed and compared case-insensitively. Names alone never
establish identity; a guest without an ID still needs manual approval each time.

- A new VIS booking applies remembered approval separately to its main visitor
  and each extra visitor. Changing guest order or moving a guest between the
  main and extra positions does not lose clearance.
- If everyone has clearance, `participantApproved` is `yes` and the booking
  starts at `รอตรวจสอบวินัย`. Discipline is always blank on a new booking.
- In a mixed party, returning guests have `yes` and new guests remain blank.
  The booking remains in participant review until staff decide the new guests.
- When staff finish all individual decisions, an approved main visitor and
  extras each marked `yes` or `no` complete the participant stage automatically.
  Rejected extras are excluded from the approved attendance and charge. Rejecting
  the main visitor retains the existing whole-booking rejection behavior.
- Staff may also approve the whole participant stage through the existing single
  or bulk action. This clears identified guests except explicit rejections.
- The latest explicit individual rejection stops automatic approval on future
  bookings. It does not auto-reject that person's next booking, revoke other
  existing bookings, or prevent staff approving the person again.
- Automatic reuse does not renew or overwrite the underlying staff decision.
  Retrying an older stage approval cannot override a newer rejection.
- A TBL booking's automatic entry approvals never create VIS clearance.
- Current guest ages and current pricing determine the new charge; prices and
  discipline decisions are never copied from the old booking.

Only accounts with `visitor_approval` or `approve_participant` can record
individual clearance. Public submission cannot supply approval flags. Individual
decisions and their booking update share a D1 transaction; stale or failed
booking writes do not leave a new clearance behind.

The dashboard immediately applies the resulting booking/participant status after
each individual decision. Public booking confirmation displays the server's
actual initial status. Existing pending bookings are not retroactively changed
when someone receives clearance on another booking.

## Migration and rollout

Apply `0031_returning_visitor_clearances.sql` before deploying the backend. It
adds the indexed `visitor_clearances` table and seeds identified guests from
both live and archived VIS bookings. Explicit individual decisions take priority
over the group's participant approval; the latest known booking timestamp wins
between historical records, with a rejection winning a timestamp tie. Payment
alone and legacy names without IDs are insufficient. No existing booking,
payment, charge or attendance data is rewritten.

Deploy the backend, Dashboard and Frontend together. Older clients remain
compatible: they already understand individual approval flags and review
statuses, while the new clients refresh stage status immediately after saving.
Clearances survive archiving and deletion of the original booking.

For a UI rollback, restore the previous Dashboard/Frontend builds and keep the
new backend recording decisions. A full backend rollback can retain the additive
table and all bookings, but the old backend does not update this history; decisions
made during that interval must be reconciled before enabling reuse again. Do not
drop the history table or undo individual booking approvals as part of rollback.

Run `npm run smoke:returning`, `npm run smoke:approvals`, and the existing paid
total preservation check. The returning-visitor check uses in-memory SQLite and
synthetic identities, never production. It covers historical preservation,
partial reuse, identity/prisoner isolation, staff permissions, current child fees,
stage retries, rejection/reapproval, atomic rollback, stale cancellation, public
submission, archive handling and both approval/payment orders.
