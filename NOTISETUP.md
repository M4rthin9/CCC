# Notification Setup Guide

Backend is fully built. Toggle on + add secrets = done.

---

## 1. VAPID Keys (Web Push)

Generated keypair — copy into CF secrets:

```
VAPID_PUBLIC_KEY = BH_6XRF8FMI05sOiv-WBHd7j2YYX6ar8LIBd0dqR9MTQy6Os54svU7KpHETgZ2FPLWK6B4h1aXQOVenTnsvTtlk
VAPID_PRIVATE_KEY = y6Os54svU7KpHETgZ2FPLWK6B4h1aXQOVenTnsvTtlk
```

Set secrets:

```bash
echo "BH_6XRF8FMI05sOiv-WBHd7j2YYX6ar8LIBd0dqR9MTQy6Os54svU7KpHETgZ2FPLWK6B4h1aXQOVenTnsvTtlk" | npx wrangler secret put VAPID_PUBLIC_KEY
echo "y6Os54svU7KpHETgZ2FPLWK6B4h1aXQOVenTnsvTtlk" | npx wrangler secret put VAPID_PRIVATE_KEY
```

Set VAPID subject (email for `mailto:` in JWT `sub` claim):

```bash
echo "mailto:admin@cida.dpdns.org" | npx wrangler secret put VAPID_SUBJECT
```

Then flip the toggle in `wrangler.toml`:

```
NOTIFY_PUSH_ENABLED = "true"
```

### Frontend (Service Worker)

1. Get the public key from backend:
   ```
   GET /api/notify/publicKey
   → { publicKey, pushEnabled }
   ```

2. Register Service Worker + subscribe:
   ```js
   const reg = await navigator.serviceWorker.ready;
   const sub = await reg.pushManager.subscribe({
     userVisibleOnly: true,
     applicationServerKey: urlBase64ToUint8Array(publicKey),
   });
   ```

3. Save subscription to backend:
   ```
   POST /api/notify/subscribe
   { endpoint, p256dh, auth, ref }
   ```

---

## 2. LINE Official Account

### Step 1 — Create LINE OA

1. Go to [LINE Developers Console](https://developers.line.biz/console/)
2. Create a provider (or use existing)
3. Create a **Messaging API** channel
4. Note the **Channel Secret** and **Channel Access Token**

### Step 2 — Set Secrets

```bash
echo "YOUR_CHANNEL_ACCESS_TOKEN" | npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
echo "YOUR_CHANNEL_SECRET" | npx wrangler secret put LINE_CHANNEL_SECRET
```

Set OA ID in `wrangler.toml` (optional, for display):

```
LINE_OA_ID = "YOUR_LINE_OA_ID"
```

### Step 3 — Set Webhook URL

In LINE Developers Console → Messaging API → Webhook settings:

```
Webhook URL: https://ccc-backend.pongsinbas.workers.dev/api/line/webhook
```

Enable **Use webhook** toggle.

### Step 4 — Flip Toggle

```
NOTIFY_LINE_ENABLED = "true"
```

### How LINE Linking Works

1. Visitor adds your OA as friend → webhook receives `follow` event → auto-asks for ref
2. Visitor sends `VIS-12345` → webhook binds that ref to their LINE userId
3. Or frontend calls `POST /api/linkLine` after booking

---

## 3. Enable Events

Default allowlist is only `payment_due`. Add more events in `wrangler.toml`:

```
NOTIFY_EVENT_ALLOWLIST = "payment_due,booking_submitted,status_changed,payment_confirmed,booking_cancelled,visitor_approved,visitor_rejected"
```

---

## 4. Tuning

| Setting | Default | What it does |
|---|---|---|
| `LINE_MONTHLY_CAP` | 200 | Max LINE messages/month (can override per-account in settings) |
| `NOTIFY_LINE_FALLBACK_ONLY` | `true` | Skip LINE if push already delivered successfully |
| `NOTIFY_EVENT_ALLOWLIST` | `payment_due` | Comma-separated event types allowed to spend quota |

---

## 5. Verify

1. Deploy with secrets:
   ```bash
   npm run deploy
   npm run migrate
   ```
2. Test Web Push:
   - Frontend: subscribe to push → call `POST /api/notify/subscribe`
   - Admin: call `POST /api/notify` with `{ ref, type: "payment_due", ... }`
3. Test LINE:
   - Add OA as friend → send a ref
   - Check `POST /api/notify/logs` for delivery status
4. Check pending retry:
   - `POST /api/notify/processPending` (admin only) — re-queues failed transients

---

## 6. Cron

The cron job `processPendingNotifications` runs daily at 00:00 Bangkok (0 17 * * *) alongside the discipline cleanup. It retries any pending/failed notifications (up to 5 attempts per message).

---

## 7. DB Tables

Already created by migration `0005_add_notifications.sql`:

- `push_subscriptions` — browser push subscription registry
- `line_friends` — LINE userId ↔ booking ref bindings
- `notifications` — delivery outbox + audit trail (deduplicated per ref+type+channel+recipient)
