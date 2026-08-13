# PLAN — PromptPay Bill Payment QR (backend-owned, per-booking) + Server-authoritative pricing

**Status:** v3 — re-verified against the repo at commit `fb8f3e3` (2026-08-13). v2 corrected v1's stale/unsafe assumptions; v3 splits the work into two pillars and adds production slip verification (§6F) + the credential boundary (§6G).
**Workspace:** `H:\Web CIDA` (CCC worker / Frontend SPA / Dashboard SPA)
**Spec reference:** https://thai-qr-payment.js.org/llms-full.txt — **re-fetched 2026-08-13**, not summarized from memory. Payload/CRC findings in §3; the decisive scope limit ("verification that a transaction actually occurred is outside scope") in §6F.1.

---

## 0. What changed from v1 (read this first)

v1 was drafted before migrations `0005`–`0007` landed. Re-verification against the current tree found:

| # | v1 said | Reality | Impact |
|---|---------|---------|--------|
| 1 | New migration is `0002_payment_ref_and_pricing.sql` | `0002_add_indexes.sql` already exists; tree is at **`0007`** | **Blocker** — `wrangler d1 migrations apply` would refuse/misorder. Renumbered to `0008`. |
| 2 | Schema baseline is `0001_initial.sql` | `0004` added `source`; `0006` added `slip_verify_*`; `0007` added `slip_fingerprint`, `slip_image_hash` + 2 partial indexes | Field/column lists in §7 were incomplete. |
| 3 | Slip verify matches static cfg (L257) | Still true, **but** `0006`/`0007` added a `duplicate` status, transaction fingerprinting, and a `reviewRequired: 'no_transaction_id'` gate on `paymentQr` matches | §6C rewritten — per-booking refs must slot *under* the fingerprint layer, not replace it. |
| 4 | dispatcher L143 is an admin `promptpayQr` action | L143 is `generatePromptPayQr` in `POST_ROUTES`, also `auth: false`. **No admin-gated QR action exists.** | §7 corrected. |
| 5 | ref2 = visitor phone, "never exposed via public lookup" | The QR endpoint is keyed on `ref` and unauthenticated; `generateUniqueRefServer` emits `VIS-` + 5 digits (**90k space, enumerable**); `lookupByRef` has no rate limit | **Security regression** — see §6B / §10. ref2 changed to the booking ref. |
| 6 | `ensureBookingPaymentRef` queries existing refs then UPDATEs | Read-then-write TOCTOU: two concurrent QR fetches for one booking mint two refs | **Correctness** — replaced with a conditional UPDATE + unique index (§6B). |
| 7 | `qrcode` "pure JS, works under `nodejs_compat`" | Unverified assumption. `qrcode`'s main entry can pull `fs`/`stream` renderers into the bundle | **Schedule risk** — promoted to a spike at step 0 with an explicit fallback (§6A.3). |

Also newly added in v2: cache invalidation on the lazy ref write (§6B), amount-drift handling (§11), and tamper logging instead of silent override (§6D).

**v3 additions (2026-08-13)**

| # | Finding | Where |
|---|---------|-------|
| 8 | **`'ok'` is unreachable today** — `SlipVerifyStatus` declares it, but no code path returns it. The system cannot confirm a payment at all; every slip goes to manual review by construction | §6F.1 |
| 9 | **The library cannot verify payments** — re-fetched docs: *"verification that a transaction actually occurred is outside scope"*, and no Open-API provider/endpoint/schema is documented. Production verification **requires an external vendor**; no QR-side change substitutes | §6F.1-2 |
| 10 | **Receiver-account matching is the check that matters** and the one most easily omitted — without it, any transfer of the right amount to anyone validates | §6F.3 |
| 11 | **`getPromptPayConfig` is public today**, handing biller identity + refs to any caller purely because the frontend built QRs client-side. Fetch-only makes it unnecessary ⇒ gate it. *The one breaking change here — sequencing matters* | §6G.1, §13 step 10 |
| 12 | **Biller identity is hardcoded into both client bundles** (`promptpay-biller.js`, `Dashboard/utils/promptpay.ts`) — publicly readable JS. Already slated for deletion; now with a security rationale | §6G.2 |
| 13 | A slip carrying **only our own paymentQr and no bank Mini-QR** is affirmatively suspicious (it is a screenshot of our unpaid payment screen), not merely unverified — label it distinctly | §6F.4 |
| 14 | Q4 closed: the Mini-QR carries **no reference fields**, so `ref2` could never have served slip verification | §6B.1 |

---

## 1. Objective

1. **Fix the PromptPay payment QR** so every booking gets its own working QR:
   - `billerId` = fixed institution biller `010753700088205` (15-digit; Tax ID + suffix).
   - `Reference 1` (ref1) = a **new dynamic alphanumeric invoice number generated per booking**, bound to that booking (NOT `VIS-00001`, which the bank rejected).
   - `Reference 2` (ref2) = the **booking ref, hyphen-stripped** (`VIS00001`) — see §6B for why this replaced v1's "visitor phone".
2. **Move ALL PromptPay QR creation to the backend** (Cloudflare Worker). Frontend + Dashboard become fetch-and-display only — no client-side EMVCo building, **and no biller credentials or configuration reaching the client** (§6G: `getPromptPayConfig` gated, hardcoded biller identity removed from both bundles, public response minimized).
3. **Recalculate the price on every booking** server-side from attendance count + ages (server-authoritative, not trusting client-submitted `total`/counts).
4. **Make slip verification production-grade** — move from *"a QR was parsed"* to *"the bank confirms this payment happened, for this amount, into our account"*. Requires an external verification provider (§6F); the QR library explicitly cannot do this.

## 2. Scope

This plan has **two pillars**, independent enough to ship separately:

- **Pillar 1 — Traceable QR + server-authoritative pricing** (§6A–§6E). Every booking gets its own `ref1`, so a payment traces back to a booking. Self-contained, no external dependencies.
- **Pillar 2 — Production slip verification** (§6F). Turns *"we parsed a QR"* into *"the bank confirms this payment happened, for this amount, into our account"*. **Requires a third-party verification provider** — §6F.1 shows why the library cannot do this and why no amount of QR parsing will.

Pillar 1 is a prerequisite for Pillar 2's reconciliation path, but not for its API path. Pillar 2 can be deferred without blocking Pillar 1.

**In scope — Pillar 1**
- CCC worker: migration `0008`, `paymentRef` service, `qrImage` service, async QR route (+ `ref` path), per-booking slip verify, pricing recalc, dependency moves.
- Frontend: `getPaymentQr(ref)` endpoint + `PaymentForm.svelte` renders backend QR.
- Dashboard: `ReservationDetailModal.svelte` fetches QR by ref; `PromptPay.svelte` sample QR via backend; remove duplicate EMVCo builder.
- Tests: extend `scripts/verify-smoke.ts`; typecheck + lint + **`npm run build`** (bundle gate) + frontend/dashboard checks.

**In scope — Pillar 2**
- Migration `0009`; `services/slipProvider.ts` (vendor-agnostic interface) + one adapter; receiver/amount/freshness checks; the `'ok'` status made reachable; KV result cache keyed on `transRef`; admin reconciliation lookup by `payment_ref1`.

**Out of scope**
- **Vendor selection/procurement.** §6F.2 defines the interface and selection criteria; the commercial choice is yours. Nothing else in the plan depends on which vendor wins.
- Slip OCR (image → text) — the provider path supersedes it.
- Fixing `VIS-XXXXX` ref enumerability itself (follow-up F1, §14).

---

## 3. Spec review — thai-qr-payment.js.org (llms-full.txt)

*(Unchanged from v1 — re-verified against `src/services/promptpay.ts` and `src/services/slipverify.ts`; both still conform.)*

### 3.1 BillPayment payload structure (EMVCo MPM, Merchant Account template)

Cross-Bank BillPayment is **tag `30`** (tag 29 is the PromptPay merchant/TrueMoney template):

| Tag | Field | Value / notes |
|-----|-------|---------------|
| 00 | Payload Format Indicator | always `01` |
| 01 | Point of Initiation | `11` static / `12` dynamic (flip to `12` when a non-zero amount is set) |
| 30 | Merchant Account Info — **BillPayment** | nested TLV below |
| 30/00 | GUID | `A000000677010112` (domestic) · `A000000677012006` (cross-border) |
| 30/01 | Biller ID | 15 chars on the wire (Tax ID + suffix); shorter zero-padded left, longer throws |
| 30/02 | Reference 1 | "application-defined" |
| 30/03 | Reference 2 | "application-defined" |
| 52 | Merchant Category Code | 4-digit ISO 18245 |
| 53 | Transaction Currency | always `764` (THB) |
| 54 | Transaction Amount | ≤ `9,999,999,999.99`, 2 decimals, no symbol; zero/omitted ⇒ static QR |
| 58 | Country Code | always `TH` |
| 59 | Merchant Name | ≤ 25 alphanumeric (auto-truncated) |
| 60 | Merchant City | ≤ 15 alphanumeric |
| 62 | Additional Data Field Template | 01 Bill Number, 02 Mobile, 03 Store Label, 04 Loyalty, 05 Reference Label, 06 Customer Label, **07 Terminal Label**, 08 Purpose, 09 Consumer Data Request |
| 63 | CRC | CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`, no reflect, no XOR out) over the body **plus** the `6304` header; 4 uppercase hex digits |

> *"CRC is CRC-16/CCITT-FALSE ... computed over the body plus the `6304` tag header. Missing that header in your verifier is the classic off-by-spec mistake."*

**Verified in code:** `promptpay.ts:74-76` builds `withoutCrc + '6304'` then appends `crc16(withCrcMarker)`. ✅ Correct.

### 3.2 Reference 1 / Reference 2 rules

- Both are **optional** in builder and parser — spec leaves them "application-defined".
- No documented character-set cap or 25/30-char max for the QR variant; hard constraints are the EMVCo 2-digit length header (≤ 99 chars) and QR alphanumeric mode: `[0-9A-Z $%*+-./:]`.
- In the sibling **BOT 1D barcode** format, `ref1` is **mandatory**, `ref2` optional.

**Corrections vs. earlier assumptions**
- BillPayment is tag **30**, not 29. Existing `buildPromptPayBillPayment` emits tag 30 with AID `A000000677010112` — **correct**.
- Biller ID strictly 15 digits (`/^\d{15}$/` at `promptpay.ts:44`). `010753700088205` = 15 digits — **correct**.
- The guide states **no** "no hyphen" rule; hyphen is in the EMVCo alphanumeric charset. The `VIS-00001` failure is a real-world *bank-side* constraint, not a spec violation. **Decision:** conservative uppercase-alphanumeric refs (no special chars) for maximum bank/scanner compatibility.

### 3.3 Slip Verify Mini-QR (used by `slipverify.ts`)

- Bank envelope: root tag `00` (`00`=API type `000001`, `01`=sending bank 3-digit BoT code, `02`=transaction ref), tag `51`=`TH`, tag `91`=CRC-16/CCITT-FALSE uppercase.
- TrueMoney variant: same root/country/CRC; sub-tags `00`/`01` marker `'01'`, `02` event type, `03` transaction id, `04` date `DDMMYYYY`; **lowercase** CRC.
- Worker already uses `@thai-qr-payment/payload` (`parsePayload`, `parseSlipVerify`, `parseTrueMoneySlipVerify`) at `slipverify.ts:4`. **No parsing change needed** — only the expected-value source changes (§6C).

### 3.4 Dependencies

- `@thai-qr-payment/payload ^1.2.0` — already a runtime dependency. Its `billPayment()` builder is spec-faithful, but our hand-rolled builder additionally carries `ref3` as 62/07 (Terminal Label). **Keep the existing builder**; add charset validation + auto-POI (§6A).
- `qrcode ^1.5.4` — currently a **devDependency**, used only by `scripts/verify-smoke.ts`. Moving it to runtime deps is **gated on spike S0** (§6A.3).

---

## 4. Root cause recap

- Bookings use `VIS-XXXXX` refs (`generateUniqueRefServer`, `reservationService.ts:43`). The hyphenated ref was rejected by the bank as Reference 1 → "the QR didn't work".
- Frontend (`PaymentForm.svelte`) and Dashboard **build the QR client-side** from static defaults (`ref1: 'ML099400ZO0160208VX'`, `ref2: 'CIDA'`) — **every booking shares one ref**, so the biller report cannot attribute a payment to a booking. The builder is duplicated in 3 places (CCC `services/promptpay.ts`, Frontend `promptpay-emvco.js`, Dashboard `utils/promptpay.ts`).
- Slip verification (`slipverify.ts:257`) compares scanned refs against **static cfg** (`cfg.ref1/ref2/ref3`), so a slip for booking A validates identically against booking B.
- Pricing: the backend **trusts client-submitted** `total`, `adultCount`, `child5to8Count`, `childUnder5Count`, `visitorCount`, `totalPersons` on every write path (`validateSaveReservation` only sanitizes them to non-negative ints). `visitorAge` for the main visitor is sent by the frontend (`booking.svelte.ts:610`) but **never persisted**, so it cannot be recomputed server-side.

---

## 5. Current state (verified at `fb8f3e3`)

**CCC (Cloudflare Worker + D1 + KV)**
- `src/services/promptpay.ts` — `buildPromptPayBillPayment` (tag 30 TLV + CRC-16), `buildTlv`, `crc16`. Spec-correct; **no ref charset validation**; `pointOfInitiation` defaults `'11'` and is never auto-flipped.
- `src/services/promptpayConfig.ts` — `PROMPTPAY_DEFAULTS` + `getPromptPayConfig(env)` (reads `admin_settings.promptpay`, never throws).
- `src/routes/promptpay.ts` — `handleGetPromptPayConfig(env)` (async) + `handleGeneratePromptPayQr(body)` (**sync**, no `env`, builds purely from caller-supplied fields, returns `{ status, payload }` only — **no image**).
- `src/routes/dispatcher.ts` — `generatePromptPayQr` at **L91** (GET_ROUTES, `auth: false`) and **L143** (POST_ROUTES, `auth: false`). Neither passes `env`. There is **no** admin-gated QR action.
- `src/services/slipverify.ts` — `verifySlipBytes(db, bytes, cfg, booking)`; downscales to `MAX_SCAN_DIM=1600` before `jsQR`; two-pass scan (mask + rescan) since slips carry both Mini-QR and payment QR; `buildPaymentResult` matches static cfg at **L256-257**; fingerprint dedupe via `findReservationBySlipFingerprint`; statuses `ok | mismatch | slip_verify | unreadable | duplicate`.
- `src/services/pricing.ts` — `BASE_MAIN_FEE=2000` (main 1000 + prisoner 1000), `EXTRA_VISITOR_FEE=1000`, child free `<5` / half `500` `≤8`. `extraVisitorFee` hardcodes the Thai relation `'บุตร / ธิดา'`. `computeApprovalTotals(mainApproved, extraVisitorApproved, extraVisitorNames)` — **no main-visitor discount**, and charges `BASE_MAIN_FEE` even when `mainApproved` is false.
- `src/services/reservationService.ts` — `validateSaveReservation` (sanitize only), `generateUniqueRefServer`, `parseUpdateBookingFields`.
- `src/routes/public.ts` — `handleSaveReservation` (Turnstile-gated), `handleLookupByRef` (**unauthenticated, KV-cached 15s, no rate limit**), `maskRowForPublic` (whitelist via `PUBLIC_LOOKUP_FIELDS`; strips all but names from `extraVisitorNames`).
- `src/routes/reservations.ts` — `handleCreateBooking`, `handleUpdateBooking`, `handleUpdateVisitorApproval`.
- `src/constants.ts` — `SAVE_RESERVATION_FIELDS` (L100), `SAVE_NUMERIC_FIELDS` (L127), `SAVE_STRING_CAPS` (L136), `UPDATE_BOOKING_FIELDS` (L157), `UPDATE_BOOKING_NUMERIC` (L182), `UPDATE_BOOKING_CAPS` (L191), `STANDARD_HEADERS` (L209), `PUBLIC_LOOKUP_FIELDS` (L239).
- `src/db/queries/reservations.ts` — `RESERVATION_COLUMNS` (L4, 37 cols incl. `slip_verify_*`, `slip_fingerprint`, `slip_image_hash`, `source`); `RESERVATION_WRITABLE_COLUMNS = [...RESERVATION_COLUMNS, 'slip_base64']`; `updateReservationColumns`; archive copy uses `[...RESERVATION_COLUMNS, 'slip_base64', 'archivedAt']`.
- `src/cache/kv.ts` — `checkRateLimit(kv, key, max, ttl)` + `resetRateLimit`; currently used **only** by login (`routes/auth.ts:22`).
- `src/db/migrations/` — `0001`…**`0007`**. Next free number is **`0008`**.
- `package.json` — `qrcode` + `@types/qrcode` in devDependencies.
- `scripts/verify-smoke.ts` — standalone `tsx` script (no test runner in this repo). Dynamic-imports `qrcode.toBuffer`, composes two QRs into one PNG via `UPNG`, converts to JPEG, calls `verifySlipBytes` with a `fakeDb` stub (`prepare().bind().first() => null`) and `booking = { ref: 'VIS-00001', total: 500 }`. Assertions via a `check(name, actual, expected)` helper.

**Frontend (Svelte 5, runes only)** — `promptpay-biller.js` (duplicate static defaults), `promptpay-emvco.js` (client EMVCo builder → delete), `components/status/PaymentForm.svelte` (`onMount` → `QRCode.toDataURL`), `lib/api/endpoints.ts`, `lib/api/types.ts`, `lib/store/booking.svelte.ts` (`calcCost` at L76 = pricing source of truth; `submit()` sends `visitorAge` + counts + `total`), `lib/utils/validation.ts` (`normalizePhone`).

**Dashboard (Svelte 5)** — `ReservationDetailModal.svelte` (local `buildBillerPayload`), `ReservationFormModal.svelte` (builds `extraVisitorNames`; no main `visitorAge`), `lib/utils/promptpay.ts` (duplicate builder → delete), `routes/PromptPay.svelte`, `lib/api/endpoints.ts`.

---

## 6. Design

### A. Backend-owned QR generation

**A.1 — Builder hardening** (`services/promptpay.ts`)
- Add `REF_PATTERN = /^[A-Z0-9]+$/` validation for `ref1` and `ref2`, with an explicit error naming the offending value. *This is the `VIS-00001` guard — it makes the original bug unrepresentable.*
- Auto-POI: when `amount` is present and `Number(amount) > 0` ⇒ `pointOfInitiation: '12'`; otherwise honor the caller / default `'11'`. An explicit caller-supplied `'12'` with no amount stays an error-free no-op (matches spec: dynamic without amount is legal but pointless).
- Keep everything else — the TLV/CRC path is spec-verified (§3.1).

**A.2 — `src/services/qrImage.ts` (NEW)**
```
renderQr(payload: string): Promise<{ svg: string; qrDataUrl: string }>
```
SVG via `QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 300 })`; `qrDataUrl = 'data:image/svg+xml;base64,' + btoa(svg)`.
Return **`qrDataUrl` only** to clients — v1 returned both `qrSvg` and `qrDataUrl`, doubling the response for the same bytes. Keep `svg` internal for the smoke test.

**A.3 — Spike S0: does `qrcode` bundle into a Worker?** ⚠️ *Do this first.*
`qrcode`'s package entry can pull `fs`/`stream`-backed renderers into the bundle. Verify with `npm run build` (which runs `wrangler deploy --dry-run`) against a one-line import before writing any other code.
- **Pass** → move `qrcode` to `dependencies`, proceed.
- **Fail, fixable** → import the browser entry (`qrcode/lib/browser`) and re-verify.
- **Fail, unfixable** → **Fallback F-QR:** the endpoint returns `payload` only and each client renders it with its own already-present QR lib. Objective 2 (single source of truth for the *payload*) is still met; only image rendering stays client-side. Cost: ~1h of frontend work, no redesign.

**A.4 — `src/routes/promptpay.ts` → async, two paths**
1. **Per-booking** — `{ ref }`:
   `getReservationByRef` → 404-shape error if absent → `ensureBookingPaymentRef(env, ref)` (§6B) → `getPromptPayConfig(env)` for `billerId`/`ref3` → `amount = booking.total` → build (POI `12`) → render.
   Returns `{ status, payload, qrDataUrl, billerId, ref1, ref2, ref3, amount }`.
2. **Sample/diagnostic** — existing `{ billerId, ref1, ref2, ref3, amount }` fields, kept for the Dashboard `PromptPay.svelte` test card; now also returns `qrDataUrl`.

Dispatch on `body.ref` being present. Both paths need `env` (path 1 for D1, path 2 for `getPromptPayConfig`).

**A.5 — `src/routes/dispatcher.ts`** — pass `ctx.env` at **L91** and **L143**; both handlers become `await`ed. (Correcting v1: L143 is *not* an admin action — it is the POST twin of L91, also `auth: false`.)

### B. Per-booking Reference 1 (`payment_ref1`) + Reference 2

**B.1 — Why ref2 is no longer the phone number** ⚠️ *security change vs. v1*

**Resolved 2026-08-13 (Q4).** The stated rationale for `ref2 = phone` was "to verify the Mini-QR from the customer's slip upload". That is not mechanically possible — **the Mini-QR carries no reference fields at all**:

| Envelope | Parser | Fields carried |
|----------|--------|----------------|
| Bank Mini-QR | `parseSlipVerify` | `sendingBank`, `transRef` — *that's it* |
| TrueMoney Mini-QR | `parseTrueMoneySlipVerify` | `eventType`, `transactionId`, `date` |
| **Our payment QR** | `parsePayload` → `billPayment` | biller, **reference1/2/3**, amount, POI, CRC |

Reference comparison happens in exactly one function — `buildPaymentResult` (`slipverify.ts:256-257`) — and `parseEnvelope` only ever routes the **`paymentQr`** envelope there. The Mini-QR path is `buildSlipVerifyOnlyResult`, which compares *nothing* and returns `reviewRequired: true` with the standing comment *"The Mini-QR has no amount or biller identity — manual review required"* (`slipverify.ts:300`). ⇒ `ref2` is never read when a Mini-QR is scanned, regardless of its value.

The underlying concern is real and stays open: a Mini-QR proves *"a transfer with this transRef occurred at this bank"*, **not** *"that transfer paid this booking for this amount"*. Nothing in the Mini-QR binds transaction → booking. The three ways to close that gap are §14 F3 (bank Open API on `sendingBank`+`transRef` — what the Mini-QR is designed for, and both values are already stored as `slip_fingerprint`), biller-statement reconciliation via `ref1`, or slip OCR. None involve `ref2`.

Independently, the v1 assertion that "`visitorPhone` is never exposed via the public lookup API" does not hold for the new endpoint:

- `handleGeneratePromptPayQr` is `auth: false` and keyed solely on `ref`.
- `generateUniqueRefServer` mints `'VIS-' + Math.floor(10000 + Math.random() * 90000)` — a **90,000-value space**, trivially enumerable.
- Neither `lookupByRef` nor the QR action is rate-limited (`checkRateLimit` is wired to login only).

⇒ A scripted walk of `VIS-10000..VIS-99999` would harvest the phone number of every visitor in the system, from a payload that today deliberately excludes it (`PUBLIC_LOOKUP_FIELDS`). That is a strict privacy regression introduced by this change.

So `ref2 = phone` carries privacy cost for **zero** benefit: it cannot serve its stated Mini-QR purpose (above), and on the one path where refs *are* compared (`paymentQr`), **ref1 is already unique per booking** — strictly more specific than a phone number, which is shared across a visitor's repeat bookings. **Decision:** `ref2 = booking.ref.replace(/-/g, '')` (e.g. `VIS00001`) — alphanumeric-safe, human-recognizable on a bank statement, and reveals nothing the caller did not already supply.

**B.2 — `src/services/paymentRef.ts` (NEW)**
- `REF_PREFIX = 'PP'`; `REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'` (29 chars — no `0 O 1 I L Q`).
- `generatePaymentRef()` → `'PP' + 10 chars` (12 total, e.g. `PP4K7MX9QW2D`). Collision space 29¹⁰ ≈ 4.2×10¹⁴.
- `ensureBookingPaymentRef(env, ref): Promise<string>` — **idempotent and concurrency-safe** (fixes v1's read-then-write race, which could mint two refs for one booking and orphan an already-scanned QR):
  1. `SELECT payment_ref1 FROM reservations WHERE ref = ?` → return it if non-empty.
  2. `UPDATE reservations SET payment_ref1 = ? WHERE ref = ? AND payment_ref1 = ''` — the `AND payment_ref1 = ''` predicate makes the first writer win.
  3. Re-`SELECT` and return the stored value (the loser of a race gets the winner's ref, not its own).
  4. On unique-index violation (§8), regenerate and retry, max 5 attempts.
  Backed by a partial unique index rather than v1's full-table "query existing values" scan.
- **Cache invalidation** *(missed in v1)*: step 2 mutates the row, so follow with `invalidateReservationsCache(env)` + `invalidateLookupCache(env, ref)`, exactly as `persistVerify` does (`slipverify.ts:323-324`). Without this the admin list serves a stale row from KV.
- Lazy generation at QR/slip-verify time ⇒ **no backfill script**, legacy rows self-heal on first access.

### C. Slip verification per booking

**C.1 —** In `buildPaymentResult` (`slipverify.ts:256-257`), replace static-cfg matching:
- `expectedRef1 = booking.payment_ref1 || cfg.ref1` (legacy fallback while rows self-heal)
- `expectedRef2 = booking.ref.replace(/-/g, '') || cfg.ref2` — but **only when `booking.payment_ref1` is set**; a legacy row must compare against `cfg.ref2` or every historical slip flips to `mismatch`.
- `cfg.ref3` (62/07) unchanged.

Report the two as separate mismatch reasons (`ref1` / `ref2`) instead of one opaque `refs`, so the dashboard can say *which* reference disagreed.

**C.2 — Ordering is load-bearing.** The `0007` duplicate check runs *after* the match result is built and overrides it (`slipverify.ts:394-408`). Per-booking refs must not change that: a reused transaction stays `duplicate` even if refs now match perfectly. Do not move the dedupe block.

**C.3 — Per-booking refs do NOT make `paymentQr` auto-confirmable.** ⚠️
`slipverify.ts:266-269` deliberately routes a fully-matching `paymentQr` to `slip_verify` + `reviewRequired: 'no_transaction_id'`, because our own QR carries no bank transaction id — a screenshot of the *unpaid* QR matches just as well as a paid one. Unique ref1 does not change this; it strengthens **reconciliation** (the bank's biller report now maps ref1 → booking), not **proof of payment**. Keep the `reviewRequired` gate exactly as-is. State this explicitly so a later change does not "optimize away" a manual review step that is the only thing standing between a screenshot and a confirmed booking.

**C.4 —** Amount matching against `booking.total` is unchanged — but see the drift risk in §11.

### D. Server-authoritative pricing

**D.1 — Persist the main visitor's age.** Add a `visitorAge` column (§8) and thread it through: `SAVE_RESERVATION_FIELDS`, `SAVE_STRING_CAPS` (cap 8), `UPDATE_BOOKING_FIELDS`, `UPDATE_BOOKING_CAPS` (8), `STANDARD_HEADERS`, `RESERVATION_COLUMNS`, and the `Reservation` type. **Not** in `SAVE_NUMERIC_FIELDS` — `''` must stay distinguishable from `0` (unknown age ≠ newborn). The frontend already sends it.

**D.2 — Shared pricing module** (`services/pricing.ts`)
- `export const CHILD_RELATIONS = ['บุตร / ธิดา', 'Child', '子女', 'Son/Daughter']` — matches `booking.svelte.ts:33`. Compare trimmed.
- `computeBookingCost({ relation, visitorAge, extraVisitorNames })`, mirroring frontend `calcCost`:
  - `PRISONER_FEE (1000) + mainFee + Σ extraFees`
  - main visitor: `1000`, unless `relation ∈ CHILD_RELATIONS` and age `<5` ⇒ `0`, `≤8` ⇒ `500`
  - extras parsed from `extraVisitorNames` (`name|id|relation|age` joined by `;;`), same discount ladder
  - returns `{ total, visitorCount, adultCount, child5to8Count, childUnder5Count }`; `totalPersons = visitorCount + 1`
- Keep `BASE_MAIN_FEE = 2000` as `PRISONER_FEE + MAIN_VISITOR_FEE` (both `1000`) so the two modules cannot drift apart — express it as a sum, not a literal.
- Refactor `extraVisitorFee` to use `CHILD_RELATIONS`.

**D.3 — Two pre-existing bugs in `computeApprovalTotals` this touches** (decide before coding):
- **(a) No main-visitor child discount.** It always adds `BASE_MAIN_FEE`, so approving a booking whose *main* visitor is a 4-year-old silently re-inflates the total the frontend correctly discounted. Fixing it requires a signature change to accept `relation` + `visitorAge`, rippling into `handleUpdateVisitorApproval`. **Recommend: fix**, since D.1 finally makes the inputs available.
- **(b) Main fee charged even when `mainApproved` is false.** `correctTotal` starts at `BASE_MAIN_FEE` unconditionally while `visitorCount` excludes the unapproved main visitor — an internally inconsistent row. **Recommend: leave as-is in this change** and track separately; it is orthogonal to the QR work and changing it re-prices live bookings.
- ⚠️ Either fix **re-prices existing bookings on their next approval action**. Not a data migration (nothing is rewritten retroactively), but finance-visible. Needs sign-off — see §14 Q2.

**D.4 — Hook points.** Server value wins; **log the discrepancy** rather than overriding silently (v1 said "silent"):
- `handleSaveReservation` (`public.ts`) and `handleCreateBooking` (`reservations.ts`): after `validateSaveReservation`, run `applyServerPricing(data)`; if a client-supplied `total` was present and differs, `logEvent(env, actor, 'pricing_override', ref, { clientTotal, serverTotal }, 'success')`. Costs one row and turns a silent correction into a tamper signal.
- `handleUpdateBooking`: after `parseUpdateBookingFields`, merge with the current row; if `relation` / `visitorAge` / `extraVisitorNames` changed **or** any pricing numeric was supplied, recompute from the merged row, **drop the client numerics from `cols`**, and append the authoritative ones.
- `handleUpdateVisitorApproval`: keeps its approval-time recompute, now via shared `CHILD_RELATIONS` (+ main discount per D.3a).

### E. Frontend / Dashboard become fetch-only

- **Frontend:** add `getPaymentQr(ref)` to `endpoints.ts` + `PaymentQrResponse` to `types.ts`; `PaymentForm.svelte` `onMount` fetches by `booking.ref` and binds `qrSrc = res.qrDataUrl`; drop the `promptpay-emvco.js` import, `QRCode.toDataURL`, and the `getPromptPayConfig` call. Delete `promptpay-emvco.js`; prune now-dead exports from `promptpay-biller.js`.
  Needs a loading + error state — the QR is now a network round-trip on a payment screen, not a synchronous local render. v1 omitted this.
- **Dashboard:** `ReservationDetailModal.svelte` fetches `{ ref }` and renders `qrDataUrl` (drop local `buildBillerPayload`); `PromptPay.svelte` uses the sample path; delete `lib/utils/promptpay.ts`.
- **Recommended:** `ReservationFormModal.svelte` gains a main-visitor `visitorAge` field, so admin-created bookings can earn the child discount. Absent ⇒ priced as adult, matching frontend behavior.

### F. Production slip verification (Pillar 2)

**F.1 — Why the library cannot do this, and neither can any QR change**

Re-fetched `llms-full.txt` on 2026-08-13. The decisive statements:

> *"The library parses QR structure only; verification that a transaction actually occurred is outside scope."*
> *"...suitable for embedding in a printed slip and looking the transaction up via bank Open APIs."* — with **no provider names, URLs, or response schemas documented.**

The Mini-QR yields `sendingBank` + `transRef` and nothing else (§6B.1 table). Those are a **pointer to** a transaction record, not the record. Everything that matters for accepting money — amount, destination account, timestamp, success/reversal — lives on the bank's side. No change to our QR, our refs, or our parser can recover it.

⚠️ **Today the system cannot confirm a single payment.** `SlipVerifyStatus` declares `'ok'`, but **no code path returns it** — `buildPaymentResult` yields `slip_verify`/`mismatch`, `buildSlipVerifyOnlyResult` yields `slip_verify`, and the remaining paths yield `unreadable`/`duplicate`. Every uploaded slip lands in manual review by construction. That is the correct behavior given the available data, and it is exactly the gap "production" has to close.

**F.2 — Provider abstraction** (`src/services/slipProvider.ts`, NEW)

Vendor-agnostic so the commercial decision stays reversible:
```ts
export interface VerifiedTransaction {
  amount: number;
  receiverAccount: string;   // masked account/PromptPay id of the payee
  receiverName: string;
  senderName: string;
  transferredAt: string;     // ISO
  raw: unknown;              // provider response, persisted for audit
}
export interface SlipProvider {
  name: string;
  verify(input: { sendingBank: string; transRef: string; amount?: number }):
    Promise<{ ok: true; tx: VerifiedTransaction } | { ok: false; reason: 'not_found' | 'rate_limited' | 'provider_error' | 'not_configured' }>;
}
```
Candidate classes (**verify current terms before committing — do not take these as specified**): Thai slip-verification aggregators (SlipOK / EasySlip / Slip2Go and similar), or a direct bank Open API if you hold a corporate agreement with the receiving bank. Selection criteria that actually matter here: (a) accepts `sendingBank`+`transRef` rather than requiring an image upload; (b) returns **receiver account**, not just amount — without it the check is worthless (§F.3); (c) per-call cost and monthly quota against your booking volume; (d) uptime/latency inside a Worker's limits.

Credentials via `wrangler secret put SLIP_PROVIDER_KEY` — **never** in `wrangler.toml` `[vars]`, never in a response body, never in the client bundle (§6G).

**F.3 — The four checks that make `'ok'` meaningful**

A slip proving *"someone transferred 2,000 THB"* is worth nothing on its own. All four must pass, or the result degrades to manual review:

1. **Receiver** — `tx.receiverAccount` matches our configured payee. *Without this, any transfer to anyone validates.* This is the single most important check and the one most often omitted.
2. **Amount** — `|tx.amount − booking.total| < 0.005` (reuse the existing tolerance).
3. **Freshness** — `tx.transferredAt` is after `booking.createdAt` and within a configurable window (default 7 days). Blocks replaying a genuine but unrelated older transfer.
4. **Uniqueness** — `bank:{sendingBank}:{transRef}` unused by another booking. Already implemented (`findReservationBySlipFingerprint`, `0007`) — reuse it unchanged.

All four pass ⇒ **`status: 'ok'`** (first reachable use). Any failure ⇒ `mismatch` with a specific reason. Provider error/timeout/quota ⇒ **`slip_verify` + `reviewRequired`, never `ok`** — fail closed.

**F.4 — A slip carrying only our `paymentQr` and no bank Mini-QR is a red flag** *(new)*

Real bank slips carry the bank's Mini-QR. A "slip" containing only the QR **we** generated is, by construction, a screenshot of our own unpaid payment screen — the exact forgery this system is exposed to. Today that case returns `slip_verify` + `reviewRequired: 'no_transaction_id'` (`slipverify.ts:266-269`), which is right but under-labelled. In production, give it its own reason (`payment_qr_only`) and surface it distinctly in the dashboard so reviewers treat it as suspicious rather than merely unverified. Keep §6C.3's rule: it must never auto-confirm.

**F.5 — Cost, caching, idempotency**

Providers bill per call. Only call when a **Mini-QR actually parsed** (never for `paymentQr`-only or unreadable slips). Cache the provider response in KV keyed on `slipverify:{sendingBank}:{transRef}` (TTL 30d) so re-verification, retries, and duplicate uploads cost one call. Persist `tx.raw` into `slip_verify_json` for audit.

**F.6 — Migration `0009`**
```sql
-- 0009: provider-backed slip verification.
ALTER TABLE reservations ADD COLUMN slip_tx_json    TEXT NOT NULL DEFAULT '';  -- VerifiedTransaction incl. raw
ALTER TABLE reservations ADD COLUMN slip_verified_by TEXT NOT NULL DEFAULT ''; -- provider name, '' = not provider-verified
ALTER TABLE reservations_archive ADD COLUMN slip_tx_json    TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN slip_verified_by TEXT NOT NULL DEFAULT '';
```
Plus `RESERVATION_COLUMNS` += both (and therefore the archive coupling of §7 applies again).

**F.7 — Reconciliation lookup.** Add an admin-only `getBookingByPaymentRef` action (backed by `0008`'s unique index) so a `ref1` off a bank biller statement resolves to its booking in one query. This is what Pillar 1 buys you even if Pillar 2's API path is deferred.

### G. Credential & confidentiality boundary

Making the frontend fetch-only is not just a refactor — it removes data that is public today.

**G.1 — `getPromptPayConfig` must leave the public surface.** It is currently `auth: false` and returns `{ billerId, ref1, ref2, ref3, pointOfInitiation }` to any caller, because the frontend needed it to build the QR client-side. **After §6A/§6E, no frontend needs it at all.** ⇒ Gate it to admin auth (Dashboard settings screen still uses it) and drop the public route. Leaving it public would keep a hole open for zero benefit.

**G.2 — Delete hardcoded biller identity from client bundles.** `Frontend/src/lib/utils/promptpay-biller.js` and `Dashboard/src/lib/utils/promptpay.ts` ship `BILLER_ID` / `REF_1` / `REF_2` inside publicly-readable JS. §7 already deletes both files; this is the security rationale, not just dead-code cleanup.

**G.3 — Minimize the QR response.** Return `{ status, payload, qrDataUrl, amount }` to public callers. Drop `billerId`/`ref1`/`ref2`/`ref3` as separate JSON fields — `payload` necessarily contains the biller identity (a scannable QR cannot hide it from the payer), but echoing config internals as structured fields invites clients to re-couple to them and re-creates the duplication this change removes. Admin callers may receive the full breakdown.

**G.4 — Secrets stay server-side.** `SLIP_PROVIDER_KEY` via `wrangler secret`; add it to `.dev.vars.example` as a documented key with no value. Never returned in any response, never logged — `logEvent` payloads must carry the provider *name* and outcome only, never the key or the raw provider URL with query credentials.

---

## 7. File-by-file change list

**CCC**
| File | Change |
|------|--------|
| `src/db/migrations/0008_payment_ref_and_pricing.sql` | **NEW** (renumbered from v1's `0002`) — see §8 |
| `src/services/paymentRef.ts` | **NEW** — `generatePaymentRef`, `ensureBookingPaymentRef` (conditional-UPDATE + retry + cache invalidation) |
| `src/services/qrImage.ts` | **NEW** — payload → `{ svg, qrDataUrl }` *(skipped under fallback F-QR)* |
| `src/services/promptpay.ts` | `REF_PATTERN` validation on ref1/ref2; auto-POI `12` when amount > 0 |
| `src/services/promptpayConfig.ts` | Document `ref1`/`ref2` defaults as **sample-path only**; per-booking path ignores them |
| `src/routes/promptpay.ts` | Async; `{ ref }` booking path + sample path; returns `payload` + `qrDataUrl` |
| `src/routes/dispatcher.ts` | Pass `ctx.env` at **L91** and **L143** (both `auth: false` GET/POST twins) |
| `src/services/slipverify.ts` | Per-booking ref1/ref2 expectation in `buildPaymentResult` (L256-257); split `refs` mismatch into `ref1`/`ref2`; **leave the dedupe block and `reviewRequired` gate untouched** |
| `src/services/pricing.ts` | `CHILD_RELATIONS`, `computeBookingCost`, `applyServerPricing`; `BASE_MAIN_FEE` as a sum; align `computeApprovalTotals` (D.3a) |
| `src/services/reservationService.ts` | `visitorAge` plumbing; call `applyServerPricing` |
| `src/routes/public.ts` | `handleSaveReservation` → `applyServerPricing` + `pricing_override` log |
| `src/routes/reservations.ts` | `handleCreateBooking` + `handleUpdateBooking` recalc; approval alignment |
| `src/constants.ts` | `visitorAge` → `SAVE_RESERVATION_FIELDS`, `SAVE_STRING_CAPS`, `UPDATE_BOOKING_FIELDS`, `UPDATE_BOOKING_CAPS`, `STANDARD_HEADERS`. **`payment_ref1` must NOT enter `PUBLIC_LOOKUP_FIELDS`** |
| `src/types.ts` | `Reservation` += `payment_ref1?`, `visitorAge?` |
| `src/db/queries/reservations.ts` | `RESERVATION_COLUMNS` += `payment_ref1`, `visitorAge`. ⚠️ This list also drives `reservationRowToObject`, the archive copy (`[...RESERVATION_COLUMNS, 'slip_base64', 'archivedAt']`, L252) and `RESERVATION_WRITABLE_COLUMNS` — so the archive table **must** get both columns in `0008` or archiving breaks |
| `package.json` | Move `qrcode` → `dependencies` *(gated on spike S0)* |
| `src/routes/promptpay.ts` | **G.1:** `getPromptPayConfig` → admin-gated; remove from the public GET route |
| `src/routes/dispatcher.ts` | **G.1:** flip `getPromptPayConfig` to `auth: true` |
| `scripts/verify-smoke.ts` | See §12.2 |

**CCC — Pillar 2 (§6F)**
| File | Change |
|------|--------|
| `src/db/migrations/0009_slip_provider.sql` | **NEW** — `slip_tx_json`, `slip_verified_by` on both tables |
| `src/services/slipProvider.ts` | **NEW** — `SlipProvider` interface + one adapter + `not_configured` no-op default |
| `src/services/slipverify.ts` | Call the provider when a Mini-QR parsed; apply the four checks (§F.3); emit `'ok'`; add `payment_qr_only` reason (§F.4); KV cache (§F.5) |
| `src/db/queries/reservations.ts` | `RESERVATION_COLUMNS` += `slip_tx_json`, `slip_verified_by`; add `getBookingByPaymentRef` (§F.7) |
| `src/routes/reservations.ts` + `dispatcher.ts` | Admin-only `getBookingByPaymentRef` action |
| `.dev.vars.example` / `README.md` | Document `SLIP_PROVIDER_KEY` (§G.4) |

**Frontend** — `lib/api/endpoints.ts` (+`getPaymentQr`, **−`getPromptPayConfig`**), `lib/api/types.ts` (+`PaymentQrResponse`), `components/status/PaymentForm.svelte` (fetch + loading/error state), delete `lib/utils/promptpay-emvco.js`, **delete `lib/utils/promptpay-biller.js`** (§G.2 — it hardcodes the biller identity into the public bundle).

**Dashboard** — `lib/components/ReservationDetailModal.svelte` (fetch by ref), `routes/PromptPay.svelte` (sample path), delete `lib/utils/promptpay.ts`, `lib/api/endpoints.ts` (`ref`/`qrDataUrl`), `lib/components/ReservationFormModal.svelte` (recommended `visitorAge` field).

---

## 8. Data model — `0008_payment_ref_and_pricing.sql`

```sql
-- 0008: per-booking PromptPay invoice ref + main-visitor age for pricing recalc.
-- payment_ref1 — Reference 1 on the booking's PromptPay BillPayment QR. Minted
--                lazily on first QR/slip-verify access (services/paymentRef.ts);
--                '' means "not yet issued" and falls back to the static sample ref.
-- visitorAge   — main visitor's age as free text; '' = unknown (priced as adult).
--                TEXT, not INTEGER, so '' stays distinguishable from 0.
ALTER TABLE reservations ADD COLUMN payment_ref1 TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN visitorAge   TEXT NOT NULL DEFAULT '';

ALTER TABLE reservations_archive ADD COLUMN payment_ref1 TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations_archive ADD COLUMN visitorAge   TEXT NOT NULL DEFAULT '';

-- Enforces ref1 uniqueness so ensureBookingPaymentRef can retry on violation
-- instead of scanning the table. Partial, because '' is the un-issued sentinel
-- and repeats on every legacy row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_payment_ref1
  ON reservations (payment_ref1) WHERE payment_ref1 != '';
```

Naming follows the file's existing split convention: business fields camelCase (`extraVisitorNames`, `visitDateISO`), infrastructure fields snake_case (`slip_verify_status`, `slip_fingerprint`). Index style matches `0007`.

**Rollback:** D1 migrations are forward-only, but every statement here is additive with a default, so an old Worker bundle ignores the new columns entirely. ⇒ the migration is safe to apply **before** deploying (which is the order §12 uses) and needs no down-migration.

---

## 9. API contract changes

- `generatePromptPayQr` (GET + POST, both public):
  - Request: `{ ref }` (booking path) **or** `{ billerId, ref1, ref2, ref3, amount }` (sample path, now admin-gated alongside `getPromptPayConfig`).
  - Response to public callers: `{ status, payload, qrDataUrl, amount }` (§G.3). Admin callers additionally receive `{ billerId, ref1, ref2, ref3 }`.
  - `payload` is unchanged and `qrDataUrl` is additive ⇒ **no breaking change** for the booking path; frontends can deploy after the worker.
- **`getPromptPayConfig` becomes admin-only** (§G.1) — ⚠️ **the one breaking change in this plan.** The public frontend must stop calling it *before* the worker flips the flag, or its payment screen breaks. Sequenced explicitly in §13 (frontend step 7 ships before the gate flips at step 10). The Dashboard keeps access via its existing admin auth.
- **`getBookingByPaymentRef`** (NEW, admin-only) — `{ paymentRef }` → the booking, for reconciling a bank biller statement (§F.7).
- `verifySlip` result gains `slip_verified_by` and, on success, `status: 'ok'` — **previously unreachable** (§F.1). Any consumer branching on status must handle `'ok'` before Pillar 2 deploys, or a genuinely verified payment falls through an `else` into an error path.
- `lookupByRef`: unchanged. `payment_ref1` and `visitorAge` stay out of `PUBLIC_LOOKUP_FIELDS`.
- `saveReservation` / `createBooking`: response shape unchanged; stored totals now server-computed.
- `updateBooking`: server recomputes numerics; client `total`/counts ignored (and logged when they disagreed).
- `verifySlip`: `result.mismatch` may now contain `'ref1'` / `'ref2'` where it previously contained `'refs'`. **Dashboard mismatch-label rendering must handle all three** (legacy rows verified before this deploy retain `'refs'` in their stored `slip_verify_json`).

---

## 10. Security & privacy

- **ref2 no longer carries the phone number** (§6B.1). `visitorPhone` stays server-side only and out of `PUBLIC_LOOKUP_FIELDS`. Every value in the QR response is either public already or supplied by the caller.
- `payment_ref1` is returned by the QR endpoint (the bank/slip matching requires it) but never by public lookup.
- **New: rate-limit the QR endpoint.** It is unauthenticated and — unlike `lookupByRef` — performs a **write** (lazy ref mint) plus a QR render. Reuse `checkRateLimit(env.CACHE_KV, rateLimitKey('qr', ip), 30, 60)`. Without it, enumerating `VIS-XXXXX` mints a `payment_ref1` for every booking in the system and burns CPU per request. v1 had no limit.
- Turnstile still gates public booking creation. QR read stays public-by-ref — the same trust level as the existing `lookupByRef`, now that ref2 is not sensitive.
- `applyServerPricing` clamps to non-negative ints; `visitorAge` capped at 8 chars via `SAVE_STRING_CAPS`.
- Pricing overrides are logged (`pricing_override`), giving an audit trail for client tampering.

**Credential & confidential-data hygiene (§6G)** — what this change *removes* from public reach:

| Exposed today | After |
|---|---|
| `getPromptPayConfig` public: biller identity + refs to any caller | Admin-gated (G.1) |
| `BILLER_ID`/`REF_1`/`REF_2` hardcoded in the Frontend + Dashboard JS bundles | Files deleted (G.2) |
| QR response would echo config internals as JSON fields | Public response trimmed to `payload` + `qrDataUrl` + `amount` (G.3) |
| — | `SLIP_PROVIDER_KEY` via `wrangler secret`, never in `[vars]`, responses, logs, or bundles (G.4) |

`billerId` inside `payload` is **not** a leak — a scannable QR must carry the payee identity or the payer's bank cannot route the transfer. The leak was shipping it *outside* the QR, to callers who had no reason to hold it.

---

## 11. Risks / edge cases

| Risk | Handling |
|------|----------|
| **Legacy rows** without `payment_ref1` | Lazily assigned on first access; slip verify falls back to `cfg.ref1`/`cfg.ref2` **together** (never a mixed comparison — see §6C.1) |
| **Concurrent QR fetches** for one booking | Conditional `UPDATE ... WHERE payment_ref1 = ''` + re-SELECT; loser returns the winner's ref (§6B.2) |
| **Ref collisions** | Partial unique index + regenerate-and-retry (≤5); 29¹⁰ space makes this effectively unreachable |
| **Hyphen refs** | `REF_PATTERN` rejects non-`[A-Z0-9]`; the `VIS-00001` bug becomes unrepresentable |
| **Amount drift after QR issuance** ⚠️ *new* | An admin edit or approval recompute changes `booking.total` **after** a visitor screenshotted the QR. They pay the old amount → slip verify reports `mismatch` on a legitimately-paid slip. The QR is generated on demand so the window is narrow, but nonzero. **Mitigation:** when `handleUpdateBooking` / `handleUpdateVisitorApproval` changes `total` on a booking with a non-empty `payment_ref1` **and** status `'รอชำระเงิน'`, log a `price_changed_after_qr` event so the reviewing admin sees why the amount disagrees. Do **not** auto-accept the old amount |
| **`qrcode` fails to bundle** | Spike S0 first; fallback F-QR returns `payload` only (§6A.3) |
| **Re-pricing on approval** (D.3a) | Finance-visible behavior change; gated on sign-off Q2 |
| **Main-visitor age missing** | Priced as adult — identical to current frontend behavior |
| **Child relation language variants** | Shared `CHILD_RELATIONS` aligns approval recompute with the frontend |
| **`RESERVATION_COLUMNS` / archive coupling** | New columns must exist on `reservations_archive` too, or `archiveOldReservations` breaks — covered in `0008` |
| **`slip_verify_json` shape drift** | Stored results from before this deploy carry `'refs'`; new ones carry `'ref1'`/`'ref2'`. Dashboard must render all three (§9) |
| **CRC** | Builder computes over `...6304` (verified §3.1); slipverify validates via `parsePayload` |
| **`getPromptPayConfig` gate breaks the live payment screen** | Sequencing: flip only after both frontends are deployed (§13 step 10). Reversible in one line if it bites |
| **Provider returns no receiver account** | Blocks §F.3.1 ⇒ auto-confirm is not safely buildable. Settle at P0 (Q5) before writing code; fallback is manual review + §F.7 reconciliation |
| **Provider outage / quota exhaustion** | Fail closed to `slip_verify` + `reviewRequired`; never `ok`. Pinned by smoke §12.5.5 |
| **Provider cost blowout** | Call only when a Mini-QR parsed; KV cache per `transRef` (§F.5); pinned by smoke §12.5.7-8 |
| **Vendor lock-in** | `SlipProvider` interface + adapter; swapping vendors touches one file |
| **Auto-confirm on a vendor bug** | Shadow mode P6 (2-4 weeks) before enabling P7 |
| **Consumers not handling `'ok'`** | Previously unreachable, so no existing branch expects it — audit dashboard status rendering before P3 (§9) |

---

## 12. Verification

There is **no test runner in this repo** — `typecheck` + `lint` + `verify-smoke.ts` are the whole safety net. Budget accordingly.

**12.1 — Backend gates**
```bash
npm run typecheck
npm run lint
npm run build            # tsc + wrangler deploy --dry-run — THE qrcode bundling gate (spike S0)
npx tsx scripts/verify-smoke.ts
npm run migrate          # 0008 → remote D1 (safe pre-deploy: additive-only, §8)
npm run deploy
```

**12.2 — `verify-smoke.ts` additions.** It stubs D1 as `prepare().bind().first() => null`; the `booking` fixture must gain `payment_ref1` and the fake DB must be able to return a row for the duplicate/uniqueness assertions.
1. QR payload for a booking parses as tag 30, AID `A000000677010112`, biller `010753700088205`, valid CRC.
2. `ref1` matches `/^PP[A-Z0-9]{10}$/`; two `generatePaymentRef()` calls differ.
3. `ref2 === booking.ref.replace(/-/g,'')`; **assert the payload contains no phone digits** (the §6B.1 regression guard).
4. `buildPromptPayBillPayment` **throws** on `ref1: 'VIS-00001'` (the original bug, pinned).
5. Amount present ⇒ POI `12`; amount absent ⇒ `11`.
6. Slip carrying the per-booking QR verifies against its own booking, and reports `mismatch: ['ref1']` against a different one.
7. Legacy booking (`payment_ref1: ''`) still matches `cfg.ref1`/`cfg.ref2`.
8. A matching `paymentQr` still yields `status: 'slip_verify'` + `reviewRequired` — **pins §6C.3 against a future "optimization"**.
9. Duplicate fingerprint still wins over a matching per-booking ref (pins §6C.2 ordering).
10. `computeBookingCost` matches frontend `calcCost` across: adult-only; child <5; child ≤8; mixed extras; each `CHILD_RELATIONS` variant.
11. `applyServerPricing` overwrites a tampered client `total`.

**12.3 — Frontend / Dashboard:** `npm run check` in each. Manual: booking → status → payment card shows the backend QR (plus its loading and error states); dashboard detail modal loads the QR by ref; PromptPay sample tab works.

**12.5 — Pillar 2 assertions** (extend `verify-smoke.ts` with a stubbed `SlipProvider`; no live vendor calls in the smoke path)
1. All four checks pass ⇒ `status: 'ok'` and `slip_verified_by` set — the first test that can ever produce `'ok'`.
2. **Wrong receiver account ⇒ `mismatch`, never `ok`.** The highest-value assertion in the suite (§F.3.1).
3. Amount off by more than the tolerance ⇒ `mismatch: ['amount']`.
4. `transferredAt` before `booking.createdAt`, and beyond the freshness window ⇒ `mismatch` (two cases).
5. Provider returns `provider_error` / `rate_limited` / times out ⇒ `slip_verify` + `reviewRequired`, **never `ok`** — pins fail-closed (three cases).
6. `not_configured` (no key set) ⇒ behaves exactly as today: manual review, no crash. Guarantees Pillar 2 code is inert until deliberately switched on.
7. Slip with only our `paymentQr` and no Mini-QR ⇒ `payment_qr_only`, and **the provider is never called** (cost guard, §F.5).
8. Second verify of the same `transRef` hits the KV cache ⇒ provider called once.
9. Duplicate fingerprint still overrides a provider `'ok'` (dedupe ordering, §6C.2).

**12.4 — Manual smoke (dev):** create a booking → `generatePromptPayQr {ref}` → decode the payload and confirm tag 30 / AID / biller / `ref1 = PP…` (12 chars) / `ref2 = VIS…` / amount = server total / CRC valid → re-fetch and confirm the **same** `ref1` (idempotency) → resubmit the booking with a tampered `total` and confirm the stored total is server-computed and a `pricing_override` event was logged.

---

## 13. Execution order

| Step | Work | Gate |
|------|------|------|
| **0** | **Spike S0** — `qrcode` bundling under `nodejs_compat` | `npm run build` passes, or fallback F-QR adopted |
| 1 | Migration `0008` + `RESERVATION_COLUMNS` / `types.ts` / `constants.ts` plumbing | `npm run typecheck` |
| 2 | `pricing.ts` (`CHILD_RELATIONS`, `computeBookingCost`, `applyServerPricing`) + hooks in `public.ts` / `reservations.ts` / `reservationService.ts` | smoke §12.2 items 10-11 |
| 3 | `paymentRef.ts` (+ cache invalidation) + `qrImage.ts` + builder validation + async `routes/promptpay.ts` + dispatcher `env` + rate limit | smoke items 1-5 |
| 4 | `slipverify.ts` per-booking matching | smoke items 6-9 |
| 5 | `package.json` (`qrcode` → deps) | `npm run build` |
| 6 | Remaining `verify-smoke.ts` assertions | full smoke green |
| 7 | Frontend endpoint + `PaymentForm.svelte` (+ loading/error); delete client builder + `promptpay-biller.js` | `npm run check` |
| 8 | Dashboard detail modal + sample page + mismatch labels (§9); delete duplicate builder | `npm run check` |
| 9 | Apply `0008` → deploy worker → **deploy frontends** | §12.4 |
| 10 | **Only once both frontends are live:** flip `getPromptPayConfig` to `auth: true` (§G.1) | public call 401s; dashboard unaffected |

Steps 1-6 ship as one Worker deploy. The booking path in §9 is backward-compatible, so frontends (7-8) can follow at any pace — the old client-side QR keeps working until swapped. **The one ordering constraint is step 10:** flipping the config gate before the frontends stop calling it breaks the live payment screen. *v1 put the dependency check at step 5, after everything depending on it was built; that is the main sequencing fix in Pillar 1.*

**Pillar 2 (§6F) — separate track, after Pillar 1 is stable in production**

| Step | Work | Gate |
|------|------|------|
| **P0** | **Vendor selection** against §F.2 criteria — especially *"returns receiver account"*, without which §F.3.1 is impossible | signed terms + sandbox key |
| P1 | `slipProvider.ts` interface + adapter + `not_configured` no-op; `SLIP_PROVIDER_KEY` secret | adapter unit-checked against sandbox |
| P2 | Migration `0009` + `RESERVATION_COLUMNS` + archive coupling | `npm run typecheck` |
| P3 | Four checks (§F.3) + `'ok'` emission + `payment_qr_only` reason + KV cache | smoke §12.5 |
| P4 | Dashboard: render `'ok'`, `slip_verified_by`, provider tx detail, `payment_qr_only` flag | `npm run check` |
| P5 | `getBookingByPaymentRef` reconciliation lookup (§F.7) | manual |
| P6 | **Shadow mode** — run provider verification and record the outcome, but keep routing everything to manual review. Compare provider verdicts against reviewer decisions for 2-4 weeks | agreement rate acceptable |
| P7 | Enable auto-confirm on `'ok'` | — |

P6 is not optional ceremony: switching straight to auto-confirm makes a vendor bug or a mis-mapped receiver field into silently-accepted unpaid bookings. Shadow mode makes that visible while manual review is still catching it.

---

## 14. Decisions locked

- `ref1` = `PP` + 10 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (12 total, no ambiguous glyphs), stored in `payment_ref1`, minted lazily, unique-indexed.
- **`ref2` = booking ref with hyphens stripped (`VIS00001`) — changed from v1's visitor phone (§6B.1).**
- `billerId` stays `010753700088205`, overridable via admin settings.
- QR generation is backend-owned; frontends fetch `qrDataUrl` (or `payload` under fallback F-QR).
- Pricing is server-authoritative: **override + log**, no hard-fail (changed from v1's "silent").
- `visitorPhone` remains out of public lookup **and** out of the QR.
- QR endpoint is rate-limited (30/min/IP).
- `paymentQr` matches still require manual review (§6C.3) — non-negotiable, and unchanged by Pillar 2 (§F.4).
- `qrcode` moves to runtime dependencies *iff* spike S0 passes.
- **`getPromptPayConfig` becomes admin-only** (§G.1); biller identity leaves the public surface and both client bundles.
- **Public QR response is minimized** to `payload` + `qrDataUrl` + `amount` (§G.3).
- **Slip verification requires an external provider** (§6F.1). Auto-confirm (`'ok'`) is gated on all four checks (§F.3) and reached only after shadow mode (P6).
- Provider credentials via `wrangler secret` only; never in `[vars]`, responses, logs, or bundles (§G.4).

**Follow-ups (out of scope, tracked)**
- **F1:** `generateUniqueRefServer` produces a 90,000-value enumerable space. Independent of this change, it makes `lookupByRef` scrapeable. Worth widening to 8+ chars and/or rate-limiting.
- **F2:** `computeApprovalTotals` charges the main fee even when `mainApproved` is false (§6D.3b).
- ~~**F3 — Mini-QR → booking binding**~~ **Promoted to Pillar 2 (§6F)** on 2026-08-13, per "I want to make this production". Option (1), the provider/Open-API lookup, is now the in-scope design; option (2) biller-statement reconciliation is delivered as `getBookingByPaymentRef` (§F.7) and works even if Pillar 2 is deferred; option (3) OCR is dropped as superseded.
