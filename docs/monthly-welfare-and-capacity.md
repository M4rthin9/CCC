# Monthly welfare allocation and shared booking capacity

The dashboard's financial report (`#/reports/overall`) deducts 20% for
สวัสดิการร้านสงเคราะห์ from received revenue (ชำระแล้ว / เสร็จสิ้น), leaving
80% net revenue. Pending, cancelled, rejected and refunded bookings are excluded
from this allocation. The summary, monthly table and printed report support all
bookings together or VIS/TBL separately, including archived records. Allocation
is rounded to satang; it does not change booking charges or record a transfer.

Admin-created bookings consume the public daily capacity, but authorized staff
can create additional VIS or TBL bookings even when that pool is full. Public
bookings are refused once the combined count reaches or exceeds the cap.
Existing VIS cancellation release rules are preserved for both sources. TBL
retains its separate pool, seat limit and payment-hold rules. Both public creation
paths check and insert in one SQL statement so competing public requests cannot
exceed the cap. The override belongs to the authenticated staff route and cannot
be enabled through public request fields. A new calendar cache key avoids serving
counts that previously excluded admin bookings.

Deploy the backend and dashboard; no database migration is required. Verify with
`npm run smoke:capacity`, `npm run smoke:table`, and the dashboard's `npm test`.
