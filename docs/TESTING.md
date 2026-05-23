# Testing the rowing recorder (ingest-only)

Deployment: **https://rowing-app-recorder-pwa.vercel.app**

## Step 1 — Connection test

```
https://rowing-app-recorder-pwa.vercel.app/test.html
```

| Button | Expect |
|--------|--------|
| 1. Ping API | `{"ok":true,...}` |
| 2. Test ingest | `{"ok":true,"received":1}` |
| 3. List devices | Device in list |
| 4. GPS positions | `"positions":[{...}]` |

## Step 2 — Phone settings

| Field | Value |
|-------|--------|
| Device ID | `TEST-PHONE-01` |
| Ingest API URL | `https://rowing-app-recorder-pwa.vercel.app/api/ingest` |
| Ingest token | (if `INGEST_TOKEN` set in Vercel) |

No Traccar fields.

## Step 3 — Record

Save → **Start session** → allow location → watch **Log** for `Upload: N sent, 0 failed`.

## Step 4 — Dashboard

```
https://rowing-app-recorder-pwa.vercel.app/dashboard.html
```

## Step 5 — Positions API (map source)

```
https://rowing-app-recorder-pwa.vercel.app/api/positions
```

Use this instead of Traccar for live maps.
