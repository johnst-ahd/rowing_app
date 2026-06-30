import type { MapPosition } from './api';
import { colorForDevice, type ChartSeries } from './history-track';

const WINDOW_MS = 5 * 60 * 1000;

type LivePoint = {
  t: number;
  speedMps: number;
  lat: number;
  lon: number;
  cumDistM: number;
};

type DeviceBuffer = {
  points: LivePoint[];
};

const buffers = new Map<string, DeviceBuffer>();
const deviceOrder = new Map<string, number>();

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

function prune(buf: DeviceBuffer, now: number): void {
  const cutoff = now - WINDOW_MS;
  buf.points = buf.points.filter((p) => p.t >= cutoff);
}

/** Append latest map samples; keeps a rolling 5-minute window per device. */
export function recordLiveSpeedSamples(positions: MapPosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const p of positions) {
    if (!p.deviceId || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    seen.add(p.deviceId);
    const speed = p.speed;
    if (speed == null || !Number.isFinite(speed) || speed < 0) continue;

    const t = p.fixMs ?? now;
    let buf = buffers.get(p.deviceId);
    if (!buf) {
      buf = { points: [] };
      buffers.set(p.deviceId, buf);
      if (!deviceOrder.has(p.deviceId)) {
        deviceOrder.set(p.deviceId, deviceOrder.size);
      }
    }

    const prev = buf.points[buf.points.length - 1];
    let cumDistM = prev?.cumDistM ?? 0;
    if (prev && t > prev.t) {
      cumDistM += haversineM(prev.lat, prev.lon, p.latitude, p.longitude);
    }

    if (prev && Math.abs(t - prev.t) < 400 && Math.abs(speed - prev.speedMps) < 0.05) {
      prune(buf, now);
      continue;
    }

    buf.points.push({
      t,
      speedMps: speed,
      lat: p.latitude,
      lon: p.longitude,
      cumDistM: cumDistM,
    });
    prune(buf, now);
  }

  for (const id of buffers.keys()) {
    if (!seen.has(id)) {
      const buf = buffers.get(id)!;
      prune(buf, now);
      if (!buf.points.length) buffers.delete(id);
    }
  }
}

export function liveSpeedVsDistanceSeries(activeDeviceIds: string[]): ChartSeries[] {
  const ids = activeDeviceIds.filter((id) => (buffers.get(id)?.points.length ?? 0) >= 2);
  return ids.map((id, i) => {
    const pts = buffers.get(id)!.points;
    const baseDist = pts[0].cumDistM;
    const order = deviceOrder.get(id) ?? i;
    return {
      id,
      label: id,
      color: colorForDevice(order),
      points: pts.map((p) => ({
        x: Math.max(0, p.cumDistM - baseDist),
        y: p.speedMps * 3.6,
      })),
    };
  });
}

export function clearLiveSpeedBuffers(): void {
  buffers.clear();
  deviceOrder.clear();
}
