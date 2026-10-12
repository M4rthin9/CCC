# Public system status

Customer page: `/system-status.html` on the frontend. Public JSON:
`GET /api/system-status`. The separate static document does not mount the booking
application, run settings polling, or depend on the main application's JavaScript.

The existing five-minute production cron records one bounded KV snapshot, including
seven days of observations. It uses one indexed `admin_settings` SELECT, zero D1
writes, one KV get/put, and one read-only R2 head per scheduled check. That is 288
scheduled queries and KV puts per day, independent of page visitors. Physical D1
row accounting and all account-wide usage still depend on Cloudflare metrics.
KV Free allows 1,000 writes/day shared across the account; keep other KV workloads
within the remaining allowance. Public requests use a canonical 60-second edge
cache and KV only, never the existing diagnostic endpoint, D1 or table scans.

Operational means the specific connection/configuration described on the page
passed. It does not test real bookings, payment transfers, upload writes or push
delivery. Intentional booking closures and scheduled TBL opening are maintenance,
not outages. No slot-availability numbers or invented uptime percentages appear.
Customer announcements reuse the dashboard's existing public promo notice.

There is no historical backfill. Missing observations remain gray. Snapshot age
over 15 minutes is unknown, including when cron/KV/Worker fails. The browser also
rechecks timestamp on refresh so old HTTP cached responses cannot stay green.
Incident intervals represent observation times, not exact outage boundaries.

The status page can remain readable if the backend is unavailable because its
static document lives on Pages. It is not an independent external monitor and
cannot serve if that same Pages site is down. No new account, subscription,
database, migration, external notification, or third-party paid service is added.

Rollout: deploy backend, then frontend. First result appears on the next five-minute
cron, with possible KV propagation delay; unknown is shown beforehand. Development
has no cron. Rollback: deploy the prior commits; retain the inert bounded KV key.

Verification: `npm run smoke:status` checks the real SQLite query, read/write
budgets, maintenance, failures, retention, stale data, privacy, Worker route, edge
cache and no-D1 fallback. The frontend browser script exercises actual built HTML,
desktop/mobile, failures, incident recovery, notice escaping, polling and hidden tabs.
