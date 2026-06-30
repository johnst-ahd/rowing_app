import type { GpsReading } from './types';

/** Collect fixes at this cadence; report interval is configured separately. */
export const GPS_COLLECT_MS = 500;

const MIN_ACC_M = 5;

function fixWeight(acc?: number): number {
  const a = Math.max(acc ?? 25, MIN_ACC_M);
  return 1 / (a * a);
}

/** Accuracy-weighted mean of fixes collected since the last report. */
export function weightedAverageGpsFixes(fixes: GpsReading[]): GpsReading | null {
  if (!fixes.length) return null;
  if (fixes.length === 1) return { ...fixes[0] };

  let wSum = 0;
  let lat = 0;
  let lon = 0;
  let spdSum = 0;
  let spdW = 0;
  let altSum = 0;
  let altW = 0;
  let bestHdg: number | undefined;
  let bestHdgW = 0;
  let accSum = 0;

  for (const f of fixes) {
    const w = fixWeight(f.acc);
    wSum += w;
    lat += f.lat * w;
    lon += f.lon * w;
    accSum += (f.acc ?? 25) * w;
    if (f.spd != null && f.spd >= 0) {
      spdSum += f.spd * w;
      spdW += w;
    }
    if (f.alt != null && Number.isFinite(f.alt)) {
      altSum += f.alt * w;
      altW += w;
    }
    if (f.hdg != null && f.hdg >= 0 && w >= bestHdgW) {
      bestHdgW = w;
      bestHdg = f.hdg;
    }
  }

  if (wSum <= 0) return { ...fixes[fixes.length - 1] };

  return {
    t: Date.now(),
    lat: lat / wSum,
    lon: lon / wSum,
    acc: accSum / wSum,
    spd: spdW > 0 ? spdSum / spdW : undefined,
    hdg: bestHdg,
    alt: altW > 0 ? altSum / altW : undefined,
  };
}

export type GpsWindowReporter = {
  addFix: (fix: GpsReading) => void;
  stop: () => void;
};

/** Buffer fixes every ~500ms; emit one weighted-average reading each report interval. */
export function createGpsWindowReporter(
  onReading: (r: GpsReading) => void,
  reportIntervalMs: number,
): GpsWindowReporter {
  const buffer: GpsReading[] = [];
  let lastCollectAt = 0;
  let reportTimer: ReturnType<typeof setInterval> | null = null;

  const flush = () => {
    const averaged = weightedAverageGpsFixes(buffer);
    buffer.length = 0;
    if (averaged) onReading(averaged);
  };

  reportTimer = setInterval(flush, Math.max(GPS_COLLECT_MS, reportIntervalMs));

  return {
    addFix(fix: GpsReading) {
      const now = Date.now();
      if (now - lastCollectAt < GPS_COLLECT_MS) return;
      lastCollectAt = now;
      buffer.push({ ...fix, t: fix.t || now });
    },
    stop() {
      if (reportTimer) clearInterval(reportTimer);
      reportTimer = null;
      buffer.length = 0;
    },
  };
}
