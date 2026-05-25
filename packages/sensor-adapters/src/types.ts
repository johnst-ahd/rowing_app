import type { GpsSample, HrSample, MotionSample } from '@rowing/telemetry-types';

export type GpsReading = GpsSample & { t: number };
export type MotionReading = MotionSample & { t: number };
export type HrReading = HrSample & { t: number };

export type GpsWatcher = { stop: () => void | Promise<void> };
export type MotionWatcher = { stop: () => void | Promise<void> };

export type HeartRateMonitor = {
  name: string;
  disconnect: () => Promise<void>;
};

export type SensorAdapters = {
  startGpsWatcher: (
    onReading: (r: GpsReading) => void,
    intervalMs: number,
    onError?: (msg: string) => void,
    options?: { enableBackground?: boolean },
  ) => GpsWatcher | Promise<GpsWatcher>;
  startMotionWatcher: (
    onReading: (r: MotionReading) => void,
    intervalMs: number,
    onError?: (msg: string) => void,
    options?: { enableBackground?: boolean },
  ) => Promise<MotionWatcher>;
  connectHeartRate: (
    onReading: (r: HrReading) => void,
    onError?: (msg: string) => void,
  ) => Promise<HeartRateMonitor | null>;
  requestNativePermissions?: () => Promise<void>;
};
