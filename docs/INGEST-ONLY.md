# Ingest-only architecture (no Traccar on phones)

Phones talk only to **rowing-app-recorder-pwa.vercel.app**.

## Data flow

```
Phone PWA
    │  POST /api/ingest  (GPS + HR + accelerometer batches)
    ▼
Vercel API (ingest-store, in-memory per deployment)
    │
    ├── GET /api/devices   → dashboard (rates, sensors)
    └── GET /api/positions → live map (latest lat/lon per device)
```

## Phone settings (only 3 required)

| Field | Example |
|-------|---------|
| Device ID | `CREW-01` |
| Ingest API URL | `https://rowing-app-recorder-pwa.vercel.app/api/ingest` |
| Ingest token | Same as Vercel `INGEST_TOKEN` (if set) |

No Traccar URL on the phone.

## APIs

### POST /api/ingest

Telemetry batches from the recorder.

### GET /api/devices

Per-device stats: online, GPS/HR/motion rates, last coordinates.

### GET /api/positions

Latest GPS fix per device (for maps). Shape is Traccar-like:

```json
{
  "ok": true,
  "positions": [{
    "uniqueId": "CREW-01",
    "latitude": -36.8485,
    "longitude": 174.7633,
    "fixTime": "2026-05-22T12:00:00.000Z",
    "online": true,
    "attributes": { "hr": 142, "ax": 0.1, "ay": 0.2, "az": 9.8 }
  }]
}
```

## traccar-overlay (next step)

Point overlay maps at `GET https://rowing-app-recorder-pwa.vercel.app/api/positions` instead of Traccar, or add a thin proxy in traccar-overlay that forwards to this URL.

## Persistence

Ingest is **in-memory** today (resets on cold start, split across Vercel instances). For production:

- Vercel KV, Postgres, or Timescale for samples + latest position
- Same API contracts
