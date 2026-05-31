import { normalizeGeofence, type GeofenceConfig } from './geofence';

const CACHE_MS = 5 * 60 * 1000;

let cached: GeofenceConfig[] = [];
let cachedAt = 0;

function geofencesUrl(ingestUrl: string): string {
  const base = ingestUrl.replace(/\/api\/ingest\/?$/i, '');
  return `${base}/api/geofences`;
}

export async function fetchGeofences(
  ingestUrl: string,
  ingestToken?: string,
  force = false,
): Promise<GeofenceConfig[]> {
  const now = Date.now();
  if (!force && cached.length && now - cachedAt < CACHE_MS) return cached;

  const url = geofencesUrl(ingestUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ingestToken?.trim()) headers.Authorization = `Bearer ${ingestToken.trim()}`;

  try {
    const res = await fetch(url, { headers });
    const data = (await res.json()) as { ok?: boolean; geofences?: unknown[] };
    if (!res.ok || !data.ok || !Array.isArray(data.geofences)) return cached;
    cached = data.geofences.map((g) =>
      normalizeGeofence(g as Record<string, unknown>),
    );
    cachedAt = now;
    return cached;
  } catch {
    return cached;
  }
}

export function clearGeofenceCache(): void {
  cached = [];
  cachedAt = 0;
}
