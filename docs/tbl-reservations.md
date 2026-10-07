# TBL reservations for outside guests

The changes span `CCC` (API), `Frontend` (customer booking), and `Dashboard` (settings and reservation management).

In dashboard **ตั้งค่า → การจองโต๊ะ (TBL)**, click **เริ่มนับถอยหลัง 2 ชั่วโมง**. The API records an opening timestamp exactly two hours after its current time. The homepage displays the Thai announcement banner and a live countdown; the TBL page shows the countdown instead of the booking form. At the deadline, booking opens automatically without a cron job. Opening dates and times display in Bangkok time. The main booking-window switch, date restrictions, seat limit, and daily capacity still apply.

During the countdown, **ยกเลิกการเปิดรับจอง** closes TBL and clears its scheduled opening. After it opens, **ปิดรับจองโต๊ะ** closes it. Opening again starts a fresh two-hour countdown. These controls preserve payment and other settings; existing bookings remain accessible through status lookup.

Before confirming a public TBL booking, customers must explicitly accept the formal seating, no-changes, and no-refund terms in the final confirmation modal. The button reads **ยอมรับข้อตกลงและยืนยันการจอง** and remains disabled until the checkbox is selected. Closing the modal creates no booking. Successful TBL creation navigates directly to that booking's status/payment page and opens its PromptPay payment form. Failed submissions stay on the booking flow.

The API rejects missing acceptance or an outdated agreement version. Version `tbl-2026-10-07-v2` adds final booking details: customers cannot request amendments, changes, rescheduling, or cancellation after accepting and confirming; transferred or PromptPay payments are non-refundable, fully or partially. The API records the agreement version and server acceptance timestamp in the booking and preserves them when archiving. Public cancellation is blocked for bookings accepted under the final-booking terms, and the customer cancellation button is hidden. Earlier TBL bookings keep their original policy.

## Separate dashboard pages

The sidebar has **การจองเยี่ยม (VIS)** at `#/reservations` and **การจองโต๊ะ (TBL)** at `#/reservations/tables`. Each has a separate archive page, respectively `#/reservations/archive` and `#/reservations/tables/archive`. The route fixes the booking type before filters, totals, selection, exports, and printing; a query parameter cannot switch a page to the other type. Dashboard queue and daily links open the appropriate page. Staff creation fixes the type to the current page; TBL forms omit prisoner selection, and TBL progress shows payment and completion. Existing role and action permissions continue to apply.

The shared reservation store still serves overview and reporting. No booking data is moved or rewritten to separate the management pages. Explicit `bookingType` takes precedence; legacy rows without that field use the `TBL-` reference prefix.

## Deployment

Apply `src/db/migrations/0022_table_booking_agreement.sql` before deploying the updated backend: both live and archive queries require the new columns. Deploy the backend and then the dashboard and customer frontend together. The new dashboard action is `setTableBookingStatus` with a boolean `enabled`; it requires the existing `manage_users` permission. No live opening has been scheduled by the code changes themselves.

The banner is at `../Frontend/public/banners/tbl-public-opening.png`. Its generation prompt is saved beside it. It is downloadable from the homepage announcement during the opening campaign.

## Verification

Run `npm run smoke:table` for countdown boundaries, API rejection before opening, open/close permissions, cancellation, settings preservation, and mandatory agreement checks. `npm run smoke` covers existing backend behavior. Use `npm run build` in the backend and `npm run check` / `npm run build` in both Svelte apps.

Verified locally: 143 existing smoke checks, the focused TBL checks including successful creation with a server-recorded acceptance timestamp, refusal of public cancellation under v2, and preserved cancellation behavior for older TBL and VIS bookings; type checking, lint, and builds passed. Browser checks with mocked API responses covered desktop/mobile presentation, automatic opening, closed forms, the agreement checkbox, and dashboard start/cancel. The updated final modal was checked at 390px and 1365px: dismissing creates no booking; failed creation stays on the booking page; retries require fresh acceptance; successful creation opens the matching booking's payment form; cancellation is hidden under v2. All migrations were applied to an in-memory SQLite database to verify that existing bookings and the new agreement fields survive. These checks did not change live settings or customer bookings.
