import type { GpsSample, HrSample, MotionSample } from '@rowing/telemetry-types';

/** Build OsmAnd-style URL for Traccar HTTP port (usually 5055). */
export function buildOsmAndUrl(
  baseUrl: string,
  deviceId: string,
  gps: GpsSample,
  timestampMs: number,
  extras?: { hr?: HrSample; motion?: MotionSample },
): string {
  const raw = baseUrl.trim().replace(/\/$/, '');
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  if (!u.port) u.port = '5055';

  u.searchParams.set('id', deviceId);
  u.searchParams.set('lat', String(gps.lat));
  u.searchParams.set('lon', String(gps.lon));
  u.searchParams.set('timestamp', String(timestampMs));
  if (gps.acc != null) u.searchParams.set('accuracy', String(Math.round(gps.acc)));
  if (gps.spd != null && gps.spd >= 0) u.searchParams.set('speed', String(gps.spd));
  if (gps.hdg != null && gps.hdg >= 0) u.searchParams.set('bearing', String(gps.hdg));
  if (gps.alt != null) u.searchParams.set('altitude', String(gps.alt));
  if (extras?.hr?.bpm != null) u.searchParams.set('hr', String(extras.hr.bpm));
  if (extras?.motion) {
    u.searchParams.set('ax', String(extras.motion.ax.toFixed(3)));
    u.searchParams.set('ay', String(extras.motion.ay.toFixed(3)));
    u.searchParams.set('az', String(extras.motion.az.toFixed(3)));
  }
  return u.toString();
}

/** Send via same-origin proxy (avoids Traccar CORS block in the browser). */
export async function sendOsmAndPosition(
  osmandUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const proxy = `/api/traccar-forward?url=${encodeURIComponent(osmandUrl)}`;
    const res = await fetch(proxy, { method: 'GET', keepalive: true });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      detail?: string;
    };
    if (!res.ok || !data.ok) {
      const msg = data.error || data.detail || `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
