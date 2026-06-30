import type { GpsReading } from './types';

/** Collect fixes at this cadence; report interval is configured separately. */
export const GPS_COLLECT_MS = 500;

/**
 * Latest fix collected since the last report, stamped with wall clock.
 * Map smoothing is handled server-side (EMA); client sends freshest coords.
 */
export function latestGpsReadingAtReport(fixes: GpsReading[]): GpsReading | null {
  if (!fixes.length) return null;
  return { ...fixes[fixes.length - 1], t: Date.now() };
}

/** @deprecated use latestGpsReadingAtReport — kept for callers migrating off averaging */
export function weightedAverageGpsFixes(fixes: GpsReading[]): GpsReading | null {
  return latestGpsReadingAtReport(fixes);
}

export type GpsWindowReporter = {
  addFix: (fix: GpsReading) => void;
  stop: () => void;
};

/** Buffer fixes every ~500ms; emit the latest reading each report interval. */
export function createGpsWindowReporter(
  onReading: (r: GpsReading) => void,
  reportIntervalMs: number,
): GpsWindowReporter {
  const buffer: GpsReading[] = [];
  let lastCollectAt = 0;
  let reportTimer: ReturnType<typeof setInterval> | null = null;

  const flush = () => {
    const reading = latestGpsReadingAtReport(buffer);
    buffer.length = 0;
    if (reading) onReading(reading);
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
