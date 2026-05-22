# RNZ Rowing Recorder (PWA)

Phone Progressive Web App to record **GPS**, **accelerometer**, and **heart rate (BLE)** during rowing sessions, and send data to **Traccar** (for `traccar-overlay` maps) plus a telemetry ingest API.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 — configure **Settings** (Device ID, Traccar URL, ingest token), then **Start session**.

## Features

| Sensor | Default rate | Upload path |
|--------|--------------|-------------|
| GPS | 1000 ms | Traccar OsmAnd HTTP + telemetry batch |
| Accelerometer | 50 ms | Telemetry ingest API |
| Heart rate | BLE notifications | Telemetry ingest + Traccar attributes on GPS tick |

- IndexedDB offline outbox with background flush
- Installable PWA (manifest + service worker)
- Screen wake lock while recording (where supported)

## Deploy (Vercel)

1. Push to [JohnSt-AHD/rowing_app](https://github.com/JohnSt-AHD/rowing_app)
2. Import project on Vercel — root directory = repo root
3. Set `INGEST_TOKEN` in environment variables
4. In the PWA Settings, set **Ingest API URL** to `https://your-deployment.vercel.app/api/ingest`

## Traccar setup

1. Create a device in Traccar with **Unique ID** matching the PWA Device ID (e.g. `CREW-01`).
2. Set **Traccar URL** in the app to your server host (e.g. `https://traccar.example.com`) — port `:5055` is added automatically for OsmAnd.

## Project layout

```
apps/recorder-pwa/     PWA (Vite + TypeScript)
packages/telemetry-types/
api/ingest.js          Vercel serverless ingest
docs/                  Architecture summary (Word)
```

## Integration with traccar-overlay

GPS appears on existing maps once Traccar receives OsmAnd positions. Overlay poll rate (3–10 s) is separate from recorder GPS interval.

HR and high-rate accelerometer are stored via `/api/ingest` — extend traccar-overlay later to read `GET /api/ingest?sessionId=…`.

## Local API (optional)

Run Vercel dev for ingest during development:

```bash
npx vercel dev
```

Proxy in `vite.config.ts` forwards `/api` to port 3000.
