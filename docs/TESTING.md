# Testing the rowing recorder

Use your deployment: **https://rowing-app-recorder-pwa.vercel.app**

## Step 1 — Connection test page (2 minutes)

Open on your phone (Safari/Chrome):

```
https://rowing-app-recorder-pwa.vercel.app/test.html
```

Tap each button in order:

| Button | Expect |
|--------|--------|
| **1. Ping API** | `{"ok":true,"service":"rowing-recorder",...}` |
| **2. Test ingest** | `{"ok":true,"received":1,...}` |
| **3. List devices** | `"devices":[{"deviceId":"TEST-PHONE-01",...}]` |
| **4. Test Traccar proxy** | `{"ok":true,"traccarStatus":200}` |

If **2** returns `401`, enter your Vercel `INGEST_TOKEN` in the token field (or remove the env var in Vercel).

If **4** fails, check the device **TEST-PHONE-01** exists in Traccar (Unique ID).

## Step 2 — Traccar device

1. Login: https://xmvjx05iw.traccar.com  
2. Add device, Unique ID: `TEST-PHONE-01`

## Step 3 — Phone recorder settings

| Field | Value |
|-------|--------|
| Device ID | `TEST-PHONE-01` |
| Traccar URL | `https://xmvjx05iw.traccar.com` |
| Ingest API URL | `https://rowing-app-recorder-pwa.vercel.app/api/ingest` |
| Ingest token | (only if INGEST_TOKEN set in Vercel) |

Save → **Start session** → allow **location** when prompted.

Watch the **Log** at the bottom:

- `Upload: N sent, 0 failed` = ingest OK  
- `Traccar queued: ...` = GPS will retry (after deploy with proxy fix, should succeed)

## Step 4 — Dashboard

```
https://rowing-app-recorder-pwa.vercel.app/dashboard.html
```

Device should show **Online** with GPS / motion rates within ~30 s.

## Step 5 — Traccar map

In https://xmvjx05iw.traccar.com open device **TEST-PHONE-01** — position should update every few seconds while recording.

## Common failures

| Symptom | Cause | Fix |
|---------|--------|-----|
| Ingest 401 | Token mismatch | Match phone token to Vercel `INGEST_TOKEN` or clear both |
| Dashboard empty | No ingest data | Run test.html step 2; check ingest URL |
| Traccar no position | Device missing or CORS (old build) | Create device; redeploy latest app (uses proxy) |
| GPS count stays 0 | Location denied | iOS Settings → Safari → Location; keep app in foreground |
| Queued count grows | Network/API errors | Read Log line after failed upload |

## Redeploy

After code fixes, wait for Vercel deploy from `main`, then hard-refresh the PWA (close tab, reopen).
