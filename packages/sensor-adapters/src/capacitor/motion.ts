import type { MotionReading, MotionWatcher } from '../types';
import { startNativeAccelerometerWatcher } from './native-motion';

export type MotionWatcherOptions = {
  /** When false, skips native sensor (web shim only — native APK should leave true). */
  enableBackground?: boolean;
};

/** Native APK: always uses SensorManager accelerometer. */
export async function startMotionWatcher(
  onReading: (r: MotionReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
  options?: MotionWatcherOptions,
): Promise<MotionWatcher> {
  if (options?.enableBackground === false) {
    onError?.('Native accelerometer required for motion on this build');
    return { stop: () => {} };
  }
  return startNativeAccelerometerWatcher(onReading, intervalMs, onError);
}
