import type { GpsReading } from './types';

export const MAX_GPS_ACCURACY_M = 150;

export function isValidGpsCoords(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return true;
}

export function isValidGpsReading(
  reading: Pick<GpsReading, 'lat' | 'lon' | 'acc'> | null | undefined,
): boolean {
  if (!reading) return false;
  if (!isValidGpsCoords(reading.lat, reading.lon)) return false;
  if (
    reading.acc != null &&
    Number.isFinite(reading.acc) &&
    reading.acc > MAX_GPS_ACCURACY_M
  ) {
    return false;
  }
  return true;
}
