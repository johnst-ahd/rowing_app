import type { GpsReading, GpsWatcher } from '../types';
import { createGpsWindowReporter } from '../gps-window-average';

function positionToReading(pos: GeolocationPosition): GpsReading {
  const c = pos.coords;
  return {
    t: pos.timestamp,
    lat: c.latitude,
    lon: c.longitude,
    acc: c.accuracy,
    spd: c.speed ?? undefined,
    hdg: c.heading ?? undefined,
    alt: c.altitude ?? undefined,
  };
}

export function startGpsWatcher(
  onReading: (r: GpsReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): GpsWatcher {
  if (!navigator.geolocation) {
    onError?.('Geolocation not supported');
    return { stop: () => {} };
  }

  let watchId: number | null = null;
  const reporter = createGpsWindowReporter(onReading, intervalMs);

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      reporter.addFix(positionToReading(pos));
    },
    (err) => onError?.(err.message),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );

  return {
    stop: () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      reporter.stop();
    },
  };
}

export type { GpsReading, GpsWatcher };
