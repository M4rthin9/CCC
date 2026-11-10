# VIS capacity and prisoner booking blacklist

VIS visit dates before 9 November 2026 retain 20 tables per day. From that date
(9 November 2569 BE), the daily limit is 25. Existing settings that specify the
legacy limit of 20 follow this schedule; explicit custom staff limits remain
overrides. Public settings and date counts expose `perDay`, `previousPerDay`
and `effectiveFrom`. The booking frontend uses the selected visit date for
calendar capacity, remaining places and submission checks. TBL keeps its own
capacity. Authorized staff retain the existing capacity override.

From installation of migration 0032, two consecutive Admin/Superadmin
cancellations for a prisoner trigger a three-calendar-month booking ban,
starting at the second cancellation. This includes cancellations for nonpayment;
unpaid VIS bookings do not expire automatically. A paid/completed booking resets
the cancellation streak. Public cancellations and rejection decisions do not add
strikes or reset that streak. One reservation can contribute at most one strike
per prisoner. Shared-table prisoners are included. The next pair of cancellations
starts a fresh streak after a ban is triggered.

Migration 0033 exempts staff cancellations that return the VIS slot: at least
four Bangkok calendar days before the visit, matching `CANCEL_RELEASE_DAYS`.
For a 9 November visit, cancellation on 5 November or earlier adds no strike;
6 November or later counts. Exempt cancellations leave the existing streak
unchanged. This applies to every staff cancellation path and shared prisoners.
The migration also removes identifiable early-cancellation strikes from existing
history and rebuilds only affected prisoners' streaks and bans. Outcomes for
deleted bookings are retained because their visit dates cannot be recovered.

Bans expire automatically at the recorded time, with no cleanup job required.
Calendar-month arithmetic uses Bangkok time and clamps month ends (31 August
becomes 30 November). New bookings, changes of prisoner and reopening cancelled
bookings enforce bans, including staff and Superadmin requests. Existing active
bookings remain usable. Outcomes and bans survive reservation deletion and
archiving. Editing archived historical records does not create new strikes.
Historical cancellations are not backfilled because their actor is not reliably
recorded.

The dashboard's **บัญชีระงับการจอง** page (`#/blacklist`, Admin/Superadmin/Discipline) lists
current warning streaks, automatic warning history, expiry in Bangkok time and
remaining days. Search the roster to apply a manual three-calendar-month ban,
edit the expiry/current warning count, or lift a ban. A manual three-month ban
starts a new warning round. Lifting a ban keeps pending warnings; saving zero
warnings explicitly clears them. Manual changes are recorded in the event log
with the actor, previous state and optional reason. They use the same live
blacklist table and booking guards as automatic bans. Former prisoners remain
visible if they have a blacklist record.

Authenticated actions: `getBookingBlacklist` returns `rows` and `serverTime`;
`updateBookingBan` accepts `prisonerId`, `operation` (`ban`, `unban`, `update`),
and an optional `reason`. `update` additionally requires `warnings` (0 or 1)
and `bannedUntil` (future ISO instant with timezone, or empty to lift the ban).

The prisoner editor now uses `updatePrisoner`, which updates only the selected
`prisonerId` and supplied fields (`prisonerName`, `wing`, `status`, `vinaiDate`,
`note`). It requires `manage_prisoners` (Superadmin/Discipline). The authenticated
`getPrisonersAdmin` list includes notes so edits preserve them; the public list
is unchanged. A wing edit also synchronizes that prisoner's live booking wings.
Full CSV replacement remains an import operation and requires `replaceAll: true`;
old single-row import calls and invalid replacement rows are rejected before
the roster is modified.

These dashboard controls require no new migration and do not reset the database.
Deploy the backend first (including these actions), then the Dashboard. A stale
dashboard's old editor will be rejected safely until it is refreshed.

Release: apply D1 migrations through 0033 before deploying the backend, then deploy the
adjacent Frontend repository. Dashboard only has updated text-catalog defaults.
No production database or deployment is changed by the verification scripts.

Verify with `npm run smoke:prisoners`, `npm run smoke:blacklist`, `npm run smoke:capacity`, `npm run build`,
and the Frontend repository's `npm run check`, `npm run build` and
`node scripts/verify-dated-vis-capacity.mjs` (uses its built files).
