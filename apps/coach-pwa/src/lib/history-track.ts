import type { HistoryPoint } from './api';

export const DEVICE_COLORS = [
  '#38bdf8',
  '#a78bfa',
  '#4ade80',
  '#fb923c',
  '#f472b6',
  '#facc15',
  '#2dd4bf',
  '#818cf8',
] as const;

export type DeviceTrack = {
  deviceId: string;
  color: string;
  points: EnrichedPoint[];
  tMin: number;
  tMax: number;
  totalDistanceM: number;
};

export type EnrichedPoint = HistoryPoint & {
  deviceId: string;
  cumDistM: number;
};

export type HistorySelection = {
  t0: number;
  t1: number;
  distanceMode: boolean;
  distStartM: number;
  distWindowM: number;
};

export type DeviceStats = {
  deviceId: string;
  color: string;
  durationSec: number;
  distanceM: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  avgStrokeRate: number | null;
  pointCount: number;
};

export type ChartSeries = {
  id: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
};

export function colorForDevice(index: number): string {
  return DEVICE_COLORS[index % DEVICE_COLORS.length];
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Attach cumulative distance along GPS path. */
export function enrichTrack(deviceId: string, points: HistoryPoint[]): EnrichedPoint[] {
  let cum = 0;
  const out: EnrichedPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const prev = points[i - 1];
      if (
        p.lat != null &&
        p.lon != null &&
        prev.lat != null &&
        prev.lon != null
      ) {
        cum += haversineM(prev.lat, prev.lon, p.lat, p.lon);
      }
    }
    out.push({ ...p, deviceId, cumDistM: cum });
  }
  return out;
}

export function buildDeviceTrack(deviceId: string, color: string, points: HistoryPoint[]): DeviceTrack {
  const enriched = enrichTrack(deviceId, points);
  const tMin = enriched.length ? enriched[0].t : 0;
  const tMax = enriched.length ? enriched[enriched.length - 1].t : 0;
  const totalDistanceM = enriched.length ? enriched[enriched.length - 1].cumDistM : 0;
  return { deviceId, color, points: enriched, tMin, tMax, totalDistanceM };
}

export function defaultSelection(tracks: DeviceTrack[]): HistorySelection {
  if (!tracks.length) {
    return { t0: 0, t1: 1, distanceMode: false, distStartM: 0, distWindowM: 500 };
  }
  const t0 = Math.min(...tracks.map((t) => t.tMin));
  const t1 = Math.max(...tracks.map((t) => t.tMax));
  const maxDist = Math.max(...tracks.map((t) => t.totalDistanceM));
  return {
    t0,
    t1,
    distanceMode: false,
    distStartM: 0,
    distWindowM: Math.min(500, Math.max(100, Math.round(maxDist / 4))),
  };
}

function inTimeRange(p: EnrichedPoint, sel: HistorySelection): boolean {
  return p.t >= sel.t0 && p.t <= sel.t1;
}

function inDistanceRange(p: EnrichedPoint, sel: HistorySelection): boolean {
  const end = sel.distStartM + sel.distWindowM;
  return p.cumDistM >= sel.distStartM && p.cumDistM <= end;
}

export function filterTracks(tracks: DeviceTrack[], sel: HistorySelection): DeviceTrack[] {
  return tracks.map((track) => ({
    ...track,
    points: track.points.filter((p) =>
      sel.distanceMode ? inDistanceRange(p, sel) && inTimeRange(p, sel) : inTimeRange(p, sel),
    ),
  }));
}

export function computeDeviceStats(tracks: DeviceTrack[], sel: HistorySelection): DeviceStats[] {
  const filtered = filterTracks(tracks, sel);
  return filtered.map((track) => {
    const pts = track.points;
    const speeds = pts.map((p) => p.speed).filter((s): s is number => s != null && s >= 0);
    const spm = pts
      .map((p) => p.strokeRate)
      .filter((v): v is number => v != null && v >= 15 && v <= 50);
    const durationSec = Math.max(0, (sel.t1 - sel.t0) / 1000);
    let distanceM = 0;
    if (pts.length >= 2) {
      distanceM = pts[pts.length - 1].cumDistM - pts[0].cumDistM;
    }
    const avgSpeedMps =
      speeds.length > 0
        ? speeds.reduce((a, b) => a + b, 0) / speeds.length
        : durationSec > 0
          ? distanceM / durationSec
          : 0;
    return {
      deviceId: track.deviceId,
      color: track.color,
      durationSec: sel.distanceMode
        ? Math.max(0, (pts[pts.length - 1]?.t ?? sel.t1) - (pts[0]?.t ?? sel.t0)) / 1000
        : durationSec,
      distanceM,
      avgSpeedMps,
      maxSpeedMps: speeds.length ? Math.max(...speeds) : 0,
      avgStrokeRate: spm.length ? spm.reduce((a, b) => a + b, 0) / spm.length : null,
      pointCount: pts.length,
    };
  });
}

export function speedVsTimeSeries(tracks: DeviceTrack[], sel: HistorySelection): ChartSeries[] {
  const filtered = filterTracks(tracks, sel);
  return filtered.map((track) => ({
    id: track.deviceId,
    label: track.deviceId,
    color: track.color,
    points: track.points
      .filter((p) => p.speed != null)
      .map((p) => ({ x: (p.t - sel.t0) / 1000, y: p.speed! * 3.6 })),
  }));
}

export function speedVsDistanceSeries(tracks: DeviceTrack[], sel: HistorySelection): ChartSeries[] {
  const filtered = filterTracks(tracks, sel);
  return filtered.map((track) => ({
    id: track.deviceId,
    label: track.deviceId,
    color: track.color,
    points: track.points
      .filter((p) => p.speed != null)
      .map((p) => ({
        x: p.cumDistM - (sel.distanceMode ? sel.distStartM : track.points[0]?.cumDistM ?? 0),
        y: p.speed! * 3.6,
      })),
  }));
}

export function strokeRateSeries(tracks: DeviceTrack[], sel: HistorySelection): ChartSeries[] {
  const filtered = filterTracks(tracks, sel);
  return filtered.map((track) => ({
    id: track.deviceId,
    label: track.deviceId,
    color: track.color,
    points: track.points
      .filter((p) => p.strokeRate != null && p.strokeRate >= 15 && p.strokeRate <= 50)
      .map((p) => ({ x: (p.t - sel.t0) / 1000, y: p.strokeRate! })),
  }));
}

/** Map distance window start to approximate time on primary track. */
export function timeAtDistance(track: DeviceTrack, distM: number): number {
  for (const p of track.points) {
    if (p.cumDistM >= distM) return p.t;
  }
  return track.tMax;
}

export function maxDistance(tracks: DeviceTrack[]): number {
  return tracks.length ? Math.max(...tracks.map((t) => t.totalDistanceM)) : 0;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatSpeedKmh(mps: number): string {
  return `${(mps * 3.6).toFixed(1)} km/h`;
}
