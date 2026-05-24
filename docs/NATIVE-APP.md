# RNZ Row Recorder — native app (Capacitor)

The native shell wraps the same Vite UI as the PWA but uses **native GPS, accelerometer, and BLE** so recording continues with the screen locked (especially on iOS).

## Architecture

```
apps/recorder-native/     Capacitor project (ios/ + android/)
apps/recorder-pwa/        Shared UI + session logic
packages/sensor-adapters/ web vs native sensor implementations
```

Server-side ingest, Postgres, and fleet dashboard are **unchanged** — phones still POST to `/api/ingest`.

## Easy install on Android (Samsung, etc.) — no USB

You do **not** need Android Studio on your phone. Pick one:

### A) Direct download link (Samsung / Android)

**https://github.com/JohnSt-AHD/rowing_app/releases/download/android-apk-latest/RNZ-Row-Recorder.apk** (~10 MB arm64 build)

Install page: **https://rowing-app-recorder-pwa.vercel.app/install-native.html**

(Vercel `/downloads/…` redirects to GitHub — do not use old 40 MB universal APKs.)

Install steps and Samsung “stuck at 100%” help: [install-native.html](https://rowing-app-recorder-pwa.vercel.app/install-native.html)

If the link 404s, open [Releases](https://github.com/JohnSt-AHD/rowing_app/releases/tag/android-apk-latest) or run **Actions → Android APK → Run workflow**, wait ~5 min, then try again.

### B) Download APK from GitHub Actions artifact

Requires **Android Studio installed once** (for the Android SDK), then:

```powershell
cd c:\path\to\Rowing_App
npm install
npm run native:apk
```

This creates:

`apps/recorder-native/install/RNZ-Row-Recorder.apk`

Copy that file to the phone and tap it to install. Windows Explorer opens the folder when done.

### Upload fails with “Failed to fetch”

1. **Settings → Ingest API URL** must be exactly:  
   `https://rowing-app-recorder-pwa.vercel.app/api/ingest`  
   (not `localhost` — the native WebView uses `https://localhost` internally.)
2. Tap **Test upload connection** (v1.0.2+). You should see `OK — server received …`.
3. **Ingest token** — leave empty unless you set `INGEST_TOKEN` on Vercel (then use the same token).
4. Install APK **v1.0.2** or newer (uses Android native HTTP instead of WebView `fetch`).

## After install (Samsung S21)

1. **Settings → Apps → RNZ Row Recorder → Battery** → **Unrestricted**
2. **Location** → **Allow all the time**
3. In the app: **Settings** → Device ID → **Start session**

---

## Developer workflow (Android Studio / USB)

| Tool | Android | iOS |
|------|---------|-----|
| Node 20 | ✓ | ✓ |
| Android Studio | ✓ (or use APK install above) | — |
| Xcode (Mac) | — | ✓ |

From repo root:

```bash
npm install
npm run native:sync          # build native web bundle + cap sync both platforms
npm run native:android       # open Android Studio
npm run native:ios           # open Xcode (Mac only)
```

Or from `apps/recorder-native`:

```bash
npm run sync
npm run open:android
```

## First-time platform setup

```bash
cd apps/recorder-native
npx cap add android
npx cap add ios          # Mac only
npm run sync
```

## iOS background modes (required)

After `npx cap add ios`, open **Xcode → App target → Signing & Capabilities**:

1. **+ Capability → Background Modes**
   - ☑ Location updates
   - ☑ Uses Bluetooth LE accessories (if using HR)

2. **Info.plist** usage descriptions (Capacitor may add some; verify):

| Key | Example text |
|-----|----------------|
| `NSLocationAlwaysAndWhenInUseUsageDescription` | Track boat position during rowing sessions, including when the screen is locked. |
| `NSLocationWhenInUseUsageDescription` | Track boat position during rowing sessions. |
| `NSMotionUsageDescription` | Measure stroke rate and detect capsize from boat motion. |
| `NSBluetoothAlwaysUsageDescription` | Connect to a heart rate chest strap. |

3. On first session, iOS will prompt for location — choose **Allow While Using**, then upgrade to **Always** when prompted (needed for background GPS).

## Android permissions

`cap sync` merges permissions from Capacitor plugins. Ensure these exist in `AndroidManifest.xml` (usually automatic):

- `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION` (Android 10+ — request at runtime for background GPS)
- `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` (Android 12+)

## Sensor adapters

| Build | Command | Sensors |
|-------|---------|---------|
| Web PWA | `npm run build:app` | Browser geolocation, DeviceMotion, Web Bluetooth |
| Native | `npm run build:native -w recorder-pwa` | Native GPS + BLE; motion via Capacitor Motion (DeviceMotion in WebView) |

**Note:** GPS and heart rate use full native APIs and continue in background with the correct iOS/Android permissions. Accelerometer/stroke rate uses the Capacitor Motion plugin (WebView-based). For always-on background accel on iOS, a CoreMotion native plugin could be added later.

Vite `--mode native` sets `VITE_PLATFORM=native` and aliases `@rowing/sensor-adapters` to the Capacitor implementation.

## TestFlight / distribution

1. `npm run native:sync`
2. Open Xcode → **Product → Archive**
3. Upload to App Store Connect → **TestFlight**
4. Crew installs via TestFlight link

Android: **Build → Generate Signed Bundle** in Android Studio, or sideload debug APK for testing:

```bash
npm run run:android -w recorder-native
```

## Phone settings

Same as PWA:

- **Ingest URL:** `https://rowing-app-recorder-pwa.vercel.app/api/ingest`
- **Device ID:** e.g. `G1`, `CREW-01`
- Enable **Background recording** and **Keep screen on** in app Settings (still useful on Android)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| GPS stops when locked (iOS) | Background Modes → Location updates; grant **Always** location |
| No stroke rate | Motion permission; verify native build (`Native app` in header) |
| HR won't connect | Bluetooth permission; tap **Connect HR strap** before launching |
| White screen after sync | Run `npm run build:web -w recorder-native` first — `webDir` must contain `index.html` |

## Vercel vs native

| Component | Hosted on |
|-----------|-----------|
| Recorder UI in native app | Bundled in IPA/APK |
| `/api/ingest`, dashboard, Postgres | Vercel (unchanged) |
| traccar-overlay | Separate Vercel project |

Do **not** point Capacitor `server.url` at production for normal use — the app should run offline-capable UI with network only for uploads.
