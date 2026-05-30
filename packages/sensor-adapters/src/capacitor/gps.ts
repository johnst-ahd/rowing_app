import { Geolocation } from '@capacitor/geolocation';
import type { GpsReading, GpsWatcher } from '../types';
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
  let last: GpsReading | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

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
      last = {
        t: pos.timestamp ?? Date.now(),
        lat: c.latitude,
        lon: c.longitude,
        acc: c.accuracy,
        spd: c.speed ?? undefined,
        hdg: c.heading ?? undefined,
        alt: c.altitude ?? undefined,
      };
    },
  ).then((id) => {
    watchId = id;
  });

  timer = setInterval(() => {
    if (stopped) return;
    if (last) {
      onReading({ ...last });
      return;
    }
    void Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 15000,
    })
      .then((pos) => {
        const c = pos.coords;
        last = {
          t: pos.timestamp ?? Date.now(),
          lat: c.latitude,
          lon: c.longitude,
          acc: c.accuracy,
          spd: c.speed ?? undefined,
          hdg: c.heading ?? undefined,
          alt: c.altitude ?? undefined,
        };
        if (last) onReading({ ...last });
      })
      .catch((e) => onError?.(e instanceof Error ? e.message : String(e)));
  }, intervalMs);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
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
