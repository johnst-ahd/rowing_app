/** Geofence types and circle geometry (mirrors api/lib/geofence.js). */

export type GeofenceKind = 'boat_park';

export type GeofenceConfig = {
  id: number;
  name: string;
  kind: GeofenceKind | string;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  enabled: boolean;
  economyGpsIntervalSec: number;
  economyUploadIntervalSec: number;
  disableCapsize: boolean;
};

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function distanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function pointInCircle(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radiusM: number,
): boolean {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(centerLat) ||
    !Number.isFinite(centerLon) ||
    !Number.isFinite(radiusM) ||
    radiusM <= 0
  ) {
    return false;
  }
  return distanceM(lat, lon, centerLat, centerLon) <= radiusM;
}

export function findBoatParkAt(
  lat: number,
  lon: number,
  geofences: GeofenceConfig[],
): GeofenceConfig | null {
  for (const g of geofences) {
    if (!g.enabled || g.kind !== 'boat_park') continue;
    if (pointInCircle(lat, lon, g.centerLat, g.centerLon, g.radiusM)) return g;
  }
  return null;
}

export function normalizeGeofence(raw: Record<string, unknown>): GeofenceConfig {
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ''),
    kind: String(raw.kind ?? 'boat_park'),
    centerLat: Number(raw.centerLat),
    centerLon: Number(raw.centerLon),
    radiusM: Number(raw.radiusM),
    enabled: raw.enabled !== false,
    economyGpsIntervalSec: Number(raw.economyGpsIntervalSec ?? 30),
    economyUploadIntervalSec: Number(raw.economyUploadIntervalSec ?? 30),
    disableCapsize: raw.disableCapsize !== false,
  };
}
