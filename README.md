# CrewSight

GPS rowing recorder PWA — records **GPS**, **accelerometer**, and **heart rate (BLE)** during rowing sessions. Data uploads to the ingest API on your Vercel deployment. See [docs/INGEST-ONLY.md](docs/INGEST-ONLY.md).

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 — configure **Settings** (Device ID, Traccar URL, ingest token), then **Start session**.

## Features

| Sensor | Default rate | Upload path |
|--------|--------------|-------------|
| GPS | 1000 ms | Ingest API (with HR/motion in same batch) |
| Accelerometer | 50 ms | Telemetry ingest API |
| Heart rate | BLE notifications | Telemetry ingest + Traccar attributes on GPS tick |

- IndexedDB offline outbox with background flush
- Installable PWA (manifest + service worker)
- Screen wake lock while recording (where supported)
- **Native app (Capacitor)** for reliable background GPS on iOS/Android — see [docs/NATIVE-APP.md](docs/NATIVE-APP.md)

## Native app (Capacitor)

For crew phones that need **GPS and HR while the screen is locked**:

```bash
npm install
npm run native:sync       # build + sync to android/ and ios/
npm run native:android    # open Android Studio
npm run native:ios        # open Xcode (Mac)
```

Full setup: [docs/NATIVE-APP.md](docs/NATIVE-APP.md)

## Deploy (Vercel)

**Recommended** (matches typical Vercel + Vite monorepo detection):

| Setting | Value |
|---------|--------|
| **Root Directory** | `apps/recorder-pwa` |
| **Framework Preset** | Other (or leave auto) |
| **Build / Output** | Leave blank — uses `apps/recorder-pwa/vercel.json` |
| **Install** | Runs `cd ../.. && npm install` for workspace deps |

Set `INGEST_TOKEN` in Vercel env. In the app **Settings**, set **Ingest API URL** to `https://your-deployment.vercel.app/api/ingest`.

## CrewSight Manager

Open **`/dashboard.html`** (or `/dashboard`) on your deployment — the fleet monitor for live GPS, stroke rate, and capsize alerts. It polls `/api/devices` every 1–10 s and shows per device:

- Online / offline (last seen within 30 s)
- GPS refresh rate (Hz) and last coordinates
- Heart rate present + rate + last BPM
- Accelerometer present + sample rate
- Overall ingest throughput (Hz)

**Native Android app** (background capsize alerts): [CrewSight-Manager.apk](https://github.com/JohnSt-AHD/rowing_app/releases/download/android-apk-manager-latest/CrewSight-Manager.apk) — see [docs/COACH-APP.md](docs/COACH-APP.md).

**Alternative:** Root Directory = empty (repo root) uses root `vercel.json` and `scripts/vercel-build.mjs` → output `dist/` at repo root.

## APIs

| Endpoint | Purpose |
|----------|---------|
| `POST /api/ingest` | Receive telemetry from phones |
| `GET /api/devices` | Dashboard — rates and sensor presence |
| `GET /api/positions` | Latest GPS per device (for maps) |

## Project layout

```
apps/recorder-pwa/     PWA (Vite + TypeScript)
packages/telemetry-types/
api/ingest.js          Vercel serverless ingest
docs/                  Architecture summary (Word)
```

## Integration with traccar-overlay

Wire live maps to `GET /api/positions` on this deployment instead of Traccar. Details in [docs/INGEST-ONLY.md](docs/INGEST-ONLY.md).

## Local API (optional)

Run Vercel dev for ingest during development:

```bash
npx vercel dev
```

Proxy in `vite.config.ts` forwards `/api` to port 3000.
