import { Geolocation } from '@capacitor/geolocation';
import type { GpsReading, GpsWatcher } from '../types';
import { createGpsWindowReporter } from '../gps-window-average';
import { startBackgroundGpsWatcher } from './background-gps';

export type GpsWatcherOptions = {
  /** Use foreground-service background GPS (native only). */
  enableBackground?: boolean;
};

function startForegroundGpsWatcher(
  onReading: (r: GpsReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): GpsWatcher {
  let watchId: string | null = null;
  let stopped = false;
  const reporter = createGpsWindowReporter(onReading, intervalMs);

  void Geolocation.watchPosition(
    { enableHighAccuracy: true, timeout: 15000 },
    (pos, err) => {
      if (stopped) return;
      if (err) {
        onError?.(err.message);
        return;
      }
      if (!pos) return;
      const c = pos.coords;
      reporter.addFix({
        t: pos.timestamp ?? Date.now(),
        lat: c.latitude,
        lon: c.longitude,
        acc: c.accuracy,
        spd: c.speed ?? undefined,
        hdg: c.heading ?? undefined,
        alt: c.altitude ?? undefined,
      });
    },
  ).then((id) => {
    watchId = id;
  });

  return {
    stop: async () => {
      stopped = true;
      reporter.stop();
      if (watchId) await Geolocation.clearWatch({ id: watchId });
    },
  };
}

export function startGpsWatcher(
  onReading: (r: GpsReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
  options?: GpsWatcherOptions,
): GpsWatcher {
  if (options?.enableBackground) {
    return startBackgroundGpsWatcher(onReading, intervalMs, onError);
  }
  return startForegroundGpsWatcher(onReading, intervalMs, onError);
}
