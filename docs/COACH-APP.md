# RNZ Coach Monitor

Android app for coaches to watch fleet GPS, stroke rate, and capsize alerts while on the water.

## Features (v0.1)

- **Start / Stop monitoring** — background work only runs while monitoring is ON
- **Background capsize alerts** — native service polls `/api/devices`; triangle notification + sound when any boat capsizes
- **Live map** — fleet positions from `/api/positions` (when app is open)
- **History** — session list, GPS trace, speed vs time, speed vs distance

Uses the same **API base URL** and **ingest token** as the rower app and dashboard.

## Dev

```bash
npm install
npm run dev:coach          # web preview (no background alerts)
npm run build:coach:native
npm run coach:sync         # build web + cap sync android
cd apps/coach-native/android && ./gradlew assembleDebug
```

## Monitoring OFF vs ON

| State | Background poll | Status bar | Capsize alerts |
|-------|-----------------|------------|----------------|
| OFF   | No              | No         | No             |
| ON    | Yes (~3 s)      | Rowing shell icon | Yes (triangle) |

Stop via in-app **Stop monitoring** or the notification **Stop monitoring** action.

## Package

- App ID: `nz.org.rowing.coach`
- Native plugin: `CoachMonitor`
