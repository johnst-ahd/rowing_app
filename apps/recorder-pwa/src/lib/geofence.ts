/** Geofence types and geometry (mirrors api/lib/geofence.js). */

export type GeofenceKind = 'boat_park';
export type GeofenceShapeType = 'circle' | 'polygon';

export type GeofenceConfig = {
  id: number;
  name: string;
  kind: GeofenceKind | string;
  shapeType: GeofenceShapeType;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  polygonCoords: Array<[number, number]>;
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

export function pointInPolygon(lat: number, lon: number, ring: Array<[number, number]>): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function parsePolygonCoords(raw: unknown): Array<[number, number]> {
  if (!raw) return [];
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const ring: Array<[number, number]> = [];
  for (const pt of value) {
    if (Array.isArray(pt) && pt.length >= 2) {
      const lat = Number(pt[0]);
      const lon = Number(pt[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    } else if (pt && typeof pt === 'object') {
      const obj = pt as Record<string, unknown>;
      const lat = Number(obj.lat ?? obj.latitude);
      const lon = Number(obj.lon ?? obj.longitude ?? obj.lng);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    }
  }
  return ring.length >= 3 ? ring : [];
}

export function pointInGeofence(g: GeofenceConfig, lat: number, lon: number): boolean {
  if (!g.enabled || g.kind !== 'boat_park') return false;
  if (g.shapeType === 'polygon') {
    return pointInPolygon(lat, lon, g.polygonCoords);
  }
  return pointInCircle(lat, lon, g.centerLat, g.centerLon, g.radiusM);
}

export function findBoatParkAt(
  lat: number,
  lon: number,
  geofences: GeofenceConfig[],
): GeofenceConfig | null {
  for (const g of geofences) {
    if (pointInGeofence(g, lat, lon)) return g;
  }
  return null;
}

export function normalizeGeofence(raw: Record<string, unknown>): GeofenceConfig {
  const shapeType =
    String(raw.shapeType ?? raw.shape_type ?? 'circle').toLowerCase() === 'polygon'
      ? 'polygon'
      : 'circle';
  const polygonCoords =
    shapeType === 'polygon'
      ? parsePolygonCoords(raw.polygonCoords ?? raw.polygon_coords)
      : [];
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ''),
    kind: String(raw.kind ?? 'boat_park'),
    shapeType,
    centerLat: Number(raw.centerLat ?? raw.center_lat),
    centerLon: Number(raw.centerLon ?? raw.center_lon),
    radiusM: Number(raw.radiusM ?? raw.radius_m),
    polygonCoords,
    enabled: raw.enabled !== false,
    economyGpsIntervalSec: Number(raw.economyGpsIntervalSec ?? raw.economy_gps_interval_sec ?? 30),
    economyUploadIntervalSec: Number(
      raw.economyUploadIntervalSec ?? raw.economy_upload_interval_sec ?? 30,
    ),
    disableCapsize: raw.disableCapsize !== false && raw.disable_capsize !== false,
  };
}
