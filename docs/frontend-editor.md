# Dashboard categories and Frontend Editor

The implementation spans `CCC` (backend), `../Dashboard` (admin app), and `../Frontend` (public booking site). Deploy the backend first, then the two apps. No database migration or change to live settings is required.

Dashboard navigation groups every page under Overview, Bookings and Prisoners, Reports, Payments, Website and Communications, or System Administration. Desktop navigation, mobile menus, and menu search share the same definitions. Existing role visibility is preserved; the new administrative pages are available to Superadmin.

Moved out of Settings:

- Booking opening/closing, TBL countdown, and calendar overrides: `#/booking-settings`.
- Payment opening/closing and its customer message: `#/payment-settings`.
- Promotions, popup images, and notices: `#/frontend-editor`, Promotions tab.
- PDPA settings and consent statistics: `#/privacy-settings`.
- Push subscribers: `#/notifications`, below the announcements interface.

Settings retains appearance, archive maintenance, and a collapsed advanced JSON editor. Connection information remains in the existing Connection page.

Frontend Editor provides searchable wording grouped by page and function, with Thai, English, Chinese, and Vietnamese fields. Edit text, save all pending changes, or reset individual fields to their defaults. Search spans categories; pagination keeps the editor usable on mobile. Literal HTML is displayed as text. This edits website copy; text embedded in image files must be changed by replacing the image.

Text is stored in `admin_settings.frontendContent` as language-to-key overrides. The authenticated `saveFrontendContent` action accepts `{ changes: { th: { homeCtaBook: "New label", homeHeroTitle: null } } }`; `null` removes an override. It checks the existing `manage_users` permission and reads current settings before applying only changed text keys. It preserves operational settings and other text/language overrides. Server validation restricts languages and keys, preserves interpolation variables, limits each field to 10,000 characters, and bounds the whole override payload to 512 KB. Empty text is supported for labels without required variables.

`getPublicSettings` returns only registered, valid text overrides. The public site applies them through its translation store and refreshes existing tabs on its normal 15-second settings poll. Default labels remain bundled for missing or unavailable settings. Relationship and religion option values remain canonical even when their visible labels change, so pricing and submitted data keep their meaning. Calendar closures also remain effective when holiday labels are edited or hidden.

The canonical text catalog is generated from the public site's locale files:

```text
node scripts/sync-frontend-text.mjs
node scripts/sync-frontend-text.mjs --check
```

Run synchronization after adding or changing default public text. It updates `src/content/frontend-text.json` and the dashboard's catalog together. Keep those updates with the corresponding frontend changes.

Focused verification:

```text
npx tsx scripts/verify-frontend-content.ts
npx tsx scripts/verify-table-booking.ts
```

The dashboard's `npm test` additionally checks changed-key/reset behavior, placeholder validation, menu categorization, and role visibility. Browser checks with mocked API responses exercise editing, saving, live public updates, language selection, reset, desktop/mobile navigation, promotion relocation, literal HTML handling, and preserved payment/booking switches. They do not send messages, change production settings, or create reservations.
