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

Bans expire automatically at the recorded time, with no cleanup job required.
Calendar-month arithmetic uses Bangkok time and clamps month ends (31 August
becomes 30 November). New bookings, changes of prisoner and reopening cancelled
bookings enforce bans, including staff and Superadmin requests. Existing active
bookings remain usable. Outcomes and bans survive reservation deletion and
archiving. Editing archived historical records does not create new strikes.
Historical cancellations are not backfilled because their actor is not reliably
recorded.

Release: apply D1 migration 0032 before deploying the backend, then deploy the
adjacent Frontend repository. Dashboard only has updated text-catalog defaults.
No production database or deployment is changed by the verification scripts.

Verify with `npm run smoke:blacklist`, `npm run smoke:capacity`, `npm run build`,
and the Frontend repository's `npm run check`, `npm run build` and
`node scripts/verify-dated-vis-capacity.mjs` (uses its built files).
