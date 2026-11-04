# Independent booking approvals

Public prisoner visits need two independent checks: participant approval (Tadtel)
and discipline approval (Vinai). Either team can work first. After both approve,
the booking enters `รอชำระเงิน`, followed by the existing payment and finance flow.
Table bookings continue directly to payment.

The live and archive tables store `participantApproved` and `disciplineApproved`
as `yes` or an empty string. These are booking-level checks, separate from the
individual guests' `visitorApproved` / `extraVisitorApproved` decisions.
The public submission whitelist excludes both booking-level fields.

## API

Use the existing authenticated `updateStatus` action:

```json
{ "action": "updateStatus", "ref": "VIS-12345", "status": "รอตรวจสอบวินัย", "approvalStage": "participant" }
```

```json
{ "action": "updateStatus", "ref": "VIS-12345", "status": "รอชำระเงิน", "approvalStage": "discipline" }
```

The target identifies the requested check. Read `newStatus` in the response for
the actual resulting booking status. The response includes both approval fields.
The first approval leaves a review status; the second opens payment. Permissions
are checked on the authenticated account for each check. Concurrent approvals
use an atomic SQL update; repeating a completed check returns `noop: true`.
Rejected, cancelled, refunded and archived bookings cannot be approved this way.

Older non-Superadmin clients may omit `approvalStage`: `รอตรวจสอบวินัย` means
participant approval and `รอชำระเงิน` means discipline approval. A Superadmin's
explicit manual status change without `approvalStage` retains the force override.
The normal dashboard buttons always supply the stage, including for Superadmin.

`bulkBookingAction` with `operation: "approve"` chooses a pending check permitted
for the account, or accepts an explicit `approvalStage`. Each result reports its
actual `newStatus`. A role with only one approval permission cannot complete the
other team's check by repeating its bulk action.

The dashboard work queues, daily counts, single and bulk actions, participant
review modal, and progress indicators use these independent decisions. Public
lookup exposes the two flags so the visitor's progress indicator is accurate.
Payment QR generation, slip upload, and slip settlement reject pending reviews.
Only the second approval sends the payment-due notification.

## Rollout and rollback

1. Apply `0030_parallel_booking_approvals.sql` to the target D1 database before
   deploying the backend. It adds fields to both tables, backfills completed
   checks from existing statuses, and leaves all existing columns unchanged.
2. Deploy the backend, then the sibling Dashboard and Frontend applications.
   Refresh open dashboard sessions to load the new actions. Until the dashboard
   refreshes, older clients retain their previous sequential UI; the backend
   still requires both decisions.
3. Run `npm run smoke:approvals` for isolated regression verification; it does
   not connect to production. The Dashboard also has queue/store regression tests.

Rollback by restoring the previous app builds and keeping the additive columns
and recorded decisions. Do not drop the fields or undo the backfill. An older
dashboard/backend shows the original sequential workflow, so a discipline-first
booking may require its discipline step to be repeated after participant review.
The independent flags remain available when the new version is restored.

Verification covers both orders, simultaneous calls, repeated clicks, built-in
and custom permissions, early-payment rejection, bulk operations, migration data
preservation, public lookup, archive copying, and the unchanged finance flow.
