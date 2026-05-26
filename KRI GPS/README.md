# KRI GPS

KRI Safety System themed variant of the recorder app.

Profile:
- GPS enabled
- Accelerometer/capsize enabled
- Heart rate / Bluetooth disabled
- Stroke-rate and HR UI hidden

## Web (dev)

- `npm run dev:kri`
- `npm run build:kri`

## Android APK

After CI builds (push to `main` touching `KRI GPS/` or `apps/kri-native/`):

| Link | URL |
|------|-----|
| **GitHub Release** | https://github.com/JohnSt-AHD/rowing_app/releases/tag/android-apk-kri-latest |
| **Direct download** | https://github.com/JohnSt-AHD/rowing_app/releases/download/android-apk-kri-latest/KRI-GPS.apk |
| **Short link (Vercel)** | https://rowing-app-recorder-pwa.vercel.app/downloads/KRI-GPS.apk |

Local build:

```bash
npm run kri:apk
```

APK output: `apps/kri-native/install/KRI-GPS.apk`

Install on phone: Battery → Unrestricted; Location → Allow all the time; Notifications on. In Settings set **Ingest API URL** to `https://rowing-app-recorder-pwa.vercel.app/api/ingest` and a **Device ID**, then start a session with GPS + Accelerometer.
