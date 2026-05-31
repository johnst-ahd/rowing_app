/**
 * Geofence geometry helpers (circle zones).
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in metres. */
function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function pointInCircle(lat, lon, centerLat, centerLon, radiusM) {
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

/** @param {Array<object>} geofences */
function findBoatParkAt(lat, lon, geofences) {
  if (!Array.isArray(geofences)) return null;
  for (const g of geofences) {
    if (!g || g.enabled === false) continue;
    if (g.kind !== 'boat_park') continue;
    if (pointInCircle(lat, lon, g.centerLat, g.centerLon, g.radiusM)) return g;
  }
  return null;
}

function normalizeGeofence(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind || 'boat_park',
    centerLat: Number(row.center_lat ?? row.centerLat),
    centerLon: Number(row.center_lon ?? row.centerLon),
    radiusM: Number(row.radius_m ?? row.radiusM),
    enabled: row.enabled !== false,
    economyGpsIntervalSec: Number(
      row.economy_gps_interval_sec ?? row.economyGpsIntervalSec ?? 30,
    ),
    economyUploadIntervalSec: Number(
      row.economy_upload_interval_sec ?? row.economyUploadIntervalSec ?? 30,
    ),
    disableCapsize: row.disable_capsize !== false && row.disableCapsize !== false,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

module.exports = {
  distanceM,
  pointInCircle,
  findBoatParkAt,
  normalizeGeofence,
};
