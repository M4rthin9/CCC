# Returned-table notifications

Browsers that opt in to `openingAlerts` receive the existing opening notices and
a Thai Web Push when a previously full **TBL** date becomes bookable again.
Booking-status-only subscriptions are excluded. The frontend explains this opt-in
and that an alert does not reserve a table.

Reservation mutations call `reservationChanged`: invalidate cached counts, then
detect availability. The `*/5 * * * *` cron also detects expired unpaid holds
without waiting for a visitor or the daily housekeeping. Alerts link to
`/#/table-booking`; customers must still choose an available date and submit.
Existing cancellation restrictions, pricing, payments and hold duration are unchanged.

The `table_availability` table records full dates. One D1 batch reads current
capacity, captures a durable event, and advances a bounded recipient cursor with
its outbox and daily budget. Concurrent scans and repeated cancellations cannot duplicate an alert;
a date that fills again can generate a later alert. Closed, maintenance, scheduled,
past, weekend/holiday and out-of-window dates are excluded until bookable.

Delivery uses the existing durable outbox and push queue, including recipients
beyond one delivery batch. A failed queue kick is retried by the next scan.
Availability is accurate when queued; another customer may reserve it before
the recipient opens the notification. No LINE broadcast is added.

## Rollout and rollback

1. Verify account-wide D1 Row Metrics for the current UTC day **before any remote
   migration or deployment**. Include other databases and one-time index creation.
   Without Analytics access/headroom, keep this work local; do not enable it.
2. Apply additive migrations `0027_table_availability_alerts.sql` and
   `0028_table_notification_budget.sql` before deploying
   the Worker. It seeds existing full dates and leaves reservation/subscription
   data intact. The existing deployment workflow already migrates first.
3. Deploy the Worker with all three production cron triggers; deploy the frontend
   and its matching dashboard text catalog. The development environment has no
   cron triggers, so run the focused test or invoke the service in development.
4. Rollback by deploying the prior Worker/frontend and restoring its two cron
   triggers. Retain the new table and notification history; old code ignores them.

Local proof: `npm run smoke:availability` executes actual migrations and SQL using
SQLite, tests the real cancellation handlers, and verifies preservation, opt-in
filtering, expiry, concurrent dedupe, closed/scheduled gates, atomic rollback,
delivery restart and deep links without sending any real notifications.

## Free-tier headroom

The Free tier shares 5,000,000 rows read/day and 100,000 rows written/day across
the account; index maintenance also counts. Reset is 00:00 UTC (07:00 Bangkok).
Source: https://developers.cloudflare.com/d1/platform/pricing/

- Availability admits at most 2,000,000 **estimated** scan reads per UTC day,
  reserving a conservative allowance before each scan. This is a feature budget,
  not an account-wide usage meter or a guarantee of physical D1 rows scanned.
- At most 1,000 availability-recipient outbox rows are created per UTC day, with
  at most 2,000 delivery attempts per UTC day, including an older retry backlog.
  Each has index and delivery/retry writes; these are not 1,000 total D1 writes.
  A durable cursor resumes remaining recipients on later days. Events with no
  remaining bookable vacancy are retired before generating further pushes.
  Notifications can still arrive after availability has changed.
- Capacity counts stop at the configured limit and query exact date/status
  indexes. Unchanged states are not rewritten. Idle scans only write one small
  budget-admission counter; a depleted budget performs no additional writes.
- No subscribers/no bookable dates skip scanning. Default expiry checks remain
  every five minutes; capacities over 50 use proportionally fewer scheduled
  scans. Booking/payment operations remain independent of this optional budget.
- Push delivery uses batches of 15 to leave room within D1's 50 queries per Free
  Worker invocation. An exhausted attempt allowance stops the queue chain rather
  than continually requeuing it. Daily processing reserves its small batch for
  booking/payment/other notices; the availability queue retries separately.
  Pending pushes and event cursors have dedicated indexes.
- Public settings read one snapshot instead of seven. The public frontend checks
  settings once a minute while visible and refreshes when returning to the tab.

Actual total usage depends on traffic, database size, retries and other account
workloads. Confirm `meta.rows_read`/`meta.rows_written` and account Row Metrics
before enabling; do not upgrade to Paid to bypass the user's Free-tier constraint.
