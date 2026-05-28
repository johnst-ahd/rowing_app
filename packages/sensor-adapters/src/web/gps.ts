import type { GpsSample } from '@rowing/telemetry-types';
import { isValidGpsReading } from '../gps-validate';
import type { GpsReading, GpsWatcher } from '../types';

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
  let last: GpsReading | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      last = positionToReading(pos);
    },
    (err) => onError?.(err.message),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );

  timer = setInterval(() => {
    if (last && isValidGpsReading(last)) onReading({ ...last, t: Date.now() });
    else {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          last = positionToReading(pos);
          if (last && isValidGpsReading(last)) onReading({ ...last });
        },
        (err) => onError?.(err.message),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      );
    }
  }, intervalMs);

  return {
    stop: () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (timer) clearInterval(timer);
    },
  };
}

export type { GpsReading, GpsWatcher };
