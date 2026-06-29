import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import type { GpsReading, GpsWatcher } from '../types';
import { createGpsWindowReporter } from '../gps-window-average';

const BackgroundGeolocation =
  registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

/**
 * GPS via foreground service + background location (screen off / app in background).
 * Requires android.useLegacyBridge and POST_NOTIFICATIONS on Android 13+.
 */
export function startBackgroundGpsWatcher(
  onReading: (r: GpsReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): GpsWatcher {
  let watcherId: string | undefined;
  let stopped = false;
  const reporter = createGpsWindowReporter(onReading, intervalMs);

  void BackgroundGeolocation.addWatcher(
    {
      backgroundMessage: 'Recording rowing session — open app to view.',
      backgroundTitle: 'CrewSight',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    },
    (location, err) => {
      if (stopped) return;
      if (err) {
        const msg =
          typeof err === 'object' && err && 'message' in err
            ? String((err as { message?: string }).message)
            : String(err);
        onError?.(msg);
        return;
      }
      if (!location) return;

      reporter.addFix({
        t: location.time ?? Date.now(),
        lat: location.latitude,
        lon: location.longitude,
        acc: location.accuracy,
        spd: location.speed ?? undefined,
        hdg: location.bearing ?? undefined,
        alt: location.altitude ?? undefined,
      });
    },
  )
    .then((id) => {
      watcherId = id;
    })
    .catch((e) => {
      onError?.(e instanceof Error ? e.message : String(e));
    });

  return {
    stop: async () => {
      stopped = true;
      reporter.stop();
      if (watcherId) {
        await BackgroundGeolocation.removeWatcher({ id: watcherId });
        watcherId = undefined;
      }
    },
  };
}
